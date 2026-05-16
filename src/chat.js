const express = require('express');
const router = express.Router({ mergeParams: true });
const supabase = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');

// --------------------------------------------------------
// GET /api/rooms/:roomId/chat
// Get chat messages for a room
// --------------------------------------------------------
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;

    // Check room exists
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('id, is_public, invite_token')
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Fetch last 100 messages
    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      console.error('Fetch messages error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch messages' });
    }

    return res.status(200).json({
      room_id: roomId,
      count: messages.length,
      messages,
    });

  } catch (err) {
    console.error('Get chat error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/chat
// Send a chat message
// --------------------------------------------------------
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { content, type, guest_name } = req.body || {};
    const userId = req.auth?.userId || null;

    // Validate content
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    if (content.trim().length > 500) {
      return res.status(400).json({ 
        error: 'Message too long. Maximum 500 characters.' 
      });
    }

    // Validate type
    const messageType = type || 'message';
    if (!['message', 'reaction'].includes(messageType)) {
      return res.status(400).json({ 
        error: 'Invalid message type. Must be message or reaction.' 
      });
    }

    // Check room exists and is active
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('id, status')
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (room.status === 'ended') {
      return res.status(410).json({ error: 'This room has ended' });
    }

    // Get sender name
    let senderName = guest_name || 'Guest';
    if (userId) {
      const { data: user } = await supabase
        .from('users')
        .select('display_name')
        .eq('id', userId)
        .single();
      if (user) senderName = user.display_name;
    }

    // Rate limiting — check last message time
    if (userId) {
      const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
      const { count } = await supabase
        .from('chat_messages')
        .select('*', { count: 'exact', head: true })
        .eq('room_id', roomId)
        .eq('sender_id', userId)
        .gte('created_at', oneSecondAgo);

      if (count > 0) {
        return res.status(429).json({ 
          error: 'slow_down',
          message: 'You are sending messages too fast. Slow down!' 
        });
      }
    }

    // Save message
    const { data: message, error: messageError } = await supabase
      .from('chat_messages')
      .insert({
        room_id: roomId,
        sender_id: userId,
        sender_name: senderName,
        content: content.trim(),
        type: messageType,
      })
      .select()
      .single();

    if (messageError) {
      console.error('Save message error:', messageError.message);
      return res.status(500).json({ error: 'Failed to send message' });
    }

    console.log(`💬 Message sent in room ${roomId} by ${senderName}`);

    return res.status(201).json({ message });

  } catch (err) {
    console.error('Send message error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// DELETE /api/rooms/:roomId/chat/:messageId
// Delete a message — only sender or host can delete
// --------------------------------------------------------
router.delete('/:messageId', requireAuth, async (req, res) => {
  try {
    const { roomId, messageId } = req.params;
    const { userId } = req.auth;

    // Get the message
    const { data: message, error: messageError } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('id', messageId)
      .eq('room_id', roomId)
      .single();

    if (messageError || !message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check if user is sender or host
    const { data: room } = await supabase
      .from('rooms')
      .select('host_id')
      .eq('id', roomId)
      .single();

    const isSender = message.sender_id === userId;
    const isHost = room?.host_id === userId;

    if (!isSender && !isHost) {
      return res.status(403).json({ 
        error: 'Only the sender or host can delete this message' 
      });
    }

    await supabase
      .from('chat_messages')
      .delete()
      .eq('id', messageId);

    console.log(`🗑️ Message ${messageId} deleted in room ${roomId}`);

    return res.status(200).json({ message: 'Message deleted successfully' });

  } catch (err) {
    console.error('Delete message error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;