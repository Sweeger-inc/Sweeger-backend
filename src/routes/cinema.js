const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const cinema = require('../services/cinema');
const walletService = require('../services/wallet');
const { extractYouTubeId, getVideoMetadata } = require('../services/youtube');
const { generateStreamToken, createStreamCall } = require('../services/stream');
const realtime = require('../services/realtime');

const ALLOWED_BREAKS = [0, 5, 10, 15];

// Lock for group-size-1 match acceptance races
const matchAcceptLocks = new Map();
async function withMatchLock(requestId, fn) {
  while (matchAcceptLocks.has(requestId)) {
    await matchAcceptLocks.get(requestId);
  }
  let release;
  const p = new Promise((r) => {
    release = r;
  });
  matchAcceptLocks.set(requestId, p);
  try {
    return await fn();
  } finally {
    matchAcceptLocks.delete(requestId);
    release();
  }
}

// --------------------------------------------------------
// GET /api/cinema/youtube-meta?url=...
// Fetches title, author, and thumbnail for a YouTube video link
// --------------------------------------------------------
router.get('/youtube-meta', async (req, res) => {
  try {
    const { url } = req.query;
    const videoId = extractYouTubeId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube link or video ID' });
    }
    const meta = await getVideoMetadata(videoId);
    return res.status(200).json(meta);
  } catch (err) {
    console.error('YouTube meta error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch YouTube metadata' });
  }
});

// --------------------------------------------------------
// GET /api/cinema/picks — Sweeger Picks (7-day freshness, category + search)
// --------------------------------------------------------
router.get('/picks', optionalAuth, async (req, res) => {
  try {
    await cinema.ensureSeededSweegerPicks();
    const { category = 'All', q = '' } = req.query;
    const userId = req.auth?.userId || null;

    const { data: movies, error } = await supabase
      .from('cinema_movies')
      .select('*')
      .eq('source', 'sweeger_pick')
      .order('posted_at', { ascending: false });

    if (error) throw error;

    let fresh = (movies || []).filter((m) => cinema.isFreshPick(m.posted_at));

    if (category && category !== 'All') {
      const catLower = String(category).toLowerCase();
      fresh = fresh.filter(
        (m) =>
          (m.industry && m.industry.toLowerCase() === catLower) ||
          (m.genre && m.genre.toLowerCase().includes(catLower))
      );
    }

    if (q && String(q).trim()) {
      const needle = String(q).trim().toLowerCase();
      fresh = fresh.filter((m) => m.title && m.title.toLowerCase().includes(needle));
    }

    const movieIds = fresh.map((m) => m.id);
    let showsByMovie = new Map();

    if (movieIds.length > 0) {
      const { data: shows } = await supabase
        .from('cinema_shows')
        .select('*')
        .in('movie_id', movieIds)
        .order('starts_at', { ascending: true });

      const showIds = (shows || []).map((s) => s.id);
      let bookingsByShow = new Map();
      let myBookedShows = new Set();

      if (showIds.length > 0) {
        const { data: bookings } = await supabase
          .from('cinema_bookings')
          .select('show_id, user_id, status')
          .in('show_id', showIds)
          .eq('status', 'booked');

        for (const b of bookings || []) {
          bookingsByShow.set(b.show_id, (bookingsByShow.get(b.show_id) || 0) + 1);
          if (userId && b.user_id === userId) myBookedShows.add(b.show_id);
        }
      }

      for (const s of shows || []) {
        if (!showsByMovie.has(s.movie_id)) showsByMovie.set(s.movie_id, []);
        showsByMovie.get(s.movie_id).push({
          ...s,
          booked_count: bookingsByShow.get(s.id) || 0,
          user_booked: myBookedShows.has(s.id),
        });
      }
    }

    const nowMs = Date.now();
    const shaped = fresh.map((m) => {
      const movieShows = showsByMovie.get(m.id) || [];
      const upcoming = movieShows.filter((s) => new Date(s.starts_at).getTime() > nowMs);
      const nextShow = upcoming[0] || movieShows[0] || null;
      return {
        ...m,
        days_left: cinema.daysLeftForPick(m.posted_at),
        days_left_label: `${cinema.daysLeftForPick(m.posted_at)}d left`,
        next_show: nextShow,
        upcoming_shows_count: upcoming.length,
      };
    });

    return res.status(200).json({
      categories: cinema.SWEEGER_PICKS_CATEGORIES,
      count: shaped.length,
      picks: shaped,
    });
  } catch (err) {
    console.error('Get cinema picks error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Sweeger Picks' });
  }
});

// --------------------------------------------------------
// GET /api/cinema/picks/:movieId — Movie detail with upcoming shows, invites, and match requests
// --------------------------------------------------------
router.get('/picks/:movieId', optionalAuth, async (req, res) => {
  try {
    await cinema.ensureSeededSweegerPicks();
    const { movieId } = req.params;
    const userId = req.auth?.userId || null;

    const { data: movie } = await supabase
      .from('cinema_movies')
      .select('*')
      .eq('id', movieId)
      .maybeSingle();

    if (!movie || !cinema.isFreshPick(movie.posted_at)) {
      return res.status(404).json({ error: 'Movie not found or expired' });
    }

    const { data: shows } = await supabase
      .from('cinema_shows')
      .select('*')
      .eq('movie_id', movieId)
      .order('starts_at', { ascending: true });

    const showIds = (shows || []).map((s) => s.id);
    const [bookingsRes, requestsRes, invitesRes, meRes] = await Promise.all([
      showIds.length
        ? supabase.from('cinema_bookings').select('show_id, user_id').in('show_id', showIds).eq('status', 'booked')
        : { data: [] },
      showIds.length
        ? supabase.from('cinema_match_requests').select('*').in('show_id', showIds).eq('status', 'open')
        : { data: [] },
      userId && showIds.length
        ? supabase.from('cinema_friend_invites').select('*').in('show_id', showIds).eq('invitee_id', userId).eq('status', 'pending')
        : { data: [] },
      userId
        ? supabase.from('users').select('id, gender, age, location').eq('id', userId).maybeSingle()
        : { data: null },
    ]);

    const me = meRes.data;
    const nowMs = Date.now();

    const shapedShows = (shows || []).map((s) => {
      const showBookings = (bookingsRes.data || []).filter((b) => b.show_id === s.id);
      const showRequests = (requestsRes.data || []).filter((r) => r.show_id === s.id);
      const matchingRequests = me
        ? showRequests.filter((r) => r.requester_id !== userId && cinema.doesProfileMatchCriteria(me, r))
        : [];
      const showInvites = (invitesRes.data || []).filter((i) => i.show_id === s.id);

      return {
        ...s,
        booked_count: showBookings.length,
        user_booked: userId ? showBookings.some((b) => b.user_id === userId) : false,
        countdown_seconds: Math.max(0, Math.floor((new Date(s.starts_at).getTime() - nowMs) / 1000)),
        open_match_requests: showRequests.map((r) => ({
          id: r.id,
          requester_id: r.requester_id,
          requester_name: r.requester_name,
          group_size: r.group_size,
          label: `${r.requester_name || 'Someone'} is looking for ${r.group_size} ${r.group_size === 1 ? 'person' : 'people'}`,
          also_watch_with_general: Boolean(r.also_watch_with_general),
        })),
        matching_requests: matchingRequests,
        matching_requests_count: matchingRequests.length,
        friend_invites: showInvites,
        invited: showInvites.length > 0,
      };
    });

    const liveShows = shapedShows.filter(
      (s) => new Date(s.starts_at).getTime() <= nowMs && new Date(s.starts_at).getTime() + (s.duration_minutes || 90) * 60000 > nowMs
    );
    const upcomingShows = shapedShows.filter((s) => new Date(s.starts_at).getTime() > nowMs);
    const nextShow = upcomingShows[0] || null;

    return res.status(200).json({
      movie: {
        ...movie,
        days_left: cinema.daysLeftForPick(movie.posted_at),
      },
      watching_now: liveShows.reduce((acc, s) => acc + s.booked_count, 0),
      next_show: nextShow,
      upcoming_shows: upcomingShows,
    });
  } catch (err) {
    console.error('Get movie detail error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch movie details' });
  }
});

// --------------------------------------------------------
// GET /api/cinema/community — Community Picks, Gathering rooms, Share & Distributor posts
// --------------------------------------------------------
router.get('/community', optionalAuth, async (req, res) => {
  try {
    const userId = req.auth?.userId || null;
    const { category = 'All' } = req.query;

    const [{ data: shows }, { data: posts }] = await Promise.all([
      supabase.from('cinema_shows').select('*').eq('show_type', 'community').order('created_at', { ascending: false }),
      supabase.from('cinema_community_posts').select('*').order('created_at', { ascending: false }),
    ]);

    const showIds = (shows || []).map((s) => s.id);
    let bookings = [];
    if (showIds.length > 0) {
      const { data: bRows } = await supabase
        .from('cinema_bookings')
        .select('show_id, user_id')
        .in('show_id', showIds)
        .eq('status', 'booked');
      bookings = bRows || [];
    }

    const bookingsByShow = new Map();
    const myBookedShows = new Set();
    for (const b of bookings) {
      bookingsByShow.set(b.show_id, (bookingsByShow.get(b.show_id) || 0) + 1);
      if (userId && b.user_id === userId) myBookedShows.add(b.show_id);
    }

    const nowMs = Date.now();
    const catLower = String(category).toLowerCase();
    const matchesCat = (item) => {
      if (!category || category === 'All') return true;
      return (
        (item.industry && item.industry.toLowerCase() === catLower) ||
        (item.genre && item.genre.toLowerCase().includes(catLower))
      );
    };

    const communityPicks = [];
    const gatheringRooms = [];
    const privateRooms = [];
    const bookedPast = [];

    for (const s of shows || []) {
      const count = bookingsByShow.get(s.id) || 0;
      const userBooked = myBookedShows.has(s.id);
      const startsMs = new Date(s.starts_at).getTime();
      const enriched = {
        ...s,
        booked_count: count,
        user_booked: userBooked,
        gathering_minutes_left: cinema.gatheringMinutesLeft(s),
        is_community_pick: cinema.isCommunityPickEligible(s, count),
      };

      if (s.visibility === 'private') {
        if (userId && s.host_id === userId) privateRooms.push(enriched);
        continue;
      }

      if (!matchesCat(s)) continue;

      if (startsMs <= nowMs && userBooked) {
        bookedPast.push(enriched);
      } else if (enriched.is_community_pick) {
        communityPicks.push(enriched);
      } else if (startsMs > nowMs) {
        gatheringRooms.push(enriched);
      }
    }

    // Load distributor sessions & tickets
    const distPosts = (posts || []).filter((p) => p.post_type === 'distributor' && (p.review_status === 'live' || (userId && p.creator_id === userId)));
    const distIds = distPosts.map((d) => d.id);
    let sessions = [];
    let tickets = [];
    if (distIds.length > 0) {
      const { data: sessRows } = await supabase
        .from('distributor_sessions')
        .select('*')
        .in('post_id', distIds)
        .order('starts_at', { ascending: true });
      sessions = sessRows || [];

      if (userId && sessions.length > 0) {
        const { data: tRows } = await supabase
          .from('distributor_tickets')
          .select('session_id')
          .eq('user_id', userId)
          .in('session_id', sessions.map((x) => x.id));
        tickets = tRows || [];
      }
    }
    const ticketedSessions = new Set(tickets.map((t) => t.session_id));

    const distributorListings = distPosts.map((p) => {
      const postSessions = sessions
        .filter((s) => s.post_id === p.id)
        .map((s) => {
          const started = new Date(s.starts_at).getTime() <= nowMs;
          const hasTicket = ticketedSessions.has(s.id);
          let ctaState = 'get_ticket';
          if (!started && hasTicket) ctaState = 'booked';
          else if (started && hasTicket) ctaState = 'join';
          else if (started && !hasTicket) ctaState = 'started';
          return {
            ...s,
            started,
            has_ticket: hasTicket,
            now_showing: started && hasTicket,
            cta_state: ctaState,
            countdown_seconds: Math.max(0, Math.floor((new Date(s.starts_at).getTime() - nowMs) / 1000)),
          };
        });
      return {
        ...p,
        tag: 'DISTRIBUTOR',
        price_label: `from ₦${p.price_ngn} per seat`,
        sessions: postSessions,
      };
    });

    const sharePosts = (posts || [])
      .filter((p) => p.post_type === 'share')
      .map((p) => {
        const startsMs = p.starts_at ? new Date(p.starts_at).getTime() : nowMs + 3600000;
        const started = startsMs <= nowMs;
        return {
          ...p,
          now_showing: started,
          countdown_seconds: Math.max(0, Math.floor((startsMs - nowMs) / 1000)),
        };
      });

    return res.status(200).json({
      community_picks: communityPicks,
      gathering_viewers: gatheringRooms,
      private_rooms: privateRooms,
      booked_screenings: bookedPast,
      share_posts: sharePosts,
      distributor_listings: distributorListings,
    });
  } catch (err) {
    console.error('Get community cinema error:', err.message);
    return res.status(500).json({ error: 'Failed to load Community cinema' });
  }
});

// --------------------------------------------------------
// POST /api/cinema/community — Create screening (Priority Match), Share post, or Distributor upload
// --------------------------------------------------------
router.post('/community', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const body = req.body || {};
    const mode = body.mode || body.post_type || 'screening';

    if (mode === 'share') {
      const { title, when_label, youtube_url, starts_at } = body;
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'title (what to watch) is required' });
      }
      const videoId = youtube_url ? extractYouTubeId(youtube_url) : null;
      const meta = videoId ? await getVideoMetadata(videoId) : null;

      const { data: post, error } = await supabase
        .from('cinema_community_posts')
        .insert({
          creator_id: userId,
          post_type: 'share',
          title: String(title).trim(),
          when_label: when_label || 'Flexible',
          youtube_id: videoId,
          thumbnail: meta?.thumbnail || null,
          starts_at: starts_at || new Date(Date.now() + 30 * 60000).toISOString(),
          review_status: 'live',
        })
        .select()
        .single();

      if (error) throw error;
      return res.status(201).json({ message: 'Share post created', post });
    }

    if (mode === 'distributor') {
      const { title, description, price_ngn, sessions_per_day } = body;
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'content name (title) is required' });
      }
      const price = Math.round(Number(price_ngn));
      const sessionsCount = Number(sessions_per_day);
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: 'price_ngn must be greater than 0' });
      }
      if (!Number.isInteger(sessionsCount) || sessionsCount < 1 || sessionsCount > 10) {
        return res.status(400).json({ error: 'sessions_per_day must be between 1 and 10' });
      }

      const { data: post, error } = await supabase
        .from('cinema_community_posts')
        .insert({
          creator_id: userId,
          post_type: 'distributor',
          title: String(title).trim(),
          description: description ? String(description).trim() : '',
          price_ngn: price,
          sessions_per_day: sessionsCount,
          review_status: 'under_review',
        })
        .select()
        .single();

      if (error) throw error;

      return res.status(201).json({
        message: 'Your content cinema distribution is under review (up to 24 hours). Sweeger takes 30% and you keep 70%.',
        listing: post,
        commission_split: { creator_percent: 70, sweeger_percent: 30 },
      });
    }

    // Default mode === 'screening': sweeger-priority-match-v2.html Community screening / Priority Match
    const {
      youtube_url,
      youtube_id,
      starts_at,
      visibility = 'public',
      break_minutes = 10,
      duration_minutes = 120,
      priority_match_enabled = false,
      priority_criteria = null,
      genre = 'YouTube',
      industry = 'YouTube',
    } = body;

    const resolvedYoutubeId = youtube_id || extractYouTubeId(youtube_url);
    if (!resolvedYoutubeId) {
      return res.status(400).json({ error: 'Paste a valid YouTube video link first.' });
    }

    const startsMs = new Date(starts_at).getTime();
    if (!starts_at || !Number.isFinite(startsMs) || startsMs < Date.now() + 60000) {
      return res.status(400).json({ error: 'Choose a future start time.' });
    }

    const cleanVisibility = visibility === 'private' ? 'private' : 'public';
    const cleanBreak = ALLOWED_BREAKS.includes(Number(break_minutes)) ? Number(break_minutes) : 10;

    // Priority Match can ONLY be configured when creating a PUBLIC Community Pick
    let resolvedCriteria = null;
    const enablePriority = cleanVisibility === 'public' && Boolean(priority_match_enabled);
    if (enablePriority) {
      const c = priority_criteria || {};
      const minAge = Number(c.min_age ?? 21);
      const maxAge = Number(c.max_age ?? 35);
      const groupSize = Number(c.group_size ?? 3);

      if (!Number.isInteger(minAge) || !Number.isInteger(maxAge) || minAge < 18 || maxAge > 99 || minAge > maxAge) {
        return res.status(400).json({ error: 'Enter a valid Priority Match age range (18–99).' });
      }
      if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 8) {
        return res.status(400).json({ error: 'Priority Match group_size must be between 1 and 8.' });
      }

      resolvedCriteria = {
        gender: ['Any', 'Male', 'Female'].includes(c.gender) ? c.gender : 'Any',
        min_age: minAge,
        max_age: maxAge,
        location: String(c.location || 'Any').trim() || 'Any',
        group_size: groupSize,
      };
    }

    const meta = await getVideoMetadata(resolvedYoutubeId);
    const { data: hostUser } = await supabase
      .from('users')
      .select('display_name')
      .eq('id', userId)
      .maybeSingle();

    const { data: show, error: insertErr } = await supabase
      .from('cinema_shows')
      .insert({
        host_id: userId,
        host_name: hostUser?.display_name || 'Creator',
        title: meta?.title || 'YouTube video',
        youtube_id: resolvedYoutubeId,
        thumbnail: meta?.thumbnail || `https://img.youtube.com/vi/${resolvedYoutubeId}/hqdefault.jpg`,
        genre,
        industry,
        starts_at: new Date(startsMs).toISOString(),
        duration_minutes: Number(duration_minutes) || 120,
        break_minutes: cleanBreak,
        visibility: cleanVisibility,
        priority_match_enabled: enablePriority,
        priority_criteria: resolvedCriteria,
        show_type: 'community',
        status: 'scheduled',
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    return res.status(201).json({
      message:
        cleanVisibility === 'private'
          ? 'Your private room is ready.'
          : 'Your room is now gathering viewers.',
      show,
    });
  } catch (err) {
    console.error('Create community cinema error:', err.message);
    return res.status(500).json({ error: 'Failed to create community screening' });
  }
});

// --------------------------------------------------------
// POST /api/cinema/community/distributor/:id/publish — Step 3 after approval
// Upload thumbnail + video and generate daily sessions
// --------------------------------------------------------
router.post('/community/distributor/:id/publish', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { id } = req.params;
    const { thumbnail, video_url } = req.body || {};

    const { data: post } = await supabase
      .from('cinema_community_posts')
      .select('*')
      .eq('id', id)
      .eq('creator_id', userId)
      .eq('post_type', 'distributor')
      .maybeSingle();

    if (!post) return res.status(404).json({ error: 'Distributor listing not found' });
    if (post.review_status !== 'approved' && post.review_status !== 'live') {
      return res.status(403).json({
        error: 'not_approved',
        message: 'Uploading is only possible after approval.',
      });
    }
    if (!video_url || !thumbnail) {
      return res.status(400).json({ error: 'thumbnail and video_url are required' });
    }

    const { data: updated } = await supabase
      .from('cinema_community_posts')
      .update({
        thumbnail,
        video_url,
        review_status: 'live',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    // Generate daily sessions based on sessions_per_day
    const count = Number(post.sessions_per_day || 1);
    const intervalHours = Math.max(1, Math.floor(24 / count));
    const base = Date.now() + 30 * 60000;
    const sessionRows = [];
    for (let i = 0; i < count; i++) {
      sessionRows.push({
        post_id: id,
        creator_id: userId,
        title: post.title,
        price_ngn: post.price_ngn,
        starts_at: new Date(base + i * intervalHours * 3600000).toISOString(),
      });
    }

    const { data: sessions } = await supabase
      .from('distributor_sessions')
      .insert(sessionRows)
      .select();

    return res.status(200).json({
      message: 'Listing is now live on Community',
      listing: updated,
      sessions: sessions || [],
    });
  } catch (err) {
    console.error('Publish distributor error:', err.message);
    return res.status(500).json({ error: 'Failed to publish distributor content' });
  }
});

// --------------------------------------------------------
// PATCH /api/cinema/community/:id/break — Creator updates conversation break
// --------------------------------------------------------
router.patch('/community/:id/break', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { id } = req.params;
    const breakMinutes = Number(req.body?.break_minutes);

    if (!ALLOWED_BREAKS.includes(breakMinutes)) {
      return res.status(400).json({
        error: `break_minutes must be one of ${ALLOWED_BREAKS.join(', ')}`,
      });
    }

    const { data: show } = await supabase
      .from('cinema_shows')
      .select('id, host_id')
      .eq('id', id)
      .maybeSingle();

    if (!show) return res.status(404).json({ error: 'Screening not found' });
    if (show.host_id !== userId) {
      return res.status(403).json({ error: 'Only the room creator can manage the conversation break' });
    }

    const { data: updated, error } = await supabase
      .from('cinema_shows')
      .update({ break_minutes: breakMinutes, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({
      message: breakMinutes
        ? `Break updated to ${breakMinutes} minutes.`
        : 'Break disabled for this screening.',
      show: updated,
    });
  } catch (err) {
    console.error('Manage break error:', err.message);
    return res.status(500).json({ error: 'Failed to update conversation break' });
  }
});

// --------------------------------------------------------
// POST /api/cinema/community/sessions/:sessionId/ticket — Buy distributor ticket via Wallet
// --------------------------------------------------------
router.post('/community/sessions/:sessionId/ticket', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { sessionId } = req.params;

    const { data: session } = await supabase
      .from('distributor_sessions')
      .select('*')
      .eq('id', sessionId)
      .maybeSingle();

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data: existingTicket } = await supabase
      .from('distributor_tickets')
      .select('*')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existingTicket) {
      return res.status(200).json({ message: 'Ticket already purchased', ticket: existingTicket });
    }

    const payment = await walletService.purchaseWithWallet({
      buyerId: userId,
      creatorId: session.creator_id,
      priceNGN: Number(session.price_ngn),
      contentId: session.post_id,
      contentTitle: session.title,
      contentType: 'distributor_ticket',
      idempotencyKey: `dist_ticket:${sessionId}:${userId}`,
    });

    const { data: ticket, error } = await supabase
      .from('distributor_tickets')
      .insert({
        session_id: sessionId,
        post_id: session.post_id,
        user_id: userId,
        price_ngn: Number(session.price_ngn),
        creator_keeps_ngn: payment.creator_keeps_ngn,
        sweeger_fee_ngn: payment.sweeger_fee_ngn,
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      message: 'Ticket purchased successfully',
      ticket,
      wallet_balance_ngn: payment.buyer_balance_ngn,
    });
  } catch (err) {
    if (err instanceof walletService.WalletError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    console.error('Buy distributor ticket error:', err.message);
    return res.status(500).json({ error: 'Failed to purchase ticket' });
  }
});

// --------------------------------------------------------
// POST /api/cinema/shows/:showId/book
// Book a screening via General, Match, or Poddy
// --------------------------------------------------------
router.post('/shows/:showId/book', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { showId } = req.params;
    const {
      mode = 'general', // 'general' | 'match' | 'poddy'
      community_choice = 'general', // 'general' | 'watchmate' | 'poddy'
      priority_confirmed = false,
      match_criteria = null,
      invite_friend_ids = [],
    } = req.body || {};

    const { data: show } = await supabase
      .from('cinema_shows')
      .select('*')
      .eq('id', showId)
      .maybeSingle();

    if (!show) return res.status(404).json({ error: 'Screening not found' });

    if (new Date(show.starts_at).getTime() <= Date.now()) {
      return res.status(400).json({
        error: 'already_started',
        message: 'This screening has already started. New bookings are closed.',
      });
    }

    // Check overlapping screening time conflict
    const conflict = await cinema.hasBookingConflict(userId, show);
    if (conflict) {
      return res.status(409).json({
        error: 'schedule_conflict',
        message: 'You already have a screening booked during this time. Choose another screening.',
      });
    }

    // If Creator Priority Match is enabled on this Community Pick, check eligibility/confirmation
    const { data: me } = await supabase
      .from('users')
      .select('id, display_name, gender, age, location')
      .eq('id', userId)
      .maybeSingle();

    if (show.priority_match_enabled && show.priority_criteria && !priority_confirmed) {
      const autoMatch = me?.gender && me?.age ? cinema.doesProfileMatchCriteria(me, show.priority_criteria) : false;
      if (!autoMatch) {
        return res.status(400).json({
          error: 'priority_confirmation_required',
          message: 'Please confirm you match the host’s Priority Match criteria before booking.',
          priority_criteria: show.priority_criteria,
        });
      }
    }

    const activeCommunities = {
      general: community_choice === 'general',
      watchmate: community_choice === 'watchmate',
      poddy: community_choice === 'poddy',
    };

    const { data: booking, error: bookErr } = await supabase
      .from('cinema_bookings')
      .upsert(
        {
          show_id: showId,
          user_id: userId,
          mode,
          active_communities: activeCommunities,
          status: 'booked',
        },
        { onConflict: 'show_id,user_id' }
      )
      .select()
      .single();

    if (bookErr) throw bookErr;

    await cinema.ensureLobbyAdmin(show);

    realtime.publish('show', showId, 'lobby_joined', {
      user_id: userId,
      display_name: me?.display_name || 'Viewer',
    });

    let matchResult = null;
    if (mode === 'match') {
      const c = match_criteria || {};
      const groupSize = Math.max(1, Math.min(8, Number(c.group_size || 2)));
      const alsoGeneral = c.also_watch_with_general !== false;

      let privateRoomId = null;
      if (!alsoGeneral) {
        const { data: privRoom } = await supabase
          .from('cinema_private_groups')
          .insert({
            show_id: showId,
            creator_id: userId,
            member_ids: [userId],
            max_size: groupSize + 1,
          })
          .select()
          .single();
        privateRoomId = privRoom.id;

        await supabase
          .from('cinema_bookings')
          .update({ private_group_id: privateRoomId, active_communities: { general: false, watchmate: false, poddy: false } })
          .eq('id', booking.id);
      }

      const { data: matchRequest } = await supabase
        .from('cinema_match_requests')
        .insert({
          show_id: showId,
          requester_id: userId,
          requester_name: me?.display_name || 'Someone',
          gender: ['Any', 'Male', 'Female'].includes(c.gender) ? c.gender : 'Any',
          min_age: c.min_age ? Number(c.min_age) : null,
          max_age: c.max_age ? Number(c.max_age) : null,
          location: String(c.location || 'Any').trim() || 'Any',
          group_size: groupSize,
          also_watch_with_general: alsoGeneral,
          private_group_id: privateRoomId,
          accepted_user_ids: [],
          status: 'open',
        })
        .select()
        .single();

      const notificationsSummary = await cinema.notifyMatchedUsers({
        requesterId: userId,
        requesterName: me?.display_name || 'Someone',
        show,
        matchRequest,
      });

      matchResult = {
        match_request: matchRequest,
        ...notificationsSummary,
      };
    }

    let invited = [];
    if (mode === 'poddy' && Array.isArray(invite_friend_ids) && invite_friend_ids.length > 0) {
      for (const friendId of invite_friend_ids) {
        if (friendId === userId) continue;
        const { data: inv } = await supabase
          .from('cinema_friend_invites')
          .insert({
            show_id: showId,
            inviter_id: userId,
            inviter_name: me?.display_name || 'Your friend',
            invitee_id: friendId,
            status: 'pending',
          })
          .select()
          .single();
        if (inv) {
          invited.push(inv);
          await supabase.from('notifications').insert({
            user_id: friendId,
            type: 'cinema_friend_invite',
            title: `${me?.display_name || 'A Poddy friend'} invited you to watch ${show.title}`,
            body: `You're invited to join "${show.title}". Accept or decline in Cinema.`,
            data: { show_id: showId, invite_id: inv.id, inviter_id: userId },
            is_read: false,
          });
        }
      }
    }

    return res.status(200).json({
      message: "You're booked! Your selected community is active.",
      booking,
      match_result: matchResult,
      friend_invites: invited,
    });
  } catch (err) {
    console.error('Book cinema show error:', err.message);
    return res.status(500).json({ error: 'Failed to book screening' });
  }
});

// --------------------------------------------------------
// DELETE /api/cinema/shows/:showId/book — Cancel my seat
// --------------------------------------------------------
router.delete('/shows/:showId/book', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { showId } = req.params;

    await supabase
      .from('cinema_bookings')
      .update({ status: 'cancelled' })
      .eq('show_id', showId)
      .eq('user_id', userId);

    realtime.publish('show', showId, 'lobby_left', { user_id: userId });

    return res.status(200).json({ message: 'Your booking was cancelled.' });
  } catch (err) {
    console.error('Cancel booking error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// --------------------------------------------------------
// POST /api/cinema/match-requests/:requestId/accept
// Group size 1 closes immediately for everyone else;
// Auto-cancels any pending friend invite for the same show slot & notifies friend!
// --------------------------------------------------------
router.post('/match-requests/:requestId/accept', requireAuth, async (req, res) => {
  const userId = req.auth.userId;
  const { requestId } = req.params;

  try {
    const result = await withMatchLock(requestId, async () => {
      const { data: mr } = await supabase
        .from('cinema_match_requests')
        .select('*')
        .eq('id', requestId)
        .maybeSingle();

      if (!mr) return { status: 404, body: { error: 'Watch request not found' } };
      if (mr.status !== 'open') {
        return { status: 409, body: { error: 'This watch request has already been filled' } };
      }
      if (mr.requester_id === userId) {
        return { status: 400, body: { error: 'Cannot accept your own watch request' } };
      }

      const accepted = Array.isArray(mr.accepted_user_ids) ? [...mr.accepted_user_ids] : [];
      if (!accepted.includes(userId)) {
        accepted.push(userId);
      }

      const isNowFull = accepted.length >= Number(mr.group_size || 1);
      await supabase
        .from('cinema_match_requests')
        .update({
          accepted_user_ids: accepted,
          status: isNowFull ? 'closed' : 'open',
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestId);

      let privateGroupId = mr.private_group_id || null;
      if (privateGroupId) {
        const { data: pg } = await supabase
          .from('cinema_private_groups')
          .select('*')
          .eq('id', privateGroupId)
          .maybeSingle();

        if (pg) {
          const members = [...new Set([...(pg.member_ids || []), userId])];
          await supabase
            .from('cinema_private_groups')
            .update({ member_ids: members })
            .eq('id', privateGroupId);
        }
      }

      // Book seat for acceptor
      await supabase.from('cinema_bookings').upsert(
        {
          show_id: mr.show_id,
          user_id: userId,
          mode: 'match',
          private_group_id: privateGroupId,
          active_communities: privateGroupId
            ? { general: false, watchmate: false, poddy: false }
            : { general: true, watchmate: true, poddy: false },
          status: 'booked',
        },
        { onConflict: 'show_id,user_id' }
      );

      // PRD v7 §7.3: If user accepts a watch request while a friend's invite is also pending
      // for that slot, auto-cancel the friend's invite and notify the friend that user declined.
      const { data: pendingInvites } = await supabase
        .from('cinema_friend_invites')
        .select('*')
        .eq('show_id', mr.show_id)
        .eq('invitee_id', userId)
        .eq('status', 'pending');

      for (const inv of pendingInvites || []) {
        await supabase
          .from('cinema_friend_invites')
          .update({ status: 'cancelled_by_match_accept' })
          .eq('id', inv.id);

        await supabase.from('notifications').insert({
          user_id: inv.inviter_id,
          type: 'cinema_invite_declined',
          title: 'Show invite declined',
          body: 'Your friend declined your show invite after joining another watch group.',
          data: { show_id: mr.show_id, invite_id: inv.id, invitee_id: userId },
          is_read: false,
        });
      }

      return {
        status: 200,
        body: {
          message: 'Watch request accepted and booked',
          show_id: mr.show_id,
          request_closed: isNowFull,
          is_private_group: Boolean(privateGroupId),
          private_group_id: privateGroupId,
        },
      };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Accept match request error:', err.message);
    return res.status(500).json({ error: 'Failed to accept watch request' });
  }
});

// --------------------------------------------------------
// POST /api/cinema/invites/:inviteId/respond — Accept or decline a friend invite
// --------------------------------------------------------
router.post('/invites/:inviteId/respond', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { inviteId } = req.params;
    const { decision } = req.body || {};

    if (!['accept', 'decline'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be accept or decline' });
    }

    const { data: inv } = await supabase
      .from('cinema_friend_invites')
      .select('*')
      .eq('id', inviteId)
      .eq('invitee_id', userId)
      .eq('status', 'pending')
      .maybeSingle();

    if (!inv) return res.status(404).json({ error: 'Pending invite not found' });

    const nextStatus = decision === 'accept' ? 'accepted' : 'declined';
    await supabase
      .from('cinema_friend_invites')
      .update({ status: nextStatus })
      .eq('id', inviteId);

    if (decision === 'accept') {
      await supabase.from('cinema_bookings').upsert(
        {
          show_id: inv.show_id,
          user_id: userId,
          mode: 'poddy',
          active_communities: { general: true, watchmate: false, poddy: true },
          status: 'booked',
        },
        { onConflict: 'show_id,user_id' }
      );
    } else {
      await supabase.from('notifications').insert({
        user_id: inv.inviter_id,
        type: 'cinema_invite_declined',
        title: 'Show invite declined',
        body: 'Your friend declined your show invite.',
        data: { show_id: inv.show_id, invite_id: inviteId },
        is_read: false,
      });
    }

    return res.status(200).json({ message: `Invite ${nextStatus}`, show_id: inv.show_id });
  } catch (err) {
    console.error('Respond invite error:', err.message);
    return res.status(500).json({ error: 'Failed to respond to invite' });
  }
});

// --------------------------------------------------------
// GET /api/cinema/shows/:showId/lobby — Lobby countdown, waiting avatars, random admin
// --------------------------------------------------------
router.get('/shows/:showId/lobby', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { showId } = req.params;

    const { data: show } = await supabase
      .from('cinema_shows')
      .select('*')
      .eq('id', showId)
      .maybeSingle();

    if (!show) return res.status(404).json({ error: 'Screening not found' });

    const { data: myBooking } = await supabase
      .from('cinema_bookings')
      .select('*')
      .eq('show_id', showId)
      .eq('user_id', userId)
      .eq('status', 'booked')
      .maybeSingle();

    const { data: allBookings } = await supabase
      .from('cinema_bookings')
      .select('user_id, private_group_id, mode')
      .eq('show_id', showId)
      .eq('status', 'booked');

    let visibleBookings = allBookings || [];
    const isPrivateGroup = Boolean(myBooking?.private_group_id);

    // PRD v7 §7.4: For private groups, nobody outside the group appears in the waiting row
    if (isPrivateGroup) {
      visibleBookings = visibleBookings.filter(
        (b) => b.private_group_id === myBooking.private_group_id
      );
    } else {
      visibleBookings = visibleBookings.filter((b) => !b.private_group_id);
    }

    const userIds = [...new Set(visibleBookings.map((b) => b.user_id))];
    let userMap = new Map();
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, display_name, avatar_url')
        .in('id', userIds);
      for (const u of users || []) userMap.set(u.id, u);
    }

    const adminId = await cinema.ensureLobbyAdmin(show);
    const secondsLeft = Math.max(0, Math.floor((new Date(show.starts_at).getTime() - Date.now()) / 1000));

    return res.status(200).json({
      show_id: showId,
      title: show.title,
      starts_at: show.starts_at,
      seconds_left: secondsLeft,
      has_started: secondsLeft === 0,
      is_private_group: isPrivateGroup,
      admin_user_id: adminId,
      can_pass_crown: secondsLeft > 0 && adminId === userId,
      waiting: userIds.map((uid) => {
        const u = userMap.get(uid);
        return {
          user_id: uid,
          display_name: u?.display_name || 'Viewer',
          avatar_url: u?.avatar_url || null,
          has_crown: uid === adminId,
        };
      }),
    });
  } catch (err) {
    console.error('Get lobby error:', err.message);
    return res.status(500).json({ error: 'Failed to load lobby' });
  }
});

// --------------------------------------------------------
// POST /api/cinema/shows/:showId/lobby/pass-crown — Pass admin crown before show starts
// --------------------------------------------------------
router.post('/shows/:showId/lobby/pass-crown', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { showId } = req.params;
    const { target_user_id } = req.body || {};

    if (!target_user_id) {
      return res.status(400).json({ error: 'target_user_id is required' });
    }

    const { data: show } = await supabase
      .from('cinema_shows')
      .select('*')
      .eq('id', showId)
      .maybeSingle();

    if (!show) return res.status(404).json({ error: 'Screening not found' });

    if (new Date(show.starts_at).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Crown can only be passed before the show starts' });
    }

    const adminId = await cinema.ensureLobbyAdmin(show);
    if (adminId !== userId) {
      return res.status(403).json({ error: 'Only the current crown holder can pass the crown' });
    }

    const { data: targetBooking } = await supabase
      .from('cinema_bookings')
      .select('id')
      .eq('show_id', showId)
      .eq('user_id', target_user_id)
      .eq('status', 'booked')
      .maybeSingle();

    if (!targetBooking) {
      return res.status(404).json({ error: 'Target user has not booked this screening' });
    }

    await supabase
      .from('cinema_shows')
      .update({ lobby_admin_id: target_user_id })
      .eq('id', showId);

    realtime.publish('show', showId, 'crown_passed', {
      from_user_id: userId,
      to_user_id: target_user_id,
    });

    return res.status(200).json({
      message: 'Crown passed successfully',
      admin_user_id: target_user_id,
    });
  } catch (err) {
    console.error('Pass crown error:', err.message);
    return res.status(500).json({ error: 'Failed to pass crown' });
  }
});

// --------------------------------------------------------
// POST /api/cinema/shows/:showId/enter — Enter Show screen (live or rejoin)
// --------------------------------------------------------
router.post('/shows/:showId/enter', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { showId } = req.params;

    const { data: show } = await supabase
      .from('cinema_shows')
      .select('*')
      .eq('id', showId)
      .maybeSingle();

    if (!show) return res.status(404).json({ error: 'Screening not found' });

    const { data: booking } = await supabase
      .from('cinema_bookings')
      .select('*')
      .eq('show_id', showId)
      .eq('user_id', userId)
      .eq('status', 'booked')
      .maybeSingle();

    const started = new Date(show.starts_at).getTime() <= Date.now();
    if (started && !booking) {
      return res.status(403).json({
        error: 'booking_closed',
        message: 'Once the screening starts, new viewers cannot enter. Only booked viewers can rejoin.',
      });
    }

    const isPrivateGroup = Boolean(booking?.private_group_id);
    const callId = isPrivateGroup ? `cinema_${showId}_${booking.private_group_id}` : `cinema_${showId}`;
    await createStreamCall(callId, userId).catch(() => {});
    const streamToken = generateStreamToken(userId);

    const activeCommunities = booking?.active_communities || {
      general: true,
      watchmate: false,
      poddy: false,
    };

    const elapsedSeconds = started
      ? Math.max(0, Math.floor((Date.now() - new Date(show.starts_at).getTime()) / 1000))
      : 0;

    return res.status(200).json({
      show: {
        id: show.id,
        title: show.title,
        youtube_id: show.youtube_id,
        starts_at: show.starts_at,
        break_minutes: show.break_minutes || 0,
        elapsed_seconds: elapsedSeconds,
        // PRD v7 §7.5: plain YouTube embed, no custom playback controls
        embed_controls_policy: 'youtube_native_only',
      },
      is_private_group: isPrivateGroup,
      private_group_id: booking?.private_group_id || null,
      show_layer_switcher: !isPrivateGroup,
      show_general_chat_and_mute: !isPrivateGroup,
      active_communities: activeCommunities,
      stream: {
        token: streamToken,
        api_key: process.env.STREAM_API_KEY,
        call_id: callId,
        user_id: userId,
      },
    });
  } catch (err) {
    console.error('Enter cinema show error:', err.message);
    return res.status(500).json({ error: 'Failed to enter screening room' });
  }
});

// --------------------------------------------------------
// PATCH /api/cinema/shows/:showId/communities — Toggle General / Watch Mate / Poddy in room
// --------------------------------------------------------
router.patch('/shows/:showId/communities', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { showId } = req.params;
    const { general, watchmate, poddy } = req.body || {};

    const { data: booking } = await supabase
      .from('cinema_bookings')
      .select('*')
      .eq('show_id', showId)
      .eq('user_id', userId)
      .eq('status', 'booked')
      .maybeSingle();

    if (!booking) return res.status(404).json({ error: 'Booking not found for this screening' });
    if (booking.private_group_id) {
      return res.status(403).json({
        error: 'private_group_isolated',
        message: 'Private matched rooms are isolated from General and other communities.',
      });
    }

    const current = booking.active_communities || { general: true, watchmate: false, poddy: false };
    const next = {
      general: typeof general === 'boolean' ? general : Boolean(current.general),
      watchmate: typeof watchmate === 'boolean' ? watchmate : Boolean(current.watchmate),
      poddy: typeof poddy === 'boolean' ? poddy : Boolean(current.poddy),
    };

    await supabase
      .from('cinema_bookings')
      .update({ active_communities: next })
      .eq('id', booking.id);

    const activeNames = [];
    if (next.general) activeNames.push(cinema.COMMUNITY_MESSAGES.general);
    if (next.watchmate) activeNames.push(cinema.COMMUNITY_MESSAGES.watchmate_random);
    if (next.poddy) activeNames.push(cinema.COMMUNITY_MESSAGES.poddy);

    return res.status(200).json({
      active_communities: next,
      banner: activeNames.length
        ? activeNames.join(' ')
        : 'All communities are inactive. Activate one to connect with viewers.',
    });
  } catch (err) {
    console.error('Toggle show communities error:', err.message);
    return res.status(500).json({ error: 'Failed to update active communities' });
  }
});

// --------------------------------------------------------
// GET /api/cinema/shows/:showId/events — SSE real-time stream for Lobby & Show
// --------------------------------------------------------
router.get('/shows/:showId/events', optionalAuth, (req, res) => {
  realtime.attachSseStream(req, res, 'show', req.params.showId);
});

module.exports = router;
