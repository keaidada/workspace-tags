#!/bin/bash
# Workspace Tags - Native Messaging Host 安装脚本 (macOS / Linux)
# 此脚本将 Native Host 注册到 Chrome，使扩展能够读取本地文件系统。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/read_dir.py"
RUN_HOST_PATH="$SCRIPT_DIR/run_host.sh"
HOST_NAME="com.workspace_tags.native_host"

if [ ! -f "$HOST_PATH" ]; then
  echo "错误：未找到 Host 脚本：$HOST_PATH"
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="python"
else
  echo "错误：未找到 Python。请先安装 Python 3.8+。"
  exit 1
fi

if ! "$PYTHON_CMD" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
  echo "错误：需要 Python 3.8+。当前命令: $PYTHON_CMD"
  exit 1
fi

PYTHON_PATH="$("$PYTHON_CMD" -c 'import os, sys; print(os.path.realpath(sys.executable))')"
if [ -z "$PYTHON_PATH" ] || [ ! -x "$PYTHON_PATH" ]; then
  echo "错误：无法解析 Python 可执行文件路径"
  exit 1
fi

OS="$(uname -s)"
case "$OS" in
  Darwin)
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "不支持的操作系统: $OS"
    exit 1
    ;;
esac
mkdir -p "$TARGET_DIR"

EXTENSION_ID="${1:-}"

if [ -z "$EXTENSION_ID" ]; then
  echo "======================================"
  echo " Workspace Tags - Native Host 安装"
  echo "======================================"
  echo ""
  echo "请先在 Chrome 中加载扩展，然后在 chrome://extensions 页面中"
  echo "找到 \"Workspace Tags\" 扩展的 ID（一串 32 位字母）。"
  echo ""
  read -r -p "请输入扩展 ID: " EXTENSION_ID
fi

if [ -z "$EXTENSION_ID" ]; then
  echo "错误：必须提供扩展 ID"
  exit 1
fi

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "错误：扩展 ID 格式无效，应为 32 位 a-p 小写字母"
  exit 1
fi

cat > "$RUN_HOST_PATH" <<EOF
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
HOST_PATH="\$SCRIPT_DIR/read_dir.py"
PINNED_PYTHON="$PYTHON_PATH"

if [ -n "\${WORKSPACE_TAGS_HOST_PYTHON:-}" ] && [ -x "\${WORKSPACE_TAGS_HOST_PYTHON}" ]; then
  PYTHON_CMD="\${WORKSPACE_TAGS_HOST_PYTHON}"
elif [ -x "\$PINNED_PYTHON" ]; then
  PYTHON_CMD="\$PINNED_PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD="\$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD="\$(command -v python)"
else
  echo "错误：未找到 Python。请先安装 Python 3.8+。" >&2
  exit 1
fi

exec "\$PYTHON_CMD" "\$HOST_PATH" "\$@"
EOF

chmod +x "$HOST_PATH" "$RUN_HOST_PATH"

MANIFEST_PATH="$TARGET_DIR/$HOST_NAME.json"
cat > "$MANIFEST_PATH" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Workspace Tags - 本地文件系统访问",
  "path": "$RUN_HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo ""
echo "✅ 安装成功！"
echo ""
echo "  Host 名称:   $HOST_NAME"
echo "  Host 脚本:   $HOST_PATH"
echo "  启动包装器: $RUN_HOST_PATH"
echo "  Python:      $PYTHON_PATH"
echo "  Manifest:    $MANIFEST_PATH"
echo "  扩展 ID:     $EXTENSION_ID"
echo ""
echo "正在执行安装后自检..."
echo ""

if "$PYTHON_PATH" "$HOST_PATH" --self-check; then
  echo ""
  echo "请重新加载 Chrome 扩展使配置生效。"
else
  echo ""
  echo "⚠️ 安装已写入，但自检未通过。请根据上面的检查结果修复后重试。"
  exit 1
fi
