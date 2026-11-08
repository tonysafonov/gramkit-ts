#!/usr/bin/env bash
# Runs the server in the foreground. `runtime.env` says which runtime this submission is; push.sh writes it.
#
# Tuning goes in ./tuning.env and ./tuning.d/*.env (sourced in that order if present, so steps stack), e.g.
#   WORKERS=2
#   DB__POOL_SIZE=10
# push.sh stages tuning/workers2-pool10.env as tuning.env unless told otherwise.
set -euo pipefail
cd "$(dirname "$0")"
set -a
. ./runtime.env
if [ -f tuning.env ]; then . ./tuning.env; fi
for f in tuning.d/*.env; do if [ -f "$f" ]; then . "$f"; fi; done
set +a

export NODE_ENV=production
export WORKERS="${WORKERS:-2}"
export DB__POOL_SIZE="${DB__POOL_SIZE:-10}"
export KEEP_ALIVE_TIMEOUT="${KEEP_ALIVE_TIMEOUT:-95}"
export RATE_LIMIT__ENABLED=false
export REDIS__HOST="${REDIS__HOST:-127.0.0.1}" REDIS__PORT="${REDIS__PORT:-6379}"
# systemd's HOST and PORT come from /etc/challenge/env
export HOST="${HOST:-127.0.0.1}" PORT="${PORT:-3000}"

case "$RUNTIME" in
  node) exec "${NODE_BIN:-/opt/js/node-26.12.1/bin/node}" dist/main.node.js ;;
  bun) exec "${BUN_BIN:-/opt/js/bun-1.4.4/bun}" bench/conduit/src/main.bun.ts ;;
  *) echo "unknown RUNTIME=$RUNTIME"; exit 1 ;;
esac
