#!/usr/bin/env bash
# Runs once as root on the benchmark box (Ubuntu 24.04): Redis (create_api opens an arq pool per process
# at startup), uv, CPython 3.14 (gramkit's Python).
set -euo pipefail
apt-get update -q && apt-get install -y -q curl ca-certificates redis-server
systemctl enable --now redis-server
if ! /usr/local/bin/uv --version 2>/dev/null | grep -q '^uv 0.13.0'; then
  curl -fsSL https://astral.sh/uv/0.13.0/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi
UV_PYTHON_INSTALL_DIR=/opt/uv/python /usr/local/bin/uv python install 3.14
chmod -R a+rX /opt/uv
/usr/local/bin/uv --version
redis-cli ping
