#!/usr/bin/env bash
# Builds as a normal user. Dependencies come from gramkit-ts' own bun.lock, on both runtimes: Bun is only the installer
# for the Node submission. Node runs the esbuild bundle (scripts/build.ts' flags with this app's entry, plus splitting:
# without it the bundle's top imports every package, so the supervisor process loads what only workers need; on Bun the
# dynamic import in main.bun.ts does this by itself). Bun runs the TypeScript source: no dev dependencies, no build step.
# SKIP_INSTALL=1 keeps the node_modules that is there (test/local.sh).
set -euo pipefail
cd "$(dirname "$0")"
. ./runtime.env
export PATH="/opt/js/bun-1.4.4:/opt/js/node-26.12.1/bin:$PATH"
install() { if [ -z "${SKIP_INSTALL:-}" ]; then bun install --frozen-lockfile "$@"; fi; }

case "$RUNTIME" in
  node)
    install
    node_modules/.bin/esbuild bench/conduit/src/main.node.ts --bundle --splitting --platform=node --target=node24 \
      --format=esm --packages=external --sourcemap --outdir=dist --log-level=warning
    node -e 'import("bcrypt").then((b) => console.log("build ok: node", process.version, b.default.hashSync("x", 4).slice(0, 7)))'
    ;;
  bun)
    install --production
    bun -e 'import bcrypt from "bcrypt"; console.log("build ok: bun", Bun.version, bcrypt.hashSync("x", 4).slice(0, 7))'
    ;;
  *) echo "unknown RUNTIME=$RUNTIME"; exit 1 ;;
esac
