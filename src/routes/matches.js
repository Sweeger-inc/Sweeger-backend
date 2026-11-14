const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { createStreamCall, endStreamCall } = require('../services/stream');
const sz = require('../services/scorezone');

// A match room is considered finished after this long (API has no end-time)
const MATCH_ROOM_TTL_MS = (Number(process.env.MATCH_ROOM_TTL_HOURS) || 6) * 60 * 60 * 1000;
const MATCH_ID_RE = /^[\w.:\-@~ %]{3,200}$/;

const handleError = (res, err, label) => {
  if (err instanceof sz.ScoreZoneError) {
    return res.status(err.status === 400 ? 400 : err.status === 503 ? 503 : 502)
      .json({ error: err.message });
  }
  console.error(`${label}:`, err.message);
  return res.status(500).json({ error: 'Server error' });
};

// Attach room info and participant count to events so the UI can show "12 watching"
const withRooms = async (events) => {
  if (!events || !events.length) return [];
  const matchIds = events.map((e) => e.id);
  const { data: rooms } = await supabase
    .from('rooms')
    .select('id, match_id')
    .eq('status', 'active')
    .in('match_id', matchIds);

  const byMatch = new Map((rooms || []).map((r) => [r.match_id, r.id]));
  const roomIds = (rooms || []).map((r) => r.id);

  let participantCounts = new Map();
  if (roomIds.length > 0) {
    const { data: participants } = await supabase
      .from('room_participants')
      .select('room_id')
      .in('room_id', roomIds)
      .eq('is_active', true);

    if (participants) {
      for (const p of participants) {
        participantCounts.set(p.room_id, (participantCounts.get(p.room_id) || 0) + 1);
      }
    }
  }

  return events.map((e) => {
    const roomId = byMatch.get(e.id) || null;
    return {
      id: e.id,
      name: e.name,
      home_team: e.home_team,
      away_team: e.away_team,
      league: e.league,
      status: e.status,
      is_live: e.is_live,
      starts_at_label: e.starts_at_label,
      poster: e.poster || null,
      room_id: roomId,
      sport: e.sport,
      participant_count: roomId ? (participantCounts.get(roomId) || 0) : 0,
    };
  });
};

// GET /api/matches/live?sport=football
router.get('/live', async (req, res) => {
  try {
    const events = await sz.getLive(req.query.sport || 'football');
    const shaped = await withRooms(events);
    return res.status(200).json({ count: shaped.length, matches: shaped });
  } catch (err) { return handleError(res, err, 'Matches live error'); }
});

// GET /api/matches/schedule?sport=football&skip=0
router.get('/schedule', async (req, res) => {
  try {
    const events = await sz.getSchedule(req.query.sport || 'football', req.query.skip);
    const shaped = await withRooms(events);
    return res.status(200).json({ count: shaped.length, matches: shaped });
  } catch (err) { return handleError(res, err, 'Matches schedule error'); }
});

// --------------------------------------------------------
// POST /api/matches/:matchId/room
// Get-or-create the single community room for a match.
// Body: { sport?: 'football', skip?: 0 }
// Then the client calls the existing POST /api/rooms/:id/join
// --------------------------------------------------------
router.post('/:matchId/room', requireAuth, async (req, res) => {
  try {
    const rawMatchId = req.params.matchId;
    const matchId = decodeURIComponent(rawMatchId).trim();
    const { sport = 'football', skip = 0, name, home_team, away_team, league, poster } = req.body || {};
    const userId = req.auth.userId;

    if (!MATCH_ID_RE.test(matchId)) {
      return res.status(400).json({ error: 'Invalid match id' });
    }

    // 1. Existing active room?
    const findActive = () => supabase
      .from('rooms')
      .select('id, created_at')
      .eq('match_id', matchId)
      .eq('status', 'active')
      .maybeSingle();

    let { data: existing } = await findActive();

    if (existing && Date.now() - new Date(existing.created_at).getTime() > MATCH_ROOM_TTL_MS) {
      // Stale room from an old match — retire it and start fresh
      await supabase.from('rooms')
        .update({ status: 'ended', ended_at: new Date().toISOString(), is_playing: false })
        .eq('id', existing.id);
      await supabase.from('room_participants')
        .update({ is_active: false, left_at: new Date().toISOString() })
        .eq('room_id', existing.id).eq('is_active', true);
      await endStreamCall(existing.id);
      existing = null;
    }

    if (existing) {
      return res.status(200).json({ room_id: existing.id, created: false });
    }

    // 2. Look up match metadata from ScoreZone / fallback, or body
    let event = await sz.findEvent(matchId, sport, skip);
    if (!event && (home_team || name)) {
      event = {
        id: matchId,
        name: name || (home_team && away_team ? `${home_team} vs ${away_team}` : matchId),
        home_team: home_team || 'Home',
        away_team: away_team || 'Away',
        league: league || 'Sports',
        sport: sport || 'football',
        poster: poster || null,
      };
    }

    if (!event) return res.status(404).json({ error: 'Match not found' });

    // 3. Create it. The unique index makes concurrent creates safe.
    const { data: room, error } = await supabase
      .from('rooms')
      .insert({
        host_id: userId,
        name: event.name,
        is_public: true,
        invite_token: null,
        video_id: null,
        video_title: event.name,
        video_thumbnail: event.poster,
        room_type: 'match',
        match_id: matchId,
        sport: event.sport || sport,
        match_meta: { home: event.home_team, away: event.away_team, league: event.league },
        is_playing: false,
        current_time: 0,
        status: 'active',
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') { // someone else won the race
        const { data: winner } = await findActive();
        if (winner) return res.status(200).json({ room_id: winner.id, created: false });
      }
      console.error('Match room create error:', error.message);
      return res.status(500).json({ error: 'Failed to create match room' });
    }

    await supabase.from('room_participants')
      .insert({ room_id: room.id, user_id: userId, is_active: true });

    await createStreamCall(room.id, userId);

    console.log(`✅ Match room ${room.id} created for ${matchId}`);
    return res.status(201).json({ room_id: room.id, created: true });
  } catch (err) { return handleError(res, err, 'Match room error'); }
});

// GET /api/matches/:matchId/embed?sport=football&home=..&away=..&league=..
router.get('/:matchId/embed', async (req, res) => {
  try {
    const rawMatchId = req.params.matchId;
    const matchId = decodeURIComponent(rawMatchId).trim();
    if (!MATCH_ID_RE.test(matchId)) {
      return res.status(400).json({ error: 'Invalid match id' });
    }
    const { sport = 'football', home, away, league } = req.query;
    const embed = await sz.getEmbed(matchId, { sport, home, away, league });
    return res.status(200).json({ match_id: matchId, ...embed });
  } catch (err) { return handleError(res, err, 'Match embed error'); }
});

module.exports = router;
