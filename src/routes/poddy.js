const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// POST /api/poddy/request/:userId — send a poddy request
router.post('/request/:userId', requireAuth, async (req, res) => {
  try {
    const requesterId = req.auth.userId;
    const receiverId = req.params.userId;

    if (requesterId === receiverId) {
      return res.status(400).json({ error: 'You cannot add yourself to your Poddy' });
    }

    // Check receiver exists
    const { data: receiver } = await supabase
      .from('users')
      .select('id')
      .eq('id', receiverId)
      .single();

    if (!receiver) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if relationship already exists in either direction
    const { data: existing } = await supabase
      .from('poddy_relationships')
      .select('id, status')
      .or(`and(requester_id.eq.${requesterId},receiver_id.eq.${receiverId}),and(requester_id.eq.${receiverId},receiver_id.eq.${requesterId})`)
      .single();

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({ error: 'This person is already in your Poddy' });
      }
      if (existing.status === 'pending') {
        return res.status(400).json({ error: 'A Poddy request already exists' });
      }
    }

    // Check requester poddy count (max 20)
    const { count: requesterCount } = await supabase
      .from('poddy_relationships')
      .select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${requesterId},receiver_id.eq.${requesterId}`)
      .eq('status', 'accepted');

    if (requesterCount >= 20) {
      return res.status(400).json({ error: 'Your Poddy is full — remove someone to make room' });
    }

    await supabase
      .from('poddy_relationships')
      .insert({ requester_id: requesterId, receiver_id: receiverId, status: 'pending' });

    return res.status(201).json({ message: 'Poddy request sent' });

  } catch (err) {
    console.error('Poddy request error:', err.message);
    return res.status(500).json({ error: 'Failed to send Poddy request' });
  }
});

// POST /api/poddy/accept/:requesterId — accept a poddy request
router.post('/accept/:requesterId', requireAuth, async (req, res) => {
  try {
    const receiverId = req.auth.userId;
    const requesterId = req.params.requesterId;

    // Check receiver poddy count (max 20)
    const { count: receiverCount } = await supabase
      .from('poddy_relationships')
      .select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${receiverId},receiver_id.eq.${receiverId}`)
      .eq('status', 'accepted');

    if (receiverCount >= 20) {
      return res.status(400).json({ error: 'Your Poddy is full — remove someone to make room' });
    }

    const { data, error } = await supabase
      .from('poddy_relationships')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('requester_id', requesterId)
      .eq('receiver_id', receiverId)
      .eq('status', 'pending')
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Poddy request not found' });
    }

    return res.status(200).json({ message: 'Poddy request accepted' });

  } catch (err) {
    console.error('Poddy accept error:', err.message);
    return res.status(500).json({ error: 'Failed to accept Poddy request' });
  }
});

// POST /api/poddy/decline/:requesterId — decline a poddy request
router.post('/decline/:requesterId', requireAuth, async (req, res) => {
  try {
    const receiverId = req.auth.userId;
    const requesterId = req.params.requesterId;

    await supabase
      .from('poddy_relationships')
      .update({ status: 'declined', updated_at: new Date().toISOString() })
      .eq('requester_id', requesterId)
      .eq('receiver_id', receiverId)
      .eq('status', 'pending');

    return res.status(200).json({ message: 'Poddy request declined' });

  } catch (err) {
    console.error('Poddy decline error:', err.message);
    return res.status(500).json({ error: 'Failed to decline Poddy request' });
  }
});

// DELETE /api/poddy/:userId — remove someone from your poddy
router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const targetId = req.params.userId;

    await supabase
      .from('poddy_relationships')
      .delete()
      .or(`and(requester_id.eq.${userId},receiver_id.eq.${targetId}),and(requester_id.eq.${targetId},receiver_id.eq.${userId})`)
      .eq('status', 'accepted');

    return res.status(200).json({ message: 'Removed from Poddy' });

  } catch (err) {
    console.error('Poddy remove error:', err.message);
    return res.status(500).json({ error: 'Failed to remove from Poddy' });
  }
});

// GET /api/poddy — get my poddy list
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data, error } = await supabase
      .from('poddy_relationships')
      .select(`
        id,
        requester_id,
        receiver_id,
        created_at,
        requester:users!poddy_relationships_requester_id_fkey (id, display_name, avatar_url),
        receiver:users!poddy_relationships_receiver_id_fkey (id, display_name, avatar_url)
      `)
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      .eq('status', 'accepted');

    if (error) throw error;

    const poddy = data.map(row => {
      const friend = row.requester_id === userId ? row.receiver : row.requester;
      return {
        user_id: friend.id,
        display_name: friend.display_name,
        avatar_url: friend.avatar_url,
        connected_since: row.created_at,
      };
    });

    return res.status(200).json({ count: poddy.length, poddy });

  } catch (err) {
    console.error('Poddy list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Poddy list' });
  }
});

// GET /api/poddy/requests — get incoming pending poddy requests
router.get('/requests', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data, error } = await supabase
      .from('poddy_relationships')
      .select(`
        id,
        requester_id,
        created_at,
        requester:users!poddy_relationships_requester_id_fkey (id, display_name, avatar_url)
      `)
      .eq('receiver_id', userId)
      .eq('status', 'pending');

    if (error) throw error;

    const requests = data.map(row => ({
      request_id: row.id,
      user_id: row.requester_id,
      display_name: row.requester.display_name,
      avatar_url: row.requester.avatar_url,
      requested_at: row.created_at,
    }));

    return res.status(200).json({ count: requests.length, requests });

  } catch (err) {
    console.error('Poddy requests error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Poddy requests' });
  }
});

module.exports = router;
