const {
  generateStreamToken,
  createStreamCall,
  endStreamCall,
} = require('../services/stream');

const {
  calculateDistinctViewers,
  trashRoom,
  isRoomStale,
  filterAndCleanStaleRooms,
  cleanAllStaleRooms,
  recordHeartbeat,
  removePresence,
} = require('../services/roomCleaner');

const express = require('express');
const scorezone = require('../services/scorezone');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../services/supabase');
const { requireAuth, optionalAuth, requireHost } = require('../middleware/auth');
const { isUserPremium } = require('./subscriptions');
const walletService = require('../services/wallet');
const { extractYouTubeId, getVideoMetadata } = require('../services/youtube');
const realtime = require('../services/realtime');

const LIVE_CATEGORIES = ['All', 'Football', 'Afrobeats', 'Nollywood', 'Gaming'];

async function recordPoddyWatchStreaks(roomId, userId) {
  if (!userId) return;
  try {
    const [{ data: rels }, { data: activeParts }] = await Promise.all([
      supabase
        .from('poddy_relationships')
        .select('requester_id, receiver_id')
        .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
        .eq('status', 'accepted'),
      supabase
        .from('room_participants')
        .select('user_id')
        .eq('room_id', roomId)
        .eq('is_active', true),
    ]);

    if (!rels?.length || !activeParts?.length) return;
    const activeSet = new Set(activeParts.map((p) => p.user_id).filter(Boolean));
    const friendIds = rels
      .map((r) => (r.requester_id === userId ? r.receiver_id : r.requester_id))
      .filter((fid) => fid !== userId && activeSet.has(fid));

    if (!friendIds.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    for (const fid of friendIds) {
      const [userA, userB] = [userId, fid].sort();
      const { data: streak } = await supabase
        .from('poddy_streaks')
        .select('*')
        .eq('user_a', userA)
        .eq('user_b', userB)
        .maybeSingle();

      if (!streak) {
        await supabase.from('poddy_streaks').insert({
          user_a: userA,
          user_b: userB,
          streak_days: 1,
          last_watched_date: today,
        });
      } else if (streak.last_watched_date !== today) {
        const nextDays = streak.last_watched_date === yesterday ? (streak.streak_days || 0) + 1 : 1;
        await supabase
          .from('poddy_streaks')
          .update({ streak_days: nextDays, last_watched_date: today })
          .eq('id', streak.id);
      }
    }
  } catch (err) {
    console.warn('Poddy streak update notice:', err.message);
  }
}

// --------------------------------------------------------
// Shared room creation handler for POST /api/rooms and POST /api/rooms/paid
// --------------------------------------------------------
async function createRoomHandler(req, res) {
  try {
    const { userId } = req.auth;
    const {
      video_id,
      video_title,
      video_thumbnail,
      youtube_url,
      name,
      is_public,
      room_type,
      category,
      is_paid,
      price_ngn,
      notify_poddy,
    } = req.body || {};

    if (process.env.ENFORCE_PREMIUM_HOSTING === 'true' || is_paid) {
      const premium = await isUserPremium(userId);
      if (!premium) {
        return res.status(403).json({
          error: 'premium_required',
          message: 'Subscribe ₦200 to join this league',
        });
      }
    }

    const type = room_type === 'screenshare' ? 'screenshare' : 'youtube';
    let resolvedVideoId = video_id || (youtube_url ? extractYouTubeId(youtube_url) : null);
    let resolvedTitle = video_title;
    let resolvedThumb = video_thumbnail;

    if (type === 'youtube' && resolvedVideoId && (!resolvedTitle || !resolvedThumb)) {
      const meta = await getVideoMetadata(resolvedVideoId);
      if (meta) {
        resolvedTitle = resolvedTitle || meta.title;
        resolvedThumb = resolvedThumb || meta.thumbnail;
      }
    }

    if (type === 'youtube' && (!resolvedVideoId || !resolvedTitle || !resolvedThumb)) {
      return res.status(400).json({
        error: 'video_id, video_title and video_thumbnail are required for YouTube rooms',
      });
    }
    if (type === 'screenshare' && !name) {
      return res.status(400).json({
        error: 'name is required for screen share rooms',
      });
    }

    const paidRoom = Boolean(is_paid);
    const seatPrice = paidRoom ? Math.round(Number(price_ngn || 0)) : 0;
    if (paidRoom && (!Number.isFinite(seatPrice) || seatPrice <= 0)) {
      return res.status(400).json({ error: 'A positive price_ngn is required for paid rooms' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, display_name')
      .eq('id', userId)
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const inviteToken = is_public === false ? uuidv4() : null;

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .insert({
        host_id: userId,
        name: name || resolvedTitle,
        is_public: is_public !== undefined ? is_public : true,
        invite_token: inviteToken,
        video_id: resolvedVideoId || null,
        video_title: resolvedTitle || name,
        video_thumbnail: resolvedThumb || null,
        room_type: type,
        category: category || 'Football',
        is_paid: paidRoom,
        price_ngn: seatPrice,
        is_playing: false,
        current_time: 0,
        status: 'active',
      })
      .select()
      .single();

    if (roomError) {
      console.error('Room creation error:', roomError.message);
      return res.status(500).json({ error: 'Failed to create room' });
    }

    await supabase.from('room_participants').insert({
      room_id: room.id,
      user_id: userId,
      is_active: true,
      mic_on: false,
      cam_on: false,
    });

    const baseFrontend = process.env.FRONTEND_URL || 'https://sweeger.buzz';
    const inviteLink = inviteToken
      ? `${baseFrontend}/room/${room.id}?invite=${inviteToken}`
      : `${baseFrontend}/room/${room.id}`;

    await createStreamCall(room.id, userId);

    if (notify_poddy) {
      const premium = await isUserPremium(userId);
      if (premium) {
        const { notifyPoddyFriends } = require('./notifications');
        notifyPoddyFriends(userId, user.display_name || 'Your friend', room.id, room.name).catch(() => {});
      }
    }

    console.log(`✅ Room created: ${room.id} by ${user.display_name}`);

    return res.status(201).json({
      room,
      invite_link: inviteLink,
      revenue_split: paidRoom ? { creator_percent: 70, sweeger_percent: 30 } : null,
    });
  } catch (err) {
    console.error('Create room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

router.post('/', requireAuth, createRoomHandler);

// --------------------------------------------------------
// POST /api/rooms/paid — Community Paid Live Room (PRD v7 §4.9)
// --------------------------------------------------------
router.post('/paid', requireAuth, (req, res) => {
  req.body = { ...(req.body || {}), is_paid: true };
  return createRoomHandler(req, res);
});

// --------------------------------------------------------
// GET /api/rooms/active
// Get all active public rooms for homepage (supports ?category= and ?q=)
// --------------------------------------------------------
router.get('/active', async (req, res) => {
  try {
    const { category, q, paid_only } = req.query;

    let query = supabase
      .from('rooms')
      .select(`
        id,
        name,
        video_id,
        video_title,
        video_thumbnail,
        room_type,
        category,
        is_paid,
        price_ngn,
        match_id,
        sport,
        match_meta,
        is_playing,
        is_public,
        created_at,
        updated_at,
        host_id,
        users!rooms_host_id_fkey (display_name, avatar_url)
      `)
      .eq('status', 'active')
      .eq('is_public', true);

    if (category && category !== 'All') {
      query = query.eq('category', category);
    }
    if (paid_only === 'true') {
      query = query.eq('is_paid', true);
    }

    const { data: rooms, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch active rooms error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch rooms' });
    }

    let cleanRooms = await filterAndCleanStaleRooms(rooms || []);

    if (q && String(q).trim()) {
      const needle = String(q).trim().toLowerCase();
      cleanRooms = cleanRooms.filter(
        (r) =>
          (r.name && r.name.toLowerCase().includes(needle)) ||
          (r.video_title && r.video_title.toLowerCase().includes(needle))
      );
    }

    const shaped = cleanRooms.map((room) => ({
      id: room.id,
      name: room.name,
      video_id: room.video_id,
      video_title: room.video_title,
      video_thumbnail: room.video_thumbnail,
      category: room.category || 'Football',
      is_paid: Boolean(room.is_paid),
      price_ngn: Number(room.price_ngn || 0),
      is_playing: room.is_playing,
      created_at: room.created_at,
      host: room.users,
      participant_count: room.participant_count || 0,
      viewer_count: room.participant_count || 0,
      room_type: room.room_type,
      match_id: room.match_id,
      sport: room.sport || null,
      match_meta: room.match_meta || null,
    }));

    return res.status(200).json({
      categories: LIVE_CATEGORIES,
      rooms: shaped,
    });
  } catch (err) {
    console.error('Active rooms error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// GET /api/rooms/paid — Community paid rooms list (PRD v7 §4.9)
// --------------------------------------------------------
router.get('/paid', async (req, res) => {
  try {
    const { data: rooms, error } = await supabase
      .from('rooms')
      .select(`
        id,
        name,
        video_id,
        video_title,
        video_thumbnail,
        category,
        is_paid,
        price_ngn,
        is_playing,
        created_at,
        updated_at,
        host_id,
        users!rooms_host_id_fkey (display_name, avatar_url)
      `)
      .eq('status', 'active')
      .eq('is_public', true)
      .eq('is_paid', true)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch paid rooms' });
    }

    const cleanRooms = await filterAndCleanStaleRooms(rooms || []);
    return res.status(200).json({
      count: cleanRooms.length,
      rooms: cleanRooms.map((r) => ({
        ...r,
        host: r.users,
        price_ngn: Number(r.price_ngn || 0),
      })),
    });
  } catch (err) {
    console.error('Paid rooms error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// GET /api/rooms/coming-soon — Upcoming scheduled live streams (PRD v7 §4.1)
// --------------------------------------------------------
router.get('/coming-soon', optionalAuth, async (req, res) => {
  try {
    const userId = req.auth?.userId || null;
    const { category } = req.query;

    let { data: items, error } = await supabase
      .from('coming_soon_streams')
      .select('*')
      .order('scheduled_start', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch coming soon streams' });
    }

    // Seed sensible defaults if empty
    if (!items || items.length === 0) {
      const now = Date.now();
      const seeds = [
        {
          title: 'Champions League Watchalong',
          category: 'Football',
          channel_name: 'Sweeger Football',
          thumbnail: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=800&q=80',
          scheduled_start: new Date(now + 2 * 3600000).toISOString(),
        },
        {
          title: 'Afrobeats Live Acoustic Session',
          category: 'Afrobeats',
          channel_name: 'Lagos Live',
          thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=800&q=80',
          scheduled_start: new Date(now + 4 * 3600000).toISOString(),
        },
        {
          title: 'Nollywood Director Q&A Premiere',
          category: 'Nollywood',
          channel_name: 'NollySpotlight',
          thumbnail: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=800&q=80',
          scheduled_start: new Date(now + 6 * 3600000).toISOString(),
        },
      ];
      const inserted = await supabase.from('coming_soon_streams').insert(seeds).select();
      items = inserted.data || [];
    }

    const nowMs = Date.now();
    let upcoming = (items || []).filter((i) => new Date(i.scheduled_start).getTime() > nowMs);
    if (category && category !== 'All') {
      upcoming = upcoming.filter((i) => i.category === category);
    }

    let userReminders = new Map();
    if (userId && upcoming.length > 0) {
      const { data: rems } = await supabase
        .from('stream_reminders')
        .select('stream_id, notify_poddy')
        .eq('user_id', userId);
      for (const r of rems || []) {
        userReminders.set(r.stream_id, Boolean(r.notify_poddy));
      }
    }

    return res.status(200).json({
      count: upcoming.length,
      streams: upcoming.map((s) => ({
        ...s,
        user_reminded: userReminders.has(s.id),
        notify_poddy: userReminders.get(s.id) || false,
      })),
    });
  } catch (err) {
    console.error('Coming soon error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/coming-soon/:id/remind
// Set reminder ("Remind me" + optional "Notify my Poddy too when it starts")
// --------------------------------------------------------
router.post('/coming-soon/:id/remind', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { id } = req.params;
    const { notify_poddy = false } = req.body || {};

    const { data: stream } = await supabase
      .from('coming_soon_streams')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!stream) {
      return res.status(404).json({ error: 'Upcoming stream not found' });
    }

    await supabase.from('stream_reminders').upsert(
      {
        stream_id: id,
        user_id: userId,
        notify_poddy: Boolean(notify_poddy),
      },
      { onConflict: 'stream_id,user_id' }
    );

    if (notify_poddy) {
      const { data: rels } = await supabase
        .from('poddy_relationships')
        .select('requester_id, receiver_id')
        .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
        .eq('status', 'accepted');

      const { data: me } = await supabase
        .from('users')
        .select('display_name')
        .eq('id', userId)
        .maybeSingle();

      const friendIds = (rels || []).map((r) =>
        r.requester_id === userId ? r.receiver_id : r.requester_id
      );

      if (friendIds.length > 0) {
        await supabase.from('notifications').insert(
          friendIds.map((fid) => ({
            user_id: fid,
            type: 'coming_soon_poddy_reminder',
            title: `${me?.display_name || 'Your Poddy friend'} set a reminder`,
            body: `They plan to watch "${stream.title}" when it starts.`,
            data: { stream_id: id, triggered_by: userId },
            is_read: false,
          }))
        );
      }
    }

    return res.status(200).json({
      message: 'Reminder saved',
      stream_id: id,
      notify_poddy: Boolean(notify_poddy),
    });
  } catch (err) {
    console.error('Set reminder error:', err.message);
    return res.status(500).json({ error: 'Failed to set reminder' });
  }
});

router.delete('/coming-soon/:id/remind', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { id } = req.params;

    await supabase
      .from('stream_reminders')
      .delete()
      .eq('stream_id', id)
      .eq('user_id', userId);

    return res.status(200).json({ message: 'Reminder removed' });
  } catch (err) {
    console.error('Remove reminder error:', err.message);
    return res.status(500).json({ error: 'Failed to remove reminder' });
  }
});

// --------------------------------------------------------
// GET /api/rooms/for-video/:videoId
// Get active public rooms for a specific video
// --------------------------------------------------------
router.get('/for-video/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    const { data: rooms, error } = await supabase
      .from('rooms')
      .select(`
        id,
        name,
        video_id,
        video_title,
        video_thumbnail,
        room_type,
        category,
        is_paid,
        price_ngn,
        match_id,
        sport,
        match_meta,
        is_playing,
        created_at,
        updated_at,
        host_id,
        users!rooms_host_id_fkey (display_name, avatar_url)
      `)
      .eq('status', 'active')
      .eq('is_public', true)
      .eq('video_id', videoId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('For-video rooms error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch rooms' });
    }

    const cleanRooms = await filterAndCleanStaleRooms(rooms || []);

    const shaped = cleanRooms.map((room) => ({
      id: room.id,
      name: room.name,
      video_id: room.video_id,
      video_title: room.video_title,
      video_thumbnail: room.video_thumbnail,
      category: room.category || 'Football',
      is_paid: Boolean(room.is_paid),
      price_ngn: Number(room.price_ngn || 0),
      is_playing: room.is_playing,
      created_at: room.created_at,
      host: room.users,
      participant_count: room.participant_count || 0,
      room_type: room.room_type,
      match_id: room.match_id,
      sport: room.sport || null,
      match_meta: room.match_meta || null,
    }));

    return res.status(200).json({ rooms: shaped });
  } catch (err) {
    console.error('For-video rooms error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/cleanup
// Trigger manual cleanup of any stale rooms
// --------------------------------------------------------
router.post('/cleanup', async (req, res) => {
  try {
    const result = await cleanAllStaleRooms();
    return res.status(200).json({
      message: 'Cleanup completed successfully',
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Manual cleanup error:', err.message);
    return res.status(500).json({ error: 'Failed to run cleanup' });
  }
});

// --------------------------------------------------------
// GET /api/rooms/:roomId
// Get a single room by ID
// --------------------------------------------------------
router.get('/:roomId', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { invite } = req.query;

    const { data: room, error } = await supabase
      .from('rooms')
      .select(`
        *,
        users!rooms_host_id_fkey (display_name, avatar_url)
      `)
      .eq('id', roomId)
      .single();

    if (error || !room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (room.status === 'ended') {
      return res.status(410).json({
        error: 'This room has ended',
        video_title: room.video_title,
      });
    }

    if (!room.is_public) {
      if (!invite || invite !== room.invite_token) {
        return res.status(404).json({ error: 'Room not found' });
      }
    }

    const { data: activeParticipants } = await supabase
      .from('room_participants')
      .select('id, user_id, guest_name, joined_at, is_active')
      .eq('room_id', roomId)
      .eq('is_active', true);

    const { count: activeCount } = calculateDistinctViewers(activeParticipants || []);

    const { isStale, reason } = isRoomStale(room, activeCount);
    if (isStale) {
      await trashRoom(roomId, reason);
      return res.status(410).json({
        error: 'This room has ended',
        video_title: room.video_title,
      });
    }

    const updatedAt = new Date(room.updated_at || room.created_at).getTime();
    const now = Date.now();
    const elapsed = (now - updatedAt) / 1000;
    const adjustedTime = room.is_playing
      ? room.current_time + elapsed
      : room.current_time;

    return res.status(200).json({
      room: {
        ...room,
        host_id: room.host_id,
        host: room.users,
        participant_count: activeCount || 0,
        current_time: adjustedTime,
        sport: room.sport || null,
        match_meta: room.match_meta || null,
      },
    });
  } catch (err) {
    console.error('Get room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/pay-join — Pay with Wallet & join paid Live room (70/30 split)
// --------------------------------------------------------
router.post('/:roomId/pay-join', requireAuth, async (req, res, next) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth.userId;

    const { data: room, error: roomErr } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .maybeSingle();

    if (roomErr || !room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    if (room.status === 'ended') {
      return res.status(410).json({ error: 'This room has ended' });
    }

    if (room.is_paid && Number(room.price_ngn) > 0 && room.host_id !== userId) {
      const { data: existingTicket } = await supabase
        .from('paid_room_tickets')
        .select('id')
        .eq('room_id', roomId)
        .eq('user_id', userId)
        .maybeSingle();

      if (!existingTicket) {
        const paymentResult = await walletService.purchaseWithWallet({
          buyerId: userId,
          creatorId: room.host_id,
          priceNGN: Number(room.price_ngn),
          contentId: roomId,
          contentTitle: room.name || room.video_title || 'Paid Live Room',
          contentType: 'paid_room',
          idempotencyKey: `paid_room:${roomId}:${userId}`,
        });

        await supabase.from('paid_room_tickets').insert({
          room_id: roomId,
          user_id: userId,
          price_ngn: Number(room.price_ngn),
          creator_keeps_ngn: paymentResult.creator_keeps_ngn,
          sweeger_fee_ngn: paymentResult.sweeger_fee_ngn,
        });
      }
    }

    req.paidTicketVerified = true;
    return joinRoomHandler(req, res);
  } catch (err) {
    if (err instanceof walletService.WalletError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    console.error('Pay & join room error:', err.message);
    return res.status(500).json({ error: 'Failed to process room payment' });
  }
});

// --------------------------------------------------------
// Shared join handler for POST /api/rooms/:roomId/join and pay-join
// --------------------------------------------------------
async function joinRoomHandler(req, res) {
  try {
    const { roomId } = req.params;
    const { invite, guest_name, guest_id: clientGuestId } = req.body || {};
    const userId = req.auth?.userId || null;

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .single();

    if (roomError || !room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (room.status === 'ended') {
      return res.status(410).json({ error: 'This room has ended' });
    }

    if (!room.is_public) {
      if (!invite || invite !== room.invite_token) {
        return res.status(403).json({ error: 'Invalid invite token' });
      }
    }

    // Enforce payment for paid live rooms
    if (room.is_paid && Number(room.price_ngn) > 0 && !req.paidTicketVerified) {
      if (!userId) {
        return res.status(401).json({ error: 'Sign in required to join a paid room' });
      }
      if (room.host_id !== userId) {
        const { data: ticket } = await supabase
          .from('paid_room_tickets')
          .select('id')
          .eq('room_id', roomId)
          .eq('user_id', userId)
          .maybeSingle();

        if (!ticket) {
          return res.status(402).json({
            error: 'payment_required',
            message: `Pay ₦${room.price_ngn} from your Wallet to join this room`,
            price_ngn: Number(room.price_ngn),
          });
        }
      }
    }

    let displayName = 'Guest';
    if (userId) {
      const { data: userRecord } = await supabase
        .from('users')
        .select('display_name')
        .eq('id', userId)
        .maybeSingle();
      displayName = userRecord?.display_name || guest_name || 'User';
    } else if (guest_name) {
      displayName = guest_name.trim();
    }

    const { data: currentParticipants } = await supabase
      .from('room_participants')
      .select('id, user_id, guest_name, is_active')
      .eq('room_id', roomId)
      .eq('is_active', true);

    const { count: currentCount, distinctUsers, distinctGuests } = calculateDistinctViewers(
      currentParticipants || []
    );

    const isAlreadyActive = userId
      ? distinctUsers.has(userId)
      : displayName && distinctGuests.has(displayName.toLowerCase());

    if (currentCount >= 12 && !isAlreadyActive) {
      return res.status(403).json({
        error: 'room_full',
        message: 'This room is full. Create your own room for this video.',
      });
    }

    const effectiveGuestId = clientGuestId || (userId ? null : `guest_${uuidv4().slice(0, 8)}`);

    if (userId) {
      await supabase
        .from('room_participants')
        .update({ is_active: false, left_at: new Date().toISOString() })
        .eq('user_id', userId)
        .neq('room_id', roomId)
        .eq('is_active', true);

      const { data: existingRows } = await supabase
        .from('room_participants')
        .select('id')
        .eq('room_id', roomId)
        .eq('user_id', userId);

      if (existingRows && existingRows.length > 0) {
        const primaryId = existingRows[0].id;
        await supabase
          .from('room_participants')
          .update({
            is_active: true,
            left_at: null,
            joined_at: new Date().toISOString(),
          })
          .eq('id', primaryId);

        if (existingRows.length > 1) {
          const duplicateIds = existingRows.slice(1).map((r) => r.id);
          await supabase
            .from('room_participants')
            .update({ is_active: false, left_at: new Date().toISOString() })
            .in('id', duplicateIds);
        }
      } else {
        await supabase.from('room_participants').insert({
          room_id: roomId,
          user_id: userId,
          guest_name: null,
          is_active: true,
          mic_on: false,
          cam_on: false,
          joined_at: new Date().toISOString(),
        });
      }
    } else {
      const { data: existingGuests } = await supabase
        .from('room_participants')
        .select('id')
        .eq('room_id', roomId)
        .is('user_id', null)
        .eq('guest_name', displayName);

      if (existingGuests && existingGuests.length > 0) {
        const primaryId = existingGuests[0].id;
        await supabase
          .from('room_participants')
          .update({
            is_active: true,
            left_at: null,
            joined_at: new Date().toISOString(),
          })
          .eq('id', primaryId);

        if (existingGuests.length > 1) {
          const duplicateIds = existingGuests.slice(1).map((r) => r.id);
          await supabase
            .from('room_participants')
            .update({ is_active: false, left_at: new Date().toISOString() })
            .in('id', duplicateIds);
        }
      } else {
        await supabase.from('room_participants').insert({
          room_id: roomId,
          user_id: null,
          guest_name: displayName,
          is_active: true,
          mic_on: false,
          cam_on: false,
          joined_at: new Date().toISOString(),
        });
      }
    }

    const presenceKey = userId || effectiveGuestId || displayName;
    recordHeartbeat(roomId, presenceKey);

    const updatedAt = new Date(room.updated_at || room.created_at).getTime();
    const now = Date.now();
    const elapsed = (now - updatedAt) / 1000;
    const adjustedTime = room.is_playing ? room.current_time + elapsed : room.current_time;

    const streamUserId = userId || effectiveGuestId || `guest_${Date.now()}`;
    const streamToken = generateStreamToken(streamUserId);

    console.log(`✅ ${displayName} joined room ${roomId}`);

    if (userId) {
      recordPoddyWatchStreaks(roomId, userId).catch(() => {});
      try {
        const { notifyPoddyFriends } = require('./notifications');
        notifyPoddyFriends(userId, displayName, roomId, room.name).catch(() => {});
      } catch (notifyErr) {
        console.error('Poddy notify error:', notifyErr.message);
      }
    }

    realtime.publish('room', roomId, 'viewer_joined', {
      user_id: userId,
      guest_id: effectiveGuestId,
      display_name: displayName,
    });

    let match = null;
    if (room.room_type === 'match' && room.match_id) {
      try {
        const embed = await scorezone.getEmbed(room.match_id, {
          sport: room.sport || 'football',
          ...(room.match_meta || {}),
        });
        match = { id: room.match_id, sport: room.sport, ...embed };
      } catch (embedErr) {
        console.error('Match embed error:', embedErr.message);
        match = { id: room.match_id, sport: room.sport, embed_url: null, streams: [] };
      }
    }

    return res.status(200).json({
      room: {
        id: room.id,
        name: room.name,
        video_id: room.video_id,
        video_title: room.video_title,
        video_thumbnail: room.video_thumbnail,
        category: room.category || 'Football',
        is_paid: Boolean(room.is_paid),
        price_ngn: Number(room.price_ngn || 0),
        is_playing: room.is_playing,
        current_time: adjustedTime,
        room_type: room.room_type,
        match_id: room.match_id || null,
        sport: room.sport || null,
        match_meta: room.match_meta || null,
      },
      match,
      participant: {
        user_id: userId,
        guest_id: effectiveGuestId,
        display_name: displayName,
        is_host: room.host_id === userId,
      },
      audio_graph_policy: {
        voice_activity_ducking: true,
        independent_mic_and_video_sources: true,
      },
      stream: {
        token: streamToken,
        api_key: process.env.STREAM_API_KEY,
        call_id: roomId,
        user_id: streamUserId,
        features: {
          screensharing: true,
          voice: true,
          video: true,
        },
      },
    });
  } catch (err) {
    console.error('Join room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

router.post('/:roomId/join', optionalAuth, joinRoomHandler);

// --------------------------------------------------------
// PATCH /api/rooms/:roomId/presence — Update live mic/cam badges (<1s via SSE)
// --------------------------------------------------------
router.patch('/:roomId/presence', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth?.userId || null;
    const { mic_on, cam_on, guest_name } = req.body || {};

    if (!userId && !guest_name) {
      return res.status(400).json({ error: 'Authenticated user or guest_name is required' });
    }

    const patch = {};
    if (typeof mic_on === 'boolean') patch.mic_on = mic_on;
    if (typeof cam_on === 'boolean') patch.cam_on = cam_on;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'mic_on or cam_on boolean is required' });
    }

    let query = supabase
      .from('room_participants')
      .update(patch)
      .eq('room_id', roomId)
      .eq('is_active', true);

    if (userId) {
      query = query.eq('user_id', userId);
    } else {
      query = query.is('user_id', null).eq('guest_name', guest_name.trim());
    }

    const { data, error } = await query.select();
    if (error) throw error;

    const updated = data?.[0] || patch;

    realtime.publish('room', roomId, 'presence_updated', {
      room_id: roomId,
      user_id: userId,
      guest_name: guest_name || null,
      mic_on: Boolean(updated.mic_on),
      cam_on: Boolean(updated.cam_on),
    });

    return res.status(200).json({
      room_id: roomId,
      user_id: userId,
      guest_name: guest_name || null,
      mic_on: Boolean(updated.mic_on),
      cam_on: Boolean(updated.cam_on),
    });
  } catch (err) {
    console.error('Presence update error:', err.message);
    return res.status(500).json({ error: 'Failed to update presence' });
  }
});

// --------------------------------------------------------
// GET /api/rooms/:roomId/events — SSE stream for real-time presence, chat & reactions
// --------------------------------------------------------
router.get('/:roomId/events', optionalAuth, async (req, res) => {
  const { roomId } = req.params;
  const { data: activeParticipants } = await supabase
    .from('room_participants')
    .select('id, user_id, guest_name, mic_on, cam_on, is_active')
    .eq('room_id', roomId)
    .eq('is_active', true);

  realtime.attachSseStream(req, res, 'room', roomId, {
    participants: activeParticipants || [],
  });
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/notify-poddy — Premium-gated manual Poddy live notification
// --------------------------------------------------------
router.post('/:roomId/notify-poddy', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { roomId } = req.params;

    const premium = await isUserPremium(userId);
    if (!premium) {
      return res.status(403).json({
        error: 'premium_required',
        message: 'Subscribe ₦200 to join this league',
      });
    }

    const [{ data: room }, { data: user }] = await Promise.all([
      supabase.from('rooms').select('id, name').eq('id', roomId).maybeSingle(),
      supabase.from('users').select('display_name').eq('id', userId).maybeSingle(),
    ]);

    if (!room) return res.status(404).json({ error: 'Room not found' });

    const { notifyPoddyFriends } = require('./notifications');
    await notifyPoddyFriends(userId, user?.display_name || 'Your friend', room.id, room.name);

    return res.status(200).json({ message: 'Poddy notified' });
  } catch (err) {
    console.error('Notify Poddy error:', err.message);
    return res.status(500).json({ error: 'Failed to notify Poddy' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/leave
// --------------------------------------------------------
router.post('/:roomId/leave', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth?.userId || null;
    const { guest_name, guest_id } = req.body || {};

    res.status(200).json({ message: 'Left room successfully' });

    setImmediate(async () => {
      try {
        const leftAt = new Date().toISOString();

        if (userId) {
          await supabase
            .from('room_participants')
            .update({ is_active: false, left_at: leftAt })
            .eq('room_id', roomId)
            .eq('user_id', userId);
          removePresence(roomId, userId);
        } else if (guest_name) {
          await supabase
            .from('room_participants')
            .update({ is_active: false, left_at: leftAt })
            .eq('room_id', roomId)
            .is('user_id', null)
            .eq('guest_name', guest_name.trim());
          removePresence(roomId, guest_id || guest_name);
        }

        realtime.publish('room', roomId, 'viewer_left', {
          user_id: userId,
          guest_name: guest_name || null,
        });

        const [{ data: room }, { data: rawParts }] = await Promise.all([
          supabase.from('rooms').select('host_id, status').eq('id', roomId).single(),
          supabase
            .from('room_participants')
            .select('id, user_id, joined_at, is_active, guest_name')
            .eq('room_id', roomId)
            .eq('is_active', true)
            .order('joined_at', { ascending: true }),
        ]);

        if (!room || room.status === 'ended') return;

        const remainingParts = (rawParts || []).filter((p) => {
          if (userId && p.user_id === userId) return false;
          if (!userId && guest_name && !p.user_id && p.guest_name?.trim().toLowerCase() === guest_name.trim().toLowerCase()) {
            return false;
          }
          return true;
        });

        const { count: remainingCount } = calculateDistinctViewers(remainingParts);

        if (remainingCount === 0) {
          await trashRoom(roomId, 'all_participants_left');
          console.log(`🗑️ Room ${roomId} trashed — all participants left`);
        } else if (room.host_id === userId) {
          const nextUser = (remainingParts || []).find((p) => p.user_id && p.user_id !== userId);
          if (nextUser?.user_id) {
            await supabase.from('rooms').update({ host_id: nextUser.user_id }).eq('id', roomId);
            console.log(`👑 Host promoted: ${nextUser.user_id} in room ${roomId}`);
          } else {
            await trashRoom(roomId, 'host_left_no_eligible_host');
            console.log(`🗑️ Room ${roomId} trashed — host left with no eligible successor`);
          }
        }
        console.log(`✅ ${userId || guest_name || 'Guest'} left room ${roomId}`);
      } catch (bgErr) {
        console.error('Leave background error:', bgErr.message);
      }
    });
  } catch (err) {
    console.error('Leave room error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// PATCH /api/rooms/:roomId/playback — host only
// --------------------------------------------------------
router.patch('/:roomId/playback', requireAuth, requireHost, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { is_playing, current_time } = req.body;

    if (is_playing === undefined || current_time === undefined) {
      return res.status(400).json({
        error: 'is_playing and current_time are required',
      });
    }

    const { error } = await supabase
      .from('rooms')
      .update({
        is_playing,
        current_time,
        updated_at: new Date().toISOString(),
      })
      .eq('id', roomId);

    if (error) {
      return res.status(500).json({ error: 'Failed to update playback' });
    }

    return res.status(200).json({
      message: 'Playback updated',
      is_playing,
      current_time,
    });
  } catch (err) {
    console.error('Playback update error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/end — host only
// --------------------------------------------------------
router.post('/:roomId/end', requireAuth, requireHost, async (req, res) => {
  try {
    const { roomId } = req.params;

    await supabase
      .from('rooms')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
        is_playing: false,
      })
      .eq('id', roomId);

    await supabase
      .from('room_participants')
      .update({
        is_active: false,
        left_at: new Date().toISOString(),
      })
      .eq('room_id', roomId)
      .eq('is_active', true);

    await endStreamCall(roomId);
    console.log(`🔴 Room ${roomId} ended`);

    return res.status(200).json({ message: 'Room ended successfully' });
  } catch (err) {
    console.error('End room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/invite/regenerate — host only
// --------------------------------------------------------
router.post('/:roomId/invite/regenerate', requireAuth, requireHost, async (req, res) => {
  try {
    const { roomId } = req.params;
    const newToken = uuidv4();

    await supabase
      .from('rooms')
      .update({ invite_token: newToken })
      .eq('id', roomId);

    const baseFrontend = process.env.FRONTEND_URL || 'https://sweeger.buzz';
    const inviteLink = `${baseFrontend}/room/${roomId}?invite=${newToken}`;

    return res.status(200).json({ invite_link: inviteLink });
  } catch (err) {
    console.error('Regenerate invite error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/heartbeat
// --------------------------------------------------------
router.post('/:roomId/heartbeat', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth?.userId || null;
    const { guest_name, guest_id } = req.body || {};

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

    const presenceKey = userId || guest_id || guest_name;
    if (presenceKey) {
      recordHeartbeat(roomId, presenceKey);
    }

    const nowIso = new Date().toISOString();

    if (userId) {
      await supabase
        .from('room_participants')
        .update({ is_active: true, joined_at: nowIso })
        .eq('room_id', roomId)
        .eq('user_id', userId);
    } else if (guest_name) {
      await supabase
        .from('room_participants')
        .update({ is_active: true, joined_at: nowIso })
        .eq('room_id', roomId)
        .is('user_id', null)
        .eq('guest_name', guest_name.trim());
    }

    await supabase
      .from('rooms')
      .update({ updated_at: nowIso })
      .eq('id', roomId);

    const { data: activeParts } = await supabase
      .from('room_participants')
      .select('id, user_id, guest_name, is_active')
      .eq('room_id', roomId)
      .eq('is_active', true);

    const { count } = calculateDistinctViewers(activeParts || []);

    return res.status(200).json({
      status: 'ok',
      participant_count: count,
      timestamp: nowIso,
    });
  } catch (err) {
    console.error('Heartbeat error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// GET /api/rooms/:roomId/participants
// Returns deduplicated viewers with live mic/cam badges, follow/Poddy/mute states, and layer counts
// --------------------------------------------------------
router.get('/:roomId/participants', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const viewerId = req.auth?.userId || null;

    const { data: participants, error } = await supabase
      .from('room_participants')
      .select(`
        id,
        user_id,
        guest_name,
        joined_at,
        is_active,
        mic_on,
        cam_on,
        users (display_name, avatar_url)
      `)
      .eq('room_id', roomId)
      .eq('is_active', true)
      .order('joined_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch participants' });
    }

    const { participants: deduped } = calculateDistinctViewers(participants || []);

    let followingSet = new Set();
    let poddyMap = new Map();
    let mutedSet = new Set();
    let watchMateCount = 0;

    if (viewerId) {
      const [{ data: follows }, { data: poddyRels }, { data: mutes }, { data: myPod }] = await Promise.all([
        supabase.from('follows').select('following_id').eq('follower_id', viewerId),
        supabase
          .from('poddy_relationships')
          .select('requester_id, receiver_id, status')
          .or(`requester_id.eq.${viewerId},receiver_id.eq.${viewerId}`),
        supabase.from('user_mutes').select('muted_user_id').eq('user_id', viewerId),
        supabase
          .from('watch_mate_members')
          .select('pod_id')
          .eq('room_id', roomId)
          .eq('user_id', viewerId)
          .eq('is_active', true)
          .maybeSingle(),
      ]);

      followingSet = new Set((follows || []).map((f) => f.following_id));
      mutedSet = new Set((mutes || []).map((m) => m.muted_user_id));

      for (const r of poddyRels || []) {
        const other = r.requester_id === viewerId ? r.receiver_id : r.requester_id;
        if (r.status === 'accepted') poddyMap.set(other, 'in_poddy');
        else if (r.status === 'pending') poddyMap.set(other, 'requested');
      }

      if (myPod?.pod_id) {
        const { count: wmCount } = await supabase
          .from('watch_mate_members')
          .select('*', { count: 'exact', head: true })
          .eq('pod_id', myPod.pod_id)
          .eq('is_active', true);
        watchMateCount = wmCount || 0;
      }
    }

    let poddyCount = 0;
    const shaped = deduped.map((p) => {
      const pStatus = p.user_id ? poddyMap.get(p.user_id) || 'none' : 'none';
      if (pStatus === 'in_poddy') poddyCount++;
      const isFollowing = p.user_id ? followingSet.has(p.user_id) : false;

      return {
        id: p.id,
        user_id: p.user_id,
        display_name: p.users?.display_name || p.guest_name || 'Guest',
        avatar_url: p.users?.avatar_url || null,
        joined_at: p.joined_at,
        is_guest: !p.user_id,
        mic_on: Boolean(p.mic_on),
        cam_on: Boolean(p.cam_on),
        is_muted_for_me: p.user_id ? mutedSet.has(p.user_id) : false,
        is_following: isFollowing,
        follow_label: isFollowing ? 'Following' : 'Follow',
        poddy_status: pStatus,
        poddy_label:
          pStatus === 'in_poddy'
            ? 'In Poddy'
            : pStatus === 'requested'
              ? 'Requested'
              : 'Add to Poddy',
      };
    });

    return res.status(200).json({
      participants: shaped,
      count: shaped.length,
      layer_counts: {
        general: shaped.length,
        poddy: poddyCount,
        watchmate: watchMateCount,
      },
    });
  } catch (err) {
    console.error('Get participants error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
