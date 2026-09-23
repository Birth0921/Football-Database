# Football Data Platform

A production-ready football data platform built on **API-Football**:

```
API-Football
      ↓  (quota-aware sync engine, raw payload archive)
PostgreSQL  ──  derived statistics (team/player/referee/league, H2H, prediction features)
      ↓
Redis cache
      ↓
OUR REST API  (/api/v1 style endpoints, OpenAPI docs at /docs)
      ↓  (our own API keys — pf_live_…)
Prediction App · Website · other clients
```

**The API-Football key stays on the backend.** Clients only ever see platform-issued API keys.

---

## Quick start

```bash
cp .env.example .env          # fill in the values (see below)
npm install
npm run db:migrate            # create the schema
npm run dev                   # API only          (dev)
npm run cli -- worker         # worker + scheduler (separate terminal, prod-style)
npm run cli -- historical:import   # initial data import
```

Then generate a key for your prediction app:

```bash
npm run cli -- api-key:create --client "Prediction App" \
  --scopes "fixtures:read,teams:read,standings:read,statistics:read,predictions:read"
# Client:  Prediction App
# API Key:
# pf_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# IMPORTANT: Save this key now. It will not be displayed again.
```

Use it:

```bash
curl -H "X-API-Key: pf_live_…" http://localhost:3000/fixtures/live
curl -H "X-API-Key: pf_live_…" http://localhost:3000/predictions/features/12345
```

Interactive key management UI: **`/admin/api-keys/ui`** (requires `X-Admin-Token: $ADMIN_TOKEN`).
Full API docs: **`/docs`** (Swagger UI), machine-readable at `/docs/json`.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (cache, rate limits, quota counters) |
| `API_FOOTBALL_KEY` | **Secret.** Upstream provider key — backend only, never exposed |
| `API_FOOTBALL_BASE_URL` | `https://v3.football.api-sports.io` (or your RapidAPI host) |
| `API_PORT`, `API_HOST`, `API_BASE_URL` | Our API server |
| `ADMIN_TOKEN` | Protects `/admin/*` (sent as `X-Admin-Token` or `Authorization: Bearer`) |
| `API_KEY_PEPPER` | Pepper for hashing platform API keys (falls back to `ADMIN_TOKEN`) |
| `IMPORT_LEAGUE_IDS` | Comma list of API-Football league ids (empty = curated defaults) |
| `IMPORT_PREVIOUS_SEASONS` | Completed past seasons to import (default 3) + current |
| `HISTORICAL_DETAIL_SEASONS` | How many most recent seasons get deep per-fixture data |
| `PROVIDER_DAILY_LIMIT`, `PROVIDER_MINUTE_LIMIT`, `PROVIDER_MAX_RPS` | Quota planning |
| `SYNC_INLINE`, `WORKER_CONCURRENCY`, `LIVE_POLL_SECONDS`, `SCHEDULER_ENABLED` | Sync engine |

See `.env.example` for everything.

## Commands (CLI)

```bash
npm run cli -- help                     # full list
npm run cli -- database:migrate
npm run cli -- competitions:import      # catalogue + seasons + coverage
npm run cli -- historical:import        # 3 previous seasons + current, resumable
npm run cli -- current:sync
npm run cli -- competition:sync --league=39 [--season=2025]
npm run cli -- fixture:sync --id=1035048
npm run cli -- statistics:recalculate
npm run cli -- prediction-features:rebuild
npm run cli -- cache:rebuild
npm run cli -- data-quality:check
npm run cli -- quota:status
npm run cli -- sync:failed [--retry]
npm run cli -- api-key:create|rotate|revoke|list
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, sync engine, queue design |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, tables, relationships |
| [docs/SYNC.md](docs/SYNC.md) | Sync lifecycle, workers, scheduling, quota management |
| [docs/API.md](docs/API.md) | All endpoints with examples |
| [docs/API_KEYS.md](docs/API_KEYS.md) | Key lifecycle: create, rotate, revoke, scopes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, prod deployment, operations |
| [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) | Field meanings, provider coverage limitations |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems and fixes |

## Testing

```bash
npm test          # unit + integration (needs DATABASE_URL/REDIS_URL; local defaults provided)
npx tsc --noEmit  # typecheck
```

## Core guarantees

- **Idempotent** — every provider payload can be re-imported without duplicates (unique keys + upserts everywhere)
- **Resumable** — sync tasks live in PostgreSQL; crashes never lose progress (`FOR UPDATE SKIP LOCKED` claiming, stale-task requeue)
- **Quota-aware** — NORMAL/CAUTION/CRITICAL thresholds gate low-priority work before high-priority work; ~75k/day plans are used intelligently
- **Secure** — provider key never leaves the backend; platform keys stored as prefix + HMAC hash only; shown exactly once; per-client rate limits & scopes; parameterized SQL everywhere
- **Honest data** — unavailable values are NULL, never fabricated; provider coverage decides what gets fetched
