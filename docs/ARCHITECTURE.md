# Architecture

## Overview

```
                API-FOOTBALL (v3)
                     │  API_FOOTBALL_KEY (backend-only)
                     ▼
             ┌───────────────┐
             │  SYNC ENGINE  │  quota manager · retries/backoff · raw archive
             └───────┬───────┘
      ┌──────────────┴───────────────┐
      ▼                              ▼
raw_provider_payloads        normalized PostgreSQL
(reprocessable archive)        (source of truth)
                                     │
        ┌────────────┬───────────────┼────────────────┐
        ▼            ▼               ▼                ▼
   team stats   player stats   referee stats    league stats
        └────────────┴───────────────┼────────────────┘
                                     ▼
                        H2H + prediction features
                                     ▼
                                 Redis cache
                                     ▼
                              ┌─────────────┐
                              │  OUR API    │  Fastify · OpenAPI · API-key auth
                              └──────┬──────┘
                                     │  X-API-Key: pf_live_…
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
              Prediction App                      Website
```

## Components

| Path | Responsibility |
|---|---|
| `src/provider/client.ts` | API-Football HTTP client: rate limiting, retries with exponential backoff, 429/5xx/401/403/404 handling, Redis response cache, raw payload persistence, request logging |
| `src/provider/quota.ts` | Quota manager: daily/minute tracking from `/status` + response headers + `provider_requests` aggregation; NORMAL/CAUTION/CRITICAL levels gate task priorities |
| `src/mapping/*` | Provider JSON → typed rows (never trust provider shapes at the repo layer) |
| `src/repos/*` | Idempotent upserts (all writes) |
| `src/analytics/*` | Local-only derivations: team/league/player/referee statistics, H2H, prediction features |
| `src/sync/*` | Durable task queue (PostgreSQL), worker loop, scheduler, import planner |
| `src/keys/service.ts` | Platform API keys: generation, HMAC hashing, verify, rotate (grace), revoke |
| `src/api/*` | Fastify REST API, auth preHandler (scopes + per-client rate limits + usage), admin UI, OpenAPI |

## Key engineering decisions

1. **PostgreSQL-backed task queue instead of BullMQ.** The spec requires inspectable, restart-safe `sync_jobs`/`sync_tasks` tables. Keeping the queue *in* those tables (claimed via `FOR UPDATE SKIP LOCKED`) means one source of truth, trivial failure inspection (`sync:failed`), and zero double-bookkeeping. Redis is used for what it excels at: caching, rate-limit counters, quota counters, distributed locks. This satisfies "BullMQ **or another Redis-backed reliable job queue**" — ours is Redis-assisted and PostgreSQL-durable.

2. **Raw payload archive.** Every successful provider response is stored in `raw_provider_payloads` (keyed by endpoint+params hash) so future re-processing never needs to re-call the provider.

3. **Change detection.** Fixtures carry a `data_hash` (status+scores); re-imports skip work when nothing changed. Finalized fixtures are never re-fetched unless data is missing.

4. **Coverage-driven fetching.** `competition_season_coverage` (from API-Football's per-season coverage flags) decides which detail endpoints (events, lineups, statistics, player statistics, standings, injuries, toplists, odds) are requested for each competition/season. Unsupported endpoints are never called.

5. **Derived stats are computed locally.** The provider does not offer referee aggregates or leaguewide analytics; we derive everything from stored fixtures/events/team-stats. `statistics:recalculate` is quota-free.

6. **Two independent credential systems.** `API_FOOTBALL_KEY` exists only in the backend process env and is only sent in provider request headers. Platform clients authenticate with `pf_live_…` keys (prefix + HMAC-SHA256(pepper) stored; plaintext shown once at creation).

## Process model

- **API process** (`npm start` / `cli -- server`): serves REST + admin + docs.
- **Worker process** (`npm run worker` / `cli -- worker`): claims and executes sync tasks, runs the scheduler (live polling, upcoming refresh, standings, injuries, features rebuild, post-match finalization sweeps).
- **All-in-one** (`npm run cli --` with `src/index.ts` via `node dist/index.js`): single container deployments — migrations, API, worker, scheduler in one process.

Multiple workers are safe: task claiming uses row locks; scheduler rules use Redis locks.

## Failure semantics

| Failure | Behaviour |
|---|---|
| Provider 429 | Respect `Retry-After`/backoff, reschedule task |
| Provider 5xx | Exponential backoff retry (5 attempts), then task `failed` with scheduled retry |
| Provider 401/403 | No retry; surfaced via `health/provider` and task error |
| Provider 404 | Marked, not retried endlessly |
| Worker crash mid-task | Task stuck `running` > 15 min is requeued automatically |
| Redis down | Cache misses fall through to PostgreSQL; rate limiting fails closed for API keys; scheduler locks degrade to allow |
| Quota CRITICAL | Low-priority work pauses; live/post-match/upcoming continue |
