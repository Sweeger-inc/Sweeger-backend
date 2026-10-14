# ScoreZone Public Sports API

Version: 1.0.0  
Format: JSON over HTTPS  
Access: Read-only

This API provides sports schedules, live events, match metadata, and embeddable ScoreZone player links.

The API does not expose raw HLS URLs, stream tokens, premium credentials, trial systems, analytics, Discord controls, or admin operations.

## Base URL

The deployed API base URL is:

```text
https://scorezone-api.scorezone.workers.dev
```

For local testing:

```text
http://localhost:8787
```

## Authentication

If the API owner has enabled authentication, send the API key with every `/v1/*` request:

```http
X-API-Key: YOUR_API_KEY
```

Bearer authentication is also supported:

```http
Authorization: Bearer YOUR_API_KEY
```

The `/health` and `/openapi.json` endpoints do not require authentication.

Never publish the API key in frontend JavaScript, a public repository, or a browser URL.

## Health check

```http
GET /health
```

Example response:

```json
{
  "ok": true,
  "service": "scorezone-public-api",
  "version": "1.0.0"
}
```

## Supported sports

```http
GET /v1/sports
```

Example:

```bash
  curl "https://scorezone-api.scorezone.workers.dev/v1/sports" \
  -H "X-API-Key: YOUR_API_KEY"
```

The response contains sport IDs such as `football`, `basketball`, `baseball`, `tennis`, `rugby`, `fight`, `motor-sports`, and others.

## Schedule

```http
GET /v1/schedule?sport=football&skip=0
```

Parameters:

- `sport` — supported sport ID. Defaults to `football`.
- `skip` — pagination offset. Use `0` for the first page, then increase it when requesting later addon pages.

Example:

```bash
  curl "https://scorezone-api.scorezone.workers.dev/v1/schedule?sport=football" \
  -H "X-API-Key: YOUR_API_KEY"
```

Each event can include:

```json
{
  "id": "streamed:home-vs-away-123",
  "sport": "football",
  "sportName": "Football",
  "name": "Home vs Away",
  "homeTeam": "Home",
  "awayTeam": "Away",
  "league": "Example League",
  "status": "NS",
  "startsAt": "Today at 19:30 UTC",
  "poster": "https://..."
}
```

`status` is normally `NS` for scheduled events and `LIVE` for events currently live.

## Live events

```http
GET /v1/live?sport=football
```

This has the same event format as the schedule endpoint but only returns events currently marked live by the addon.

## Match details and embed links

```http
GET /v1/matches/{eventId}?sport=football&home=Home&away=Away&league=Example%20League
```

Example:

```bash
  curl "https://scorezone-api.scorezone.workers.dev/v1/matches/streamed%3Ahome-vs-away-123?sport=football&home=Home&away=Away&league=Example%20League" \
  -H "X-API-Key: YOUR_API_KEY"
```

The response includes embeddable player URLs:

```json
{
  "data": {
    "id": "streamed:home-vs-away-123",
    "sport": "football",
    "name": "streamed:home-vs-away-123",
    "embedUrl": "https://scorezonetv.live/embed/home-vs-away-2ygx3ty",
    "streams": [
      {
        "name": "Main stream",
        "type": "embed",
        "locked": false,
        "url": "https://scorezonetv.live/embed/home-vs-away-2ygx3ty"
      }
    ]
  }
}
```

Open the returned `embedUrl` or `streams[].url` in an iframe or a new browser tab. Do not try to play or transform the underlying source URL yourself. The API intentionally does not return raw `.m3u8` URLs or access tokens.

Locked entries may return the match-page URL so ScoreZone can display the appropriate access message. Do not treat a locked entry as a playable stream.

## Errors

Errors use this format:

```json
{
  "error": {
    "code": "invalid_sport",
    "message": "Unsupported sport"
  }
}
```

Common status codes:

- `400` — invalid sport, event ID, or parameter.
- `401` — missing or invalid API key.
- `404` — endpoint not found.
- `405` — method not supported. The API is read-only and accepts `GET` requests.
- `502` — the upstream sports addon is temporarily unavailable.

## OpenAPI description

```http
GET /openapi.json
```

This endpoint can be imported into Postman, Insomnia, Swagger UI, or another API client.

## Integration example

```javascript
const API_BASE = "https://scorezone-api.scorezone.workers.dev";
const API_KEY = "YOUR_API_KEY";

const response = await fetch(`${API_BASE}/v1/live?sport=football`, {
  headers: { "X-API-Key": API_KEY }
});

const result = await response.json();
for (const match of result.data || []) {
  console.log(match.name, match.league, match.status);
}
```

Keep API keys on a server or other trusted backend whenever possible.
