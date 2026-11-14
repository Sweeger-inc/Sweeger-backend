const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// POST /api/follows/:userId — follow a user
router.post('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;
    const followerId = req.auth.userId;

    if (followerId === targetUserId) {
      return res.status(400).json({ error: 'You cannot follow yourself' });
    }

    // Check target user exists
    const { data: targetUser, error: targetUserError } = await supabase
      .from('users')
      .select('id')
      .eq('id', targetUserId)
      .maybeSingle();

    if (targetUserError) {
      console.error('Check user error:', targetUserError.message);
      return res.status(500).json({ error: 'Failed to verify user' });
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check already following
    const { data: existing, error: existingError } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', followerId)
      .eq('following_id', targetUserId)
      .maybeSingle();

    if (existingError) {
      console.error('Check follow status error:', existingError.message);
      return res.status(500).json({ error: 'Failed to check follow status' });
    }

    if (existing) {
      return res.status(400).json({ error: 'You are already following this user' });
    }

    const { error: insertError } = await supabase
      .from('follows')
      .insert({ follower_id: followerId, following_id: targetUserId });

    if (insertError) {
      if (insertError.code === '23505') {
        return res.status(400).json({ error: 'You are already following this user' });
      }
      console.error('Follow error:', insertError.message);
      return res.status(500).json({ error: 'Failed to follow user' });
    }

    return res.status(201).json({ message: 'Followed successfully' });

  } catch (err) {
    console.error('Follow error:', err.message);
    return res.status(500).json({ error: 'Failed to follow user' });
  }
});

// DELETE /api/follows/:userId — unfollow a user
router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;
    const followerId = req.auth.userId;

    const { error: deleteError } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', followerId)
      .eq('following_id', targetUserId);

    if (deleteError) {
      console.error('Unfollow error:', deleteError.message);
      return res.status(500).json({ error: 'Failed to unfollow user' });
    }

    return res.status(200).json({ message: 'Unfollowed successfully' });

  } catch (err) {
    console.error('Unfollow error:', err.message);
    return res.status(500).json({ error: 'Failed to unfollow user' });
  }
});

// GET /api/follows/following — get list of people I follow
router.get('/following', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data, error } = await supabase
      .from('follows')
      .select(`
        following_id,
        created_at,
        users!follows_following_id_fkey (
          id,
          display_name,
          avatar_url
        )
      `)
      .eq('follower_id', userId);

    if (error) throw error;

    const following = (data || []).map(row => ({
      user_id: row.following_id,
      display_name: row.users?.display_name || 'User',
      avatar_url: row.users?.avatar_url || null,
      followed_at: row.created_at,
    }));

    return res.status(200).json({ count: following.length, following });

  } catch (err) {
    console.error('Following list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch following list' });
  }
});

// GET /api/follows/followers — get list of people following me
router.get('/followers', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data, error } = await supabase
      .from('follows')
      .select(`
        follower_id,
        created_at,
        users!follows_follower_id_fkey (
          id,
          display_name,
          avatar_url
        )
      `)
      .eq('following_id', userId);

    if (error) throw error;

    const followers = (data || []).map(row => ({
      user_id: row.follower_id,
      display_name: row.users?.display_name || 'User',
      avatar_url: row.users?.avatar_url || null,
      followed_at: row.created_at,
    }));

    return res.status(200).json({ count: followers.length, followers });

  } catch (err) {
    console.error('Followers list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch followers list' });
  }
});

// GET /api/follows/:userId/status — check if I follow a specific user
router.get('/:userId/status', requireAuth, async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;
    const followerId = req.auth.userId;

    const { data, error } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', followerId)
      .eq('following_id', targetUserId)
      .maybeSingle();

    if (error) {
      console.error('Follow status error:', error.message);
      return res.status(500).json({ error: 'Failed to check follow status' });
    }

    return res.status(200).json({ is_following: !!data });

  } catch (err) {
    console.error('Follow status error:', err.message);
    return res.status(500).json({ error: 'Failed to check follow status' });
  }
});

module.exports = router;
