#!/usr/bin/env bash
# Assembles the submission folder (scripts + the framework's server source + this app + the lockfile, no node_modules)
# and installs it on the benchmark box as /opt/challenge/subs/<name>, then runs the challenge's prepare.sh
# (install + build).
#
#   bench/conduit/push.sh root@<target-ip> gramkit-ts-node        # a name ending in -bun runs on Bun, any other on Node
#   RUNTIME=bun bench/conduit/push.sh root@<ip> some-name
#   TUNING_ENV=path/to/tuning.env bench/conduit/push.sh root@<ip> gramkit-ts-node-w1
#   OVERLAYS="prepared" bench/conduit/push.sh root@<ip> gramkit-ts-node-prepared
#     each overlays/<name>/ goes over the staged folder in order: its *.patch files are applied, anything else is copied
#     (paths relative to the staged folder), so a step ships as its own change and the app itself stays as shipped.
#   STAGE_ONLY=<dir> bench/conduit/push.sh local gramkit-ts-node  # stage into <dir>/<name> and stop, for a local run
set -euo pipefail
TARGET="${1:?usage: push.sh user@host name}"
NAME="${2:?usage: push.sh user@host name}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STAGE="${STAGE_ONLY:-$(mktemp -d)}"
[ -n "${STAGE_ONLY:-}" ] || trap 'rm -rf "$STAGE"' EXIT

case "$NAME" in
  *-bun|*-bun-*) DEFAULT_RUNTIME=bun ;;
  *) DEFAULT_RUNTIME=node ;;
esac

OUT="$STAGE/$NAME"
rm -rf "$OUT"
mkdir -p "$OUT/bench/conduit"
cp "$HERE"/{README.md,install.sh,build.sh,start.sh} "$OUT/"
cp "$ROOT"/{package.json,bun.lock,bunfig.toml} "$OUT/"
rsync -a --exclude '*.test.ts' --exclude testing/ --exclude test-utils.ts "$ROOT/src/server" "$OUT/src/"
rsync -a "$HERE/src" "$OUT/bench/conduit/"
echo "RUNTIME=${RUNTIME:-$DEFAULT_RUNTIME}" > "$OUT/runtime.env"
for o in ${OVERLAYS:-}; do
  [ -d "$HERE/overlays/$o" ] || { echo "no overlay $o"; exit 1; }
  rsync -a --exclude '*.patch' --exclude README.md "$HERE/overlays/$o/" "$OUT/"
  for p in "$HERE/overlays/$o"/*.patch; do
    if [ -f "$p" ]; then patch -d "$OUT" -p1 --no-backup-if-mismatch < "$p"; fi
  done
  echo "$o" >> "$OUT/OVERLAYS"
done
cp "${TUNING_ENV:-$HERE/tuning/workers2-pool10.env}" "$OUT/tuning.env"
git -C "$ROOT" rev-parse --short HEAD 2>/dev/null > "$OUT/GIT_HEAD" || echo uncommitted > "$OUT/GIT_HEAD"

if [ -n "${STAGE_ONLY:-}" ]; then echo "staged $OUT"; exit 0; fi

COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -cf - "$NAME" | ssh "$TARGET" \
  "rm -rf '/opt/challenge/subs/$NAME' && tar -xf - -C /opt/challenge/subs && /opt/conduit-tools/prepare.sh '$NAME'"
