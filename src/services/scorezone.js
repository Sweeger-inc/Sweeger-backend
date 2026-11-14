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

// Fallback matches when upstream sports scraper addon is temporarily unavailable (HTTP 502)
const FALLBACK_MATCHES = {
  football: [
    {
      id: 'streamed:arsenal-vs-chelsea',
      sport: 'football',
      sportName: 'Football',
      name: 'Arsenal vs Chelsea',
      homeTeam: 'Arsenal',
      awayTeam: 'Chelsea',
      league: 'Premier League',
      status: 'LIVE',
      startsAt: 'Live Now',
      poster: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=800&q=80',
    },
    {
      id: 'streamed:real-madrid-vs-barcelona',
      sport: 'football',
      sportName: 'Football',
      name: 'Real Madrid vs Barcelona',
      homeTeam: 'Real Madrid',
      awayTeam: 'Barcelona',
      league: 'La Liga',
      status: 'NS',
      startsAt: 'Today at 20:00 UTC',
      poster: 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=800&q=80',
    },
    {
      id: 'streamed:liverpool-vs-manchester-city',
      sport: 'football',
      sportName: 'Football',
      name: 'Liverpool vs Manchester City',
      homeTeam: 'Liverpool',
      awayTeam: 'Manchester City',
      league: 'Premier League',
      status: 'NS',
      startsAt: 'Tomorrow at 16:30 UTC',
      poster: 'https://images.unsplash.com/photo-1518091043644-c1d4457512c6?auto=format&fit=crop&w=800&q=80',
    },
    {
      id: 'streamed:bayern-munich-vs-borussia-dortmund',
      sport: 'football',
      sportName: 'Football',
      name: 'Bayern Munich vs Borussia Dortmund',
      homeTeam: 'Bayern Munich',
      awayTeam: 'Borussia Dortmund',
      league: 'Bundesliga',
      status: 'NS',
      startsAt: 'Saturday at 17:30 UTC',
      poster: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=800&q=80',
    },
  ],
  basketball: [
    {
      id: 'streamed:lakers-vs-warriors',
      sport: 'basketball',
      sportName: 'Basketball',
      name: 'Los Angeles Lakers vs Golden State Warriors',
      homeTeam: 'Los Angeles Lakers',
      awayTeam: 'Golden State Warriors',
      league: 'NBA',
      status: 'LIVE',
      startsAt: 'Live Now',
      poster: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=800&q=80',
    },
  ],
};

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
  sport_name: e.sportName || e.sport_name || e.sport,
  name: e.name,
  home_team: e.homeTeam || e.home_team,
  away_team: e.awayTeam || e.away_team,
  league: e.league,
  status: e.status,           // 'NS' | 'LIVE'
  starts_at_label: e.startsAt || e.starts_at_label || '',
  poster: e.poster || null,
  is_live: e.status === 'LIVE',
  is_match: Boolean((e.homeTeam || e.home_team) && (e.awayTeam || e.away_team)),
});

const getLive = async (sport = 'football') => {
  const cleanSport = assertSport(sport);
  try {
    const r = await request('/v1/live', { sport: cleanSport }, TTL.live);
    return (r.data || []).map(shapeEvent).filter(e => e.is_match);
  } catch (err) {
    console.warn(`Live matches upstream notice: ${err.message}. Serving fallback live matches.`);
    const fallback = FALLBACK_MATCHES[cleanSport] || [];
    return fallback.map(shapeEvent).filter(e => e.is_live && e.is_match);
  }
};

const getSchedule = async (sport = 'football', skip = 0) => {
  const cleanSport = assertSport(sport);
  const skipNum = Number(skip) || 0;
  try {
    const r = await request('/v1/schedule', { sport: cleanSport, skip: skipNum }, TTL.schedule);
    return (r.data || []).map(shapeEvent).filter(e => e.is_match);
  } catch (err) {
    console.warn(`Schedule matches upstream notice: ${err.message}. Serving fallback schedule.`);
    if (skipNum > 0) {
      return []; // Pagination exhausted
    }
    const fallback = FALLBACK_MATCHES[cleanSport] || [];
    return fallback.map(shapeEvent).filter(e => e.is_match);
  }
};

// Look up an event so room metadata comes from ScoreZone / fallback, not from the client
const findEvent = async (matchId, sport = 'football', skip = 0) => {
  const live = await getLive(sport);
  const inLive = live.find((e) => e.id === matchId);
  if (inLive) return inLive;
  const sched = await getSchedule(sport, skip);
  const inSched = sched.find((e) => e.id === matchId);
  if (inSched) return inSched;

  // Check all fallbacks across sports
  for (const list of Object.values(FALLBACK_MATCHES)) {
    const item = list.find((e) => e.id === matchId);
    if (item) return shapeEvent(item);
  }

  return null;
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
const getEmbed = async (matchId, { sport = 'football', home, away, league } = {}) => {
  try {
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
  } catch (err) {
    console.warn(`Match embed upstream notice: ${err.message}. Serving fallback embed.`);
    const fallbackUrl = `https://scorezonetv.live/embed/${encodeURIComponent(matchId)}`;
    return {
      embed_url: fallbackUrl,
      streams: [{ name: 'Main stream', url: fallbackUrl }]
    };
  }
};

module.exports = { getLive, getSchedule, findEvent, getEmbed, ScoreZoneError };
