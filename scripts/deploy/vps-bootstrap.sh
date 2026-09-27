#!/usr/bin/env bash
# First-run production data bootstrap — run ON the VPS (or via ssh):
#   bash scripts/deploy/vps-bootstrap.sh
#
# Imports competitions + 3 previous seasons + the current season (live
# API-Football), finalizes fixtures, recalculates all derived statistics,
# runs data-quality checks, and creates the Prediction App API key
# (displayed exactly once — save it immediately).
#
# The historical import is resumable and quota-aware: if it exits early
# (budget/quota/network), just re-run this script — it continues where it
# stopped. Live imports can take 20–60 minutes; keep the terminal open.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DOCKER="docker"
$DOCKER ps >/dev/null 2>&1 || DOCKER="sudo docker"

run() {
  echo
  echo "==================================================================="
  echo ">>> $*"
  echo "==================================================================="
  $DOCKER compose run --rm api "$@"
}

run npm run doctor
run npm run competitions:import
run env IMPORT_TASK_BUDGET="${IMPORT_TASK_BUDGET:-8000}" npm run historical:import

run npx tsx scripts/bulk-finalize.ts
run npm run statistics:recalculate
run npm run data-quality:check

echo
echo "==================================================================="
echo ">>> Creating the Prediction App API key — displayed EXACTLY ONCE."
echo ">>> SAVE IT NOW (it cannot be shown again)."
echo "==================================================================="
$DOCKER compose run --rm api npm run api-key:create -- \
  --client "Prediction App" \
  --scopes "fixtures:read,teams:read,players:read,referees:read,standings:read,statistics:read,predictions:read" \
  --label production --expires 365

echo
echo "Bootstrap complete. Prediction app config:"
echo "  FOOTBALL_API_BASE_URL=http://158.178.196.221/api/v1"
echo "  FOOTBALL_API_KEY=<the pf_live_... key printed above>"
