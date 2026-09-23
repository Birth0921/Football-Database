# Deployment

## Requirements

- Node.js ≥ 20
- PostgreSQL ≥ 14
- Redis ≥ 6

## Docker

```bash
docker compose up -d --build     # app + postgres + redis
docker compose exec app npm run db:migrate
docker compose exec app npm run cli -- historical:import
```

`docker-compose.yml` provides app (API+worker in one process), PostgreSQL 16 and Redis 7 with healthchecks. For production use managed Postgres/Redis and set the connection env vars instead.

## Environment

Copy `.env.example` → `.env` and set at minimum:

```ini
DATABASE_URL=postgresql://user:pass@host:5432/football
REDIS_URL=redis://default:pass@host:6379
API_FOOTBALL_KEY=your-provider-key
ADMIN_TOKEN=long-random-string
API_KEY_PEPPER=another-long-random-string
API_BASE_URL=https://api.yourdomain.com
```

## Boot sequence (first deploy)

```bash
npm ci
npm run db:migrate               # schema
npm run build                    # compile to dist/
npm run cli -- competitions:import
npm run cli -- historical:import # resumable; safe to re-run if interrupted
npm start                        # API     (port $API_PORT)
npm run worker                   # sync worker + scheduler (second process/service)
```

All-in-one container alternative: `node dist/index.js` (runs migrations, scheduler, worker and API together).

## Process supervision

Run `server` and `worker` as separate services (systemd, Docker Compose, k8s Deployments). Both are stateless; all state is in PostgreSQL/Redis. Scale workers horizontally — task claiming is lock-safe.

Example systemd units are straightforward:

```ini
# /etc/systemd/system/football-api.service
[Service]
EnvironmentFile=/opt/football/.env
ExecStart=/usr/bin/node /opt/football/dist/api/server.js
Restart=always
```

## Reverse proxy

Terminate TLS at nginx/Caddy and forward to `API_PORT`. The API trusts `X-Forwarded-*` (`trustProxy: true`).

## Backups & data retention

- PostgreSQL is the source of truth — schedule `pg_dump`/WAL archiving.
- `raw_provider_payloads` grows over time; prune old rows when no longer needed for reprocessing:
  `DELETE FROM raw_provider_payloads WHERE fetched_at < now() - interval '180 days';`
- `provider_requests` can be pruned similarly (e.g. keep 90 days).

## Operations runbook

| Task | Command |
|---|---|
| Migrate | `npm run cli -- database:migrate` |
| Import catalogue | `npm run cli -- competitions:import` |
| Full/resume import | `npm run cli -- historical:import` |
| Add competition | set `IMPORT_LEAGUE_IDS`, then `competition:sync --league=ID` |
| Recompute analytics | `npm run cli -- statistics:recalculate` |
| Rebuild features/cache | `prediction-features:rebuild` / `cache:rebuild` |
| Data quality | `npm run cli -- data-quality:check` or `GET /health/data` |
| Quota | `npm run cli -- quota:status` or `GET /health/provider` |
| Failed syncs | `npm run cli -- sync:failed` / `--retry` or `GET /admin/sync` |
| Keys | `api-key:create/rotate/revoke/list` or `/admin/api-keys/ui` |
