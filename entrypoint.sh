#!/bin/bash
# Role-based entrypoint.
#   ROLE=api | worker | scheduler | web | migrate | all   (default: api)
#   ROLE=all runs API + worker + scheduler + website in one container
#   (single-service PaaS deploys; the website proxies /api/v1 to the API and
#   passes client API keys through, so one public URL serves everything).
#   Any other ROLE value runs "$@" as a one-off command (e.g. docker run … npm run historical:import).
#   SKIP_MIGRATE=1 disables automatic migrations on api/all startup.
set -e

# Any arguments = one-off command (docker run … npm run historical:import).
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

run_migrations() {
  if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
    echo "[entrypoint] applying database migrations…"
    node --import tsx src/cli/migrate.ts
  fi
}

case "${ROLE:-api}" in
  api)
    run_migrations
    exec node --import tsx src/api/server.ts
    ;;
  worker)
    exec node --import tsx src/worker/worker.ts
    ;;
  scheduler)
    exec node --import tsx src/worker/scheduler.ts
    ;;
  web)
    exec node --import tsx src/web/server.ts
    ;;
  migrate)
    exec node --import tsx src/cli/migrate.ts
    ;;
  all)
    run_migrations
    # In single-service mode the platform's $PORT belongs to the public
    # website; the API stays internal for the proxy.
    API_PORT="${API_PORT:-4000}" node --import tsx src/api/server.ts & p1=$!
    node --import tsx src/worker/worker.ts & p2=$!
    node --import tsx src/worker/scheduler.ts & p3=$!
    WEB_PORT="${WEB_PORT:-${PORT:-8080}}" node --import tsx src/web/server.ts & p4=$!
    trap 'kill $p1 $p2 $p3 $p4 2>/dev/null || true' TERM INT
    # if any process dies, stop the rest so the platform health-check restarts us
    wait -n $p1 $p2 $p3 $p4 || true
    kill $p1 $p2 $p3 $p4 2>/dev/null || true
    exit 1
    ;;
  *)
    echo "[entrypoint] unknown ROLE='${ROLE}' (use api|worker|scheduler|web|migrate|all, or pass a command)" >&2
    exit 1
    ;;
esac
