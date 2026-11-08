#!/bin/sh
# One image, several commands: api | bot | worker | migrate | script <name> [args] | healthcheck. JS_RUNTIME (node or bun) is set by the Dockerfile.
set -e

run() {
  # run <bundle in dist/> <source file> [args...]
  bundle=$1 source=$2
  shift 2
  if [ "$JS_RUNTIME" = bun ]; then exec bun "$source" "$@"; else exec node "dist/$bundle" "$@"; fi
}

case "$1" in
  api)
    # Apply pending migrations first, like `alembic upgrade head && uvicorn`; the API is the only process that does it
    if [ "$JS_RUNTIME" = bun ]; then bun src/server/db/migrate.ts; else node dist/migrate.node.js; fi
    run main.node.js src/server/runtime/main.bun.ts
    ;;
  bot) run bot.node.js src/server/bot/main.ts ;;
  worker) run worker.node.js src/server/worker/main.ts ;;
  migrate) run migrate.node.js src/server/db/migrate.ts ;;
  script) shift; run scripts.node.js src/server/scripts/main.ts "$@" ;;
  healthcheck)
    exec "$JS_RUNTIME" -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
    ;;
  *) exec "$@" ;;
esac
