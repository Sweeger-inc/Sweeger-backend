const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// Helper — send notification to a user
const createNotification = async (userId, type, title, body, data = {}) => {
  await supabase
    .from('notifications')
    .insert({ user_id: userId, type, title, body, data });
};

// Helper — notify all poddy friends that a user joined a room
const notifyPoddyFriends = async (userId, displayName, roomId, roomName) => {
  // Get all accepted poddy relationships for this user
  const { data: relationships } = await supabase
    .from('poddy_relationships')
    .select('requester_id, receiver_id')
    .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
    .eq('status', 'accepted');

  if (!relationships || relationships.length === 0) return;

  // Get the friend IDs
  const friendIds = relationships.map(r =>
    r.requester_id === userId ? r.receiver_id : r.requester_id
  );

  // Create a notification for each friend
  const notifications = friendIds.map(friendId => ({
    user_id: friendId,
    type: 'poddy_live',
    title: `${displayName} is watching now 👀`,
    body: `Your friend ${displayName} just joined "${roomName}". Tap to watch together.`,
    data: { room_id: roomId, room_name: roomName, triggered_by: userId },
    is_read: false,
  }));

  if (notifications.length > 0) {
    await supabase.from('notifications').insert(notifications);
  }
};

// GET /api/notifications — get current user's notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { limit = 20, offset = 0 } = req.query;

    const { data, error, count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw error;

    return res.status(200).json({
      total: count,
      unread: data.filter(n => !n.is_read).length,
      notifications: data,
    });

  } catch (err) {
    console.error('Get notifications error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// PATCH /api/notifications/:id/read — mark a notification as read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { id } = req.params;

    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId);

    return res.status(200).json({ message: 'Notification marked as read' });

  } catch (err) {
    console.error('Mark read error:', err.message);
    return res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// PATCH /api/notifications/read-all — mark all notifications as read
router.patch('/read-all', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    return res.status(200).json({ message: 'All notifications marked as read' });

  } catch (err) {
    console.error('Mark all read error:', err.message);
    return res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// DELETE /api/notifications/:id — delete a notification
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { id } = req.params;

    await supabase
      .from('notifications')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    return res.status(200).json({ message: 'Notification deleted' });

  } catch (err) {
    console.error('Delete notification error:', err.message);
    return res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// POST /api/notifications/poddy-live — fired when a user joins a room
// This is called internally from the rooms join endpoint
router.post('/poddy-live', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { room_id, room_name } = req.body;

    if (!room_id || !room_name) {
      return res.status(400).json({ error: 'room_id and room_name are required' });
    }

    // Get user's display name
    const { data: user } = await supabase
      .from('users')
      .select('display_name')
      .eq('id', userId)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await notifyPoddyFriends(userId, user.display_name, room_id, room_name);

    return res.status(200).json({ message: 'Poddy friends notified' });

  } catch (err) {
    console.error('Poddy live notification error:', err.message);
    return res.status(500).json({ error: 'Failed to notify poddy friends' });
  }
});

module.exports = { router, notifyPoddyFriends };
