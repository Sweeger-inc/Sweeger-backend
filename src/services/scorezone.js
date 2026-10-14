// ------------------------------------------------------------------
// ScoreZone Public Sports API client (server-side only).
// The API key NEVER leaves the backend — the frontend talks to
// /api/matches/* and never sees ScoreZone credentials.
// ------------------------------------------------------------------
require('dotenv').config();

const BASE = (process.env.SCOREZONE_API_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.SCOREZONE_API_KEY || '';
const TIMEOUT_MS = 8000;

// Only iframe hosts we trust. Protects users if the upstream ever
// returns something unexpected.
const ALLOWED_EMBED_HOSTS = (process.env.SCOREZONE_EMBED_HOSTS || 'scorezonetv.live')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const TTL = {
  live: 30 * 1000,          // live list changes fast
  schedule: 5 * 60 * 1000,
  embed: 2 * 60 * 1000,
};

const SPORT_RE = /^[a-z0-9-]{2,32}$/;

class ScoreZoneError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const cache = new Map();     // key -> { value, expires }
const inflight = new Map();  // key -> Promise (de-dupes concurrent calls)

async function request(path, params = {}, ttl = 0) {
  if (!BASE || !API_KEY) {
    throw new ScoreZoneError('ScoreZone is not configured', 503);
  }

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const key = url.toString();

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const res = await fetch(url, {
        headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new ScoreZoneError(`ScoreZone responded ${res.status}`, res.status === 400 ? 400 : 502);
      }
      const json = await res.json();
      if (ttl) cache.set(key, { value: json, expires: Date.now() + ttl });
      return json;
    } catch (err) {
      // Serve stale data rather than breaking the page if upstream blips
      if (hit) {
        console.warn(`ScoreZone error, serving stale cache: ${err.message}`);
        return hit.value;
      }
      if (err instanceof ScoreZoneError) throw err;
      throw new ScoreZoneError(`ScoreZone unreachable: ${err.message}`, 502);
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

const assertSport = (sport = 'football') => {
  if (!SPORT_RE.test(sport)) throw new ScoreZoneError('Invalid sport', 400);
  return sport;
};

const shapeEvent = (e) => ({
  id: e.id,
  sport: e.sport,
  sport_name: e.sportName,
  name: e.name,
  home_team: e.homeTeam,
  away_team: e.awayTeam,
  league: e.league,
  status: e.status,           // 'NS' | 'LIVE'
  starts_at_label: e.startsAt, // human string e.g. "Today at 19:30 UTC" (not machine-parseable)
  poster: e.poster || null,
  is_live: e.status === 'LIVE',
  is_match: Boolean(e.homeTeam && e.awayTeam),
});

const getLive = async (sport) => {
  const r = await request('/v1/live', { sport: assertSport(sport) }, TTL.live);
  return (r.data || []).map(shapeEvent).filter(e => e.is_match);
};

const getSchedule = async (sport, skip = 0) => {
  const r = await request('/v1/schedule', { sport: assertSport(sport), skip: Number(skip) || 0 }, TTL.schedule);
  return (r.data || []).map(shapeEvent).filter(e => e.is_match);
};

// Look up an event so room metadata comes from ScoreZone, not from the client
const findEvent = async (matchId, sport, skip = 0) => {
  const live = await getLive(sport);
  const inLive = live.find((e) => e.id === matchId);
  if (inLive) return inLive;
  const sched = await getSchedule(sport, skip);
  return sched.find((e) => e.id === matchId) || null;
};

const isAllowedEmbed = (u) => {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_EMBED_HOSTS.some((a) => host === a || host.endsWith('.' + a));
  } catch {
    return false;
  }
};

// Returns { embed_url, streams[] } or { embed_url: null, streams: [] } when
// nothing playable (locked / not yet available).
const getEmbed = async (matchId, { sport, home, away, league } = {}) => {
  const r = await request(
    `/v1/matches/${encodeURIComponent(matchId)}`,
    { sport: assertSport(sport), home, away, league },
    TTL.embed
  );
  const d = r.data || {};

  const streams = (d.streams || [])
    .filter((s) => s.type === 'embed' && !s.locked && isAllowedEmbed(s.url))
    .map((s) => ({ name: s.name, url: s.url }));

  let embedUrl = isAllowedEmbed(d.embedUrl) ? d.embedUrl : null;
  if (!embedUrl && streams.length) embedUrl = streams[0].url;

  return { embed_url: embedUrl, streams };
};

module.exports = { getLive, getSchedule, findEvent, getEmbed, ScoreZoneError };
