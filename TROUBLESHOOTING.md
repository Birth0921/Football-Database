# Troubleshooting

Run the doctor first:

```bash
npx tsx src/cli/doctor.ts      # DB / Redis / provider credentials report
npm run quota:status           # provider budget + recent endpoint calls
npm run sync:failed            # stuck/failed sync tasks
npm run data-quality:check     # integrity findings
```

## Connection problems

**`ECONNREFUSED 127.0.0.1:5432`** — PostgreSQL is not running. Locally:
`npm run devdb:start` (embedded) or start your server; verify `DATABASE_URL`.

**`ECONNREFUSED 127.0.0.1:6379` / `redis unavailable`** — start Redis. The API
degrades gracefully to PostgreSQL (see `GET /health/redis`), but the worker and
scheduler require Redis for BullMQ.

**`password authentication failed`** — wrong `DATABASE_URL` credentials.

## Provider problems

**`Provider authentication failed — check API_FOOTBALL_KEY`** (401/403 from
API-Football) — key missing, invalid, or banned. Verify with
`npx tsx src/cli/doctor.ts`; never paste the key into code, tickets, or logs.

**`MOCK provider active` when real data was expected** — `API_FOOTBALL_KEY` is
empty in the environment the process actually loaded (check `.env` vs shell
env; restart the services after editing).

**`PROVIDER_QUOTA_EXHAUSTED`** — daily budget spent; live services keep working;
sync resumes after the UTC day rolls (`npm run quota:status`).

**Tasks fail with 429 repeatedly** — lower `PROVIDER_MINUTE_LIMIT` to match
your plan; the engine already waits on minute-window exhaustion.

## Sync problems

**Import seems stuck / stopped part-way** — by design it is resumable. Check
`npm run sync:failed` (pending counts as fine while `scheduled_for` is in the
future — that's retry backoff). Re-run `npm run historical:import` or
`npm run current:sync` to continue; completed tasks are never redone.

**`task could not be claimed (status=done)`** — the work already completed;
re-running is safe.

**Tasks show `failed` after 5 attempts** — inspect `last_error`
(`npm run sync:failed`), fix the cause, then `npm run sync:failed -- --retry`.

**Crashed mid-import** — nothing to undo: `running` tasks are requeued
automatically after 2 minutes; simply restart the worker.

**Fixture missing events/stats** — run
`npm run fixture:sync -- --fixture <id> --postmatch`, or bulk:
`npx tsx scripts/bulk-finalize.ts`.

**Standings empty for a competition/season** — check coverage:
`GET /api/v1/competitions/:id/seasons` → `coverage.standings`. Cups and some
second divisions genuinely lack standings at the provider; we never fabricate
them.

## API-key problems

**401 `invalid api key`** — missing/typo'd `X-API-Key`, revoked, expired, or
rotation grace closed. `npm run api-key:list` shows status (prefixes only).

**403 `missing required scope`** — grant the scope via a rotated key with a
wider set (scopes cannot be edited in place — rotate instead).

**429 with `Retry-After`** — per-key rate limit (`rate_limit_per_minute`/
`rate_limit_per_day` on the client). Adjust via admin PATCH
`/admin/clients/:id`.

**"I lost my API key"** — it is unrecoverable by design (only hashes are
stored). Rotate: `npm run api-key:rotate -- --key <prefix>`.

## Cache problems

**Stale scores on the website** — caches invalidate on sync writes; if Redis
was down during a write, warm it: `npm run cache:rebuild`, or flush keys
matching `fdp:*`.

## Data-quality failures

`npm run data-quality:check` prints per-check status (duplicate provider IDs,
orphan events, completed fixtures without scores, aggregate consistency…).
`FAIL` rows indicate integrity violations — check the reported tables; the
usual cause is an interrupted manual write, not the sync engine (which is
covered by constraints).

## Known data limitations

- Provider coverage varies per competition/season (e.g. cups without
  standings, leagues without odds/expected-goals). Limitations are stored in
  `competition_season_coverage` and surfaced via
  `GET /api/v1/competitions/:id/seasons`; we never fabricate missing values.
- Fixture→referee linkage uses the referee display name (API-Football exposes
  names on fixtures); same-name referees can collapse to one internal record.
- Mock mode is synthetic data (fictional teams/players) for pipeline
  verification only — set `API_FOOTBALL_KEY` for real data. In early mock-mode
  imports some generated referee names collided and merged; the generator now
  produces unique names.
