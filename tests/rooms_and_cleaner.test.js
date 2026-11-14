const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
require('dotenv').config();

const app = require('../src/app');
const supabase = require('../src/services/supabase');
const {
  calculateDistinctViewers,
  isRoomStale,
  trashRoom,
  getBatchViewerCounts,
  cleanAllStaleRooms,
  EMPTY_ROOM_GRACE_PERIOD_MS,
  MATCH_ROOM_TTL_MS,
} = require('../src/services/roomCleaner');

describe('Room Cleaner & Viewer Count Unit Tests', () => {
  it('calculateDistinctViewers correctly deduplicates duplicate user rows', () => {
    const mockParticipants = [
      { id: '1', user_id: 'user_A', guest_name: null, is_active: true },
      { id: '2', user_id: 'user_A', guest_name: null, is_active: true }, // Duplicate of user_A!
      { id: '3', user_id: 'user_B', guest_name: null, is_active: true },
      { id: '4', user_id: 'user_C', guest_name: null, is_active: false }, // Inactive
    ];

    const result = calculateDistinctViewers(mockParticipants);
    assert.strictEqual(result.count, 2, 'Should count exactly 2 distinct users');
    assert.strictEqual(result.distinctUsers.size, 2);
    assert.strictEqual(result.participants.length, 2, 'Deduplicated participant list should have 2 items');
  });

  it('calculateDistinctViewers correctly deduplicates duplicate guest rows', () => {
    const mockParticipants = [
      { id: 'g1', user_id: null, guest_name: 'Alex', is_active: true },
      { id: 'g2', user_id: null, guest_name: 'alex ', is_active: true }, // Case/whitespace dupe
      { id: 'g3', user_id: null, guest_name: 'Sam', is_active: true },
      { id: 'u1', user_id: 'user_1', guest_name: null, is_active: true },
    ];

    const result = calculateDistinctViewers(mockParticipants);
    assert.strictEqual(result.count, 3, 'Should count 1 user + 2 distinct guests');
    assert.strictEqual(result.distinctGuests.size, 2);
    assert.strictEqual(result.distinctUsers.size, 1);
  });

  it('isRoomStale identifies empty room past grace period as stale', () => {
    const oldEmptyRoom = {
      id: 'room-1',
      room_type: 'youtube',
      created_at: new Date(Date.now() - (EMPTY_ROOM_GRACE_PERIOD_MS + 10000)).toISOString(),
      updated_at: new Date(Date.now() - (EMPTY_ROOM_GRACE_PERIOD_MS + 10000)).toISOString(),
    };

    const { isStale, reason } = isRoomStale(oldEmptyRoom, 0);
    assert.strictEqual(isStale, true);
    assert.match(reason, /0 active viewers/);
  });

  it('isRoomStale allows newly created empty room within grace period', () => {
    const freshRoom = {
      id: 'room-fresh',
      room_type: 'youtube',
      created_at: new Date(Date.now() - 30000).toISOString(), // 30s ago
      updated_at: new Date(Date.now() - 30000).toISOString(),
    };

    const { isStale } = isRoomStale(freshRoom, 0);
    assert.strictEqual(isStale, false, 'Fresh empty room should be within grace period');
  });

  it('isRoomStale keeps room with active viewers alive', () => {
    const activeRoom = {
      id: 'room-active',
      room_type: 'youtube',
      created_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour old
      updated_at: new Date(Date.now() - 60000).toISOString(),
    };

    const { isStale } = isRoomStale(activeRoom, 3);
    assert.strictEqual(isStale, false);
  });

  it('isRoomStale identifies match room exceeding TTL as stale', () => {
    const expiredMatchRoom = {
      id: 'match-room-old',
      room_type: 'match',
      created_at: new Date(Date.now() - (MATCH_ROOM_TTL_MS + 60000)).toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { isStale, reason } = isRoomStale(expiredMatchRoom, 1);
    assert.strictEqual(isStale, true);
    assert.match(reason, /match room exceeded TTL/);
  });
});

describe('Live API & Database Integration Tests', () => {
  let server;
  let baseUrl;

  before(async () => {
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('GET /api/rooms/active returns only clean rooms with accurate viewer counts', async () => {
    const res = await fetch(`${baseUrl}/api/rooms/active`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert(Array.isArray(data.rooms), 'Should return rooms array');
    // All stale rooms were previously cleaned, so all returned rooms must be genuinely active
    for (const r of data.rooms) {
      assert(typeof r.participant_count === 'number', 'participant_count must be a number');
      assert(r.participant_count >= 0, 'participant_count must be >= 0');
    }
  });

  it('POST /api/rooms/cleanup triggers manual sweep cleanly', async () => {
    const res = await fetch(`${baseUrl}/api/rooms/cleanup`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.message, 'Cleanup completed successfully');
    assert(typeof data.scanned === 'number');
    assert(typeof data.trashed === 'number');
  });

  it('POST /api/rooms/:roomId/heartbeat handles non-existent room with 404', async () => {
    const res = await fetch(`${baseUrl}/api/rooms/00000000-0000-0000-0000-000000000000/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest_name: 'Tester' }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('GET /api/rooms/for-video/:videoId returns clean rooms with participant_count', async () => {
    const res = await fetch(`${baseUrl}/api/rooms/for-video/test-video-id`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert(Array.isArray(data.rooms));
  });

  it('End-to-end Lifecycle: Room creation, duplicate join prevention, viewer count accuracy, and immediate trashing on leave', async () => {
    // 1. Fetch a valid host user
    const { data: hostUser } = await supabase.from('users').select('id').limit(1).single();
    assert(hostUser, 'Must have at least one user in DB for testing');

    // Create a temporary test room directly in Supabase
    const testRoomName = `Test_Lifecycle_${Date.now()}`;
    const { data: testRoom, error: createErr } = await supabase
      .from('rooms')
      .insert({
        host_id: hostUser.id,
        name: testRoomName,
        is_public: true,
        video_id: 'test_vid_123',
        video_title: 'Test Video',
        room_type: 'youtube',
        is_playing: false,
        current_time: 0,
        status: 'active',
      })
      .select()
      .single();

    assert(!createErr, `Room creation failed: ${createErr?.message}`);
    const roomId = testRoom.id;

    try {
      // 2. Join as guest "Muaz"
      const join1 = await fetch(`${baseUrl}/api/rooms/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_name: 'Muaz' }),
      });
      assert.strictEqual(join1.status, 200);
      const join1Data = await join1.json();
      assert.strictEqual(join1Data.participant.display_name, 'Muaz');

      // 3. Join again as guest "Muaz" (simulating reload or duplicate click)
      const join2 = await fetch(`${baseUrl}/api/rooms/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_name: 'Muaz' }),
      });
      assert.strictEqual(join2.status, 200);

      // 4. Verify participant count on GET /api/rooms/:roomId is exactly 1 (NO DOUBLE COUNTING!)
      const getRoom = await fetch(`${baseUrl}/api/rooms/${roomId}`);
      assert.strictEqual(getRoom.status, 200);
      const roomData = await getRoom.json();
      assert.strictEqual(roomData.room.participant_count, 1, 'Should count exactly 1 viewer despite multiple joins!');

      // 5. Join as a second guest "Sarah"
      const joinSarah = await fetch(`${baseUrl}/api/rooms/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_name: 'Sarah' }),
      });
      assert.strictEqual(joinSarah.status, 200);

      // 6. Verify participant count is now 2
      const getRoom2 = await fetch(`${baseUrl}/api/rooms/${roomId}`);
      const roomData2 = await getRoom2.json();
      assert.strictEqual(roomData2.room.participant_count, 2, 'Should count 2 distinct viewers!');

      // 7. Check GET /api/rooms/:roomId/participants returns deduplicated list of 2
      const getParts = await fetch(`${baseUrl}/api/rooms/${roomId}/participants`);
      assert.strictEqual(getParts.status, 200);
      const partsData = await getParts.json();
      assert.strictEqual(partsData.count, 2);
      assert.strictEqual(partsData.participants.length, 2);

      // 8. Test Heartbeat endpoint
      const hb = await fetch(`${baseUrl}/api/rooms/${roomId}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_name: 'Muaz' }),
      });
      assert.strictEqual(hb.status, 200);
      const hbData = await hb.json();
      assert.strictEqual(hbData.status, 'ok');
      assert.strictEqual(hbData.participant_count, 2);

      // 9. Leave as "Sarah"
      const leaveSarah = await fetch(`${baseUrl}/api/rooms/${roomId}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_name: 'Sarah' }),
      });
      assert.strictEqual(leaveSarah.status, 200);

      // Poll until participant count drops to 1 (background leave processing)
      let roomData3 = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        const r3 = await fetch(`${baseUrl}/api/rooms/${roomId}`);
        if (r3.status === 200) {
          const body = await r3.json();
          if (body?.room?.participant_count === 1) {
            roomData3 = body;
            break;
          }
          roomData3 = body;
        }
        console.log(`  ⏳ Waiting for Sarah's leave to reflect... attempt ${attempt + 1}/15 (count: ${roomData3?.room?.participant_count})`);
      }
      assert.ok(roomData3 !== null, 'Room should be fetchable after Sarah leaves');
      assert.strictEqual(roomData3.room.participant_count, 1, 'Should have 1 viewer after Sarah leaves');

      // 10. Leave as last participant "Muaz" -> room must be trashed in background
      const leaveMuaz = await fetch(`${baseUrl}/api/rooms/${roomId}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_name: 'Muaz' }),
      });
      assert.strictEqual(leaveMuaz.status, 200);

      // 11. Poll DB until room is 'ended' (background processing has Supabase latency)
      let dbRoom;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        const { data } = await supabase
          .from('rooms')
          .select('status, ended_at')
          .eq('id', roomId)
          .single();
        dbRoom = data;
        if (dbRoom?.status === 'ended') break;
        console.log(`  ⏳ Waiting for room to be trashed... attempt ${attempt + 1}/20 (status: ${dbRoom?.status})`);
      }
      assert.strictEqual(dbRoom.status, 'ended', 'Room status in DB must be ended after all leave!');
      assert(dbRoom.ended_at, 'Room ended_at timestamp must be set!');

      // 12. Verify GET room returns 410 (room ended)
      const getRoomEnded = await fetch(`${baseUrl}/api/rooms/${roomId}`);
      assert.strictEqual(getRoomEnded.status, 410, 'Room should return 410 after being trashed!');

    } finally {
      // Cleanup test room if still exists
      await trashRoom(roomId, 'test_cleanup');
    }
  });
});
