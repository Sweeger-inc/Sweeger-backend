const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const walletService = require('../services/wallet');

const requireAdmin = (req, res, next) => {
  const adminIds = (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV === 'development' && adminIds.length === 0) {
    return next();
  }
  if (!adminIds.includes(req.auth.userId)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// --------------------------------------------------------
// GET /api/admin/distributors — review queue for distributor listings
// --------------------------------------------------------
router.get('/distributors', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status = 'under_review' } = req.query;
    const { data, error } = await supabase
      .from('cinema_community_posts')
      .select('*')
      .eq('post_type', 'distributor')
      .eq('review_status', status)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.status(200).json({ count: (data || []).length, listings: data || [] });
  } catch (err) {
    console.error('Admin distributors list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch distributor review queue' });
  }
});

// --------------------------------------------------------
// POST /api/admin/distributors/:id/review — approve or decline distributor content
// --------------------------------------------------------
router.post('/distributors/:id/review', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { decision, note } = req.body || {};

    if (!['approved', 'declined'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approved or declined' });
    }

    const { data: post, error } = await supabase
      .from('cinema_community_posts')
      .update({
        review_status: decision,
        review_note: note || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: req.auth.userId,
      })
      .eq('id', id)
      .eq('post_type', 'distributor')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!post) return res.status(404).json({ error: 'Distributor listing not found' });

    await supabase.from('notifications').insert({
      user_id: post.creator_id,
      type: 'distributor_review_decision',
      title:
        decision === 'approved'
          ? 'Your Cinema distributor listing was approved'
          : 'Your Cinema distributor listing was declined',
      body:
        decision === 'approved'
          ? `"${post.title}" is approved! You can now upload your thumbnail and video to go live.`
          : `"${post.title}" was declined.${note ? ` Note: ${note}` : ''}`,
      data: { listing_id: post.id, decision },
      is_read: false,
    });

    return res.status(200).json({ message: `Listing ${decision}`, listing: post });
  } catch (err) {
    console.error('Admin review distributor error:', err.message);
    return res.status(500).json({ error: 'Failed to review distributor listing' });
  }
});

// --------------------------------------------------------
// GET /api/admin/withdrawals — payout queue
// --------------------------------------------------------
router.get('/withdrawals', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase
      .from('withdrawal_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({ count: (data || []).length, withdrawals: data || [] });
  } catch (err) {
    console.error('Admin withdrawals list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// --------------------------------------------------------
// PATCH /api/admin/withdrawals/:id — mark Paid or Declined (refunds creator balance on decline)
// --------------------------------------------------------
router.patch('/withdrawals/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, payout_reference, note } = req.body || {};

    if (!['approved', 'paid', 'declined'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved, paid, or declined' });
    }

    const { data: existing } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ error: 'Withdrawal request not found' });
    if (existing.status === 'paid' || existing.status === 'declined') {
      return res.status(400).json({ error: `Withdrawal is already ${existing.status}` });
    }

    if (status === 'declined') {
      const wallet = await walletService.ensureWallet(existing.user_id);
      const restored = Number(wallet.creator_balance_ngn || 0) + Number(existing.amount_ngn);
      await supabase
        .from('wallets')
        .update({ creator_balance_ngn: restored, updated_at: new Date().toISOString() })
        .eq('user_id', existing.user_id);
    }

    const { data: updated, error } = await supabase
      .from('withdrawal_requests')
      .update({
        status,
        payout_reference: payout_reference || null,
        note: note || existing.note,
        processed_at: new Date().toISOString(),
        processed_by: req.auth.userId,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await supabase.from('notifications').insert({
      user_id: existing.user_id,
      type: 'withdrawal_status_changed',
      title: `Withdrawal status updated: ${status}`,
      body:
        status === 'paid'
          ? `Your withdrawal of ₦${existing.amount_ngn} has been disbursed.`
          : `Your withdrawal request of ₦${existing.amount_ngn} is now ${status}.`,
      data: { withdrawal_id: id, status },
      is_read: false,
    });

    return res.status(200).json({ message: `Withdrawal marked ${status}`, withdrawal: updated });
  } catch (err) {
    console.error('Admin update withdrawal error:', err.message);
    return res.status(500).json({ error: 'Failed to update withdrawal' });
  }
});

module.exports = router;
