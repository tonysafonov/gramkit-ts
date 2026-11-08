#!/usr/bin/env bash
# Assembles the submission folder (scripts + gramkit core + this app + pinned requirements) and installs it
# on the benchmark box as /opt/challenge/subs/<name>, then runs the challenge's prepare.sh (install + build).
#
#   apps/conduit-bench/push.sh root@<target-ip> [name]      # name defaults to gramkit-conduit
#   TUNING_ENV=path/to/tuning.env apps/conduit-bench/push.sh root@<ip> gramkit-conduit-tuned
#   OVERLAYS="1-bot-arq-per-process 2-..." apps/conduit-bench/push.sh root@<ip> gramkit-fix2
#     each overlays/<name>/ is copied over the staged folder in order (paths relative to it: app/..., core/...,
#     tuning.env), so a fix step ships as its own files and the app itself stays "gramkit as shipped".
set -euo pipefail
TARGET="${1:?usage: push.sh user@host [name]}"
NAME="${2:-gramkit-conduit}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$NAME"
cp "$HERE"/{README.md,install.sh,build.sh,start.sh} "$STAGE/$NAME/"
rsync -a --exclude __pycache__ "$ROOT/core/backend/src/" "$STAGE/$NAME/core/"
rsync -a --exclude __pycache__ "$HERE/backend/src/" "$STAGE/$NAME/app/"
(cd "$ROOT" && uv export --frozen --no-hashes --package template-backend --all-extras --no-emit-workspace --no-header) \
  > "$STAGE/$NAME/requirements.txt"
echo 'bcrypt==5.0.0' >> "$STAGE/$NAME/requirements.txt"
for o in ${OVERLAYS:-}; do
  [ -d "$HERE/overlays/$o" ] || { echo "no overlay $o"; exit 1; }
  rsync -a --exclude __pycache__ "$HERE/overlays/$o/" "$STAGE/$NAME/"
  echo "$o" >> "$STAGE/$NAME/OVERLAYS"
done
if [ -n "${TUNING_ENV:-}" ]; then cp "$TUNING_ENV" "$STAGE/$NAME/tuning.env"; fi
git -C "$ROOT" rev-parse --short HEAD > "$STAGE/$NAME/GIT_HEAD"

COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -cf - "$NAME" | ssh "$TARGET" \
  "rm -rf '/opt/challenge/subs/$NAME' && tar -xf - -C /opt/challenge/subs && /opt/conduit-tools/prepare.sh '$NAME'"
