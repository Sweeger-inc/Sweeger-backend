const { 
  generateStreamToken, 
  createStreamCall, 
  endStreamCall 
} = require('../services/stream');

const {
  calculateDistinctViewers,
  getBatchViewerCounts,
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

// --------------------------------------------------------
// POST /api/rooms
// Create a new room — must be logged in
// --------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const { 
      video_id, 
      video_title, 
      video_thumbnail, 
      name, 
      is_public,
      room_type,
    } = req.body;

    const type = room_type === 'screenshare' ? 'screenshare' : 'youtube';

    // Validate required fields based on room type
    if (type === 'youtube' && (!video_id || !video_title || !video_thumbnail)) {
      return res.status(400).json({ 
        error: 'video_id, video_title and video_thumbnail are required for YouTube rooms' 
      });
    }
    if (type === 'screenshare' && !name) {
      return res.status(400).json({ 
        error: 'name is required for screen share rooms' 
      });
    }

    // Check user exists in our DB
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, display_name')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate invite token for private rooms
    const inviteToken = !is_public ? uuidv4() : null;

    // Create the room
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .insert({
        host_id: userId,
        name: name || video_title,
        is_public: is_public !== undefined ? is_public : true,
        invite_token: inviteToken,
        video_id: video_id || null,
        video_title: video_title || name,
        video_thumbnail: video_thumbnail || null,
        room_type: type,
        is_playing: false,
        "current_time": 0,
        status: 'active',
      })
      .select()
      .single();

    if (roomError) {
      console.error('Room creation error:', roomError.message);
      return res.status(500).json({ error: 'Failed to create room' });
    }

    // Add host as first participant
    await supabase
      .from('room_participants')
      .insert({
        room_id: room.id,
        user_id: userId,
        is_active: true,
      });

    // Build invite link
    const inviteLink = inviteToken 
      ? `${process.env.FRONTEND_URL}/room/${room.id}?invite=${inviteToken}`
      : `${process.env.FRONTEND_URL}/room/${room.id}`;

    // Create Stream call for this room
    await createStreamCall(room.id, userId);

    console.log(`✅ Room created: ${room.id} by ${user.display_name}`);

    return res.status(201).json({
      room,
      invite_link: inviteLink,
    });

  } catch (err) {
    console.error('Create room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// GET /api/rooms/active
// Get all active public rooms for homepage
// --------------------------------------------------------
router.get('/active', async (req, res) => {
  try {
    const { data: rooms, error } = await supabase
      .from('rooms')
      .select(`
        id,
        name,
        video_id,
        video_title,
        video_thumbnail,
        room_type,
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
      .eq('is_public', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch active rooms error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch rooms' });
    }

    // Filter out and immediately trash stale rooms, computing accurate distinct viewer counts
    const cleanRooms = await filterAndCleanStaleRooms(rooms || []);

    const shaped = cleanRooms.map((room) => ({
      id: room.id,
      name: room.name,
      video_id: room.video_id,
      video_title: room.video_title,
      video_thumbnail: room.video_thumbnail,
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
    console.error('Active rooms error:', err.message);
    return res.status(500).json({ error: 'Server error' });
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

    // Filter out and immediately trash stale rooms, computing accurate distinct viewer counts
    const cleanRooms = await filterAndCleanStaleRooms(rooms || []);

    const shaped = cleanRooms.map((room) => ({
      id: room.id,
      name: room.name,
      video_id: room.video_id,
      video_title: room.video_title,
      video_thumbnail: room.video_thumbnail,
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

    // Check if room has ended
    if (room.status === 'ended') {
      return res.status(410).json({ 
        error: 'This room has ended',
        video_title: room.video_title,
      });
    }

    // Private room — validate invite token
    if (!room.is_public) {
      if (!invite || invite !== room.invite_token) {
        return res.status(404).json({ error: 'Room not found' });
      }
    }

    // Get accurate distinct active count
    const { data: activeParticipants } = await supabase
      .from('room_participants')
      .select('id, user_id, guest_name, joined_at, is_active')
      .eq('room_id', roomId)
      .eq('is_active', true);

    const { count: activeCount } = calculateDistinctViewers(activeParticipants || []);

    // Check if room is stale
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
      ? room["current_time"] + elapsed
      : room["current_time"];

    return res.status(200).json({
      room: {
        ...room,
        host_id: room.host_id,
        host: room.users,
        participant_count: activeCount || 0,
        current_time: adjustedTime,
        sport: room.sport || null,
        match_meta: room.match_meta || null,
      }
    });

  } catch (err) {
    console.error('Get room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/join
// Join a room
// --------------------------------------------------------
router.post('/:roomId/join', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { invite, guest_name, guest_id: clientGuestId } = req.body || {};
    const userId = req.auth?.userId || null;

    // Fetch room
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

    // Validate private room token
    if (!room.is_public) {
      if (!invite || invite !== room.invite_token) {
        return res.status(403).json({ error: 'Invalid invite token' });
      }
    }

    // Get display name
    let displayName = 'Guest';
    if (userId) {
      const { data: userRecord } = await supabase
        .from('users')
        .select('display_name')
        .eq('id', userId)
        .single();
      displayName = userRecord?.display_name || guest_name || 'User';
    } else if (guest_name) {
      displayName = guest_name.trim();
    }

    // Check capacity — max 12 participants (calculate real distinct viewers)
    const { data: currentParticipants } = await supabase
      .from('room_participants')
      .select('id, user_id, guest_name, is_active')
      .eq('room_id', roomId)
      .eq('is_active', true);

    const { count: currentCount, distinctUsers, distinctGuests } = calculateDistinctViewers(currentParticipants || []);
    
    // Check if the current user/guest is already counted among the active viewers
    const isAlreadyActive = userId 
      ? distinctUsers.has(userId) 
      : (displayName && distinctGuests.has(displayName.toLowerCase()));

    if (currentCount >= 12 && !isAlreadyActive) {
      return res.status(403).json({ 
        error: 'room_full',
        message: 'This room is full. Create your own room for this video.'
      });
    }

    // Stable guest ID for voice/stream & tracking
    const effectiveGuestId = clientGuestId || (userId ? null : `guest_${uuidv4().slice(0, 8)}`);

    // Deduplicate / Activate participant:
    if (userId) {
      // Deactivate any active sessions in other rooms for this user
      await supabase
        .from('room_participants')
        .update({ is_active: false, left_at: new Date().toISOString() })
        .eq('user_id', userId)
        .neq('room_id', roomId)
        .eq('is_active', true);

      // Check existing rows in this room
      const { data: existingRows } = await supabase
        .from('room_participants')
        .select('id')
        .eq('room_id', roomId)
        .eq('user_id', userId);

      if (existingRows && existingRows.length > 0) {
        // Keep the first row, update it to active
        const primaryId = existingRows[0].id;
        await supabase
          .from('room_participants')
          .update({ 
            is_active: true, 
            left_at: null, 
            joined_at: new Date().toISOString() 
          })
          .eq('id', primaryId);

        // Deactivate any duplicate rows for this user in this room
        if (existingRows.length > 1) {
          const duplicateIds = existingRows.slice(1).map(r => r.id);
          await supabase
            .from('room_participants')
            .update({ is_active: false, left_at: new Date().toISOString() })
            .in('id', duplicateIds);
        }
      } else {
        await supabase
          .from('room_participants')
          .insert({
            room_id: roomId,
            user_id: userId,
            guest_name: null,
            is_active: true,
            joined_at: new Date().toISOString(),
          });
      }
    } else {
      // Guest participant: match by guest_name in this room
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
            joined_at: new Date().toISOString()
          })
          .eq('id', primaryId);

        if (existingGuests.length > 1) {
          const duplicateIds = existingGuests.slice(1).map(r => r.id);
          await supabase
            .from('room_participants')
            .update({ is_active: false, left_at: new Date().toISOString() })
            .in('id', duplicateIds);
        }
      } else {
        await supabase
          .from('room_participants')
          .insert({
            room_id: roomId,
            user_id: null,
            guest_name: displayName,
            is_active: true,
            joined_at: new Date().toISOString(),
          });
      }
    }

    // Record presence heartbeat
    const presenceKey = userId || effectiveGuestId || displayName;
    recordHeartbeat(roomId, presenceKey);

    // Calculate adjusted timestamp for sync
    const updatedAt = new Date(room.updated_at || room.created_at).getTime();
    const now = Date.now();
    const elapsed = (now - updatedAt) / 1000;
    const adjustedTime = room.is_playing 
      ? room["current_time"] + elapsed 
      : room["current_time"];

    // Generate Stream token for voice/video
    const streamUserId = userId || effectiveGuestId || `guest_${Date.now()}`;
    const streamToken = generateStreamToken(streamUserId);

    console.log(`✅ ${displayName} joined room ${roomId}`);

    // Fire poddy notifications in the background
    if (userId) {
      try {
        const { notifyPoddyFriends } = require('./notifications');
        const { data: userData } = await supabase
          .from('users')
          .select('display_name')
          .eq('id', userId)
          .single();
        
        if (userData) {
          notifyPoddyFriends(userId, userData.display_name, roomId, room.name);
        }
      } catch (notifyErr) {
        console.error('Poddy notify error:', notifyErr.message);
      }
    }

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
      stream: {
        token: streamToken,
        api_key: process.env.STREAM_API_KEY,
        call_id: roomId,
        user_id: streamUserId,
        features: {
          screensharing: true,
          voice: true,
          video: true,
        }
      }
    });

  } catch (err) {
    console.error('Join room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/leave
// Leave a room
// --------------------------------------------------------
router.post('/:roomId/leave', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.auth?.userId || null;
    const { guest_name, guest_id } = req.body || {};

    // Respond immediately — don't block the client on cleanup work
    res.status(200).json({ message: 'Left room successfully' });

    // Run all leave logic in background, non-blocking
    setImmediate(async () => {
      try {
        const leftAt = new Date().toISOString();

        // 1. Deactivate leaving participant first
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

        // 2. Fetch room status and remaining participants
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

        // In-memory safeguard: ensure the leaving participant is excluded even if DB replication has slight delay
        const remainingParts = (rawParts || []).filter(p => {
          if (userId && p.user_id === userId) return false;
          if (!userId && guest_name && !p.user_id && p.guest_name?.trim().toLowerCase() === guest_name.trim().toLowerCase()) return false;
          return true;
        });

        const { count: remainingCount } = calculateDistinctViewers(remainingParts);

        if (remainingCount === 0) {
          await trashRoom(roomId, 'all_participants_left');
          console.log(`🗑️ Room ${roomId} trashed — all participants left`);
        } else if (room.host_id === userId) {
          const nextUser = (remainingParts || []).find(p => p.user_id && p.user_id !== userId);
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
// PATCH /api/rooms/:roomId/playback
// Update playback state — host only
// --------------------------------------------------------
router.patch('/:roomId/playback', requireAuth, requireHost, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { is_playing, current_time } = req.body;

    if (is_playing === undefined || current_time === undefined) {
      return res.status(400).json({ 
        error: 'is_playing and current_time are required' 
      });
    }

    const { error } = await supabase
  .from('rooms')
  .update({ 
    is_playing,
    "current_time": current_time,
    updated_at: new Date().toISOString(),
  })
  .eq('id', roomId);

    if (error) {
      return res.status(500).json({ error: 'Failed to update playback' });
    }

    console.log(`▶️ Playback updated in room ${roomId}: playing=${is_playing} time=${current_time}`);

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
// POST /api/rooms/:roomId/end
// End a room — host only
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

    // Mark all participants inactive
    await supabase
      .from('room_participants')
      .update({ 
        is_active: false,
        left_at: new Date().toISOString()
      })
      .eq('room_id', roomId)
      .eq('is_active', true);

    // End Stream call
    await endStreamCall(roomId);  
    console.log(`🔴 Room ${roomId} ended`);

    return res.status(200).json({ message: 'Room ended successfully' });

  } catch (err) {
    console.error('End room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/invite/regenerate
// Generate a new invite link — host only
// --------------------------------------------------------
router.post('/:roomId/invite/regenerate', requireAuth, requireHost, async (req, res) => {
  try {
    const { roomId } = req.params;
    const newToken = uuidv4();

    await supabase
      .from('rooms')
      .update({ invite_token: newToken })
      .eq('id', roomId);

    const inviteLink = 
      `${process.env.FRONTEND_URL}/room/${roomId}?invite=${newToken}`;

    console.log(`🔄 Invite link regenerated for room ${roomId}`);

    return res.status(200).json({ invite_link: inviteLink });

  } catch (err) {
    console.error('Regenerate invite error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --------------------------------------------------------
// POST /api/rooms/:roomId/heartbeat
// Heartbeat to keep participant and room active
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

    // Refresh participant active status in DB
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

    // Touch room updated_at
    await supabase
      .from('rooms')
      .update({ updated_at: nowIso })
      .eq('id', roomId);

    // Get current distinct active count
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
// GET /api/rooms/:roomId/participants
// Get all active participants in a room (deduplicated)
// --------------------------------------------------------
router.get('/:roomId/participants', async (req, res) => {
  try {
    const { roomId } = req.params;

    const { data: participants, error } = await supabase
      .from('room_participants')
      .select(`
        id,
        user_id,
        guest_name,
        joined_at,
        is_active,
        users (display_name, avatar_url)
      `)
      .eq('room_id', roomId)
      .eq('is_active', true)
      .order('joined_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch participants' });
    }

    // Deduplicate distinct active participants so users/guests are never duplicated
    const { participants: deduped } = calculateDistinctViewers(participants || []);

    const shaped = deduped.map(p => ({
      id: p.id,
      user_id: p.user_id,
      display_name: p.users?.display_name || p.guest_name || 'Guest',
      avatar_url: p.users?.avatar_url || null,
      joined_at: p.joined_at,
      is_guest: !p.user_id,
    }));

    return res.status(200).json({ participants: shaped, count: shaped.length });

  } catch (err) {
    console.error('Get participants error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
