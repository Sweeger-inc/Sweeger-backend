const { 
  generateStreamToken, 
  createStreamCall, 
  endStreamCall 
} = require('../services/stream');

const express = require('express');
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
        is_playing,
        is_public,
        created_at,
        host_id,
        users!rooms_host_id_fkey (display_name, avatar_url),
        room_participants (count)
      `)
      .eq('status', 'active')
      .eq('is_public', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch active rooms error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch rooms' });
    }

    // Shape the response
    const shaped = rooms.map(room => ({
      id: room.id,
      name: room.name,
      video_id: room.video_id,
      video_title: room.video_title,
      video_thumbnail: room.video_thumbnail,
      is_playing: room.is_playing,
      created_at: room.created_at,
      host: room.users,
      participant_count: room.room_participants[0]?.count || 0,
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
        is_playing,
        created_at,
        host_id,
        users!rooms_host_id_fkey (display_name, avatar_url),
        room_participants (count)
      `)
      .eq('status', 'active')
      .eq('is_public', true)
      .eq('video_id', videoId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('For-video rooms error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch rooms' });
    }

    const shaped = rooms.map(room => ({
      id: room.id,
      name: room.name,
      video_id: room.video_id,
      video_title: room.video_title,
      video_thumbnail: room.video_thumbnail,
      is_playing: room.is_playing,
      created_at: room.created_at,
      host: room.users,
      participant_count: room.room_participants[0]?.count || 0,
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
        users!rooms_host_id_fkey (display_name, avatar_url),
        room_participants (count)
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

    // Get accurate active count
const { count: activeCount } = await supabase
  .from('room_participants')
  .select('*', { count: 'exact', head: true })
  .eq('room_id', roomId)
  .eq('is_active', true);

return res.status(200).json({
  room: {
    ...room,
    host_id: room.host_id,
    host: room.users,
    participant_count: activeCount || 0,
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
    const { invite, guest_name } = req.body || {};
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

    // Deactivate any existing session for this user first
if (userId) {
  await supabase
    .from('room_participants')
    .update({ is_active: false, left_at: new Date().toISOString() })
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .eq('is_active', true);
} else {
  // For guests clean up old sessions older than 10 minutes
  await supabase
    .from('room_participants')
    .update({ is_active: false, left_at: new Date().toISOString() })
    .eq('room_id', roomId)
    .is('user_id', null)
    .eq('is_active', true)
    .lt('joined_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
}

// Check capacity — max 12 participants
const { count } = await supabase
  .from('room_participants')
  .select('*', { count: 'exact', head: true })
  .eq('room_id', roomId)
  .eq('is_active', true);

if (count >= 12) {
  return res.status(403).json({ 
    error: 'room_full',
    message: 'This room is full. Create your own room for this video.'
  });
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
  displayName = guest_name;
}

    // Check if already a participant
    const { data: existing } = await supabase
  .from('room_participants')
  .select('id')
  .eq('room_id', roomId)
  .eq('user_id', userId)
  .single();

if (existing) {
  await supabase
    .from('room_participants')
    .update({ 
      is_active: true, 
      left_at: null, 
      joined_at: new Date().toISOString() 
    })
    .eq('id', existing.id);
} else {
  await supabase
    .from('room_participants')
    .insert({
      room_id: roomId,
      user_id: userId,
      guest_name: userId ? null : displayName,
      is_active: true,
    });
}

    // Calculate adjusted timestamp for sync
    const updatedAt = new Date(room.updated_at).getTime();
    const now = Date.now();
    const elapsed = (now - updatedAt) / 1000;
    const adjustedTime = room.is_playing 
      ? room["current_time"] + elapsed 
      : room["current_time"];

    // Generate Stream token for voice/video
const streamUserId = userId || `guest_${Date.now()}`;
const streamToken = generateStreamToken(streamUserId);

console.log(`✅ ${displayName} joined room ${roomId}`);

return res.status(200).json({
  room: {
    id: room.id,
    name: room.name,
    video_id: room.video_id,
    video_title: room.video_title,
    is_playing: room.is_playing,
    current_time: adjustedTime,
  },
  participant: {
    display_name: displayName,
    is_host: room.host_id === userId,
  },
  stream: {
    token: streamToken,
    api_key: process.env.STREAM_API_KEY,
    call_id: roomId,
    user_id: streamUserId,
    // Tell frontend what features are available
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

    // Mark participant as inactive
    await supabase
      .from('room_participants')
      .update({ 
        is_active: false,
        left_at: new Date().toISOString()
      })
      .eq('room_id', roomId)
      .eq('user_id', userId);

    // Check if leaver was the host
    const { data: room } = await supabase
      .from('rooms')
      .select('host_id')
      .eq('id', roomId)
      .single();

    if (room && room.host_id === userId) {
      // Find next participant to promote
      const { data: nextParticipant } = await supabase
        .from('room_participants')
        .select('user_id')
        .eq('room_id', roomId)
        .eq('is_active', true)
        .neq('user_id', userId)
        .order('joined_at', { ascending: true })
        .limit(1)
        .single();

      if (nextParticipant && nextParticipant.user_id) {
        // Promote next participant to host
        await supabase
          .from('rooms')
          .update({ host_id: nextParticipant.user_id })
          .eq('id', roomId);

        console.log(`👑 Host promoted: ${nextParticipant.user_id} in room ${roomId}`);
      } else {
        // No participants left — schedule room end
        console.log(`🏚️ No participants left in room ${roomId} — will auto-end`);
      }
    }

    console.log(`✅ User ${userId} left room ${roomId}`);
    return res.status(200).json({ message: 'Left room successfully' });

  } catch (err) {
    console.error('Leave room error:', err.message);
    return res.status(500).json({ error: 'Server error' });
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
// GET /api/rooms/:roomId/participants
// Get all active participants in a room
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

    const shaped = participants.map(p => ({
      id: p.id,
      user_id: p.user_id,
      display_name: p.users?.display_name || p.guest_name || 'Guest',
      avatar_url: p.users?.avatar_url || null,
      joined_at: p.joined_at,
      is_guest: !p.user_id,
    }));

    return res.status(200).json({ participants: shaped });

  } catch (err) {
    console.error('Get participants error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;