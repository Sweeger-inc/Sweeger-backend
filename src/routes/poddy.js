const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// In-process async lock to serialize operations involving specific user pairs
// and prevent concurrent acceptance races.
class AsyncKeyLock {
  constructor() {
    this.activeLocks = new Map();
  }

  async acquire(keys) {
    const sorted = [...new Set(keys)].sort();
    while (true) {
      const waitPromises = [];
      for (const k of sorted) {
        if (this.activeLocks.has(k)) {
          waitPromises.push(this.activeLocks.get(k));
        }
      }

      if (waitPromises.length === 0) {
        let releaseFn;
        const lockPromise = new Promise((resolve) => {
          releaseFn = resolve;
        });
        for (const k of sorted) {
          this.activeLocks.set(k, lockPromise);
        }
        return () => {
          for (const k of sorted) {
            this.activeLocks.delete(k);
          }
          releaseFn();
        };
      }

      await Promise.race(waitPromises);
    }
  }
}

const poddyLock = new AsyncKeyLock();

// POST /api/poddy/request/:userId — send a poddy request
router.post('/request/:userId', requireAuth, async (req, res) => {
  const requesterId = req.auth.userId;
  const receiverId = req.params.userId;

  if (requesterId === receiverId) {
    return res.status(400).json({ error: 'You cannot add yourself to your Poddy' });
  }

  const release = await poddyLock.acquire([requesterId, receiverId]);
  try {
    // Check receiver exists
    const { data: receiver, error: receiverError } = await supabase
      .from('users')
      .select('id')
      .eq('id', receiverId)
      .maybeSingle();

    if (receiverError) {
      console.error('Check receiver error:', receiverError.message);
      return res.status(500).json({ error: 'Failed to verify user' });
    }

    if (!receiver) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check requester poddy count (max 20)
    const { count: requesterCount, error: reqCountError } = await supabase
      .from('poddy_relationships')
      .select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${requesterId},receiver_id.eq.${requesterId}`)
      .eq('status', 'accepted');

    if (reqCountError) {
      console.error('Check requester capacity error:', reqCountError.message);
      return res.status(500).json({ error: 'Failed to check Poddy capacity' });
    }

    if (requesterCount >= 20) {
      return res.status(400).json({ error: 'Your Poddy is full — remove someone to make room' });
    }

    // Check receiver poddy count (max 20)
    const { count: receiverCount, error: recCountError } = await supabase
      .from('poddy_relationships')
      .select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${receiverId},receiver_id.eq.${receiverId}`)
      .eq('status', 'accepted');

    if (recCountError) {
      console.error('Check receiver capacity error:', recCountError.message);
      return res.status(500).json({ error: 'Failed to check Poddy capacity' });
    }

    if (receiverCount >= 20) {
      return res.status(400).json({ error: "This user's Poddy is full" });
    }

    // Check if relationship already exists in either direction
    const { data: existing, error: existingError } = await supabase
      .from('poddy_relationships')
      .select('id, status, requester_id, receiver_id')
      .or(`and(requester_id.eq.${requesterId},receiver_id.eq.${receiverId}),and(requester_id.eq.${receiverId},receiver_id.eq.${requesterId})`)
      .maybeSingle();

    if (existingError) {
      console.error('Check existing relationship error:', existingError.message);
      return res.status(500).json({ error: 'Failed to check existing relationship' });
    }

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({ error: 'This person is already in your Poddy' });
      }
      if (existing.status === 'pending') {
        if (existing.requester_id === requesterId) {
          return res.status(400).json({ error: 'A Poddy request already exists' });
        } else {
          return res.status(400).json({ error: 'This user has already sent you a Poddy request. Please accept it instead.' });
        }
      }
      if (existing.status === 'declined') {
        // Reuse and update the declined row explicitly
        const { error: updateError } = await supabase
          .from('poddy_relationships')
          .update({
            requester_id: requesterId,
            receiver_id: receiverId,
            status: 'pending',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        if (updateError) {
          console.error('Poddy request update error:', updateError.message);
          return res.status(500).json({ error: 'Failed to send Poddy request' });
        }

        return res.status(201).json({ message: 'Poddy request sent' });
      }
    }

    // Create new relationship
    const { error: insertError } = await supabase
      .from('poddy_relationships')
      .insert({
        requester_id: requesterId,
        receiver_id: receiverId,
        status: 'pending',
      });

    if (insertError) {
      console.error('Poddy request insert error:', insertError.message);
      return res.status(500).json({ error: 'Failed to send Poddy request' });
    }

    return res.status(201).json({ message: 'Poddy request sent' });

  } catch (err) {
    console.error('Poddy request error:', err.message);
    return res.status(500).json({ error: 'Failed to send Poddy request' });
  } finally {
    release();
  }
});

// POST /api/poddy/accept/:requesterId — accept a poddy request
router.post('/accept/:requesterId', requireAuth, async (req, res) => {
  const receiverId = req.auth.userId;
  const requesterId = req.params.requesterId;

  if (receiverId === requesterId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  // Acquire atomic lock for both users to prevent concurrent acceptance exceeding capacity
  const release = await poddyLock.acquire([requesterId, receiverId]);
  try {
    // 1. Fetch pending request
    const { data: request, error: requestError } = await supabase
      .from('poddy_relationships')
      .select('id, status')
      .eq('requester_id', requesterId)
      .eq('receiver_id', receiverId)
      .eq('status', 'pending')
      .maybeSingle();

    if (requestError) {
      console.error('Verify pending request error:', requestError.message);
      return res.status(500).json({ error: 'Failed to verify request' });
    }

    if (!request) {
      return res.status(404).json({ error: 'Poddy request not found' });
    }

    // 2. Check receiver capacity (max 20)
    const { count: receiverCount, error: recCountError } = await supabase
      .from('poddy_relationships')
      .select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${receiverId},receiver_id.eq.${receiverId}`)
      .eq('status', 'accepted');

    if (recCountError) {
      console.error('Check receiver capacity error:', recCountError.message);
      return res.status(500).json({ error: 'Failed to check Poddy capacity' });
    }

    if (receiverCount >= 20) {
      return res.status(400).json({ error: 'Your Poddy is full — remove someone to make room' });
    }

    // 3. Check requester capacity (max 20)
    const { count: requesterCount, error: reqCountError } = await supabase
      .from('poddy_relationships')
      .select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${requesterId},receiver_id.eq.${requesterId}`)
      .eq('status', 'accepted');

    if (reqCountError) {
      console.error('Check requester capacity error:', reqCountError.message);
      return res.status(500).json({ error: 'Failed to check Poddy capacity' });
    }

    if (requesterCount >= 20) {
      return res.status(400).json({ error: "The requester's Poddy is full" });
    }

    // 4. Update status atomically
    const { data, error } = await supabase
      .from('poddy_relationships')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', request.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (error) {
      console.error('Poddy accept error:', error.message);
      return res.status(500).json({ error: 'Failed to accept Poddy request' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Poddy request not found' });
    }

    // 5. Verification against race conditions
    const { count: postRecCount } = await supabase
      .from('poddy_relationships')
      .select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${receiverId},receiver_id.eq.${receiverId}`)
      .eq('status', 'accepted');

    const { count: postReqCount } = await supabase
      .from('poddy_relationships')
      .select('*', { count: 'exact', head: true })
      .or(`requester_id.eq.${requesterId},receiver_id.eq.${requesterId}`)
      .eq('status', 'accepted');

    if ((postRecCount && postRecCount > 20) || (postReqCount && postReqCount > 20)) {
      // Rollback to pending
      await supabase
        .from('poddy_relationships')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', request.id);
      return res.status(400).json({ error: 'Poddy capacity exceeded' });
    }

    return res.status(200).json({ message: 'Poddy request accepted' });

  } catch (err) {
    console.error('Poddy accept error:', err.message);
    return res.status(500).json({ error: 'Failed to accept Poddy request' });
  } finally {
    release();
  }
});

// POST /api/poddy/decline/:requesterId — decline a poddy request
router.post('/decline/:requesterId', requireAuth, async (req, res) => {
  try {
    const receiverId = req.auth.userId;
    const requesterId = req.params.requesterId;

    const { data, error } = await supabase
      .from('poddy_relationships')
      .update({ status: 'declined', updated_at: new Date().toISOString() })
      .eq('requester_id', requesterId)
      .eq('receiver_id', receiverId)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (error) {
      console.error('Poddy decline error:', error.message);
      return res.status(500).json({ error: 'Failed to decline Poddy request' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Poddy request not found' });
    }

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

    const { data, error } = await supabase
      .from('poddy_relationships')
      .delete()
      .or(`and(requester_id.eq.${userId},receiver_id.eq.${targetId}),and(requester_id.eq.${targetId},receiver_id.eq.${userId})`)
      .eq('status', 'accepted')
      .select();

    if (error) {
      console.error('Poddy remove error:', error.message);
      return res.status(500).json({ error: 'Failed to remove from Poddy' });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Poddy member not found' });
    }

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

    const poddy = (data || []).map(row => {
      const friend = row.requester_id === userId ? row.receiver : row.requester;
      return {
        user_id: friend?.id || (row.requester_id === userId ? row.receiver_id : row.requester_id),
        display_name: friend?.display_name || 'User',
        avatar_url: friend?.avatar_url || null,
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
        updated_at,
        requester:users!poddy_relationships_requester_id_fkey (id, display_name, avatar_url)
      `)
      .eq('receiver_id', userId)
      .eq('status', 'pending');

    if (error) throw error;

    const requests = (data || []).map(row => ({
      request_id: row.id,
      user_id: row.requester_id,
      display_name: row.requester?.display_name || 'User',
      avatar_url: row.requester?.avatar_url || null,
      requested_at: row.created_at,
    }));

    return res.status(200).json({ count: requests.length, requests });

  } catch (err) {
    console.error('Poddy requests error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Poddy requests' });
  }
});

module.exports = router;
