const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.NODE_ENV = 'development';

const app = require('../src/app');
const supabase = require('../src/services/supabase');
const cinemaService = require('../src/services/cinema');

describe('Sweeger PRD v7 & Priority Match v2 End-to-End Tests', () => {
  let server;
  let baseUrl;

  const authHeaders = (userId) => ({
    'Content-Type': 'application/json',
    'x-dev-user-id': userId,
  });

  before(async () => {
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    if (supabase.__resetStub) supabase.__resetStub();
  });

  it('Onboarding requires exactly 2 PRD v7 interests and About You fields', async () => {
    const bad = await fetch(`${baseUrl}/api/profile/onboarding`, {
      method: 'POST',
      headers: authHeaders('user_1'),
      body: JSON.stringify({
        interests: ['Football'],
        gender: 'Male',
        age: 25,
        location: 'Lagos, Nigeria',
      }),
    });
    assert.strictEqual(bad.status, 400);

    const ok = await fetch(`${baseUrl}/api/profile/onboarding`, {
      method: 'POST',
      headers: authHeaders('user_1'),
      body: JSON.stringify({
        interests: ['Football', 'Afrobeats'],
        gender: 'Male',
        age: 25,
        location: 'Lagos, Nigeria',
        display_name: 'Tunde',
        username: 'tunde',
        email: 'tunde@example.com',
      }),
    });
    assert.strictEqual(ok.status, 200);
    const data = await ok.json();
    assert.strictEqual(data.profile.onboarding_completed, true);
    assert.deepStrictEqual(data.profile.interests, ['Football', 'Afrobeats']);
  });

  it('Subscription config reflects ₦200/month and 30-day first month free; gates Poddy privacy & paid rooms', async () => {
    const cfgRes = await fetch(`${baseUrl}/api/subscriptions/config`);
    assert.strictEqual(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.strictEqual(cfg.monthly_price, 200);
    assert.strictEqual(cfg.free_trial_days, 30);
    assert.strictEqual(cfg.first_month_free, true);

    await supabase.from('users').insert({ id: 'host_1', display_name: 'Host One' });

    // Unsubscribed user cannot set Poddy privacy to followers_only or create paid room
    const privFail = await fetch(`${baseUrl}/api/poddy/privacy`, {
      method: 'PATCH',
      headers: authHeaders('host_1'),
      body: JSON.stringify({ privacy: 'followers_only' }),
    });
    assert.strictEqual(privFail.status, 403);

    const paidFail = await fetch(`${baseUrl}/api/rooms/paid`, {
      method: 'POST',
      headers: authHeaders('host_1'),
      body: JSON.stringify({ video_id: 'dQw4w9WgXcQ', video_title: 'Match Watch', video_thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg', price_ngn: 500 }),
    });
    assert.strictEqual(paidFail.status, 403);

    // Start trial -> both now succeed
    const trialRes = await fetch(`${baseUrl}/api/subscriptions/start-trial`, {
      method: 'POST',
      headers: authHeaders('host_1'),
    });
    assert.strictEqual(trialRes.status, 201);

    const privOk = await fetch(`${baseUrl}/api/poddy/privacy`, {
      method: 'PATCH',
      headers: authHeaders('host_1'),
      body: JSON.stringify({ privacy: 'followers_only' }),
    });
    assert.strictEqual(privOk.status, 200);
  });

  it('Paid Live room & Wallet: insufficient balance fails cleanly, payment credits host 70%, withdrawal stays Pending until admin pays', async () => {
    await supabase.from('users').insert([
      { id: 'creator_1', display_name: 'Creator' },
      { id: 'viewer_1', display_name: 'Viewer' },
    ]);
    await fetch(`${baseUrl}/api/subscriptions/start-trial`, {
      method: 'POST',
      headers: authHeaders('creator_1'),
    });

    const createPaid = await fetch(`${baseUrl}/api/rooms/paid`, {
      method: 'POST',
      headers: authHeaders('creator_1'),
      body: JSON.stringify({
        name: 'Premier League Watchalong',
        video_id: 'dQw4w9WgXcQ',
        video_title: 'Premier League Watchalong',
        video_thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        price_ngn: 500,
      }),
    });
    assert.strictEqual(createPaid.status, 201);
    const { room } = await createPaid.json();

    // Viewer with ₦0 cannot join
    const lowBal = await fetch(`${baseUrl}/api/rooms/${room.id}/pay-join`, {
      method: 'POST',
      headers: authHeaders('viewer_1'),
      body: JSON.stringify({}),
    });
    assert.strictEqual(lowBal.status, 402);
    const lowData = await lowBal.json();
    assert.match(lowData.message, /Insufficient wallet balance/);

    // Demo top up ₦1,000 then Pay & Join ₦500
    await fetch(`${baseUrl}/api/wallet/topup/demo`, {
      method: 'POST',
      headers: authHeaders('viewer_1'),
      body: JSON.stringify({ amount_ngn: 1000 }),
    });

    const payJoin = await fetch(`${baseUrl}/api/rooms/${room.id}/pay-join`, {
      method: 'POST',
      headers: authHeaders('viewer_1'),
      body: JSON.stringify({}),
    });
    assert.strictEqual(payJoin.status, 200);

    // Check balances: viewer = 500, creator = 350 (70% of 500)
    const viewerWallet = await (await fetch(`${baseUrl}/api/wallet`, { headers: authHeaders('viewer_1') })).json();
    const creatorWallet = await (await fetch(`${baseUrl}/api/wallet`, { headers: authHeaders('creator_1') })).json();
    assert.strictEqual(viewerWallet.balance_ngn, 500);
    assert.strictEqual(creatorWallet.creator_balance_ngn, 350);
    assert.strictEqual(creatorWallet.creator_breakdown[0].creator_keeps_ngn, 350);

    // Withdrawal request -> Pending -> Admin marks Paid
    const wdRes = await fetch(`${baseUrl}/api/wallet/withdrawals`, {
      method: 'POST',
      headers: authHeaders('creator_1'),
      body: JSON.stringify({ amount_ngn: 300, bank_name: 'GTBank', account_number: '0123456789' }),
    });
    assert.strictEqual(wdRes.status, 201);
    const wdBody = await wdRes.json();
    assert.strictEqual(wdBody.withdrawal.status, 'pending');
    assert.strictEqual(wdBody.creator_balance_ngn, 50);

    const paidRes = await fetch(`${baseUrl}/api/admin/withdrawals/${wdBody.withdrawal.id}`, {
      method: 'PATCH',
      headers: authHeaders('admin_1'),
      body: JSON.stringify({ status: 'paid', payout_reference: 'PAY-123' }),
    });
    assert.strictEqual(paidRes.status, 200);
    const paidBody = await paidRes.json();
    assert.strictEqual(paidBody.withdrawal.status, 'paid');
  });

  it('Poddy 20-cap swap and personal invite link work atomically', async () => {
    const users = [{ id: 'u_main', display_name: 'Main' }];
    for (let i = 1; i <= 21; i++) {
      users.push({ id: `u_${i}`, display_name: `Friend ${i}` });
    }
    await supabase.from('users').insert(users);

    // Fill u_main Poddy to 20
    const rels = [];
    for (let i = 1; i <= 20; i++) {
      rels.push({ requester_id: 'u_main', receiver_id: `u_${i}`, status: 'accepted' });
    }
    rels.push({ requester_id: 'u_21', receiver_id: 'u_main', status: 'pending' });
    await supabase.from('poddy_relationships').insert(rels);

    // Normal accept fails with poddy_full
    const fullRes = await fetch(`${baseUrl}/api/poddy/accept/u_21`, {
      method: 'POST',
      headers: authHeaders('u_main'),
    });
    assert.strictEqual(fullRes.status, 400);
    const fullData = await fullRes.json();
    assert.strictEqual(fullData.error, 'poddy_full');

    // Swap u_1 out for u_21
    const swapRes = await fetch(`${baseUrl}/api/poddy/accept/u_21/swap`, {
      method: 'POST',
      headers: authHeaders('u_main'),
      body: JSON.stringify({ remove_user_id: 'u_1' }),
    });
    assert.strictEqual(swapRes.status, 200);

    // Personal invite link adds mutually without request
    await supabase.from('users').insert({ id: 'u_inviter', display_name: 'Inviter' });
    await supabase.from('users').insert({ id: 'u_joiner', display_name: 'Joiner' });
    const linkRes = await fetch(`${baseUrl}/api/poddy/invite-link`, { headers: authHeaders('u_inviter') });
    const { invite_code } = await linkRes.json();

    const acceptLinkRes = await fetch(`${baseUrl}/api/poddy/invite/${invite_code}/accept`, {
      method: 'POST',
      headers: authHeaders('u_joiner'),
    });
    assert.strictEqual(acceptLinkRes.status, 200);
  });

  it('Cinema Community Picks promotion rule (40 min + 2 bookings), Priority Match, break update, conflict check, match group-size-1 & auto-cancel friend invite', async () => {
    await supabase.from('users').insert([
      { id: 'c_host', display_name: 'Kemi', gender: 'Female', age: 26, location: 'Lagos' },
      { id: 'c_u1', display_name: 'Ada', gender: 'Female', age: 24, location: 'Lagos' },
      { id: 'c_u2', display_name: 'Bola', gender: 'Female', age: 28, location: 'Lagos' },
      { id: 'c_u3', display_name: 'Chidi', gender: 'Male', age: 27, location: 'Abuja' },
    ]);

    const futureStart = new Date(Date.now() + 2 * 3600000).toISOString();

    // 1. Create public Community screening with Priority Match & 15-min break
    const createRes = await fetch(`${baseUrl}/api/cinema/community`, {
      method: 'POST',
      headers: authHeaders('c_host'),
      body: JSON.stringify({
        mode: 'screening',
        youtube_id: 'dQw4w9WgXcQ',
        starts_at: futureStart,
        visibility: 'public',
        break_minutes: 15,
        priority_match_enabled: true,
        priority_criteria: { gender: 'Female', min_age: 21, max_age: 35, location: 'Lagos', group_size: 3 },
      }),
    });
    assert.strictEqual(createRes.status, 201);
    const { show } = await createRes.json();
    assert.strictEqual(show.break_minutes, 15);
    assert.strictEqual(show.priority_match_enabled, true);

    // Creator can manage break
    const breakRes = await fetch(`${baseUrl}/api/cinema/community/${show.id}/break`, {
      method: 'PATCH',
      headers: authHeaders('c_host'),
      body: JSON.stringify({ break_minutes: 5 }),
    });
    assert.strictEqual(breakRes.status, 200);

    // 2. Promotion check: < 40 min -> gathering, >= 40 min + 2 bookings -> Community Pick
    assert.strictEqual(cinemaService.isCommunityPickEligible(show, 2), false);
    const agedShow = { ...show, created_at: new Date(Date.now() - 45 * 60000).toISOString() };
    assert.strictEqual(cinemaService.isCommunityPickEligible(agedShow, 1), false);
    assert.strictEqual(cinemaService.isCommunityPickEligible(agedShow, 2), true);

    // 3. Test overlapping screening booking conflict
    const overlapRes = await fetch(`${baseUrl}/api/cinema/community`, {
      method: 'POST',
      headers: authHeaders('c_host'),
      body: JSON.stringify({
        mode: 'screening',
        youtube_id: 'M7lc1UVf-VE',
        starts_at: new Date(Date.now() + 2.5 * 3600000).toISOString(),
        visibility: 'public',
        break_minutes: 10,
      }),
    });
    const { show: show2 } = await overlapRes.json();

    // c_u1 books show 1
    const book1 = await fetch(`${baseUrl}/api/cinema/shows/${show.id}/book`, {
      method: 'POST',
      headers: authHeaders('c_u1'),
      body: JSON.stringify({ mode: 'general', community_choice: 'general', priority_confirmed: true }),
    });
    assert.strictEqual(book1.status, 200);

    // c_u1 tries to book overlapping show 2 -> 409 conflict
    const bookConflict = await fetch(`${baseUrl}/api/cinema/shows/${show2.id}/book`, {
      method: 'POST',
      headers: authHeaders('c_u1'),
      body: JSON.stringify({ mode: 'general' }),
    });
    assert.strictEqual(bookConflict.status, 409);

    // 4. Sweeger Picks & Match Request group_size 1 + auto-cancel friend invite
    const picksRes = await fetch(`${baseUrl}/api/cinema/picks`);
    const picksData = await picksRes.json();
    const pickShowId = picksData.picks[0].next_show.id;

    // c_host invites c_u2 via Poddy tab
    await fetch(`${baseUrl}/api/cinema/shows/${pickShowId}/book`, {
      method: 'POST',
      headers: authHeaders('c_host'),
      body: JSON.stringify({ mode: 'poddy', invite_friend_ids: ['c_u2'] }),
    });

    // c_u3 creates a private match request (group_size: 1, also_watch_with_general: false)
    const mrRes = await fetch(`${baseUrl}/api/cinema/shows/${pickShowId}/book`, {
      method: 'POST',
      headers: authHeaders('c_u3'),
      body: JSON.stringify({
        mode: 'match',
        match_criteria: { gender: 'Any', min_age: 20, max_age: 40, location: 'Any', group_size: 1, also_watch_with_general: false },
      }),
    });
    const mrBody = await mrRes.json();
    const requestId = mrBody.match_result.match_request.id;

    // c_u2 accepts the match request -> closes immediately & cancels c_host's pending invite!
    const acc1 = await fetch(`${baseUrl}/api/cinema/match-requests/${requestId}/accept`, {
      method: 'POST',
      headers: authHeaders('c_u2'),
    });
    assert.strictEqual(acc1.status, 200);
    const acc1Body = await acc1.json();
    assert.strictEqual(acc1Body.request_closed, true);
    assert.strictEqual(acc1Body.is_private_group, true);

    // Second user c_u1 cannot accept closed group_size 1 request
    const acc2 = await fetch(`${baseUrl}/api/cinema/match-requests/${requestId}/accept`, {
      method: 'POST',
      headers: authHeaders('c_u1'),
    });
    assert.strictEqual(acc2.status, 409);

    // Verify c_host received decline notification for the cancelled friend invite
    const hostNotifs = await (await fetch(`${baseUrl}/api/notifications`, { headers: authHeaders('c_host') })).json();
    assert(hostNotifs.notifications.some((n) => n.type === 'cinema_invite_declined'));

    // 5. Lobby & Pass Crown before show starts
    const lobbyRes = await fetch(`${baseUrl}/api/cinema/shows/${pickShowId}/lobby`, {
      headers: authHeaders('c_u2'),
    });
    assert.strictEqual(lobbyRes.status, 200);
    const lobby = await lobbyRes.json();
    assert.strictEqual(lobby.is_private_group, true);
    assert.strictEqual(lobby.waiting.length, 2); // Only c_u3 and c_u2 in private group!
  });

  it('Distributor upload -> admin approval -> publish sessions -> wallet ticket purchase, Coming Soon reminders, Live mic/cam presence, and Watch Mate Move', async () => {
    await supabase.from('users').insert([
      { id: 'dist_1', display_name: 'NollyStudio' },
      { id: 'buyer_1', display_name: 'Buyer' },
      { id: 'wm_2', display_name: 'WatchBuddy' },
    ]);

    // 1. Distributor submits listing -> cannot publish before approval
    const submitRes = await fetch(`${baseUrl}/api/cinema/community`, {
      method: 'POST',
      headers: authHeaders('dist_1'),
      body: JSON.stringify({
        mode: 'distributor',
        title: 'Lagos Nights',
        description: 'Feature film premiere',
        price_ngn: 1000,
        sessions_per_day: 3,
      }),
    });
    assert.strictEqual(submitRes.status, 201);
    const { listing } = await submitRes.json();
    assert.strictEqual(listing.review_status, 'under_review');

    const earlyPub = await fetch(`${baseUrl}/api/cinema/community/distributor/${listing.id}/publish`, {
      method: 'POST',
      headers: authHeaders('dist_1'),
      body: JSON.stringify({ thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg', video_url: 'https://cdn.example.com/movie.mp4' }),
    });
    assert.strictEqual(earlyPub.status, 403);

    // Admin approves -> publish succeeds -> buyer purchases ticket (70/30 split)
    const approveRes = await fetch(`${baseUrl}/api/admin/distributors/${listing.id}/review`, {
      method: 'POST',
      headers: authHeaders('admin_1'),
      body: JSON.stringify({ decision: 'approved' }),
    });
    assert.strictEqual(approveRes.status, 200);

    const pubRes = await fetch(`${baseUrl}/api/cinema/community/distributor/${listing.id}/publish`, {
      method: 'POST',
      headers: authHeaders('dist_1'),
      body: JSON.stringify({ thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg', video_url: 'https://cdn.example.com/movie.mp4' }),
    });
    assert.strictEqual(pubRes.status, 200);
    const pubData = await pubRes.json();
    assert.strictEqual(pubData.sessions.length, 3);

    await fetch(`${baseUrl}/api/wallet/topup/demo`, {
      method: 'POST',
      headers: authHeaders('buyer_1'),
      body: JSON.stringify({ amount_ngn: 1500 }),
    });

    const ticketRes = await fetch(`${baseUrl}/api/cinema/community/sessions/${pubData.sessions[0].id}/ticket`, {
      method: 'POST',
      headers: authHeaders('buyer_1'),
    });
    assert.strictEqual(ticketRes.status, 201);

    const distWallet = await (await fetch(`${baseUrl}/api/wallet`, { headers: authHeaders('dist_1') })).json();
    assert.strictEqual(distWallet.creator_balance_ngn, 700); // 70% of ₦1000

    // 2. Coming Soon reminders
    const csList = await (await fetch(`${baseUrl}/api/rooms/coming-soon`, { headers: authHeaders('buyer_1') })).json();
    assert(csList.streams.length > 0);
    const remRes = await fetch(`${baseUrl}/api/rooms/coming-soon/${csList.streams[0].id}/remind`, {
      method: 'POST',
      headers: authHeaders('buyer_1'),
      body: JSON.stringify({ notify_poddy: false }),
    });
    assert.strictEqual(remRes.status, 200);

    // 3. Live room presence (mic/cam) + Watch Mate join & admin Move
    const roomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: authHeaders('dist_1'),
      body: JSON.stringify({
        name: 'Live Match Room',
        video_id: 'dQw4w9WgXcQ',
        video_title: 'Live Match',
        video_thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        category: 'Football',
      }),
    });
    const { room } = await roomRes.json();

    await fetch(`${baseUrl}/api/rooms/${room.id}/join`, {
      method: 'POST',
      headers: authHeaders('buyer_1'),
      body: JSON.stringify({}),
    });

    const presRes = await fetch(`${baseUrl}/api/rooms/${room.id}/presence`, {
      method: 'PATCH',
      headers: authHeaders('buyer_1'),
      body: JSON.stringify({ mic_on: true, cam_on: true }),
    });
    assert.strictEqual(presRes.status, 200);

    const partsData = await (await fetch(`${baseUrl}/api/rooms/${room.id}/participants`, { headers: authHeaders('dist_1') })).json();
    const buyerPart = partsData.participants.find((p) => p.user_id === 'buyer_1');
    assert.strictEqual(buyerPart.mic_on, true);
    assert.strictEqual(buyerPart.cam_on, true);

    const wm1 = await (await fetch(`${baseUrl}/api/watchmate/${room.id}/join`, { method: 'POST', headers: authHeaders('dist_1') })).json();
    const wm2 = await (await fetch(`${baseUrl}/api/watchmate/${room.id}/join`, { method: 'POST', headers: authHeaders('wm_2') })).json();
    assert.strictEqual(wm1.pod_id, wm2.pod_id);
    assert(wm1.banner.length > 0);

    const moveRes = await fetch(`${baseUrl}/api/watchmate/${room.id}/move`, {
      method: 'POST',
      headers: authHeaders('dist_1'),
      body: JSON.stringify({ target_user_id: 'wm_2' }),
    });
    assert.strictEqual(moveRes.status, 200);
    const moveData = await moveRes.json();
    assert.notStrictEqual(moveData.from_pod_id, moveData.to_pod_id);
  });
});
