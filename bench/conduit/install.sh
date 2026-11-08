#!/usr/bin/env bash
# Runs once as root on the benchmark box (Ubuntu 24.04): Redis (the queue client connects at startup) and the two
# runtimes under /opt/js, pinned and checksummed as the js-runtimes repo installs them (install/node.sh, install/bun.sh).
# One script for both submissions: each is the same code, and `build.sh` needs Bun to install dependencies on either.
# No compiler: bcrypt ships a linux-x64 prebuild that loads on both runtimes.
set -euo pipefail
NODE_VERSION=26.12.1
BUN_VERSION=1.4.4

command -v redis-server >/dev/null || { apt-get update -q && apt-get install -y -q redis-server; }
systemctl enable --now redis-server
apt-get install -y -q curl xz-utils unzip ca-certificates >/dev/null
mkdir -p /opt/js

node_dir="/opt/js/node-$NODE_VERSION"
if [ ! -x "$node_dir/bin/node" ]; then
  t="$(mktemp -d)"
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$t/$tarball"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $tarball\$" | (cd "$t" && sha256sum -c -)
  tar -xJf "$t/$tarball" -C "$t"
  mv "$t/node-v$NODE_VERSION-linux-x64" "$node_dir"
  rm -rf "$t"
fi

bun_dir="/opt/js/bun-$BUN_VERSION"
if [ ! -x "$bun_dir/bun" ]; then
  mkdir -p "$bun_dir"
  t="$(mktemp -d)"
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip" -o "$t/bun.zip"
  unzip -q "$t/bun.zip" -d "$t"
  mv "$t/bun-linux-x64/bun" "$bun_dir/bun"
  ln -sf bun "$bun_dir/bunx"
  rm -rf "$t"
fi

chmod -R a+rX /opt/js
"$node_dir/bin/node" -v
"$bun_dir/bun" --version
redis-cli ping
