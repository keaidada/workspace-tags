#!/bin/bash
# Workspace Tags - Native Messaging Host launcher (macOS / Linux)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/read_dir.py"
PINNED_PYTHON=""

if [ -n "${WORKSPACE_TAGS_HOST_PYTHON:-}" ] && [ -x "${WORKSPACE_TAGS_HOST_PYTHON}" ]; then
  PYTHON_CMD="${WORKSPACE_TAGS_HOST_PYTHON}"
elif [ -n "$PINNED_PYTHON" ] && [ -x "$PINNED_PYTHON" ]; then
  PYTHON_CMD="$PINNED_PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="$(command -v python)"
else
  echo "错误：未找到 Python。请先安装 Python 3.8+。" >&2
  exit 1
fi

exec "$PYTHON_CMD" "$HOST_PATH" "$@"
