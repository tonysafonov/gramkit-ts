#!/usr/bin/env bash
# Runs the bench on this machine: a fresh database with the small seed in the `make up` Postgres, the staged submission
# on Node and on Bun (WORKERS=2), and test/smoke.ts against each. macOS can't show how connections spread over workers;
# only that the app works.
#
#   bench/conduit/test/local.sh                 # both runtimes
#   bench/conduit/test/local.sh bun             # one
#   OVERLAYS=prepared bench/conduit/test/local.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
STAGE="$(mktemp -d)"
PORT="${PORT:-3100}"
DB=conduit_local
psql() { docker exec -i gramkit-ts-pg psql -qX -U postgres -v ON_ERROR_STOP=1 "$@"; }

fresh_db() {
  psql -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" >/dev/null
  psql -d "$DB" < "$HERE/schema.sql" >/dev/null
  hash="$(cd "$ROOT" && bun -e 'import bcrypt from "bcrypt"; console.log(bcrypt.hashSync("password123", 10))')"
  psql -d "$DB" -v hash="$hash" < "$HERE/seed.sql" >/dev/null
}

run() {
  local runtime="$1" name="gramkit-ts-$1"
  STAGE_ONLY="$STAGE" RUNTIME="$runtime" "$HERE/../push.sh" local "$name" >/dev/null
  ln -s "$ROOT/node_modules" "$STAGE/$name/node_modules"
  (cd "$STAGE/$name" && SKIP_INSTALL=1 bash build.sh) >/dev/null
  fresh_db
  (
    cd "$STAGE/$name"
    export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5460/$DB" JWT_SECRET=multicore-server-challenge
    export HOST=127.0.0.1 PORT REDIS__HOST=127.0.0.1 REDIS__PORT=6395
    NODE_BIN="$(command -v node)" BUN_BIN="$(command -v bun)" exec bash ./start.sh
  ) > "$STAGE/$name.log" 2>&1 &
  local pid=$!
  for _ in $(seq 100); do
    curl -sf -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/tags" && break
    sleep 0.2
  done
  echo "== $runtime ($("$(command -v "$runtime")" --version))"
  local rc=0
  BASE="http://127.0.0.1:$PORT" JWT_SECRET=multicore-server-challenge bun "$HERE/smoke.ts" || rc=$?
  kill -TERM "$pid"
  wait "$pid" 2>/dev/null || true
  echo "access-log lines: $(grep -c '"name":"core.access"' "$STAGE/$name.log" || true), errors: $(grep -c '"level":50' "$STAGE/$name.log" || true)"
  if [ "$rc" != 0 ]; then tail -30 "$STAGE/$name.log"; exit "$rc"; fi
}

for runtime in "${@:-node bun}"; do
  for r in $runtime; do run "$r"; done
done
[ -n "${KEEP:-}" ] && echo "kept $STAGE" || rm -rf "$STAGE"
