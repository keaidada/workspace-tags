#!/bin/bash
# Workspace Tags - Native Messaging Host 安装脚本 (macOS / Linux)
# 此脚本将 Native Host 注册到 Chrome，使扩展能够读取本地文件系统

set -e

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/read_dir.py"
HOST_NAME="com.workspace_tags.native_host"

# 确保 Python 脚本可执行
chmod +x "$HOST_PATH"

# 根据平台选择 Chrome Native Messaging Hosts 目录
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

# 需要获取扩展 ID —— 先尝试从命令行参数获取
EXTENSION_ID="$1"

if [ -z "$EXTENSION_ID" ]; then
  echo "======================================"
  echo " Workspace Tags - Native Host 安装"
  echo "======================================"
  echo ""
  echo "请先在 Chrome 中加载扩展，然后在 chrome://extensions 页面中"
  echo "找到 \"Workspace Tags\" 扩展的 ID（一串字母数字）。"
  echo ""
  read -p "请输入扩展 ID: " EXTENSION_ID
fi

if [ -z "$EXTENSION_ID" ]; then
  echo "错误：必须提供扩展 ID"
  exit 1
fi

# 生成 Native Messaging manifest
MANIFEST_PATH="$TARGET_DIR/$HOST_NAME.json"

cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "Workspace Tags - 本地文件系统访问",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo ""
echo "✅ 安装成功！"
echo ""
echo "  Host 名称:  $HOST_NAME"
echo "  Host 路径:  $HOST_PATH"
echo "  Manifest:   $MANIFEST_PATH"
echo "  扩展 ID:    $EXTENSION_ID"
echo ""
echo "请重新加载 Chrome 扩展使配置生效。"
