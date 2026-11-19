const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// --------------------------------------------------------
// GET /api/users/search?q=username — search users by username or display name
// --------------------------------------------------------
router.get('/search', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.status(200).json({ count: 0, users: [] });

    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, display_name, avatar_url')
      .neq('id', userId)
      .limit(50);

    if (error) throw error;

    const matched = (users || [])
      .filter(
        (u) =>
          (u.username && u.username.toLowerCase().includes(q)) ||
          (u.display_name && u.display_name.toLowerCase().includes(q))
      )
      .slice(0, 20);

    return res.status(200).json({
      count: matched.length,
      users: matched.map((u) => ({
        user_id: u.id,
        username: u.username || null,
        display_name: u.display_name || 'User',
        avatar_url: u.avatar_url || null,
      })),
    });
  } catch (err) {
    console.error('User search error:', err.message);
    return res.status(500).json({ error: 'Failed to search users' });
  }
});

// --------------------------------------------------------
// GET /api/users/muted — persistent "mute for me" list across rooms
// --------------------------------------------------------
router.get('/muted', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { data, error } = await supabase
      .from('user_mutes')
      .select('muted_user_id, created_at')
      .eq('user_id', userId);

    if (error) throw error;
    return res.status(200).json({
      muted_user_ids: (data || []).map((m) => m.muted_user_id),
      mutes: data || [],
    });
  } catch (err) {
    console.error('Get mutes error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch muted users' });
  }
});

// POST /api/users/:targetUserId/mute — mute user for me (persists across rooms)
router.post('/:targetUserId/mute', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { targetUserId } = req.params;

    if (userId === targetUserId) {
      return res.status(400).json({ error: 'Cannot mute yourself' });
    }

    await supabase.from('user_mutes').upsert(
      {
        user_id: userId,
        muted_user_id: targetUserId,
      },
      { onConflict: 'user_id,muted_user_id' }
    );

    return res.status(200).json({ message: 'Muted user for you across all rooms', muted_user_id: targetUserId });
  } catch (err) {
    console.error('Mute user error:', err.message);
    return res.status(500).json({ error: 'Failed to mute user' });
  }
});

// DELETE /api/users/:targetUserId/mute — unmute user for me
router.delete('/:targetUserId/mute', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { targetUserId } = req.params;

    await supabase
      .from('user_mutes')
      .delete()
      .eq('user_id', userId)
      .eq('muted_user_id', targetUserId);

    return res.status(200).json({ message: 'Unmuted user', muted_user_id: targetUserId });
  } catch (err) {
    console.error('Unmute user error:', err.message);
    return res.status(500).json({ error: 'Failed to unmute user' });
  }
});

// --------------------------------------------------------
// Block & Report (PRD v7 §5 Free forever & §11 Moderation)
// --------------------------------------------------------
router.get('/blocked', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { data, error } = await supabase
      .from('user_blocks')
      .select('blocked_user_id, created_at')
      .eq('user_id', userId);
    if (error) throw error;
    return res.status(200).json({ blocked_user_ids: (data || []).map((b) => b.blocked_user_id) });
  } catch (err) {
    console.error('Get blocked error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch blocked users' });
  }
});

router.post('/:targetUserId/block', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { targetUserId } = req.params;

    if (userId === targetUserId) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    await supabase.from('user_blocks').upsert(
      { user_id: userId, blocked_user_id: targetUserId },
      { onConflict: 'user_id,blocked_user_id' }
    );

    return res.status(200).json({ message: 'User blocked', blocked_user_id: targetUserId });
  } catch (err) {
    console.error('Block user error:', err.message);
    return res.status(500).json({ error: 'Failed to block user' });
  }
});

router.delete('/:targetUserId/block', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { targetUserId } = req.params;

    await supabase
      .from('user_blocks')
      .delete()
      .eq('user_id', userId)
      .eq('blocked_user_id', targetUserId);

    return res.status(200).json({ message: 'User unblocked', blocked_user_id: targetUserId });
  } catch (err) {
    console.error('Unblock user error:', err.message);
    return res.status(500).json({ error: 'Failed to unblock user' });
  }
});

router.post('/report', requireAuth, async (req, res) => {
  try {
    const reporterId = req.auth.userId;
    const { target_user_id, room_id, show_id, reason, details } = req.body || {};

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const { data: report, error } = await supabase
      .from('moderation_reports')
      .insert({
        reporter_id: reporterId,
        target_user_id: target_user_id || null,
        room_id: room_id || null,
        show_id: show_id || null,
        reason: String(reason).trim(),
        details: details ? String(details).trim() : null,
        status: 'open',
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      message: 'Report submitted for review',
      report,
    });
  } catch (err) {
    console.error('Report error:', err.message);
    return res.status(500).json({ error: 'Failed to submit report' });
  }
});

// POST /api/users/email-unsubscribe — PRD v7 §13.8 email opt-out
router.post('/email-unsubscribe', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { unsubscribed = true } = req.body || {};

    await supabase
      .from('users')
      .update({ email_unsubscribed: Boolean(unsubscribed) })
      .eq('id', userId);

    return res.status(200).json({
      message: unsubscribed ? 'Unsubscribed from match emails' : 'Resubscribed to emails',
      email_unsubscribed: Boolean(unsubscribed),
    });
  } catch (err) {
    console.error('Email unsubscribe error:', err.message);
    return res.status(500).json({ error: 'Failed to update email preferences' });
  }
});

module.exports = router;
