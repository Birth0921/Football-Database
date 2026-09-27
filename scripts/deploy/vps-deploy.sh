#!/usr/bin/env bash
# Idempotent production deploy for a single VPS (tested for Oracle Cloud Ubuntu).
# Run ON the server, from the project root:   scripts/deploy/vps-deploy.sh
# Requires a server-side .env (see .env.example). Secrets never leave the server.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }

# --- 1. docker + compose plugin ---------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "docker not found — installing via get.docker.com…"
  curl -fsSL https://get.docker.com | sudo sh
fi
DOCKER="docker"
if ! $DOCKER ps >/dev/null 2>&1; then DOCKER="sudo docker"; fi
$DOCKER compose version >/dev/null 2>&1 || { log "ERROR: docker compose plugin missing"; exit 1; }
log "docker: $($DOCKER --version) (via: $DOCKER)"

# --- 2. server-side secrets ---------------------------------------------------
if [ ! -f .env ]; then
  log "ERROR: .env not found — create it on the server from .env.example (real values, chmod 600)"
  exit 1
fi
chmod 600 .env
log ".env present ($(grep -c '=' .env) lines, mode 600)"

# --- 3. host firewall ---------------------------------------------------------
# Oracle Cloud Ubuntu images REJECT everything but :22 by default, even when the
# Security List allows it. Open the published web port in the host firewall.
WEB_PORT="$(sed -nE 's/^WEB_PORT=([0-9]+).*/\1/p' .env | tail -1)"
WEB_PORT="${WEB_PORT:-8080}"
log "web port: $WEB_PORT — remember to also allow it in your cloud Security List / ingress rules"
for CH in INPUT FORWARD; do
  sudo iptables -C "$CH" -p tcp --dport "$WEB_PORT" -j ACCEPT 2>/dev/null ||
    sudo iptables -I "$CH" 1 -p tcp --dport "$WEB_PORT" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save
elif [ -f /etc/iptables/rules.v4 ]; then
  sudo iptables-save | sudo tee /etc/iptables/rules.v4 >/dev/null
fi

# --- 4. build + start ----------------------------------------------------------
log "building + starting services (api, worker, scheduler, web)…"
$DOCKER compose up -d --build

# --- 5. wait for API health -----------------------------------------------------
log "waiting for API health (migrations run automatically on boot)…"
API_OK=0
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null http://127.0.0.1:4000/api/v1/health 2>/dev/null; then API_OK=1; break; fi
  sleep 2
done
if [ "$API_OK" != "1" ]; then
  log "API not healthy — recent api logs:"
  $DOCKER compose logs --tail 40 api || true
  exit 1
fi
log "API healthy ✔"
log "service status:"
$DOCKER compose ps
log "done. Verify with: scripts/deploy/vps-verify.sh"
log "then bootstrap data: see DEPLOYMENT.md §Bootstrap"
