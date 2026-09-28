# Football Data Platform

Production-grade football data platform: API-Football → sync engine → raw
storage → normalized PostgreSQL warehouse → derived statistics & prediction
features → Redis cache → **our own REST API** (API-key authenticated) →
website / prediction app / other clients.

> **Key rule:** the external provider key (`API_FOOTBALL_KEY`) never leaves the
> backend. Website and prediction apps authenticate to *our* API with our own
> `pf_live_…` keys.

## Quick start (development)

```bash
# 1) install
npm install

# 2) configure
cp .env.example .env          # fill in secrets (see below)

# 3) local services (or point DATABASE_URL / REDIS_URL at your own)
npm run devdb:start           # embedded PostgreSQL on :5432 (db "football")
# Redis on 127.0.0.1:6379 (system service or: redis-server)

# 4) migrate
npm run database:migrate

# 5) verify environment
npx tsx src/cli/doctor.ts

# 6) start everything (4 terminals or your process manager)
npm run dev:api          # REST API        :4000
npm run dev:worker       # sync worker
npm run dev:scheduler    # recurring sync scheduler
npm run dev:web          # website + admin :8080

# 7) initial data import (resumable, quota-aware)
npm run competitions:import
npm run historical:import     # 3 previous seasons + current; re-run to resume
npx tsx scripts/bulk-finalize.ts   # post-match finalization backfill
npm run statistics:recalculate
npm run data-quality:check
```

If `API_FOOTBALL_KEY` is not set the platform runs in **mock provider mode**
(deterministic synthetic data — fictional teams/players) so the entire pipeline
can be verified without credentials. Set `API_FOOTBALL_KEY` for real data.

## Create an API key for the prediction app

```bash
npm run api-key:create -- --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,standings:read,statistics:read,predictions:read"
```

The secret is printed **once**. Or use the admin dashboard at
`http://localhost:8080/admin/api-keys` (login with `ADMIN_USER`/`ADMIN_PASSWORD`).

Prediction app usage:

```bash
FOOTBALL_API_BASE_URL=https://api.yourdomain.com/api/v1
FOOTBALL_API_KEY=pf_live_xxxxxxxx

curl -H "X-API-Key: $FOOTBALL_API_KEY" \
  "$FOOTBALL_API_BASE_URL/predictions/features/12345"
```

## Services

| Service        | Command                 | Port | Purpose                                  |
|----------------|-------------------------|------|------------------------------------------|
| API            | `npm run dev:api`       | 4000 | REST API `/api/v1` + OpenAPI docs        |
| Worker         | `npm run dev:worker`    | –    | BullMQ sync worker (restart-safe queue)  |
| Scheduler      | `npm run dev:scheduler` | –    | recurring current-season sync cycles     |
| Website + Admin| `npm run dev:web`       | 8080 | public site + `/admin/api-keys`          |

## CLI commands

```
npm run database:migrate          # apply migrations
npm run database:migrate:status   # list applied migrations
npm run competitions:import       # competitions + seasons + season windows
npm run seasons:import            # provider season list
npm run historical:import         # resumable full window import
npm run current:sync              # live + upcoming + post-match scan
npm run competition:sync -- --competition <id>
npm run season:sync -- --season <id>
npm run fixture:sync -- --fixture <id> [--postmatch]
npm run statistics:recalculate    # all derived stats + prediction features + cache
npm run team:recalculate -- [--team --competition --season]
npm run player:recalculate -- [--fixture <id>]
npm run referee:recalculate -- [--fixture <id>]
npm run league:recalculate -- [--competition --season]
npm run prediction-features:rebuild -- [--upcoming]
npm run cache:rebuild
npm run data-quality:check
npm run quota:status
npm run sync:failed               # list failed tasks
npm run sync:failed -- --retry    # requeue failed tasks
npm run api-key:create -- --client "Prediction App" [--scopes …] [--expires 90]
npm run api-key:rotate -- --key <prefix-or-id> [--grace-hours 24]
npm run api-key:revoke -- --key <prefix-or-id>
npm run api-key:list
npx tsx src/cli/doctor.ts         # environment + credentials check
npx tsx scripts/bulk-finalize.ts  # finalize all completed fixtures
```

## Documentation

| File | Contents |
|------|----------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | system design, data flow, sync engine |
| [DATABASE.md](DATABASE.md) | schema overview & relationships |
| [DATA_DICTIONARY.md](DATA_DICTIONARY.md) | table/column reference |
| [SYNC.md](SYNC.md) | synchronization, quota management, priorities |
| [API.md](API.md) | REST endpoints |
| [API_KEYS.md](API_KEYS.md) | our API-key system (create/rotate/revoke/scopes) |
| [DEPLOYMENT.md](DEPLOYMENT.md) | production deployment |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | common failures & fixes |
| [Soccer.md](Soccer.md) | original build specification |

## Testing

```bash
npm test          # 48 unit/integration/API/sync/quota/security tests
```

Coverage includes: API-key generation/rotation/revocation/expiry/scopes, rate
limiting, provider mapping, duplicate-import idempotency, sync resume after
failure, quota thresholds, Redis cache, referee/league derived statistics,
data-quality checks, and proof the provider key never appears in responses.

## Environment variables

See [.env.example](.env.example) for the full annotated list:

- `DATABASE_URL`, `REDIS_URL` — required
- `API_FOOTBALL_KEY` — external provider key (backend-only; empty = mock mode)
- `JWT_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD` — admin dashboard auth
- `PROVIDER_DAILY_QUOTA` (75 000), `PROVIDER_MINUTE_LIMIT` (300) — quota plan
- `HISTORICAL_SEASONS_BACK` (3), `SYNC_*_INTERVAL_SECONDS` — sync cadences

**Never commit `.env`. Never expose `API_FOOTBALL_KEY` to any frontend.**
