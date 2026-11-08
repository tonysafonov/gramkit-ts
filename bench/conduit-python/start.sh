#!/usr/bin/env bash
# Runs the server in the foreground. Default = gramkit as shipped: the templates' uvicorn command
# (apps/template-vue/docker-compose.yml: one worker, --no-access-log (core's access-log middleware writes one
# line per request instead), --timeout-keep-alive 95).
#
# Tuning goes in ./tuning.env and ./tuning.d/*.env (sourced in that order if present; overlays add files to
# tuning.d so fix steps stack), e.g.
#   WORKERS=2
#   DB__POOL_SIZE=10
#   DB__MAX_OVERFLOW=0
set -euo pipefail
cd "$(dirname "$0")"
set -a
if [ -f tuning.env ]; then . ./tuning.env; fi
for f in tuning.d/*.env; do if [ -f "$f" ]; then . "$f"; fi; done
set +a
export PYTHONPATH="$PWD/app:$PWD/core"
export REDIS__HOST="${REDIS__HOST:-127.0.0.1}" REDIS__PORT="${REDIS__PORT:-6379}"
# shellcheck disable=SC2086  # UVICORN_EXTRA is a list of flags
exec .venv/bin/uvicorn app.webhook.app:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-3000}" \
  --workers "${WORKERS:-1}" \
  --no-access-log \
  --timeout-keep-alive 95 \
  --timeout-graceful-shutdown 30 \
  ${UVICORN_EXTRA:-}
