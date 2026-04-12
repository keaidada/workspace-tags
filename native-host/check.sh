#!/bin/bash
# Workspace Tags - Native Host 自检脚本 (macOS / Linux)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
else
  echo "错误：未找到 Python。请先安装 Python 3.8+。"
  exit 1
fi

exec "$PYTHON_CMD" read_dir.py --self-check
