const supabase = require('./supabase');
const { endStreamCall } = require('./stream');

// Grace period before an empty room is considered stale (e.g. allow host to load/reconnect)
const EMPTY_ROOM_GRACE_PERIOD_MS = Number(process.env.EMPTY_ROOM_GRACE_PERIOD_MS) || 2 * 60 * 1000; // 2 minutes
// Match rooms expire after TTL
const MATCH_ROOM_TTL_MS = (Number(process.env.MATCH_ROOM_TTL_HOURS) || 4) * 60 * 60 * 1000; // 4 hours
// Max lifetime of inactive YouTube/screenshare room
const INACTIVE_ROOM_TTL_MS = (Number(process.env.INACTIVE_ROOM_TTL_HOURS) || 2) * 60 * 60 * 1000; // 2 hours
// Participant timeout (if no heartbeat/update in this time, participant is inactive)
const PARTICIPANT_HEARTBEAT_TIMEOUT_MS = Number(process.env.PARTICIPANT_TIMEOUT_MS) || 5 * 60 * 1000; // 5 minutes

// In-memory heartbeat tracker for rapid real-time presence check:
// Map<roomId, Map<participantKey, timestamp>>
const roomPresence = new Map();

/**
 * Record a heartbeat for a user or guest in a room
 */
const recordHeartbeat = (roomId, participantKey) => {
  if (!roomId || !participantKey) return;
  let roomMap = roomPresence.get(roomId);
  if (!roomMap) {
    roomMap = new Map();
    roomPresence.set(roomId, roomMap);
  }
  roomMap.set(participantKey, Date.now());
};

/**
 * Remove participant from in-memory presence
 */
const removePresence = (roomId, participantKey) => {
  const roomMap = roomPresence.get(roomId);
  if (roomMap) {
    if (participantKey) {
      roomMap.delete(participantKey);
    } else {
      roomPresence.delete(roomId);
    }
  }
};

/**
 * Calculate accurate distinct viewer count and deduplicated participants for a room
 * Prevents double-counting duplicate user records or multi-join guests.
 * 
 * @param {Array} participantRows - list of participant rows from Supabase
 * @returns {{ count: number, distinctUsers: Set<string>, distinctGuests: Set<string>, participants: Array }}
 */
const calculateDistinctViewers = (participantRows = []) => {
  const distinctUsers = new Set();
  const distinctGuests = new Set();
  const dedupedList = [];
  const seenKeys = new Set();

  for (const p of participantRows) {
    if (!p.is_active) continue;

    let key;
    if (p.user_id) {
      key = `user:${p.user_id}`;
      distinctUsers.add(p.user_id);
    } else {
      // For guests, identify by guest_name or participant id
      const guestIdentifier = p.guest_name ? p.guest_name.trim().toLowerCase() : p.id;
      key = `guest:${guestIdentifier}`;
      distinctGuests.add(guestIdentifier);
    }

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      dedupedList.push(p);
    }
  }

  return {
    count: distinctUsers.size + distinctGuests.size,
    distinctUsers,
    distinctGuests,
    participants: dedupedList,
  };
};

/**
 * Fetch accurate viewer counts for a list of room IDs in a single batched query
 * 
 * @param {string[]} roomIds
 * @returns {Promise<Map<string, { count: number, participants: Array }>>}
 */
const getBatchViewerCounts = async (roomIds) => {
  const result = new Map();
  if (!roomIds || roomIds.length === 0) return result;

  for (const id of roomIds) {
    result.set(id, { count: 0, participants: [] });
  }

  const { data: participants, error } = await supabase
    .from('room_participants')
    .select('id, room_id, user_id, guest_name, joined_at, is_active')
    .in('room_id', roomIds)
    .eq('is_active', true);

  if (error || !participants) {
    if (error) console.error('Error fetching batch viewer counts:', error.message);
    return result;
  }

  // Group by room_id
  const byRoom = new Map();
  for (const p of participants) {
    if (!byRoom.has(p.room_id)) byRoom.set(p.room_id, []);
    byRoom.get(p.room_id).push(p);
  }

  for (const [roomId, pList] of byRoom.entries()) {
    const { count, participants: deduped } = calculateDistinctViewers(pList);
    result.set(roomId, { count, participants: deduped });
  }

  return result;
};

/**
 * Immediately trash / end a stale room
 * 
 * @param {string} roomId
 * @param {string} reason
 */
const trashRoom = async (roomId, reason = 'stale') => {
  try {
    console.log(`🗑️ Trashing room ${roomId} (reason: ${reason})`);

    // 1. Mark room as ended
    await supabase
      .from('rooms')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
        is_playing: false,
      })
      .eq('id', roomId);

    // 2. Mark all participants inactive
    await supabase
      .from('room_participants')
      .update({
        is_active: false,
        left_at: new Date().toISOString(),
      })
      .eq('room_id', roomId)
      .eq('is_active', true);

    // 3. End Stream call asynchronously without blocking
    endStreamCall(roomId).catch(streamErr => {
      console.warn(`Stream call end warning for ${roomId}:`, streamErr.message);
    });

    // 4. Remove presence cache
    removePresence(roomId);

    console.log(`✅ Successfully trashed room ${roomId}`);
    return true;
  } catch (err) {
    console.error(`Failed to trash room ${roomId}:`, err.message);
    return false;
  }
};

/**
 * Check if a single room is stale
 * 
 * @param {Object} room - room object from DB
 * @param {number} activeViewerCount - real distinct active viewers
 * @returns {{ isStale: boolean, reason: string }}
 */
const isRoomStale = (room, activeViewerCount = 0) => {
  const now = Date.now();
  const createdAt = new Date(room.created_at).getTime();
  const updatedAt = new Date(room.updated_at || room.created_at).getTime();
  const age = now - createdAt;
  const idle = now - updatedAt;

  // 1. If 0 active viewers and room has passed initial creation grace period
  if (activeViewerCount === 0 && age > EMPTY_ROOM_GRACE_PERIOD_MS) {
    return { isStale: true, reason: `0 active viewers (empty for ${(age / 1000).toFixed(0)}s)` };
  }

  // 2. Match room TTL expiration
  if (room.room_type === 'match') {
    if (age > MATCH_ROOM_TTL_MS) {
      return { isStale: true, reason: `match room exceeded TTL (${(age / 3600000).toFixed(1)}h)` };
    }
    // Match room with 0 viewers older than grace period
    if (activeViewerCount === 0) {
      return { isStale: true, reason: 'match room with 0 active viewers' };
    }
  }

  // 3. YouTube / screenshare rooms: idle with no update for > 2 hours and low activity
  if (room.room_type !== 'match') {
    if (idle > INACTIVE_ROOM_TTL_MS && activeViewerCount === 0) {
      return { isStale: true, reason: `room idle with no viewers for ${(idle / 3600000).toFixed(1)}h` };
    }
    // Room older than 24 hours with no recent update
    if (age > 24 * 60 * 60 * 1000 && idle > 30 * 60 * 1000) {
      return { isStale: true, reason: `room older than 24h with no recent updates` };
    }
  }

  return { isStale: false, reason: null };
};

/**
 * Filter a list of rooms, trashes any stale rooms immediately, and returns only clean active rooms with accurate counts.
 * This guarantees the frontend NEVER receives a stale room.
 * 
 * @param {Array} rooms
 * @returns {Promise<Array>} clean active rooms with .participant_count populated
 */
const filterAndCleanStaleRooms = async (rooms = []) => {
  if (!rooms || rooms.length === 0) return [];

  const roomIds = rooms.map(r => r.id);
  const viewerCounts = await getBatchViewerCounts(roomIds);

  const cleanRooms = [];
  const staleRoomIds = [];

  for (const room of rooms) {
    const { count } = viewerCounts.get(room.id) || { count: 0 };
    const { isStale, reason } = isRoomStale(room, count);

    if (isStale) {
      staleRoomIds.push({ id: room.id, reason });
    } else {
      cleanRooms.push({
        ...room,
        participant_count: count,
      });
    }
  }

  // Trash stale rooms asynchronously
  if (staleRoomIds.length > 0) {
    Promise.all(staleRoomIds.map(({ id, reason }) => trashRoom(id, reason)))
      .catch(err => console.error('Error trashing stale rooms during filter:', err));
  }

  return cleanRooms;
};

/**
 * Scan ALL active rooms in Supabase and trash all stale rooms immediately
 * Used by the background cleaner and manual cleanup endpoint.
 * 
 * @returns {Promise<{ scanned: number, trashed: number, trashedRooms: Array }>}
 */
const cleanAllStaleRooms = async () => {
  try {
    const now = Date.now();
    const cutoff = new Date(now - PARTICIPANT_HEARTBEAT_TIMEOUT_MS).toISOString();

    // 1. Deactivate stale participant sessions where no heartbeat has been received within timeout
    const { error: partErr } = await supabase
      .from('room_participants')
      .update({
        is_active: false,
        left_at: new Date().toISOString(),
      })
      .eq('is_active', true)
      .lt('joined_at', cutoff);

    if (partErr) {
      console.error('Error deactivating stale participants:', partErr.message);
    }

    // 2. Prune in-memory presence tracker to avoid memory leaks
    for (const [roomId, participants] of roomPresence.entries()) {
      for (const [key, lastSeen] of participants.entries()) {
        if (now - lastSeen > PARTICIPANT_HEARTBEAT_TIMEOUT_MS) {
          participants.delete(key);
        }
      }
      if (participants.size === 0) {
        roomPresence.delete(roomId);
      }
    }

    // 3. Fetch all rooms currently marked active
    const { data: activeRooms, error } = await supabase
      .from('rooms')
      .select('id, name, room_type, created_at, updated_at, status, host_id')
      .eq('status', 'active');

    if (error) {
      console.error('cleanAllStaleRooms error fetching rooms:', error.message);
      return { scanned: 0, trashed: 0, trashedRooms: [] };
    }

    if (!activeRooms || activeRooms.length === 0) {
      return { scanned: 0, trashed: 0, trashedRooms: [] };
    }

    const roomIds = activeRooms.map(r => r.id);
    const viewerCounts = await getBatchViewerCounts(roomIds);

    const trashedRooms = [];

    for (const room of activeRooms) {
      const { count } = viewerCounts.get(room.id) || { count: 0 };
      const { isStale, reason } = isRoomStale(room, count);

      if (isStale) {
        const success = await trashRoom(room.id, reason);
        if (success) {
          trashedRooms.push({ id: room.id, name: room.name, reason });
        }
      }
    }

    if (trashedRooms.length > 0) {
      console.log(`🧹 Cleaner finished: Trashed ${trashedRooms.length} of ${activeRooms.length} active rooms.`);
    }

    return {
      scanned: activeRooms.length,
      trashed: trashedRooms.length,
      trashedRooms,
    };
  } catch (err) {
    console.error('cleanAllStaleRooms unexpected error:', err.message);
    return { scanned: 0, trashed: 0, trashedRooms: [] };
  }
};

/**
 * Start the automatic background cleaner interval
 * 
 * @param {number} intervalMs - interval in milliseconds (default 30 seconds)
 * @returns {NodeJS.Timeout}
 */
let cleanerTimer = null;
const startRoomCleaner = (intervalMs = 30000) => {
  if (cleanerTimer) clearInterval(cleanerTimer);

  console.log(`⏱️ Starting automatic room cleaner (interval: ${intervalMs / 1000}s)`);

  // Run initial pass
  cleanAllStaleRooms();

  cleanerTimer = setInterval(() => {
    cleanAllStaleRooms();
  }, intervalMs);

  // Don't keep the Node.js event loop alive if only this timer is running
  if (cleanerTimer && cleanerTimer.unref) {
    cleanerTimer.unref();
  }

  return cleanerTimer;
};

const stopRoomCleaner = () => {
  if (cleanerTimer) {
    clearInterval(cleanerTimer);
    cleanerTimer = null;
    console.log('🛑 Automatic room cleaner stopped');
  }
};

module.exports = {
  calculateDistinctViewers,
  getBatchViewerCounts,
  trashRoom,
  isRoomStale,
  filterAndCleanStaleRooms,
  cleanAllStaleRooms,
  startRoomCleaner,
  stopRoomCleaner,
  recordHeartbeat,
  removePresence,
  EMPTY_ROOM_GRACE_PERIOD_MS,
  MATCH_ROOM_TTL_MS,
};
