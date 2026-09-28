# IMPLEMENTATION REPORT — Autonomous Football Data Platform

> **Scope update — 2026-09-28:** The importer now uses the strict production
> window `IMPORT_SEASONS=2023,2024,2025,2026`. The historical queue is limited
> to 2023–2025 and marks completed competition-season pairs with
> `historical_imported_at`; 2026 live/today/upcoming/recently-finished syncs
> remain current-priority. The older baseline totals and dynamic-window notes
> below describe the earlier implementation and are superseded by this scope
> update.

Date: 2026-09-24 · Branch: `arena/01a0d445-football-database` ·
Spec: `Soccer.md` (AUTONOMOUS FOOTBALL DATA PLATFORM)

---

## PART 1 — Implementation report (spec §61)

### 1. Full backend structure
Node.js 20+ / TypeScript / Express. Layers: `src/config` (env+secret
redaction) → `src/lib` (logger/db/redis/hash/migrate/cache) → `src/provider`
(live API-Football client + deterministic mock + raw store + unified mapper) →
`src/sync` (quota manager, task queue, BullMQ engine, handlers, pipelines) →
`src/stats` (referee/team/player/league/H2H/prediction) → `src/keys` (API-key
service) → `src/api` (middleware, routes, OpenAPI) → `src/web` (website +
admin UI) → `src/cli` (full §48 command set) + `src/worker` (worker &
scheduler).

### 2. Database schema
`migrations/0001_init.sql`: **45 tables** — countries, competitions, seasons,
competition_seasons, competition_season_coverage, venues, competition_rounds,
teams, team_seasons, team_coach_history, players, player_team_history,
referees, referee_match_statistics, referee_season_statistics,
referee_competition_statistics, fixtures, fixture_periods, fixture_scores,
fixture_events, fixture_team_statistics, player_match_statistics, lineups,
lineup_players, standings, standing_rows, sidelined_records, transfers,
bookmakers, odds, odds_values, player_season_statistics,
team_competition_season_stats, league_season_statistics, h2h_stats,
prediction_features, raw_provider_payloads, provider_requests, provider_quota,
sync_jobs, sync_tasks, sync_state, api_clients, api_keys, api_usage,
api_audit_log, data_quality_results. Composite unique keys (e.g. fixtures
`(provider, provider_fixture_id)`, fixture_team_statistics `(fixture_id,
team_id)`), JSONB raw fields, UTC TIMESTAMPTZ, NULL-not-zero policy,
FK/unique/check constraints and query indexes per spec §47. Migration runner
+ `schema_migrations` tracking; `database:migrate:status` CLI.

### 3. Full synchronization system
BullMQ (Redis transport) over a PostgreSQL `sync_jobs`/`sync_tasks` state
machine — restart-safe (atomic `FOR UPDATE SKIP LOCKED` claims, stuck-task
requeue after 2 min, crash never restarts an import), idempotent (unique
`task_key`s, upserts on `(provider, provider_id)`, snapshot replacement),
retry with `5s·3^attempts` backoff and `max_attempts`, permanent-failure
surfacing (`sync:failed [--retry]`). Request optimization: Redis→PostgreSQL→
coverage-gated provider calls; raw-payload replay; `data_hash` short-circuit
for unchanged historical fixtures; local derivations.

### 4. Historical import
`npm run historical:import` = resumable window import (competition → coverage
discovery → teams/squads → fixtures → details → standings → injuries → odds →
transfers → stat rollup) with `IMPORT_TASK_BUDGET` batching; re-runs resume
exactly where they stopped (verified: killed run resumed to 100%).

### 5. Initial import process (3 previous seasons + current)
Executed for **4 mock competitions × seasons 2022/23–2026/27** (3 previous +
current + next window). Verified in DB: 4 competitions, 5 seasons, 32 teams,
704 players, 24 referees, **851 fixtures** (772 finished+finalized, 79
upcoming), 10,838 events, 1,702 fixture-team-stat rows, 19,066
player-match-stat rows, 27,792 lineup-player rows, 15 standings tables (120
rows — leagues only; cups correctly absent), 30 sidelined records, 64
transfers, 851 prediction-features rows, **3,641 raw payloads + 3,641
provider request logs**, quota 3,641/75,000 (NORMAL). All 1,750 sync tasks
done, 0 open.

### 6. Team statistics
Locally derived `team_competition_season_stats` + `fixture_team_statistics`:
matches/W/D/L + home/away splits, goals for/against/diff, avg scored/conceded,
clean sheets, failed-to-score, BTTS, cards, fouls, corners, shots(+on),
possession, xG, last 5/10/20, home/away form, streaks. API:
`/teams/:id/statistics` (verified live: 14 matches, 8/2/4, 27:15).

### 7. Player statistics
`player_match_statistics` (per fixture: minutes, rating, goals, assists,
shots, passes, tackles, duels, dribbles, fouls, cards, xG…) → local
`player_season_statistics` rollups (starts from lineups). API:
`/players/:id/statistics`.

### 8. Referee statistics
Referee + match → `referee_match_statistics` → `referee_season_statistics`
(matches, home/draw/away wins, yellow/red/second-yellow + per-match, fouls,
penalties, home/away cards, last 5/10/20) and
`referee_competition_statistics`. API `/referees/:id/statistics` returns
season + competition + recent breakdown (verified: 272-match referee with
cards-per-match computed locally).

### 9. League statistics
`league_season_statistics` per competition/season: matches, goals(+per-match),
home/away goals & W/D/W, BTTS/clean-sheet/FTS %, cards (yellow/second/red +
per-match), fouls/penalties/corners/shots(+on) per match, possession, xG.
API `/competitions/:id/statistics` (verified: 56 matches, 2.43 goals/match,
4.61 cards/match, 51.8% BTTS).

### 10. H2H statistics
`h2h_stats` per team pair with rolling window (last 20): fixture counts,
wins/draws, goals, BTTS, clean sheets, cards, corners, last meetings JSONB,
symmetric (A,B) = (B,A) — covered by tests.

### 11. Prediction features (for the prediction app)
`prediction_features` per fixture: home/away recent + **home/away venue
splits** (form, PPG), goals/conceded/shots/SOT/possession/corners/cards/fouls
averages, clean-sheet/FTS/BTTS rates, league averages, referee features,
full team & league stat dumps, player availability (injuries/suspensions),
H2H, lineups availability, **data-freshness timestamps**. Built locally
during post-match pipeline + rollups. API `/predictions/features/:fixtureId`
(verified with full sample).

### 12. Redis caching
`src/lib/cache.ts`: typed keys, TTLs (live 30 s, upcoming 5 min, fixture 2
min, standings 10 min, stats 15 min, features 5 min), invalidation on writes,
`cache:rebuild` warm-up. PostgreSQL stays authoritative; Redis outage degrades
transparently (API serves from PG; `/health/redis` reports).

### 13. Our own API (`/api/v1`)
Express: competitions(+seasons+coverage, statistics), teams(+statistics),
players(+statistics), referees(+statistics), fixtures (list/upcoming/live/
finished/:id/events/statistics/lineups/players), standings,
predictions/features, health suite (incl. `/health/data`), admin endpoints.
Pagination, error codes (NOT_FOUND, UNAUTHORIZED, FORBIDDEN, RATE_LIMITED,
VALIDATION, INTERNAL), `Retry-After`, `X-RateLimit-*` headers. Website and
prediction app talk only to this API.

### 14. API-key system
`api_clients` + `api_keys`: format `pf_live_<handle>_<secret>` (CSPRNG);
**only prefix + SHA-256 hash stored** (tests prove raw keys never persist,
never leak in logs/responses). Auth pipeline: hash compare (constant-time) →
revoked? → expired? → client active? → rotation grace? → scope → rate limit →
usage record. Admin dashboard + CLI management.

### 15. API-key generation
`npm run api-key:create -- --client "Prediction App" --scopes … [--expires N]`
prints the secret **once** with “Save this key now — it will not be displayed
again” (verified output). Same one-time modal in the admin UI (copy button).

### 16. API-key rotation
`api-key:rotate [--grace-hours 24]` — new key minted with `rotated_from`
lineage; old key stays valid until `grace_until` (or revocation); zero
downtime for consuming apps. Covered by tests.

### 17. API-key revocation
`api-key:revoke [--reason …]` — immediate (even during grace); usage history
retained (`api_audit_log`); admin UI revocation button. Covered by tests.

### 18. Scopes
`fixtures:read, teams:read, players:read, referees:read, standings:read,
statistics:read, predictions:read, admin:read, admin:write` (write implies
read). Per-endpoint enforcement — verified 403 for insufficient scope.

### 19. Usage tracking
`api_usage` per key/client/day/endpoint: requests, successful, failed,
rate-limited, last used; `GET /admin/usage` + dashboard overview; per-key
per-minute/per-day rate limits returning 429 + `Retry-After` (tested).

### 20. Admin API
`/admin/login` (HMAC token, constant-time) or admin-scoped key → list keys &
clients, create client, generate/rotate/revoke keys, patch client limits,
usage report, sync queue status, retry-failed. Never returns raw secrets.

### 21. Website
`src/web`: modern UI (upcoming/live/finished fixtures, teams, players,
referees, standings, statistics, fixture detail with events/lineups/stats)
served on :8080, calling **our API only** through a server-side proxy with the
site's own `pf_live_…` key (`SITE_API_KEY` or auto-provisioned
`.website-api-key`, gitignored). Includes `/admin/api-keys` dashboard (login,
client+key management).

### 22. Prediction-app integration config
```
FOOTBALL_API_BASE_URL=https://api.yourdomain.com/api/v1
FOOTBALL_API_KEY=pf_live_xxxxxxxx          # OUR key — never API_FOOTBALL_KEY
FOOTBALL_API_TIMEOUT=15000
FOOTBALL_API_CACHE_TTL=300
```
Required set: fixtures/teams/players/referees/standings/statistics/
predictions `:read`. Sample cURL + feature payload verified.

### 23. Data-quality monitoring
11 checks (duplicates, orphan events, completed-without-scores, team-season
consistency, hash-only keys, …) → `data_quality_results` + **`GET
/api/v1/health/data`** + `data-quality:check` CLI: **9 passed / 0 warnings /
0 failed** on the imported dataset.

### 24. Deployment setup
`Dockerfile` (multi-stage, role entrypoint), `docker-compose.yml` (postgres,
redis, api, worker, scheduler, web with healthchecks), `DEPLOYMENT.md`
(env table, compose + bare-metal instructions, security checklist,
zero-downtime key rotation, health verification, cron fallback). Production
boot refuses missing `JWT_SECRET`/`ADMIN_PASSWORD`/`DATABASE_URL`/`REDIS_URL`.

### 25. Tests
**48 tests, all green, clean exit** (`npx vitest run`, isolated
`football_test` database): API-key generation/rotation/revocation/expiry/
scopes/rate-limits, secret redaction, provider mapping, duplicate-import
idempotency, sync resume after failure, quota NORMAL/CAUTION/CRITICAL gating,
Redis cache, referee & league derived stats, data-quality checks, full API
integration incl. auth matrix and no-key-leakage assertions.

### 26. CLI commands (spec §48 + extras)
`database:migrate[:status]`, `competitions:import`, `seasons:import`,
`historical:import`, `current:sync`, `competition:sync`, `season:sync`,
`fixture:sync [--postmatch]`, `statistics:recalculate`, `team:recalculate`,
`player:recalculate`, `referee:recalculate`, `league:recalculate`,
`prediction-features:rebuild [--upcoming]`, `cache:rebuild`,
`data-quality:check`, `quota:status`, `sync:failed [--retry]`,
`api-key:create/rotate/revoke/list`, `devdb:start`, `doctor`,
`bulk-finalize` — all with `--help`.

### 27. Documentation
`README.md`, `ARCHITECTURE.md`, `DATABASE.md`, `DATA_DICTIONARY.md`,
`SYNC.md`, `API.md`, `API_KEYS.md`, `DEPLOYMENT.md`, `TROUBLESHOOTING.md`,
OpenAPI/Swagger at `/api/v1/docs`, inline code documentation throughout.

### 28. Final verification (performed live)
migrations ×2, doctor, 48/48 tests, full initial import (3 previous + current
seasons), 778-fixture bulk finalization, derived-stat recalculation, 9/9
data-quality, two production API keys issued (one-time display), all four
services running (API :4000, worker, scheduler, website :8080) — health
suite 5×200, auth 401 without/bad key, 403 wrong scope, all data endpoints
200 with real imported data, zero secret leakage in responses, website proxy
+ admin login/key-management verified.

### Clear status summary (spec §56)
**Fully working:** entire pipeline above — verified end-to-end on the mock
provider with real processes, DB, Redis, API and website.
**Partial/limited:** data richness depends on provider coverage per
competition/season (gates recorded in `competition_season_coverage`; missing
values stay NULL — never fabricated). Fixture→referee links use display names
(API-Football semantics); same-name referees can merge in mock data (generator
fixed).
**Missing/unverified:** the live API-Football integration cannot be verified
from this sandbox (outbound TLS to `v3.football.api-sports.io` is blocked).
The live client implements all required behaviour (auth, retries, backoff,
429/5xx handling, raw storage, quota header parsing) and is exercised by
tests through the unified interface, but **the first real call with the
user's `API_FOOTBALL_KEY` must be verified after delivery** — run
`npx tsx src/cli/doctor.ts` then `npm run current:sync` and check
`provider_requests`. All imported data in this delivery is clearly mock-mode
synthetic data (fictional teams/players) demonstrating the full pipeline.

---

## PART 2 — Step-by-step development & deployment guide

### 1. Environment variables
```bash
cp .env.example .env   # never commit .env
```
Set `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (`openssl rand -hex 32`),
`ADMIN_USER`, `ADMIN_PASSWORD`; optionally `API_FOOTBALL_KEY`, `API_PORT`,
`WEB_PORT`, `PROVIDER_DAILY_QUOTA=75000`, `PROVIDER_MINUTE_LIMIT=300`,
`HISTORICAL_SEASONS_BACK=3`, `SYNC_LIVE_INTERVAL_SECONDS=60`,
`SYNC_UPCOMING_INTERVAL_SECONDS=900`, `SYNC_POSTMATCH_INTERVAL_SECONDS=300`,
`SYNC_METADATA_INTERVAL_SECONDS=21600`, `SITE_API_KEY`, `LOG_LEVEL`. Full
table in `DEPLOYMENT.md`. Secrets are redacted from all logs automatically.

### 2. Database migration
```bash
npm run database:migrate          # apply (idempotent)
npm run database:migrate:status   # list applied migrations
```
Local PostgreSQL: `npm run devdb:start` (embedded, db `football`), or point
`DATABASE_URL` at your server. Tests use a separate auto-created
`football_test` database.

### 3. Redis
Local: system `redis-server` (verified 7.2.7) on `redis://127.0.0.1:6379`, or
set `REDIS_URL`. Required by worker/scheduler (BullMQ); API degrades
gracefully without it (`GET /health/redis`).

### 4. API-Football key
Put the key in `.env` as `API_FOOTBALL_KEY=…` (backend-only; never in any
frontend, never logged). Without it the platform runs in **mock mode**
(deterministic synthetic data). Verify:
```bash
npx tsx src/cli/doctor.ts
```

### 5. Initial import
```bash
npm run competitions:import     # competitions + seasons + windows
npm run seasons:import
npm run data-quality:check
```

### 6. Historical import
```bash
IMPORT_TASK_BUDGET=5000 npm run historical:import   # resumable — re-run to resume
npx tsx scripts/bulk-finalize.ts                    # finalize completed fixtures
npm run statistics:recalculate                      # derived stats + features + cache
npm run data-quality:check
```
Imports 3 previous completed seasons + current season per
`HISTORICAL_SEASONS_BACK` (verified totals in report §5).

### 7. Starting synchronization
```bash
npm run dev:worker       # BullMQ worker (concurrency 2)
npm run dev:scheduler    # recurring live/upcoming/postmatch/metadata cycles
npm run current:sync     # one-shot manual current-season sync
```
Quota: `npm run quota:status`; failures: `npm run sync:failed [--retry]`.

### 8. Building derived statistics
```bash
npm run statistics:recalculate        # everything
npm run player:recalculate            # or --fixture <id>
npm run team:recalculate              # or --team --competition --season
npm run referee:recalculate           # or --fixture <id>
npm run league:recalculate            # or --competition --season
npm run prediction-features:rebuild -- --upcoming
npm run cache:rebuild
```

### 9. Running the API
```bash
npm run dev:api          # http://localhost:4000/api/v1  (docs at /api/v1/docs)
curl http://localhost:4000/api/v1/health
```

### 10. Running the website
```bash
npm run dev:web          # http://localhost:8080 (+ /admin/api-keys)
```
Uses our API only (server-side proxy with the site's `pf_live_…` key).

### 11. Generating the prediction app's API key
```bash
npm run api-key:create -- --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,referees:read,standings:read,statistics:read,predictions:read" \
  --label "production" --expires 365
```
**The secret is printed once — save it now.** Manage later via
`api-key:rotate / api-key:revoke / api-key:list` or the admin dashboard.
Example from this delivery (secret shown once at creation):
`pf_live_1de2c5b8bd1a_…` (only its prefix+hash are stored).

### 12. Prediction app integration
```env
FOOTBALL_API_BASE_URL=https://api.yourdomain.com/api/v1
FOOTBALL_API_KEY=pf_live_xxxxxxxx
FOOTBALL_API_TIMEOUT=15000
FOOTBALL_API_CACHE_TTL=300
```
```bash
curl -H "X-API-Key: $FOOTBALL_API_KEY" \
  "$FOOTBALL_API_BASE_URL/predictions/features/12345"
```
Payload includes forms (overall + venue split), scoring/conceding/shots/
possession/corners/cards/fouls averages, clean-sheet/FTS/BTTS rates, league
averages, referee stats, player availability, H2H, data freshness. See
`API.md`. Never give this app `API_FOOTBALL_KEY`.

### 13. Monitoring
```bash
npm run quota:status          # budget state NORMAL/CAUTION/CRITICAL
npm run sync:failed           # stuck/failed tasks
npm run data-quality:check    # 11 integrity checks
curl .../api/v1/health/data   # same from outside
curl .../api/v1/health/{database,redis,provider}
```
plus `/admin/sync` and `/admin/usage` (dashboard shows both).

### 14. Deployment
`DEPLOYMENT.md`: Docker (`docker compose up -d --build` + migrate/import
commands) or bare-metal (systemd/pm2 running api, worker, scheduler, web).
Post-deploy verification checklist + zero-downtime key rotation +
TLS/firewall/secrets checklist included. Run `npm run database:migrate` on
every deploy.

### 15. Troubleshooting
`TROUBLESHOOTING.md` covers DB/Redis connection failures, provider auth and
quota exhaustion, stuck/retried sync tasks, missing events/stats, standings
gaps from provider coverage, API-key 401/403/429, lost keys (rotate — raw
keys are unrecoverable by design), stale cache, data-quality failures, and
known data limitations. Start every investigation with
`npx tsx src/cli/doctor.ts`.
