#!/usr/bin/env bash
# Builds the venv as a normal user: CPython 3.14 + requirements.txt (gramkit's uv.lock as exported by
# push.sh for template-vue, plus bcrypt). core/ and app/ are plain source on PYTHONPATH (start.sh).
set -euo pipefail
cd "$(dirname "$0")"
UV=/usr/local/bin/uv
export UV_PYTHON_INSTALL_DIR=/opt/uv/python
"$UV" venv --python 3.14 --managed-python --clear .venv
"$UV" pip sync --python .venv/bin/python requirements.txt
PYTHONPATH="$PWD/app:$PWD/core" .venv/bin/python -c \
  'import sys, fastapi, sqlalchemy; print("build ok:", sys.version.split()[0], "fastapi", fastapi.__version__, "sqlalchemy", sqlalchemy.__version__)'
