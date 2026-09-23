# Troubleshooting

## Diagnostics first

```bash
curl -s http://localhost:3000/health | jq
curl -s http://localhost:3000/health/data | jq
npm run cli -- quota:status
npm run cli -- sync:failed
npm run cli -- data-quality:check
```

## Common issues

### `API_FOOTBALL_KEY is not configured`
Set `API_FOOTBALL_KEY` in `.env` and restart the API/worker processes. Verify with `npm run cli -- quota:status` (shows `NO_KEY`) and `GET /health/provider?refresh=1`.

### Provider 401/403 (`provider rejected request`)
Wrong key or subscription lacking the endpoint/plan. Check `/health/provider?refresh=1` — the `/status` account payload shows your plan. If you subscribe via RapidAPI, set `API_FOOTBALL_BASE_URL` to your RapidAPI host (the client then sends `x-rapidapi-key`).

### Import stalls / tasks pending forever
- Is the worker running? `npm run worker` (the API process alone does not execute tasks).
- `npm run cli -- sync:failed` — quota-gated tasks fail with "quota … gate closed" when the plan is CRITICAL; they auto-retry later.
- Stale running tasks are requeued after 15 minutes automatically; force with `POST /admin/sync/retry-failed`.

### `429 rate limit exceeded for this API client`
Your client hit its `rate_limit_per_minute/day`. Raise via `PATCH /admin/clients/:id` or admin UI.

### `403 insufficient scope: requires '…'`
The key lacks the route's scope. Rotate/create a key with the needed scope.

### Redis errors in logs (`redis connect failed`)
The platform degrades gracefully: cache misses hit PostgreSQL, but API-key rate limiting fails **closed** (keys stop authenticating). Restore Redis and the system recovers automatically.

### Duplicate data after re-import
Shouldn't happen — everything is idempotent by unique keys. If you see it, run `data-quality:check` and report the failing check (it pinpoints the violated invariant).

### Player/season statistics missing for some competitions
Those seasons likely lack `players`/`statistics_players` coverage (see `/competitions/:id/seasons`). This is a provider limitation, not a bug — the sync engine never requests unsupported endpoints.

### Postgres "relation does not exist"
Run migrations: `npm run db:migrate`.

### Changing `API_KEY_PEPPER` invalidated all keys
Expected — the pepper is part of every hash. Re-issue keys (`api-key:create`).

## Log locations

- Processes log structured JSON to stdout (pipe to your collector). In dev, `LOG_LEVEL=debug` shows task-level detail.
- `provider_requests` and `sync_tasks.last_error` hold per-call/per-task errors (secrets redacted).
