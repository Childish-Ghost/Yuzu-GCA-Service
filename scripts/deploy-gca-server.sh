#!/bin/bash
# deploy-gca-server.sh — GCA 一键部署：OpenClaw + gca-server
# 用法: curl -fsSL <url> | bash
# 或:   bash deploy-gca-server.sh
#
# 逻辑：
#   - OpenClaw 已装 → 只部署 gca-server
#   - OpenClaw 未装 → 部署 OpenClaw + gca-server
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}=== $1 ===${NC}"; }

echo "========================================"
echo " GCA — 一键部署脚本"
echo " OpenClaw Gateway + gca-server 控制面"
echo "========================================"
echo ""

# ────────────────────────────────────────
# 1. 环境检查
# ────────────────────────────────────────
step "1/6 检查环境"

# Node.js
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    log "Node.js $NODE_VER"
else
    err "未安装 Node.js。请先安装 Node.js 22+: https://nodejs.org"
fi

# npm/npx
if command -v npx &>/dev/null; then
    log "npx 可用"
else
    err "npx 不可用，请安装完整 Node.js"
fi

# OpenClaw
OPENCLAW_BIN=""
OPENCLAW_INSTALLED=false
if command -v openclaw &>/dev/null; then
    OPENCLAW_BIN=$(which openclaw)
    OPENCLAW_VER=$(openclaw --version 2>/dev/null || echo "unknown")
    OPENCLAW_INSTALLED=true
    log "OpenClaw 已安装: $OPENCLAW_BIN ($OPENCLAW_VER)"
else
    # 尝试 nvm 路径
    NVM_OPENCLAW="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | sort -V | tail -1)/bin/openclaw"
    if [ -x "$NVM_OPENCLAW" ]; then
        OPENCLAW_BIN="$NVM_OPENCLAW"
        OPENCLAW_INSTALLED=true
        log "OpenClaw 已安装 (nvm): $OPENCLAW_BIN"
    else
        warn "OpenClaw 未安装，将一并部署"
    fi
fi

# systemd
HAS_SYSTEMD=false
if command -v systemctl &>/dev/null; then
    HAS_SYSTEMD=true
    log "systemd 可用"
else
    warn "无 systemd，将手动启动"
fi

# ────────────────────────────────────────
# 2. 创建目录 + Token
# ────────────────────────────────────────
step "2/6 准备目录和 Token"

GCA_SERVER_DIR="$HOME/gca-server"
TOKEN_DIR="$HOME/gap-relay"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
mkdir -p "$GCA_SERVER_DIR" "$TOKEN_DIR" "$HOME/.openclaw"

TOKEN_FILE="$TOKEN_DIR/token.txt"
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
    warn "token 已存在，跳过生成"
else
    TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    echo "$TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    log "token 已生成: $TOKEN_FILE"
fi

# ────────────────────────────────────────
# 3. 部署 OpenClaw（如果未安装）
# ────────────────────────────────────────
step "3/6 OpenClaw Gateway"

if [ "$OPENCLAW_INSTALLED" = true ]; then
    log "跳过 — OpenClaw 已存在: $OPENCLAW_BIN"
else
    log "安装 OpenClaw..."
    npm install -g openclaw 2>&1 | tail -3
    OPENCLAW_BIN=$(which openclaw)
    if [ -z "$OPENCLAW_BIN" ]; then
        err "OpenClaw 安装失败"
    fi
    log "OpenClaw 已安装: $OPENCLAW_BIN"
fi

# 确保 openclaw.json 存在
if [ ! -f "$OPENCLAW_CONFIG" ]; then
    echo '{}' > "$OPENCLAW_CONFIG"
    log "创建空配置: $OPENCLAW_CONFIG"
fi

# ────────────────────────────────────────
# 4. 部署 gca-server
# ────────────────────────────────────────
step "4/6 部署 gca-server"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/gca-server/gca-server.js" ]; then
    # 本地安装
    cp "$SCRIPT_DIR"/gca-server/*.js "$GCA_SERVER_DIR/"
    log "从本地目录复制: $SCRIPT_DIR/gca-server/"
elif [ -f "$SCRIPT_DIR/gca-server.js" ]; then
    # 脚本在 gca-server 目录内
    cp "$SCRIPT_DIR"/*.js "$GCA_SERVER_DIR/"
    log "从本地目录复制: $SCRIPT_DIR"
else
    # 远程下载
    REPO="https://git.childish-ghost.com/gca/gca-client/raw/branch/main/gca-server"
    for f in gca-server.js cli.js config.js devices.js ops.js pairing.js push.js audit.js; do
        curl -fsSL "$REPO/$f" -o "$GCA_SERVER_DIR/$f" 2>/dev/null || warn "无法下载 $f"
    done
    log "从远程仓库下载"
fi

cat > "$GCA_SERVER_DIR/package.json" << 'EOF'
{
  "name": "gca-server",
  "version": "0.1.0",
  "type": "module",
  "bin": { "gca-server": "cli.js" }
}
EOF
log "gca-server 文件就绪: $GCA_SERVER_DIR"

# ────────────────────────────────────────
# 5. 配置 systemd 服务
# ────────────────────────────────────────
step "5/6 配置服务"

if [ "$HAS_SYSTEMD" = true ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"

    # gca-server 服务
    cat > "$UNIT_DIR/gca-server.service" << EOF
[Unit]
Description=GCA Control Plane (gca-server)
After=network.target

[Service]
WorkingDirectory=$GCA_SERVER_DIR
Environment="GCA_SERVER_TOKEN=$TOKEN"
Environment="OPENCLAW_BIN=$OPENCLAW_BIN"
ExecStart=$(which node) $GCA_SERVER_DIR/gca-server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    log "gca-server.service 已写入"

    # OpenClaw gateway 服务（如果之前没有）
    if [ ! -f "$UNIT_DIR/openclaw-gateway.service" ] && [ "$OPENCLAW_INSTALLED" = false ]; then
        cat > "$UNIT_DIR/openclaw-gateway.service" << EOF
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
ExecStart=$OPENCLAW_BIN gateway --port 18789
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
        log "openclaw-gateway.service 已写入"
    fi

    systemctl --user daemon-reload
    systemctl --user enable gca-server
    systemctl --user restart gca-server
    log "gca-server 服务已启动"

    # 启动 gateway（如果是新装的）
    if [ "$OPENCLAW_INSTALLED" = false ]; then
        systemctl --user enable openclaw-gateway 2>/dev/null
        systemctl --user start openclaw-gateway 2>/dev/null
        log "openclaw-gateway 服务已启动"
    fi
else
    # 无 systemd — 后台启动
    nohup node "$GCA_SERVER_DIR/gca-server.js" > "$GCA_SERVER_DIR/server.log" 2>&1 &
    echo $! > "$GCA_SERVER_DIR/pid"
    log "gca-server 已后台启动 (pid $(cat $GCA_SERVER_DIR/pid))"
fi

# ────────────────────────────────────────
# 6. 验证
# ────────────────────────────────────────
step "6/6 验证"

sleep 2

# gca-server
if curl -sf http://127.0.0.1:18790/health > /dev/null 2>&1; then
    HEALTH=$(curl -s http://127.0.0.1:18790/health)
    log "gca-server ✓ $HEALTH"
else
    warn "gca-server 无法连接，检查日志: journalctl --user -u gca-server -n 20"
fi

# OpenClaw gateway
if curl -sf http://127.0.0.1:18789/health > /dev/null 2>&1; then
    log "OpenClaw Gateway ✓"
else
    warn "OpenClaw Gateway 未响应（可能需要配置 API key 后手动启动）"
fi

# ────────────────────────────────────────
# 完成
# ────────────────────────────────────────
echo ""
echo "========================================"
echo " 部署完成！"
echo "========================================"
echo ""
echo " Token:       $TOKEN"
echo " gca-server:  http://127.0.0.1:18790"
echo " Gateway:     http://127.0.0.1:18789"
echo " 安装目录:    $GCA_SERVER_DIR"
echo ""
echo " 管理命令:"
echo "   systemctl --user status gca-server"
echo "   systemctl --user restart gca-server"
echo "   journalctl --user -u gca-server -f"
echo "   node $GCA_SERVER_DIR/cli.js status"
echo ""
echo " 客户端接入:"
echo "   1. 生成配对码: curl -X POST -H 'Authorization: Bearer $TOKEN' http://<server-ip>:18790/pair/init"
echo "   2. 客户端配对: gca pair <码>"
echo ""
echo " 配对 token (写入客户端):"
echo "   $TOKEN"
