# Deployment

## Requirements

- Node.js 20+
- PostgreSQL 14+ (managed recommended)
- Redis 6+ (or Valkey — drop-in)
- Docker + docker-compose (optional, provided)

## Deploy online now (production VPS)

Reference topology (what this repo deploys with):

- **Oracle Cloud Ubuntu VPS** — runs the Docker services (`api`, `worker`,
  `scheduler`, `web`)
- **Neon Postgres** (managed) — use the **direct** endpoint (the one *without*
  `-pooler.`): long-lived servers shouldn't share a transaction pooler, and
  session-level features like the migration advisory lock are unsafe through it
- **Upstash Redis** (managed) — use the `rediss://` (TLS) URL

All production secrets live in the server-side `.env` (chmod 600, gitignored).
`.env.example` documents the variable **names** only — never put real values in
it and never commit secrets.

### 1. Prepare the VPS (once)

```bash
ssh ubuntu@<VPS-IP>                    # 'opc' on Oracle Linux images
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit  # then log in again
```

Open the web port in the **Oracle Cloud console**: Networking → Virtual Cloud
Networks → your VCN → Security Lists → Default Security List → **Add Ingress
Rule**: Source `0.0.0.0/0`, Destination Port `80` (TCP). The deploy script
handles the in-host iptables rule; the ingress rule must be added in the OCI
console.

### 2. Place code + secrets on the server

```bash
# from your machine — no GitHub access needed on the VPS:
git archive HEAD | ssh ubuntu@<VPS-IP> 'mkdir -p /opt/football-platform && tar -x -C /opt/football-platform'
scp .env ubuntu@<VPS-IP>:/opt/football-platform/.env   # server-side secrets only
```

Server-side `.env` (production): `DATABASE_URL` (Neon **direct** endpoint),
`REDIS_URL` (`rediss://…` Upstash), `NODE_ENV=production`, `JWT_SECRET`,
`ADMIN_USER`/`ADMIN_PASSWORD`, `API_FOOTBALL_KEY`, `PUBLIC_BASE_URL=http://<VPS-IP>/`,
`WEB_PORT=80`, `WORKER_SWEEP_INTERVAL_SECONDS=15`.

### 3. Deploy

```bash
ssh ubuntu@<VPS-IP>
cd /opt/football-platform
scripts/deploy/vps-deploy.sh
```

The script is idempotent: installs Docker if missing, validates `.env`, opens
the host firewall for the web port, builds and starts the services, waits for
`/api/v1/health`, and prints the status. Migrations apply automatically on API
boot (advisory-lock protected; `SKIP_MIGRATE=1` disables).

| Service | Role | Ports | Notes |
|---|---|---|---|
| `web` | website + admin + `/api/v1` proxy | `${WEB_PORT:-8080}` public | proxies to `http://api:4000`, passes client API keys through |
| `api` | REST API | `127.0.0.1:4000` (loopback) | healthcheck `/api/v1/health` |
| `worker` | sync task executor | — | waits for API health |
| `scheduler` | periodic sync scheduling | — | waits for API health |
| `migrate` | one-shot migrations | — | `docker compose --profile tools run --rm migrate` |
| `postgres` / `redis` | self-hosted fallbacks | — | only with `--profile local` |

### 4. Verify

```bash
scripts/deploy/vps-verify.sh            # doctor (DB/Redis/provider) + endpoints
# optionally with a key:
scripts/deploy/vps-verify.sh pf_live_xxxxxxxx
```

From a browser: `http://<VPS-IP>/` (website) · `/admin/api-keys` (admin) ·
`/api/v1/docs` (OpenAPI).

### 5. Bootstrap real data (first time only)

```bash
docker compose run --rm api npm run competitions:import
docker compose run --rm api env IMPORT_TASK_BUDGET=5000 npm run historical:import  # resumable
docker compose run --rm api npx tsx scripts/bulk-finalize.ts
docker compose run --rm api npm run statistics:recalculate
docker compose run --rm api npm run data-quality:check
docker compose run --rm api npm run api-key:create -- --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,referees:read,standings:read,statistics:read,predictions:read" \
  --label production --expires 365
```

Then point the prediction app at `http://<VPS-IP>/api/v1` with its `pf_live_…`
key (client keys are forwarded by the web proxy).

### 6. TLS + custom domain (recommended)

Caddy on the host gives automatic Let's Encrypt certs:

```caddyfile
football.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

(Set `WEB_PORT=8080` behind a reverse proxy; Caddy owns :80/:443.)

### Updating

```bash
git archive HEAD | ssh ubuntu@<VPS-IP> 'tar -x -C /opt/football-platform'  # or git pull
ssh ubuntu@<VPS-IP> 'cd /opt/football-platform && scripts/deploy/vps-deploy.sh'
```

To scale later, run the same image as separate services with
`ROLE=api|web|worker|scheduler` and point `API_INTERNAL_URL` at the API's
internal URL.

## Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/football` · Neon: use the **direct** endpoint (no `-pooler.`) |
| `REDIS_URL` | yes | `redis://host:6379` · Upstash: use `rediss://…` (TLS) |
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
| `SITE_API_KEY` | no | operator override for the website proxy; by default a **managed Website key** is auto-provisioned (see API_KEYS.md) |
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
