# Synchronization

## Task queue (restart-safe, resumable, idempotent)

State lives in PostgreSQL (`sync_jobs`, `sync_tasks`); BullMQ (Redis) transports
jobs. Task `task_key`s are unique — re-enqueueing is idempotent. Execution:

1. `claimDueTasks` claims work atomically (`FOR UPDATE SKIP LOCKED`) ordered by
   `priority ASC, scheduled_for ASC`
2. handler runs (registered in `src/sync/handlers.ts`)
3. `markTaskDone(result_summary)` or `markTaskFailed` with exponential backoff
   (`5s · 3^attempts`, `max_attempts` default 5)
4. crash recovery: `requeueStuckTasks` returns `running` tasks older than 2
   minutes to the queue — a crash never restarts the import from zero

Run `npm run sync:failed` to inspect failures and `npm run sync:failed -- --retry`
to requeue them.

## Task types

`competitions:import`, `seasons:import`, `coverage:discover`, `teams:import`,
`fixtures:import`, `fixture:details`, `fixture:postmatch`, `live:sync`,
`upcoming:sync`, `postmatch:scan`, `standings:sync`, `injuries:sync`,
`transfers:sync`, `odds:sync`, `*:recalculate` (players/teams/referees/leagues),
`h2h:rebuild`, `prediction-features:rebuild`, `cache:rebuild`,
`stats:recalculate:all`, `historical:import`, `current:sync`

## Priority map

| Priority | Work |
|---------:|------|
| 10 | live score/event updates |
| 20 | upcoming fixtures (near-term) |
| 25 | post-match pipeline |
| 30 | just-completed fixture details |
| 40–45 | coverage discovery, teams/squads |
| 55–60 | fixture lists, standings |
| 70 | current completed-fixture details |
| 80–85 | historical details and injuries/transfers/odds |
| 90–95 | metadata refresh, stat rollups |

## Initial historical import

`npm run historical:import` imports the approved Tier 1–3 catalogue and enqueues
only the completed historical seasons **2023, 2024, and 2025**. Season 2026 is
not part of this background queue: live, today, upcoming, and recently finished
2026 fixtures are handled by the current-priority scheduler. Per-pair
`historical_imported_at` markers prevent completed historical seasons from
requesting `/fixtures` again. The run drains as much as `IMPORT_TASK_BUDGET`
(default 500) allows; **re-run to resume** — completed work is never redone.
Afterwards:

```bash
npx tsx scripts/bulk-finalize.ts    # post-match pipeline for completed fixtures
npm run statistics:recalculate      # derived stats + prediction features + cache
npm run data-quality:check
```

## Current-season automation (scheduler)

Every 30 s the scheduler enqueues idempotent window-scoped tasks:

- **live sync** — every `SYNC_LIVE_INTERVAL_SECONDS` (60) during match hours
  (or while any fixture is live): score/status deltas, important events, cache
  invalidation; stops intensive polling when matches finish
- **upcoming sync** — every `SYNC_UPCOMING_INTERVAL_SECONDS` (900): near-term
  fixture list refresh for approved 2026 pairs
- **recent reconciliation** — once per UTC day: re-reads the previous two days
  of approved 2026 dates so delayed provider results are stored
- **post-match scan** — every `SYNC_POSTMATCH_INTERVAL_SECONDS` (300): finished
  but non-finalized approved 2026 fixtures → `fixture:postmatch`
- **metadata refresh** — every `SYNC_METADATA_INTERVAL_SECONDS` (21600):
  re-audits the allowlist and queues any unfinished 2023–2025 pair
- **stat rollup** — hourly (delayed 5 min)

## Post-match pipeline (spec §31)

final score/events/team stats/players/lineups (only when missing) → referee
statistics → team statistics → player statistics → league statistics → H2H →
prediction features → cache invalidation → `finalized = TRUE`. Finalized
fixtures are not re-fetched.

## Coverage gating (spec §15)

Before detail requests, `competition_season_coverage` flags (events, lineups,
fixture/player statistics, standings, players, top scorers/assists/cards,
injuries, sidelined, predictions, odds, referees) are checked per
competition/season; unsupported endpoints are never called again.

## Quota manager (spec §41)

`provider_quota` tracks daily (`PROVIDER_DAILY_QUOTA`, default 75 000) and
per-minute (300) budgets. The provider's own counters are AUTHORITATIVE:
`/status` (`requests.current` / `requests.limit_day`) and any rate-limit
response headers override local counting, and the scheduler + `quota:status`
CLI reconcile every 15 minutes (or on demand). `/status` is quota-free and
exempt from deferral, so reconciliation works even in CRITICAL/EXHAUSTED.

Class-aware tiers (example for 150 000/day: essential reserve 10 000,
background floor 30 000):

- **NORMAL** — everything runs.
- **CAUTION** (remaining ≤ background floor): background traffic — historical
  imports, coverage probes, teams/squads, standings, injuries, odds, transfers,
  metadata refresh — is DEFERRED with exponential backoff (5 → 10 → 20 → 40 →
  60 min cap + jitter; deferrals never burn failure attempts). ESSENTIAL
  traffic keeps running: `live:sync`, `upcoming:sync`, `current:sync`,
  `postmatch:scan`, `fixture:postmatch`, and current-season `fixture:details`.
  Historical detail/post-match tasks explicitly use the background class.
  Example: 29 355/150 000 remaining (19.6 %) is CAUTION — live + upcoming
  fixture sync continues, background imports wait for the daily reset.
- **CRITICAL** (remaining ≤ essential reserve): only essential sync continues —
  the reserve exists precisely so live/upcoming sync survives a heavy import day.
- **EXHAUSTED** (remaining = 0): all provider traffic stops until the UTC day
  rolls; the platform (API, stats, cache) keeps serving.
- minute-window exhausted: workers wait for the window to roll (≤60 s).

Tuning: `PROVIDER_ESSENTIAL_RESERVE` (0 = auto ≈ 7 % capped at 10 000) and
`PROVIDER_BACKGROUND_FLOOR_PERCENT` (default 20).

Check + reconcile: `npm run quota:status` (live mode pulls the provider's own
counters first).

## Error handling (spec §51)

| Case | Behaviour |
|------|-----------|
| 401/403 | fail task (`PROVIDER_AUTH`); fix credentials |
| 404 | empty result, no infinite retries |
| 429 | backoff (honours `Retry-After`), reschedule task |
| 500/502/503/504 | exponential backoff, retry ≤ max_attempts |
| timeout/network | backoff + retry |
| malformed/partial JSON | raw payload stored; mapping is defensive; unknown event types preserved in JSONB |
