#!/bin/bash
# fix-gateway-android.sh — 在 Gateway VM (<网关IP>) 上运行
# 修复 gca-android MCP Server URL：/health → /mcp

set -e

CONFIG="$HOME/.openclaw/openclaw.json"
# 审查（2026-08-15）：真实 token 不入库——从环境读取（export GCA_OWNER_TOKEN=<server token>）
TOKEN="${GCA_OWNER_TOKEN:-change-me}"

echo "=== [1/4] 备份当前配置 ==="
cp "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
echo "备份完成"

echo "=== [2/4] 检查 Android 设备连通性 ==="
if curl -sf http://<Android设备IP>:3003/health > /dev/null 2>&1; then
  echo "✅ Android 设备可达: $(curl -s http://<Android设备IP>:3003/health)"
else
  echo "❌ 无法连接 Android 设备 <Android设备IP>:3003 — 请检查网络和 App 是否运行"
  exit 1
fi

echo "=== [3/4] 测试 MCP initialize 握手 ==="
INIT_RESP=$(curl -s -X POST http://<Android设备IP>:3003/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}')

if echo "$INIT_RESP" | grep -q '"result"'; then
  echo "✅ MCP initialize 成功"
  echo "$INIT_RESP" | head -5
else
  echo "❌ MCP initialize 失败:"
  echo "$INIT_RESP"
  echo ""
  echo "手动调试: curl -v -X POST http://<Android设备IP>:3003/mcp ..."
  exit 1
fi

echo "=== [4/4] 重启 OpenClaw Gateway ==="
openclaw restart 2>/dev/null || openclaw stop 2>/dev/null; sleep 1; openclaw start 2>/dev/null
sleep 3
echo ""
echo "=== 验证 ==="
openclaw mcp list 2>/dev/null || echo "请手动运行: openclaw mcp list"
echo ""
echo "如果 gca-android 显示 connected，修复完成。"
echo "配置已备份到 $CONFIG.bak-*"