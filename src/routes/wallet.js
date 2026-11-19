const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const walletService = require('../services/wallet');
const paystack = require('../services/paystack');
const supabase = require('../services/supabase');

// --------------------------------------------------------
// GET /api/wallet — spending balance, creator earnings, 70/30 breakdown, history, withdrawals
// --------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  try {
    const summary = await walletService.getWalletSummary(req.auth.userId);
    return res.status(200).json(summary);
  } catch (err) {
    console.error('Get wallet error:', err.message);
    return res
      .status(err instanceof walletService.WalletError ? err.status : 500)
      .json({ error: err.message || 'Failed to load wallet' });
  }
});

// --------------------------------------------------------
// POST /api/wallet/topup/initialize — Paystack top up checkout
// --------------------------------------------------------
router.post('/topup/initialize', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { amount_ngn, email, callback_url } = req.body || {};
    const amount = Math.round(Number(amount_ngn));

    if (!Number.isFinite(amount) || amount < 100) {
      return res.status(400).json({ error: 'Minimum top up amount is ₦100' });
    }

    let resolvedEmail = email;
    if (!resolvedEmail) {
      const { data: user } = await supabase
        .from('users')
        .select('email')
        .eq('id', userId)
        .maybeSingle();
      resolvedEmail = user?.email || `${userId}@sweeger.buzz`;
    }

    const checkout = await paystack.initializePayment({
      email: resolvedEmail,
      amount,
      userId,
      callbackUrl: callback_url,
      metadata: { purpose: 'wallet_topup', amount_ngn: amount },
    });

    return res.status(200).json({
      message: 'Wallet top up session initialized',
      amount_ngn: amount,
      ...checkout,
    });
  } catch (err) {
    console.error('Wallet topup init error:', err.message);
    return res
      .status(err instanceof paystack.PaystackError ? err.status : 500)
      .json({ error: err.message || 'Failed to initialize wallet top up' });
  }
});

// --------------------------------------------------------
// POST /api/wallet/topup/verify — verify Paystack ref and credit wallet atomically
// --------------------------------------------------------
router.post('/topup/verify', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { reference } = req.body || {};

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }

    const transaction = await paystack.verifyTransaction(reference);
    if (transaction.status !== 'success') {
      return res.status(400).json({
        error: `Payment verification failed. Status: ${transaction.status}`,
      });
    }

    const amountNGN = Math.round(Number(transaction.amount || 0) / 100);
    const result = await walletService.creditWallet({
      userId,
      amountNGN,
      reference,
      description: `Paystack wallet top up (₦${amountNGN})`,
      metadata: { paystack_id: transaction.id },
    });

    return res.status(200).json({
      message: result.duplicate ? 'Top up already credited' : 'Wallet topped up successfully',
      balance_ngn: Number(result.wallet.balance_ngn),
      transaction: result.transaction,
    });
  } catch (err) {
    console.error('Wallet topup verify error:', err.message);
    return res
      .status(err instanceof paystack.PaystackError || err instanceof walletService.WalletError ? err.status : 500)
      .json({ error: err.message || 'Failed to verify wallet top up' });
  }
});

// --------------------------------------------------------
// POST /api/wallet/topup/demo — dev/sandbox top up when Paystack is not configured
// --------------------------------------------------------
router.post('/topup/demo', requireAuth, async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.PAYSTACK_SECRET_KEY) {
    return res.status(403).json({ error: 'Demo top up is disabled in production' });
  }

  try {
    const amount = Math.round(Number(req.body?.amount_ngn || 1000));
    const result = await walletService.creditWallet({
      userId: req.auth.userId,
      amountNGN: amount,
      description: `Demo wallet top up (₦${amount})`,
    });

    return res.status(200).json({
      message: `Added ₦${amount} to your wallet`,
      balance_ngn: Number(result.wallet.balance_ngn),
      transaction: result.transaction,
    });
  } catch (err) {
    return res
      .status(err instanceof walletService.WalletError ? err.status : 500)
      .json({ error: err.message || 'Failed to credit demo wallet' });
  }
});

// --------------------------------------------------------
// POST /api/wallet/withdrawals — request manual creator payout (starts as Pending)
// --------------------------------------------------------
router.post('/withdrawals', requireAuth, async (req, res) => {
  try {
    const { amount_ngn, bank_name, account_number, account_name } = req.body || {};

    const result = await walletService.requestWithdrawal({
      userId: req.auth.userId,
      amountNGN: amount_ngn,
      bankDetails: { bank_name, account_number, account_name },
    });

    return res.status(201).json({
      message: 'Withdrawal request submitted. Status: Pending manual review and payout by Sweeger.',
      ...result,
    });
  } catch (err) {
    return res
      .status(err instanceof walletService.WalletError ? err.status : 500)
      .json({ error: err.message || 'Failed to submit withdrawal request' });
  }
});

// --------------------------------------------------------
// GET /api/wallet/withdrawals — list user's withdrawal requests
// --------------------------------------------------------
router.get('/withdrawals', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('user_id', req.auth.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      count: (data || []).length,
      withdrawals: data || [],
    });
  } catch (err) {
    console.error('List withdrawals error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

module.exports = router;
