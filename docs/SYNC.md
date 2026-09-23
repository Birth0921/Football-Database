# Synchronization

## Task queue (durable)

All work flows through `sync_tasks` in PostgreSQL:

- claimed with `FOR UPDATE SKIP LOCKED` (safe with multiple workers)
- priorities: `10` live · `8` post-match · `7` upcoming/finalizations · `5–6` standings/features · `3–4` import bulk/stats · `1–2` transfers/metadata
- retries with exponential backoff (30s → 1h, capped by `max_attempts`)
- `unique_key` idempotency — an identical pending/running task is reused, never duplicated
- stale `running` tasks (crash residue) requeued after 15 minutes
- job rollups in `sync_jobs` for progress inspection

Inspect: `npm run cli -- sync:failed` (list) / `--retry` (requeue all).

## Import pipeline (first run)

```
competitions:import          → GET /leagues (1 request): countries, competitions,
                               seasons, competition_season_coverage for everything
historical:import            → plans cs.bootstrap per (league × season) in scope
  cs.bootstrap               → coverage for that season; enqueues:
      cs.fixtures            → GET /fixtures?league&season (bulk, one call)
        fixture.details      → per finished fixture: events, statistics, lineups,
                               players (ONLY if coverage allows AND season is a
                               "detail season" — see HISTORICAL_DETAIL_SEASONS)
      cs.teams               → GET /teams + team.meta (coachs, transfers) per team
      cs.standings           → GET /standings (if covered)
      cs.injuries            → GET /injuries (if covered)
      cs.toplists            → topscorers/topassists/topcards (if covered)
      cs.players             → GET /players paginated (only detail seasons + coverage)
      cs.stats               → local recalculations (league/team/player/referee)
      cs.finalize            → prediction features + Redis warm
```

Historical completed fixtures are treated as mostly immutable: after the initial import they are only re-fetched via explicit commands.

**Scope**: `IMPORT_LEAGUE_IDS` (or a curated default of major competitions) × seasons `[current-3 … current]`. Deep per-fixture data defaults to the two most recent seasons to protect quota; earlier seasons still get fixtures/teams/standings. Adjust with `HISTORICAL_DETAIL_SEASONS`.

## Ongoing current-season automation (scheduler)

| Rule | Frequency | Guard |
|---|---|---|
| `sync.live` | every `LIVE_POLL_SECONDS` (default 60s) | only when fixtures could be live (kickoff −3h…+5h window, not finished) |
| `sync.upcoming` | 15 min | refreshes next 50 fixtures per current season, rebuilds features |
| `sync.finalize-pending` | 5 min | finds finished-but-not-finalized fixtures → post-match pipeline |
| `sync.standings` | 2 h | per current season, if covered |
| `sync.injuries` | 12 h | per current season |
| `features.rebuild` | 30 min | upcoming fixtures |
| `cache.warm` | 1 h | Redis warm for API shapes |
| `sync.quota-status` | 30 min | provider `/status` check, quota snapshot update |

## Post-match pipeline (`postmatch.finalize`)

When a fixture becomes finished:

1. final events / team statistics / lineups / player performances fetched (single pass)
2. `finalized_at` set — the fixture is never detail-refetched again
3. league, team, player, referee statistics recalculated (local, no quota)
4. prediction features rebuilt; Redis caches invalidated
5. H2H remains on-demand (computed from local fixtures, cached in Redis)

## Quota manager

Sources of truth (in order): provider `/status` → response headers (`x-ratelimit-*`) → `provider_requests` table aggregation. Redis counters give the fast path.

| Level | Condition | Behaviour |
|---|---|---|
| NORMAL | > 50% daily remaining | everything runs |
| CAUTION | 20–50% | `low` priority tasks pause |
| CRITICAL | < 20% | only `live` + `high` (live scores, post-match, near-term fixtures) |
| NO_KEY | no API key | provider calls disabled, API keeps serving local data |

Check anytime: `npm run cli -- quota:status` or `GET /health/provider`.

## Provider error handling

- **429** — honor `Retry-After`, backoff, task rescheduled
- **5xx/502/503/504** — exponential backoff (max 5 attempts), then reschedule with 30s×2^n
- **401/403** — credentials/plan problem: no retry, visible in `/health/provider` and failed-task errors
- **404** — recorded, no endless retries
- **timeouts/network** — retried with backoff
- All failures land in `sync_tasks.last_error` and `provider_requests.error` (secrets redacted)
