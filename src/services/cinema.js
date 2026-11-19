const supabase = require('./supabase');
const { v4: uuidv4 } = require('uuid');
const { sendEmail } = require('./email');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const GATHERING_PERIOD_MS = Number(process.env.COMMUNITY_GATHERING_MS) || 40 * 60 * 1000; // 40 minutes
const MIN_BOOKINGS_FOR_PROMOTION = 2;

const SWEEGER_PICKS_CATEGORIES = [
  'All',
  'Nollywood',
  'Hollywood',
  'Drama',
  'Comedy',
  'Action',
  'Romance',
  'Adventure',
  'Horror',
  'Thriller',
  'Animation',
  'Documentary',
];

const COMMUNITY_MESSAGES = {
  general: 'General is for everyone watching the room. Public chat and reactions are available here.',
  watchmate_followed: 'People you follow are already watching, so we grouped you with them.',
  watchmate_random: 'No one you follow is here yet, so we randomly matched you with others new to Sweeger.',
  poddy: 'These are your friends. You both accepted each other into your Poddy, so you land here together whenever you are both watching.',
};

// Seed default Sweeger Picks catalog into Supabase if empty (fresh within 7 days)
async function ensureSeededSweegerPicks() {
  const { data: existing } = await supabase
    .from('cinema_movies')
    .select('id')
    .eq('source', 'sweeger_pick')
    .limit(1);

  if (existing && existing.length > 0) return;

  const now = Date.now();
  const seeds = [
    {
      title: 'The Last Kingdom',
      genre: 'Action · Adventure',
      industry: 'Hollywood',
      youtube_id: 'dQw4w9WgXcQ',
      thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      duration_minutes: 90,
      break_minutes: 10,
      source: 'sweeger_pick',
      posted_at: new Date(now - 2 * 24 * 3600000).toISOString(),
    },
    {
      title: 'Laugh Out Loud',
      genre: 'Comedy · Romance',
      industry: 'Nollywood',
      youtube_id: 'M7lc1UVf-VE',
      thumbnail: 'https://img.youtube.com/vi/M7lc1UVf-VE/hqdefault.jpg',
      duration_minutes: 105,
      break_minutes: 10,
      source: 'sweeger_pick',
      posted_at: new Date(now - 1 * 24 * 3600000).toISOString(),
    },
    {
      title: 'Midnight Stories',
      genre: 'Drama · Thriller',
      industry: 'Hollywood',
      youtube_id: 'aqz-KE-bpKQ',
      thumbnail: 'https://img.youtube.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
      duration_minutes: 110,
      break_minutes: 10,
      source: 'sweeger_pick',
      posted_at: new Date(now - 3 * 24 * 3600000).toISOString(),
    },
  ];

  const { data: insertedMovies } = await supabase
    .from('cinema_movies')
    .insert(seeds)
    .select();

  if (insertedMovies && insertedMovies.length > 0) {
    const showRows = [];
    const baseHour = new Date();
    baseHour.setMinutes(0, 0, 0);
    for (const movie of insertedMovies) {
      for (let h = 1; h <= 4; h++) {
        const starts = new Date(baseHour.getTime() + h * 3600000);
        showRows.push({
          movie_id: movie.id,
          title: movie.title,
          starts_at: starts.toISOString(),
          duration_minutes: movie.duration_minutes,
          break_minutes: movie.break_minutes,
          show_type: 'sweeger_pick',
          visibility: 'public',
          status: 'scheduled',
        });
      }
    }
    await supabase.from('cinema_shows').insert(showRows);
  }
}

function isFreshPick(postedAt) {
  const postedMs = new Date(postedAt).getTime();
  return Date.now() - postedMs < SEVEN_DAYS_MS;
}

function daysLeftForPick(postedAt) {
  const expiresAt = new Date(postedAt).getTime() + SEVEN_DAYS_MS;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

/**
 * Promotion rule from sweeger-priority-match-v2.html:
 * A public Community screening is promoted to Community Pick ONLY after
 * >= 2 bookings AND >= 40 minutes gathering period, before its start time.
 */
function isCommunityPickEligible(show, bookingCount = 0) {
  if (show.visibility === 'private') return false;
  const createdMs = new Date(show.created_at).getTime();
  const startsMs = new Date(show.starts_at).getTime();
  const now = Date.now();
  return (
    bookingCount >= MIN_BOOKINGS_FOR_PROMOTION &&
    now - createdMs >= GATHERING_PERIOD_MS &&
    startsMs > now
  );
}

function gatheringMinutesLeft(show) {
  const createdMs = new Date(show.created_at).getTime();
  const ms = Math.max(0, GATHERING_PERIOD_MS - (Date.now() - createdMs));
  return Math.ceil(ms / 60000);
}

/**
 * Check if a user already has an overlapping booked screening.
 */
async function hasBookingConflict(userId, targetShow) {
  const targetStart = new Date(targetShow.starts_at).getTime();
  const targetEnd = targetStart + Number(targetShow.duration_minutes || 120) * 60000;

  const { data: myBookings } = await supabase
    .from('cinema_bookings')
    .select('show_id')
    .eq('user_id', userId)
    .eq('status', 'booked');

  const showIds = (myBookings || []).map((b) => b.show_id).filter((id) => id !== targetShow.id);
  if (showIds.length === 0) return false;

  const { data: bookedShows } = await supabase
    .from('cinema_shows')
    .select('id, starts_at, duration_minutes')
    .in('id', showIds);

  return (bookedShows || []).some((s) => {
    const start = new Date(s.starts_at).getTime();
    const end = start + Number(s.duration_minutes || 120) * 60000;
    return start < targetEnd && end > targetStart;
  });
}

function doesProfileMatchCriteria(user, criteria = {}) {
  if (!user || !criteria) return false;
  if (criteria.gender && criteria.gender !== 'Any') {
    if (!user.gender || user.gender.toLowerCase() !== criteria.gender.toLowerCase()) {
      return false;
    }
  }
  if (criteria.min_age || criteria.max_age) {
    const age = Number(user.age);
    if (!Number.isFinite(age)) return false;
    if (criteria.min_age && age < Number(criteria.min_age)) return false;
    if (criteria.max_age && age > Number(criteria.max_age)) return false;
  }
  if (criteria.location && criteria.location !== 'Any') {
    if (!user.location || !user.location.toLowerCase().includes(criteria.location.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/**
 * Notify all users in the database whose onboarding profile matches a match request.
 * Already booked users get in-app + email; non-booked users get email.
 */
async function notifyMatchedUsers({ requesterId, requesterName, show, matchRequest }) {
  const { data: allUsers } = await supabase
    .from('users')
    .select('id, display_name, email, gender, age, location');

  const { data: showBookings } = await supabase
    .from('cinema_bookings')
    .select('user_id')
    .eq('show_id', show.id)
    .eq('status', 'booked');

  const bookedUserIds = new Set((showBookings || []).map((b) => b.user_id));

  const matchedBooked = [];
  const matchedUnbooked = [];

  for (const u of allUsers || []) {
    if (u.id === requesterId) continue;
    if (!doesProfileMatchCriteria(u, matchRequest)) continue;

    if (bookedUserIds.has(u.id)) {
      matchedBooked.push({ user_id: u.id, display_name: u.display_name });
      await supabase.from('notifications').insert({
        user_id: u.id,
        type: 'watch_request_match',
        title: `${requesterName} wants to watch ${show.title} with you`,
        body: `${requesterName} is looking for ${matchRequest.group_size} ${matchRequest.group_size === 1 ? 'person' : 'people'} for ${show.title}. Tap to accept and watch.`,
        data: { show_id: show.id, match_request_id: matchRequest.id, requester_id: requesterId },
        is_read: false,
      });
      await sendEmail({
        userId: u.id,
        to: u.email,
        subject: `${requesterName} wants to watch ${show.title} with you on Sweeger`,
        text: `${requesterName} created a watch request matching you for "${show.title}". Open Sweeger Cinema to accept and watch.`,
      });
    } else {
      matchedUnbooked.push({ user_id: u.id, display_name: u.display_name });
      await sendEmail({
        userId: u.id,
        to: u.email,
        subject: `${requesterName} wants to watch ${show.title} with you`,
        text: `${requesterName} is looking for someone to watch "${show.title}" on Sweeger. Book your seat to watch together.`,
      });
    }
  }

  return {
    already_booked_matches: matchedBooked,
    not_booked_matches: matchedUnbooked,
  };
}

/**
 * Pick or retrieve the random lobby admin before the show starts.
 */
async function ensureLobbyAdmin(show) {
  if (show.lobby_admin_id) return show.lobby_admin_id;

  const { data: bookings } = await supabase
    .from('cinema_bookings')
    .select('user_id')
    .eq('show_id', show.id)
    .eq('status', 'booked');

  if (!bookings || bookings.length === 0) return null;
  const randomIdx = Math.floor(Math.random() * bookings.length);
  const chosenId = bookings[randomIdx].user_id;

  await supabase
    .from('cinema_shows')
    .update({ lobby_admin_id: chosenId })
    .eq('id', show.id);

  return chosenId;
}

module.exports = {
  SEVEN_DAYS_MS,
  GATHERING_PERIOD_MS,
  MIN_BOOKINGS_FOR_PROMOTION,
  SWEEGER_PICKS_CATEGORIES,
  COMMUNITY_MESSAGES,
  ensureSeededSweegerPicks,
  isFreshPick,
  daysLeftForPick,
  isCommunityPickEligible,
  gatheringMinutesLeft,
  hasBookingConflict,
  doesProfileMatchCriteria,
  notifyMatchedUsers,
  ensureLobbyAdmin,
};
