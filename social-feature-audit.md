
# Match rooms, Poddy, follow and YouTube live audit

Reviewed against the sibling Sweeger-backend source on 2026-11-09.

Frontend fixes:
- Match Poddy members using participant.user_id instead of participant.id.
- Resolve Watch Mate rows to user IDs so self detection and presence work.
- Refresh room social membership every 12 seconds and on focus.
- Show follow and Poddy request failures instead of failing silently.
- Read requested_at from the incoming Poddy request response.

Backend work still required:
- src/routes/follows.js: check Supabase insert/delete error results before returning success.
- src/routes/poddy.js: check insert/delete/update error results for request, decline and remove.
- Requesting again after a declined relationship currently attempts a new insert while the old relationship remains; handle the existing declined row explicitly.
- Acceptance checks only the receiver capacity. Check requester capacity too; enforce both limits atomically to prevent concurrent acceptance exceeding 20.
- The local backend has no /api/matches router. Match discovery, room creation and embed endpoints must be supplied before the full match-room journey can be verified.

Validation still needed with two signed-in accounts:
1. Follow/unfollow and confirm both following/follower lists after reload.
2. Request, accept, decline, request again, and remove a Poddy member.
3. Confirm an accepted friend appears in the room Poddy tab.
4. In a match room, mute General and confirm Poddy and Watch Mate remain audible.
5. Toggle each category audio and camera control, including overlapping membership, late joins and the floating window. Poddy has priority over Watch Mate; General contains neither group. Individual audio mutes remain applied when a category is unmuted.

YouTube discovery now requests live streams without keyword/category filters, with up to 50 results. This is a discovery page, not an exhaustive index of every YouTube live stream.

## Backend handoff and API contract

Please confirm the backend branch/commit, running port, deployment URL, and example response for each endpoint below. Local frontend configuration currently targets http://localhost:10000.

Observed locally: GET /api/matches/live?sport=football and GET /api/matches/schedule?sport=football&skip=0 returned 404 with {"error":"Route not found"}. GET /api/rooms/active returned 200. This indicates missing match routes rather than an empty schedule.

Register the matches router before the Express catch-all 404 handler and implement/deploy:

| Method | Endpoint | Expected response |
| --- | --- | --- |
| GET | /api/matches/live?sport=football | { "matches": [...] } |
| GET | /api/matches/schedule?sport=football&skip=0 | { "matches": [...] } |
| POST | /api/matches/:id/room | { "room_id": "...", "created": true } |
| GET | /api/matches/:id/embed?sport=football&home=...&away=...&league=... | { "embed_url": "..." } |

POST room creation requires authentication and accepts { "sport": "football", "skip": 0 }. Repeated creation for the same match should resolve to the same room. Schedule pagination currently increments skip by 20. Match IDs are URL-encoded by the frontend.

Match list items currently expect:

```ts
{
  id: string;
  name: string;
  home_team: string;
  away_team: string;
  league: string;
  status: string; // LIVE or is_live=true marks a live match
  is_live: boolean;
  starts_at_label: string;
  poster: string | null;
  room_id: string | null;
  sport?: string;
  participant_count?: number;
}
```

An empty match schedule must return HTTP 200 with { "matches": [] }, not 404. Room responses must include room_type: "match", match_id, sport, and match_meta: { home, away, league }. Confirm that room participant user_id, social list IDs, Watch Mate member IDs and Stream userId all refer to the same user identity.

Social routes expected by the frontend:

- POST /api/follows/:userId and DELETE /api/follows/:userId.
- GET /api/follows/following and GET /api/follows/followers.
- GET /api/poddy and GET /api/poddy/requests.
- POST /api/poddy/request/:userId, /api/poddy/accept/:requesterId and /api/poddy/decline/:requesterId.
- DELETE /api/poddy/:userId.

Check every Supabase write error before reporting success. Reuse/update a declined Poddy relationship when a new request is allowed. Enforce both users' capacity in a database transaction or equivalent atomic operation. Return meaningful non-2xx errors so the frontend can report failures.

The category mic/camera buttons only change the listener's local playback; they do not require backend mute endpoints and do not turn off other users' devices.

## Verification after backend deployment

1. Restart the backend. Set NEXT_PUBLIC_API_URL to the confirmed backend URL and restart Next.js if it changed.
2. Check both match-list URLs return 200 and the documented JSON shape.
3. Click a match, create/join its room, and verify embed loading. A second account selecting the same match should join the same room.
4. With two signed-in accounts, follow/unfollow and reload both lists to confirm persistence.
5. Send and accept a Poddy request; confirm the friend appears in the room Poddy tab. Test decline, resend and removal too.
6. Test capacity on both accounts, concurrent accepts, invalid users and rejected writes; failed writes must not return success.
7. With participants in different groups, mute General while keeping Poddy audible. Test each camera control, late joins, overlapping membership and the floating window. Individual audio mutes remain in effect when a group is unmuted.
8. Record the deployed commit, endpoint status/results and two-account test results before marking the feature verified. These authenticated tests have not yet been completed.

## YouTube live discovery: confirmed failure and recovery

A direct request using the configured local YOUTUBE_API_KEY returned HTTP 403:

```json
{
  "status": "PERMISSION_DENIED",
  "message": "Permission denied on the service.",
  "reason": "ACCESS_DENIED",
  "service": "youtube.googleapis.com"
}
```

The key is present, but Google denied service access. This response alone does not establish which Cloud project/key setting is responsible. Previously the proxy and client converted failures to an empty list, making an API failure look like no live streams. The frontend now reports discovery failures explicitly.

Recovery checklist for the Google Cloud project owner:

1. Select the project that owns the configured key and confirm YouTube Data API v3 is enabled.
2. Check the key is active and its API restrictions permit YouTube Data API v3.
3. Check application restrictions suit server-side requests from the Next.js server, including its outbound IP if IP restrictions are configured. Browser-referrer-only restrictions are unsuitable for this server-side proxy.
4. Check project/service access restrictions and the API error logs if ACCESS_DENIED persists. Check quota separately; the observed error was ACCESS_DENIED, not quotaExceeded.
5. If replacing the key, update server-only YOUTUBE_API_KEY in .env.local and the hosting environment, then restart/redeploy Next.js. Never send the key in this audit or expose it with NEXT_PUBLIC_.
6. Confirm GET /api/live-rooms returns 200 with videos, then open Home > Showing Now. The list polls every 60 seconds and upstream successes are cached for 90 seconds.

The YouTube route lives in the Next.js frontend, separately from the Express match backend. Football keyword/category restrictions have been removed; the discovery request includes live videos across categories, up to 50 results. Restoring the football filter will not resolve a service permission denial.

Official setup guidance: https://developers.google.com/youtube/data/guides/authentication
