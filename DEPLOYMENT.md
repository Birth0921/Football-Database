# Deployment

## Requirements

- Node.js 20+
- PostgreSQL 14+ (managed recommended)
- Redis 6+ (or Valkey — drop-in)
- Docker + docker-compose (optional, provided)

## Deploy online now

### Option 1 — Render (fastest, recommended)

The repo ships a Blueprint (`render.yaml`) that provisions everything:

1. Push this repo to GitHub (already done for this workspace).
2. Go to **render.com → New → Blueprint** and select the repo. Render creates:
   managed PostgreSQL, a private Key Value (Redis) instance, and one Docker web
   service running `ROLE=all` (API + worker + scheduler + website in one
   container).
3. At creation you are prompted for three secrets:
   - `ADMIN_PASSWORD` — choose a strong password (admin dashboard login)
   - `API_FOOTBALL_KEY` — your provider key, **or leave empty for mock mode**
   - `SITE_API_KEY` — optional (a stable `pf_live_…` key for anonymous website
     traffic; if left empty a fresh site key is provisioned per boot)
   `JWT_SECRET` is generated automatically. Never commit these values.
4. After the first deploy finishes, open the service Shell (dashboard →
   `football-platform` → Shell) and bootstrap the data:
   ```bash
   npm run competitions:import
   IMPORT_TASK_BUDGET=5000 npm run historical:import   # re-run to resume
   npx tsx scripts/bulk-finalize.ts
   npm run statistics:recalculate
   npm run data-quality:check
   npm run api-key:create -- --client "Prediction App" \
     --scopes "fixtures:read,teams:read,players:read,referees:read,standings:read,statistics:read,predictions:read" \
     --label "production" --expires 365
   ```
   (The CLI is included in the image. The historical import is resumable and
   quota-aware — it may need 2–3 runs to finish.)
5. Verify at `https://<your-service>.onrender.com`:
   - `/` website · `/admin/api-keys` admin · `/api/v1/docs` OpenAPI
   - `curl https://…/api/v1/health/data` → 200
   - `curl -H "X-API-Key: pf_live_…" https://…/api/v1/fixtures` → data
   The prediction app should point `FOOTBALL_API_BASE_URL` at
   `https://<your-service>.onrender.com/api/v1` with its own `pf_live_…` key
   (client keys are passed through the website proxy — verified in code).
6. Attach a custom domain in the dashboard (Render manages TLS), and update
   the prediction app's base URL.

Migrations run automatically at boot (`SKIP_MIGRATE=1` disables). For zero
downtime later, split the container into separate `ROLE=api / web / worker /
scheduler` services (same image; set `API_INTERNAL_URL` on the `web` service to
the API's URL) and scale them independently.

### Option 2 — Railway

New → Project → Deploy from GitHub. Add Postgres and Redis (Key Value)
plugins. On the Dockerfile service set `ROLE=all` and the env vars from the
table below (`DATABASE_URL` / `REDIS_URL` are wired by the plugins; Railway
injects `PORT`, which the servers accept). Run the bootstrap commands from
step 4 in the service's shell.

### Option 3 — any VPS with Docker (Hetzner, DigitalOcean, …)

```bash
git clone <repo> && cd Football-Database
cp .env.example .env    # set DATABASE_URL, REDIS_URL, JWT_SECRET,
                        # ADMIN_USER, ADMIN_PASSWORD, API_FOOTBALL_KEY
docker compose up -d --build
docker compose exec api npm run database:migrate
docker compose exec api npm run competitions:import
docker compose exec api env IMPORT_TASK_BUDGET=5000 npm run historical:import
docker compose exec api npx tsx scripts/bulk-finalize.ts
docker compose exec api npm run statistics:recalculate
docker compose exec api npm run api-key:create -- --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,referees:read,standings:read,statistics:read,predictions:read"
```
Put Caddy/nginx in front with TLS (free certs) proxying to `:8080` (website +
`/api/v1` via the site proxy) and, if you want a separate API hostname,
directly to `:4000`. Firewall PostgreSQL/Redis to loopback.

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
