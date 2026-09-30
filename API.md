# REST API

Base URL: `/api/v1` · Interactive docs: `GET /api/v1/docs` (Swagger UI) ·
Spec: `GET /api/v1/openapi.json`

Authentication: `X-API-Key: pf_live_…` (platform-issued — see
[API_KEYS.md](API_KEYS.md)). Health endpoints and `/admin/login` are public;
everything else requires a key with the right scope.

Clients: use [@football-data-platform/client](../sdk/typescript) (retries,
pagination, typed errors) or plain HTTP. Building an external app? Start with
[PREDICTION_APP.md](PREDICTION_APP.md).

> There are no CORS headers — call the API from a server, not from browser JS.

## Endpoints

| Method & path | Scope | Description |
|---------------|-------|-------------|
| GET `/health` | public | liveness |
| GET `/health/database` | public | PostgreSQL check |
| GET `/health/redis` | public | Redis check |
| GET `/health/provider` | public | provider mode + quota status |
| GET `/health/data` | public | data-quality status |
| GET `/competitions` | `teams:read` | list (pagination, `country`) |
| GET `/competitions/:id` | `teams:read` | detail |
| GET `/competitions/:id/seasons` | `teams:read` | seasons + coverage flags |
| GET `/competitions/:id/statistics` | `statistics:read` | league analytics (`season_id` required) |
| GET `/teams` | `teams:read` | list (`competition_id`, `season_id`, `name`) |
| GET `/teams/:id` | `teams:read` | detail |
| GET `/teams/:id/statistics` | `statistics:read` | team analytics (`competition_id`,`season_id`) |
| GET `/players` | `players:read` | list (`team_id`, `name`) |
| GET `/players/:id` | `players:read` | detail + team history |
| GET `/players/:id/statistics` | `statistics:read` | season statistics |
| GET `/referees` | `referees:read` | list |
| GET `/referees/:id` | `referees:read` | detail |
| GET `/referees/:id/statistics` | `statistics:read` | season/competition/recent analytics |
| GET `/fixtures` | `fixtures:read` | list (`competition_id`, `season_id`, `team_id`, `status`, `from`, `to`) |
| GET `/fixtures/upcoming` | `fixtures:read` | not started, ordered by kickoff |
| GET `/fixtures/live` | `fixtures:read` | in-play (Redis-cached, 30 s TTL) |
| GET `/fixtures/finished` | `fixtures:read` | completed (`date`) |
| GET `/fixtures/:id` | `fixtures:read` | detail |
| GET `/fixtures/:id/events` | `fixtures:read` | goals/cards/subs/VAR |
| GET `/fixtures/:id/statistics` | `statistics:read` | team match statistics |
| GET `/fixtures/:id/lineups` | `fixtures:read` | formations + squads |
| GET `/fixtures/:id/players` | `players:read` | player match statistics |
| GET `/standings` | `statistics:read` | table (`competition_id`, `season_id` required) |
| GET `/predictions/features/:fixtureId` | `predictions:read` | prediction features |
| POST `/admin/login` | public | admin token (username/password) |
| GET `/admin/api-keys` | `admin:read` | keys + clients + usage overview |
| POST `/admin/clients` | `admin:write` | create/update client |
| POST `/admin/api-keys` | `admin:write` | generate key (secret returned once) |
| POST `/admin/api-keys/:id/rotate` | `admin:write` | rotate (grace period) |
| POST `/admin/api-keys/:id/revoke` | `admin:write` | revoke immediately |
| PATCH `/admin/clients/:id` | `admin:write` | rate limits / enable-disable |
| GET `/admin/usage` | `admin:read` | usage report |
| GET `/admin/sync` | `admin:read` | sync queue status + quota |
| POST `/admin/sync/retry-failed` | `admin:write` | requeue failed tasks |

## Response shape

List endpoints (paginated):

```json
{ "ok": true, "data": [ ... ],
  "pagination": { "page": 1, "per_page": 25, "total": 851, "total_pages": 35 } }
```

Single resource: `{ "ok": true, "data": { ... } }`
Errors: `{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }`

Codes: `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `VALIDATION`,
`INTERNAL`. Rate-limited responses include `Retry-After`; all responses with a
key include `X-RateLimit-Remaining-Minute/-Day`.

## Example — prediction app

```bash
curl -H "X-API-Key: pf_live_xxx" \
  "https://api.yourdomain.com/api/v1/predictions/features/12345"
```

Returns fixture context, home/away recent & venue splits, goals/shots/
possession/corners/cards/fouls averages, clean-sheet/FTS/BTTS rates, league
averages, referee card/foul/penalty statistics, player availability
(injuries/suspensions), lineups (when known), local H2H (last 20), and
data-freshness timestamps. Computed locally — **no provider call is made per
prediction request**.

## Caching

Redis TTLs: live 30 s · upcoming 5 min · fixture detail 2 min · standings 10 min
· team/player/referee/competition stats 15 min · prediction features 5 min.
PostgreSQL is authoritative; cache is invalidated on every sync write and can be
warmed with `npm run cache:rebuild`. If Redis is down, endpoints fall back to
PostgreSQL transparently (`GET /health/redis` reports the outage).
