# Deployment

## Requirements

- Node.js 20+
- PostgreSQL 14+ (managed recommended)
- Redis 6+
- Docker + docker-compose (optional, provided)

## Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/football` |
| `REDIS_URL` | yes | `redis://host:6379` |
| `API_FOOTBALL_KEY` | for live data | empty ⇒ mock provider mode |
| `JWT_SECRET` | yes (prod) | ≥16 random chars (`openssl rand -hex 32`) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | yes (prod) | admin dashboard login |
| `API_PORT` / `WEB_PORT` / `API_HOST` | no | 4000 / 8080 / 0.0.0.0 |
| `PROVIDER_DAILY_QUOTA` | no | 75000 |
| `PROVIDER_MINUTE_LIMIT` | no | 300 |
| `HISTORICAL_SEASONS_BACK` | no | 3 |
| `SYNC_LIVE_INTERVAL_SECONDS` | no | 60 |
| `SYNC_UPCOMING_INTERVAL_SECONDS` | no | 900 |
| `SYNC_POSTMATCH_INTERVAL_SECONDS` | no | 300 |
| `SYNC_METADATA_INTERVAL_SECONDS` | no | 21600 |
| `SITE_API_KEY` | no | website's own `pf_live_…` key (else auto-provisioned) |
| `LOG_LEVEL` | no | info |

Production start-up refuses to boot with missing `JWT_SECRET`,
`ADMIN_PASSWORD`, `DATABASE_URL` or `REDIS_URL` (`ensureSecretsForProduction`).

## Docker Compose (local / single host)

```bash
cp .env.example .env    # edit secrets!
docker compose up -d --build
docker compose exec api npm run database:migrate
docker compose exec api npm run competitions:import
docker compose exec api npm run historical:import
docker compose exec api npx tsx scripts/bulk-finalize.ts
docker compose exec api npm run statistics:recalculate
docker compose exec api npm run api-key:create -- --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,standings:read,statistics:read,predictions:read"
```

Services: `postgres`, `redis`, `api` (:4000), `worker`, `scheduler`, `web`
(:8080). Run `npm run database:migrate` on every deploy before starting new
code (migrations are incremental and tracked in `schema_migrations`).

## Bare-metal / process manager

```bash
npm ci
npm run build               # optional: tsc → dist
npm run database:migrate
# under systemd/supervisor/pm2:
node --import tsx src/api/server.ts
node --import tsx src/worker/worker.ts
node --import tsx src/worker/scheduler.ts
node --import tsx src/web/server.ts
```

Terminate workers with SIGTERM — they drain gracefully.

## Health verification

```bash
curl -fsS https://api.yourdomain.com/api/v1/health           # alive
curl -fsS https://api.yourdomain.com/api/v1/health/database  # postgres
curl -fsS https://api.yourdomain.com/api/v1/health/redis     # redis
curl -fsS https://api.yourdomain.com/api/v1/health/provider  # quota/state
curl -fsS https://api.yourdomain.com/api/v1/health/data      # data quality
npm run quota:status
npm run sync:failed
npm run data-quality:check
```

## Recurring synchronization

Run `npm run dev:scheduler` (and `npm run dev:worker`) as always-on services —
that *is* the recurring synchronization (live / upcoming / post-match /
metadata cycles, see [SYNC.md](SYNC.md)). For cron-only environments, schedule:

```cron
*/5  * * * *  cd /app && npm run current:sync
0    */6 * * * cd /app && npm run seasons:import
30   3  * * *  cd /app && npm run statistics:recalculate
```

## Security checklist

- [ ] `.env` outside git (`.gitignore` enforced), secrets in a secrets manager
- [ ] TLS terminator (nginx/traefik) in front of :4000/:8080
- [ ] firewall PostgreSQL/Redis (loopback or private network)
- [ ] strong `ADMIN_PASSWORD`; rotate `JWT_SECRET` on compromise
- [ ] client API keys scoped minimally, expiring, rotated regularly
- [ ] `API_FOOTBALL_KEY` present only in backend env (worker/scheduler/api —
      never in any frontend bundle)

## Zero-downtime key rotation for clients

1. `npm run api-key:rotate -- --key <prefix> --grace-hours 24`
2. update the consuming app's `FOOTBALL_API_KEY`
3. old key auto-expires after the grace window (or revoke immediately)
