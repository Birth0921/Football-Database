#!/bin/sh
# Role-based entrypoint: api | worker | scheduler | web | migrate
set -e
case "${ROLE:-api}" in
  api)       exec node --import tsx src/api/server.ts ;;
  worker)    exec node --import tsx src/worker/worker.ts ;;
  scheduler) exec node --import tsx src/worker/scheduler.ts ;;
  web)       exec node --import tsx src/web/server.ts ;;
  migrate)   exec node --import tsx src/cli/migrate.ts ;;
  *)         exec node --import tsx "$@" ;;
esac
