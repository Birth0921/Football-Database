#!/usr/bin/env bash
# Post-deploy verification: connectivity (DB / Redis / provider), public
# endpoints through the web proxy, and an optional authenticated API check.
#   scripts/deploy/vps-verify.sh [pf_live_api_key]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"

log() { printf '\033[1;34m[verify]\033[0m %s\n' "$*"; }
DOCKER="docker"
$DOCKER ps >/dev/null 2>&1 || DOCKER="sudo docker"

WEB_PORT="$(sed -nE 's/^WEB_PORT=([0-9]+).*/\1/p' .env | tail -1)"
WEB_PORT="${WEB_PORT:-8080}"

log "1/3 platform doctor (Postgres, Redis, API-Football)…"
$DOCKER compose run --rm --no-deps api npm run doctor

log "2/3 public endpoints via web proxy (127.0.0.1:${WEB_PORT})…"
for path in / /admin/api-keys /api/v1/docs /api/v1/health /api/v1/health/data; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}${path}")"
  log "  ${path} -> ${code}"
done

log "3/3 authenticated API check…"
if [ -n "${1:-}" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $1" "http://127.0.0.1:${WEB_PORT}/api/v1/fixtures?limit=1")"
  log "  GET /api/v1/fixtures (with key) -> ${code} (200 = OK)"
else
  log "  skipped — pass an API key as argument to test an authenticated endpoint"
fi
log "done. From outside: http://<public-ip>:${WEB_PORT}/"
