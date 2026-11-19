const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { isUserPremium } = require('./subscriptions');

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

const ALLOWED_PRIVACY = ['open', 'followers_only', 'private'];

async function getAcceptedPoddyCount(userId) {
  const { count, error } = await supabase
    .from('poddy_relationships')
    .select('*', { count: 'exact', head: true })
    .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
    .eq('status', 'accepted');
  if (error) throw error;
  return count || 0;
}

// --------------------------------------------------------
// GET /api/poddy/search?q=username — inline Poddy user search
// --------------------------------------------------------
router.get('/search', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.status(200).json({ count: 0, results: [] });
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, display_name, avatar_url')
      .neq('id', userId)
      .limit(50);

    if (error) throw error;

    const lower = q.toLowerCase();
    const matched = (users || []).filter(
      (u) =>
        (u.username && u.username.toLowerCase().includes(lower)) ||
        (u.display_name && u.display_name.toLowerCase().includes(lower))
    ).slice(0, 20);

    const [{ data: follows }, { data: rels }] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', userId),
      supabase
        .from('poddy_relationships')
        .select('requester_id, receiver_id, status')
        .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`),
    ]);

    const followingSet = new Set((follows || []).map((f) => f.following_id));
    const poddyMap = new Map();
    for (const r of rels || []) {
      const other = r.requester_id === userId ? r.receiver_id : r.requester_id;
      if (r.status === 'accepted') poddyMap.set(other, 'in_poddy');
      else if (r.status === 'pending') {
        poddyMap.set(other, r.requester_id === userId ? 'requested' : 'incoming_request');
      }
    }

    const results = matched.map((u) => ({
      user_id: u.id,
      username: u.username || null,
      display_name: u.display_name || 'User',
      avatar_url: u.avatar_url || null,
      is_following: followingSet.has(u.id),
      follow_label: followingSet.has(u.id) ? 'Following' : 'Follow',
      poddy_status: poddyMap.get(u.id) || 'none',
      poddy_label:
        poddyMap.get(u.id) === 'in_poddy'
          ? 'In Poddy'
          : poddyMap.get(u.id) === 'requested'
            ? 'Requested'
            : poddyMap.get(u.id) === 'incoming_request'
              ? 'Accept Request'
              : 'Add to Poddy',
    }));

    return res.status(200).json({ count: results.length, results });
  } catch (err) {
    console.error('Poddy search error:', err.message);
    return res.status(500).json({ error: 'Failed to search users' });
  }
});

// --------------------------------------------------------
// GET /api/poddy/invite-link — personal mutual Poddy invite link
// --------------------------------------------------------
router.get('/invite-link', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { data: user } = await supabase
      .from('users')
      .select('id, poddy_invite_code')
      .eq('id', userId)
      .maybeSingle();

    let inviteCode = user?.poddy_invite_code;
    if (!inviteCode) {
      inviteCode = uuidv4().slice(0, 12);
      await supabase
        .from('users')
        .update({ poddy_invite_code: inviteCode })
        .eq('id', userId);
    }

    const baseUrl = process.env.FRONTEND_URL || 'https://sweeger.buzz';
    return res.status(200).json({
      invite_code: inviteCode,
      invite_link: `${baseUrl}/poddy/invite/${inviteCode}`,
    });
  } catch (err) {
    console.error('Poddy invite link error:', err.message);
    return res.status(500).json({ error: 'Failed to generate Poddy invite link' });
  }
});

// --------------------------------------------------------
// POST /api/poddy/invite/:code/accept — instant mutual Poddy add via personal link
// --------------------------------------------------------
router.post('/invite/:code/accept', requireAuth, async (req, res) => {
  const joinerId = req.auth.userId;
  const { code } = req.params;

  try {
    const { data: owner } = await supabase
      .from('users')
      .select('id, display_name')
      .eq('poddy_invite_code', code)
      .maybeSingle();

    if (!owner) {
      return res.status(404).json({ error: 'Invalid Poddy invite link' });
    }
    if (owner.id === joinerId) {
      return res.status(400).json({ error: 'You cannot use your own Poddy invite link' });
    }

    const release = await poddyLock.acquire([owner.id, joinerId]);
    try {
      const [ownerCount, joinerCount] = await Promise.all([
        getAcceptedPoddyCount(owner.id),
        getAcceptedPoddyCount(joinerId),
      ]);

      if (joinerCount >= 20) {
        return res.status(400).json({
          error: 'poddy_full',
          message: `Your Poddy is full, remove someone to add ${owner.display_name || 'this user'}`,
          capacity: 20,
        });
      }
      if (ownerCount >= 20) {
        return res.status(400).json({ error: "This user's Poddy is full" });
      }

      const { data: existing } = await supabase
        .from('poddy_relationships')
        .select('id, status')
        .or(`and(requester_id.eq.${owner.id},receiver_id.eq.${joinerId}),and(requester_id.eq.${joinerId},receiver_id.eq.${owner.id})`)
        .maybeSingle();

      if (existing) {
        if (existing.status === 'accepted') {
          return res.status(200).json({ message: 'Already in Poddy', status: 'accepted' });
        }
        await supabase
          .from('poddy_relationships')
          .update({ status: 'accepted', updated_at: new Date().toISOString() })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('poddy_relationships')
          .insert({
            requester_id: owner.id,
            receiver_id: joinerId,
            status: 'accepted',
          });
      }

      await supabase.from('notifications').insert({
        user_id: owner.id,
        type: 'poddy_accepted',
        title: 'New Poddy member via invite link',
        body: 'Someone joined your Poddy using your personal invite link.',
        data: { user_id: joinerId },
        is_read: false,
      });

      return res.status(200).json({
        message: `You and ${owner.display_name || 'your friend'} are now in each other's Poddy`,
        user_id: owner.id,
      });
    } finally {
      release();
    }
  } catch (err) {
    console.error('Poddy invite accept error:', err.message);
    return res.status(500).json({ error: 'Failed to join Poddy via invite link' });
  }
});

// --------------------------------------------------------
// GET /api/poddy/privacy — get current user's Poddy privacy setting
// --------------------------------------------------------
router.get('/privacy', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { data: user } = await supabase
      .from('users')
      .select('poddy_privacy')
      .eq('id', userId)
      .maybeSingle();

    const premium = await isUserPremium(userId);
    return res.status(200).json({
      privacy: user?.poddy_privacy || 'open',
      is_premium: premium,
      options: [
        { id: 'open', label: 'Open', premium_required: false },
        { id: 'followers_only', label: 'Followers only', premium_required: true },
        { id: 'private', label: 'Private', premium_required: true },
      ],
    });
  } catch (err) {
    console.error('Get Poddy privacy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Poddy privacy' });
  }
});

// --------------------------------------------------------
// PATCH /api/poddy/privacy — Open (free), Followers only / Private (Premium gated)
// --------------------------------------------------------
router.patch('/privacy', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { privacy } = req.body || {};

    if (!ALLOWED_PRIVACY.includes(privacy)) {
      return res.status(400).json({
        error: `Invalid privacy option. Must be one of: ${ALLOWED_PRIVACY.join(', ')}`,
      });
    }

    if (privacy !== 'open') {
      const premium = await isUserPremium(userId);
      if (!premium) {
        return res.status(403).json({
          error: 'premium_required',
          message: 'Subscribe ₦200 to join this league',
        });
      }
    }

    const { error } = await supabase
      .from('users')
      .update({ poddy_privacy: privacy, updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) throw error;

    return res.status(200).json({
      message: 'Poddy privacy updated',
      privacy,
    });
  } catch (err) {
    console.error('Update Poddy privacy error:', err.message);
    return res.status(500).json({ error: 'Failed to update Poddy privacy' });
  }
});

// --------------------------------------------------------
// GET /api/poddy/streaks — consecutive days two Poddy members watched together
// --------------------------------------------------------
router.get('/streaks', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { data, error } = await supabase
      .from('poddy_streaks')
      .select('*')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .order('streak_days', { ascending: false });

    if (error) throw error;

    const friendIds = (data || []).map((s) => (s.user_a === userId ? s.user_b : s.user_a));
    let userMap = new Map();
    if (friendIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, display_name, avatar_url')
        .in('id', friendIds);
      for (const u of users || []) userMap.set(u.id, u);
    }

    const streaks = (data || []).map((s) => {
      const friendId = s.user_a === userId ? s.user_b : s.user_a;
      const friend = userMap.get(friendId);
      return {
        friend_id: friendId,
        display_name: friend?.display_name || 'Friend',
        avatar_url: friend?.avatar_url || null,
        streak_days: s.streak_days || 0,
        last_watched_date: s.last_watched_date,
      };
    });

    return res.status(200).json({ count: streaks.length, streaks });
  } catch (err) {
    console.error('Get Poddy streaks error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Poddy streaks' });
  }
});

// --------------------------------------------------------
// POST /api/poddy/request/:userId — send a poddy request
// --------------------------------------------------------
router.post('/request/:userId', requireAuth, async (req, res) => {
  const requesterId = req.auth.userId;
  const receiverId = req.params.userId;

  if (requesterId === receiverId) {
    return res.status(400).json({ error: 'You cannot add yourself to your Poddy' });
  }

  const release = await poddyLock.acquire([requesterId, receiverId]);
  try {
    const { data: receiver, error: receiverError } = await supabase
      .from('users')
      .select('id, display_name, poddy_privacy')
      .eq('id', receiverId)
      .maybeSingle();

    if (receiverError) {
      console.error('Check receiver error:', receiverError.message);
      return res.status(500).json({ error: 'Failed to verify user' });
    }

    if (!receiver) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Enforce receiver's Poddy privacy setting
    if (receiver.poddy_privacy === 'private') {
      return res.status(403).json({ error: 'This user has set their Poddy to Private' });
    }
    if (receiver.poddy_privacy === 'followers_only') {
      const { data: followRow } = await supabase
        .from('follows')
        .select('id')
        .eq('follower_id', requesterId)
        .eq('following_id', receiverId)
        .maybeSingle();
      if (!followRow) {
        return res.status(403).json({ error: 'Only followers can send a Poddy request to this user' });
      }
    }

    const requesterCount = await getAcceptedPoddyCount(requesterId);
    if (requesterCount >= 20) {
      return res.status(400).json({
        error: 'poddy_full',
        message: 'Your Poddy is full — remove someone to make room',
        capacity: 20,
      });
    }

    const receiverCount = await getAcceptedPoddyCount(receiverId);
    if (receiverCount >= 20) {
      return res.status(400).json({ error: "This user's Poddy is full" });
    }

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
          return res.status(400).json({
            error: 'This user has already sent you a Poddy request. Please accept it instead.',
          });
        }
      }
      if (existing.status === 'declined') {
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

        await supabase.from('notifications').insert({
          user_id: receiverId,
          type: 'poddy_request',
          title: 'New Poddy request',
          body: 'Someone wants to join your Poddy.',
          data: { requester_id: requesterId },
          is_read: false,
        });

        return res.status(201).json({ message: 'Poddy request sent' });
      }
    }

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

    await supabase.from('notifications').insert({
      user_id: receiverId,
      type: 'poddy_request',
      title: 'New Poddy request',
      body: 'Someone wants to join your Poddy.',
      data: { requester_id: requesterId },
      is_read: false,
    });

    return res.status(201).json({ message: 'Poddy request sent' });
  } catch (err) {
    console.error('Poddy request error:', err.message);
    return res.status(500).json({ error: 'Failed to send Poddy request' });
  } finally {
    release();
  }
});

// --------------------------------------------------------
// POST /api/poddy/accept/:requesterId — accept a poddy request
// --------------------------------------------------------
router.post('/accept/:requesterId', requireAuth, async (req, res) => {
  const receiverId = req.auth.userId;
  const requesterId = req.params.requesterId;

  if (receiverId === requesterId) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const release = await poddyLock.acquire([requesterId, receiverId]);
  try {
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

    const receiverCount = await getAcceptedPoddyCount(receiverId);
    if (receiverCount >= 20) {
      const { data: reqUser } = await supabase
        .from('users')
        .select('display_name')
        .eq('id', requesterId)
        .maybeSingle();
      return res.status(400).json({
        error: 'poddy_full',
        message: `Your Poddy is full, remove someone to add ${reqUser?.display_name || 'this user'}`,
        capacity: 20,
      });
    }

    const requesterCount = await getAcceptedPoddyCount(requesterId);
    if (requesterCount >= 20) {
      return res.status(400).json({ error: "The requester's Poddy is full" });
    }

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

    const [postRecCount, postReqCount] = await Promise.all([
      getAcceptedPoddyCount(receiverId),
      getAcceptedPoddyCount(requesterId),
    ]);

    if (postRecCount > 20 || postReqCount > 20) {
      await supabase
        .from('poddy_relationships')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', request.id);
      return res.status(400).json({ error: 'Poddy capacity exceeded' });
    }

    await supabase.from('notifications').insert({
      user_id: requesterId,
      type: 'poddy_accepted',
      title: 'Poddy request accepted',
      body: 'Your Poddy request was accepted! You are now in each other’s Poddy.',
      data: { user_id: receiverId },
      is_read: false,
    });

    return res.status(200).json({ message: 'Poddy request accepted' });
  } catch (err) {
    console.error('Poddy accept error:', err.message);
    return res.status(500).json({ error: 'Failed to accept Poddy request' });
  } finally {
    release();
  }
});

// --------------------------------------------------------
// POST /api/poddy/accept/:requesterId/swap — PRD v7 20-cap swap sheet
// Atomically removes an existing Poddy member and accepts the pending request.
// --------------------------------------------------------
router.post('/accept/:requesterId/swap', requireAuth, async (req, res) => {
  const receiverId = req.auth.userId;
  const requesterId = req.params.requesterId;
  const { remove_user_id } = req.body || {};

  if (!remove_user_id || remove_user_id === receiverId || remove_user_id === requesterId) {
    return res.status(400).json({ error: 'Valid remove_user_id is required to swap' });
  }

  const release = await poddyLock.acquire([requesterId, receiverId, remove_user_id]);
  try {
    const { data: request } = await supabase
      .from('poddy_relationships')
      .select('id')
      .eq('requester_id', requesterId)
      .eq('receiver_id', receiverId)
      .eq('status', 'pending')
      .maybeSingle();

    if (!request) {
      return res.status(404).json({ error: 'Poddy request not found' });
    }

    const requesterCount = await getAcceptedPoddyCount(requesterId);
    if (requesterCount >= 20) {
      return res.status(400).json({ error: "The requester's Poddy is full" });
    }

    const { data: removed, error: remErr } = await supabase
      .from('poddy_relationships')
      .delete()
      .or(`and(requester_id.eq.${receiverId},receiver_id.eq.${remove_user_id}),and(requester_id.eq.${remove_user_id},receiver_id.eq.${receiverId})`)
      .eq('status', 'accepted')
      .select();

    if (remErr || !removed || removed.length === 0) {
      return res.status(404).json({ error: 'Member to remove was not found in your Poddy' });
    }

    const { error: accErr } = await supabase
      .from('poddy_relationships')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', request.id)
      .eq('status', 'pending');

    if (accErr) {
      return res.status(500).json({ error: 'Failed to accept Poddy request after swap' });
    }

    await supabase.from('notifications').insert({
      user_id: requesterId,
      type: 'poddy_accepted',
      title: 'Poddy request accepted',
      body: 'Your Poddy request was accepted! You are now in each other’s Poddy.',
      data: { user_id: receiverId },
      is_read: false,
    });

    return res.status(200).json({
      message: 'Swapped member and accepted Poddy request',
      removed_user_id: remove_user_id,
      accepted_user_id: requesterId,
    });
  } catch (err) {
    console.error('Poddy swap error:', err.message);
    return res.status(500).json({ error: 'Failed to swap Poddy member' });
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

    const requests = (data || []).map((row) => ({
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

    const poddy = (data || []).map((row) => {
      const friend = row.requester_id === userId ? row.receiver : row.requester;
      return {
        user_id: friend?.id || (row.requester_id === userId ? row.receiver_id : row.requester_id),
        display_name: friend?.display_name || 'User',
        avatar_url: friend?.avatar_url || null,
        connected_since: row.created_at,
      };
    });

    return res.status(200).json({ count: poddy.length, capacity: 20, poddy });
  } catch (err) {
    console.error('Poddy list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Poddy list' });
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

module.exports = router;
