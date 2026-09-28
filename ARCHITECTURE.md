# Architecture

## Data flow

```
            API-FOOTBALL (or Mock provider)
                     │  API_FOOTBALL_KEY (backend-only)
                     ▼
             ┌───────────────┐
             │  SYNC ENGINE  │  BullMQ + PostgreSQL sync_tasks (restart-safe)
             └───────┬───────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   RAW PROVIDER DATA      NORMALIZED DATA
   raw_provider_payloads   countries/competitions/seasons/teams/players…
   provider_requests       fixtures/events/lineups/statistics/standings…
          │                     │
          └──────────┬──────────┘
                     ▼
               PostgreSQL  (source of truth)
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       Team       Player     Referee      ← derived locally
       Stats       Stats       Stats
          │          │          │
          └──────────┼──────────┘
                     ▼
            League Analytics  →  H2H  →  Prediction Features
                     │
                     ▼
                   Redis       (cache layer, PostgreSQL remains authoritative)
                     │
                     ▼
              ┌─────────────┐
              │  OUR API    │  /api/v1  + OpenAPI
              └──────┬──────┘
                     │  OUR API KEYS (pf_live_…, scopes, rate limits)
         ┌───────────┴───────────┐
         ▼                       ▼
   Prediction App        Website / other clients
```

## Components

| Component | Entry point | Responsibility |
|-----------|-------------|----------------|
| REST API | `src/api/server.ts` | `/api/v1`, API-key auth, rate limiting, usage tracking, OpenAPI |
| Sync worker | `src/worker/worker.ts` | BullMQ consumer; executes sync tasks |
| Sync scheduler | `src/worker/scheduler.ts` | recurring cycles: live / upcoming / post-match / metadata |
| Website + admin | `src/web/server.ts` | static UI; proxies `/api` to our API with a site key |
| CLI | `src/cli/*.ts` | imports, recalculations, API-key administration |
| Provider layer | `src/provider/` | live API-Football client + deterministic mock; raw storage |
| Stats layer | `src/stats/` | referee/team/player/league/H2H/prediction derivations |

## Sync engine design

- **Source of truth for queue state:** `sync_jobs`, `sync_tasks`, `sync_state`
  tables (spec §39). BullMQ (Redis) is the transport; a crash never restarts an
  import — tasks are claimed atomically (`FOR UPDATE SKIP LOCKED`) and
  unfinished tasks are requeued after 2 minutes (`requeueStuckTasks`).
- **Idempotency:** every task has a unique `task_key`; entity writes are
  upserts keyed on `(provider, provider_id)`; event/stat snapshots replace in
  place; duplicate imports create no duplicate rows (verified by tests).
- **Retries:** exponential backoff `5s · 3^attempts`, `max_attempts` per task;
  permanent failures surface in `npm run sync:failed` and can be requeued with
  `--retry`.
- **Quota awareness** (spec §41): daily 75 000 / minute 300 tracked in
  `provider_quota`; states NORMAL (>50 %), CAUTION (20–50 %), CRITICAL (<20 %).
  In CRITICAL, live scores/events, near-term fixtures and post-match processing
  continue while historical/metadata refreshes are deferred. Minute-window
  exhaustion waits for the window to roll instead of failing.

## Request optimization (spec §40)

1. Redis cache checked first (API read path), 2. PostgreSQL before external
requests (skip unchanged historical fixtures via `data_hash` + `finalized`),
3. `competition_season_coverage` gates every detail endpoint, 4. raw payload
replay (`raw_provider_payloads`) allows reprocessing without provider calls,
5. all derived statistics are computed locally.

## Security (spec §52/53)

- `API_FOOTBALL_KEY`, `JWT_SECRET`, `ADMIN_PASSWORD` are env-only; logs scrub
  them (`redactSecrets` + pino redaction); raw payload/request-param hashes
  strip secret-like keys before persistence.
- Our API keys: `pf_live_<handle>_<secret>`; only `key_prefix` + SHA-256
  `key_hash` stored. Rotation keeps the old key for a grace period; revocation
  is immediate. Scope checks + per-minute/per-day rate limits + usage rows.
- Admin endpoints require either an admin token (HMAC-signed, constant-time
  verified) or an API key with `admin:*` scope. Parameterized SQL everywhere.

## Failure handling (spec §51)

401/403 fail fast; 404 never retries forever (empty/`skipped` result);
429/5xx/network/timeouts → exponential backoff + task rescheduling; malformed
provider payloads are stored raw and mapped defensively (unknown event types
are preserved in JSONB).
