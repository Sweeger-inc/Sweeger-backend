const supabase = require('./supabase');
const { v4: uuidv4 } = require('uuid');

const SWEEGER_COMMISSION_RATE = 0.30;
const CREATOR_SHARE_RATE = 0.70;

class WalletError extends Error {
  constructor(message, status = 400, code = 'wallet_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Per-user async lock to prevent double-spend / concurrent wallet races
class WalletLock {
  constructor() {
    this.locks = new Map();
  }
  async acquire(keys) {
    const sorted = [...new Set(keys.filter(Boolean))].sort();
    while (true) {
      const pending = sorted.map((k) => this.locks.get(k)).filter(Boolean);
      if (pending.length === 0) {
        let release;
        const p = new Promise((r) => {
          release = r;
        });
        for (const k of sorted) this.locks.set(k, p);
        return () => {
          for (const k of sorted) this.locks.delete(k);
          release();
        };
      }
      await Promise.race(pending);
    }
  }
}

const walletLock = new WalletLock();

function calculateSplit(grossAmountNGN) {
  const gross = Math.round(Number(grossAmountNGN));
  if (!Number.isFinite(gross) || gross <= 0) {
    throw new WalletError('Amount must be a positive number', 400, 'invalid_amount');
  }
  const creatorKeeps = Math.round(gross * CREATOR_SHARE_RATE);
  const sweegerFee = gross - creatorKeeps;
  return { gross, creatorKeeps, sweegerFee };
}

async function ensureWallet(userId) {
  const { data: existing, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new WalletError('Failed to load wallet', 500);
  if (existing) return existing;

  const { data: created, error: createErr } = await supabase
    .from('wallets')
    .insert({
      user_id: userId,
      balance_ngn: 0,
      creator_balance_ngn: 0,
    })
    .select()
    .single();

  if (createErr) throw new WalletError('Failed to initialize wallet', 500);
  return created;
}

async function getWalletSummary(userId) {
  const wallet = await ensureWallet(userId);

  const [{ data: transactions }, { data: earnings }, { data: withdrawals }] = await Promise.all([
    supabase
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', userId)
      .eq('bucket', 'creator')
      .eq('direction', 'credit')
      .order('created_at', { ascending: false }),
    supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
  ]);

  // Aggregate per-content breakdown for creator earnings
  const byContent = new Map();
  for (const tx of earnings || []) {
    const key = tx.content_id || tx.reference || 'other';
    if (!byContent.has(key)) {
      byContent.set(key, {
        content_id: tx.content_id || null,
        content_title: tx.content_title || tx.description || 'Paid session',
        content_type: tx.content_type || 'room',
        sold_count: 0,
        gross_ngn: 0,
        creator_keeps_ngn: 0,
        sweeger_fee_ngn: 0,
      });
    }
    const entry = byContent.get(key);
    entry.sold_count += 1;
    entry.gross_ngn += Number(tx.gross_amount_ngn || tx.amount_ngn || 0);
    entry.creator_keeps_ngn += Number(tx.amount_ngn || 0);
    entry.sweeger_fee_ngn += Number(tx.platform_fee_ngn || 0);
  }

  return {
    balance_ngn: Number(wallet.balance_ngn || 0),
    creator_balance_ngn: Number(wallet.creator_balance_ngn || 0),
    currency: 'NGN',
    commission_split: { creator_percent: 70, sweeger_percent: 30 },
    recent_activity: transactions || [],
    creator_breakdown: Array.from(byContent.values()),
    withdrawals: withdrawals || [],
  };
}

/**
 * Credit spending wallet (idempotent if reference is supplied).
 */
async function creditWallet({ userId, amountNGN, reference = null, description = 'Wallet top up', metadata = {} }) {
  const amount = Math.round(Number(amountNGN));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WalletError('Top up amount must be positive', 400, 'invalid_amount');
  }

  const release = await walletLock.acquire([userId]);
  try {
    if (reference) {
      const { data: dup } = await supabase
        .from('wallet_transactions')
        .select('*')
        .eq('reference', reference)
        .eq('user_id', userId)
        .maybeSingle();

      if (dup) {
        const wallet = await ensureWallet(userId);
        return { wallet, transaction: dup, duplicate: true };
      }
    }

    const wallet = await ensureWallet(userId);
    const nextBalance = Number(wallet.balance_ngn || 0) + amount;

    const { data: updated, error: updErr } = await supabase
      .from('wallets')
      .update({
        balance_ngn: nextBalance,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (updErr) throw new WalletError('Failed to credit wallet', 500);

    const { data: tx } = await supabase
      .from('wallet_transactions')
      .insert({
        user_id: userId,
        bucket: 'spending',
        direction: 'credit',
        type: 'topup',
        amount_ngn: amount,
        gross_amount_ngn: amount,
        platform_fee_ngn: 0,
        balance_after_ngn: nextBalance,
        reference: reference || `topup_${uuidv4()}`,
        description,
        metadata,
      })
      .select()
      .single();

    return { wallet: updated, transaction: tx, duplicate: false };
  } finally {
    release();
  }
}

/**
 * Atomic double-entry transfer:
 * Debits buyer's spending wallet for `priceNGN`, credits creator's earnings wallet with 70%,
 * and records Sweeger's 30% commission in the ledger.
 */
async function purchaseWithWallet({
  buyerId,
  creatorId,
  priceNGN,
  contentId,
  contentTitle,
  contentType = 'paid_room', // 'paid_room' | 'distributor_ticket'
  idempotencyKey = null,
}) {
  const { gross, creatorKeeps, sweegerFee } = calculateSplit(priceNGN);

  const release = await walletLock.acquire([buyerId, creatorId]);
  try {
    if (idempotencyKey) {
      const { data: existingTx } = await supabase
        .from('wallet_transactions')
        .select('*')
        .eq('reference', idempotencyKey)
        .eq('user_id', buyerId)
        .maybeSingle();

      if (existingTx) {
        return {
          already_paid: true,
          gross_ngn: gross,
          creator_keeps_ngn: creatorKeeps,
          sweeger_fee_ngn: sweegerFee,
          transaction: existingTx,
        };
      }
    }

    const buyerWallet = await ensureWallet(buyerId);
    const currentBuyerBalance = Number(buyerWallet.balance_ngn || 0);

    if (currentBuyerBalance < gross) {
      await supabase.from('notifications').insert({
        user_id: buyerId,
        type: 'low_wallet_balance',
        title: 'Insufficient wallet balance',
        body: `Top up your wallet to pay ₦${gross} for "${contentTitle}".`,
        data: { content_id: contentId, required_ngn: gross, balance_ngn: currentBuyerBalance },
        is_read: false,
      });

      throw new WalletError(
        'Insufficient wallet balance, top up to continue',
        402,
        'insufficient_balance'
      );
    }

    const creatorWallet = await ensureWallet(creatorId);
    const newBuyerBalance = currentBuyerBalance - gross;
    const newCreatorBalance = Number(creatorWallet.creator_balance_ngn || 0) + creatorKeeps;
    const nowIso = new Date().toISOString();

    // 1. Debit buyer spending balance
    const { error: buyerErr } = await supabase
      .from('wallets')
      .update({ balance_ngn: newBuyerBalance, updated_at: nowIso })
      .eq('user_id', buyerId);

    if (buyerErr) throw new WalletError('Failed to debit wallet', 500);

    // 2. Credit creator earnings balance (70%)
    const { error: creatorErr } = await supabase
      .from('wallets')
      .update({ creator_balance_ngn: newCreatorBalance, updated_at: nowIso })
      .eq('user_id', creatorId);

    if (creatorErr) {
      // Rollback buyer debit
      await supabase
        .from('wallets')
        .update({ balance_ngn: currentBuyerBalance, updated_at: nowIso })
        .eq('user_id', buyerId);
      throw new WalletError('Failed to credit creator earnings', 500);
    }

    const ref = idempotencyKey || `pay_${uuidv4()}`;

    // 3. Double-entry ledger records
    const [{ data: buyerTx }] = await Promise.all([
      supabase
        .from('wallet_transactions')
        .insert({
          user_id: buyerId,
          counterparty_id: creatorId,
          bucket: 'spending',
          direction: 'debit',
          type: contentType,
          amount_ngn: gross,
          gross_amount_ngn: gross,
          platform_fee_ngn: sweegerFee,
          balance_after_ngn: newBuyerBalance,
          reference: ref,
          content_id: contentId,
          content_title: contentTitle,
          content_type: contentType,
          description: `Paid ₦${gross} for ${contentTitle}`,
        })
        .select()
        .single(),
      supabase.from('wallet_transactions').insert({
        user_id: creatorId,
        counterparty_id: buyerId,
        bucket: 'creator',
        direction: 'credit',
        type: `${contentType}_earning`,
        amount_ngn: creatorKeeps,
        gross_amount_ngn: gross,
        platform_fee_ngn: sweegerFee,
        balance_after_ngn: newCreatorBalance,
        reference: `${ref}:creator`,
        content_id: contentId,
        content_title: contentTitle,
        content_type: contentType,
        description: `₦${gross} sale — you keep ₦${creatorKeeps} (70%)`,
      }),
    ]);

    return {
      already_paid: false,
      gross_ngn: gross,
      creator_keeps_ngn: creatorKeeps,
      sweeger_fee_ngn: sweegerFee,
      buyer_balance_ngn: newBuyerBalance,
      creator_balance_ngn: newCreatorBalance,
      transaction: buyerTx,
    };
  } finally {
    release();
  }
}

/**
 * Request a creator withdrawal (manual disbursement queue, status starts as 'pending').
 */
async function requestWithdrawal({ userId, amountNGN, bankDetails = {} }) {
  const amount = Math.round(Number(amountNGN));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WalletError('Withdrawal amount must be positive', 400, 'invalid_amount');
  }

  const release = await walletLock.acquire([userId]);
  try {
    const wallet = await ensureWallet(userId);
    const creatorBalance = Number(wallet.creator_balance_ngn || 0);

    if (amount > creatorBalance) {
      throw new WalletError(
        'Requested amount exceeds your creator earnings balance',
        400,
        'exceeds_creator_balance'
      );
    }

    const nextCreatorBalance = creatorBalance - amount;
    const nowIso = new Date().toISOString();

    await supabase
      .from('wallets')
      .update({ creator_balance_ngn: nextCreatorBalance, updated_at: nowIso })
      .eq('user_id', userId);

    const { data: withdrawal, error } = await supabase
      .from('withdrawal_requests')
      .insert({
        user_id: userId,
        amount_ngn: amount,
        status: 'pending',
        bank_details: bankDetails,
        note: 'Pending manual review and payout by Sweeger.',
      })
      .select()
      .single();

    if (error) {
      await supabase
        .from('wallets')
        .update({ creator_balance_ngn: creatorBalance, updated_at: nowIso })
        .eq('user_id', userId);
      throw new WalletError('Failed to create withdrawal request', 500);
    }

    await supabase.from('wallet_transactions').insert({
      user_id: userId,
      bucket: 'creator',
      direction: 'debit',
      type: 'withdrawal_request',
      amount_ngn: amount,
      gross_amount_ngn: amount,
      platform_fee_ngn: 0,
      balance_after_ngn: nextCreatorBalance,
      reference: `wd_${withdrawal.id}`,
      description: `Withdrawal request for ₦${amount} (Pending)`,
    });

    return {
      withdrawal,
      creator_balance_ngn: nextCreatorBalance,
    };
  } finally {
    release();
  }
}

module.exports = {
  SWEEGER_COMMISSION_RATE,
  CREATOR_SHARE_RATE,
  WalletError,
  calculateSplit,
  ensureWallet,
  getWalletSummary,
  creditWallet,
  purchaseWithWallet,
  requestWithdrawal,
};
