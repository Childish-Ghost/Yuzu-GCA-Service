#!/bin/bash
# build-deb.sh — 打包 gca-server.deb
# 在 Ubuntu VM 上运行: bash build-deb.sh [版本号]
# 版本号缺省时读 server/package.json（server 组件版本，版本规范见 docs/versioning.md）
set -e

PACKAGE="gca-server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/../server/package.json" | head -1)
    [ -n "$VERSION" ] || VERSION="0.1.0"
fi
# 产物命名遵循 docs/versioning.md §3：gca-server-linux-V<版本>.deb
# （包内 Version 字段走 deb 特例：upstream-revision 格式 <版本>-1）
DEB="gca-server-linux-V${VERSION}.deb"
BUILD_DIR="/tmp/gca-deb-build"
INSTALL_DIR="/opt/gca-server"

echo "=== 打包 gca-server ${VERSION} ==="

# --- 1. clean build dir ---
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/DEBIAN"
mkdir -p "$BUILD_DIR${INSTALL_DIR}"
mkdir -p "$BUILD_DIR/etc/systemd/system"
mkdir -p "$BUILD_DIR/usr/bin"

# --- 2. control file ---
cat > "$BUILD_DIR/DEBIAN/control" << EOF
Package: ${PACKAGE}
Version: ${VERSION}-1
Section: utils
Priority: optional
Architecture: amd64
Depends: nodejs (>= 18.0.0)
Maintainer: GCA Project
Description: GCA Control Plane
 Pairing center, device management, ops authorization, and audit
 for the Global Control Assistant system.
EOF

# --- 3. copy server files ---
if [ -f "$SCRIPT_DIR/../server/dist/gca-server.js" ]; then
    cp "$SCRIPT_DIR/../server/dist/"*.js "$BUILD_DIR${INSTALL_DIR}/"
    cp "$SCRIPT_DIR/../server/dist/"*.d.ts "$BUILD_DIR${INSTALL_DIR}/" 2>/dev/null || true
    cp "$SCRIPT_DIR/../server/package.json" "$BUILD_DIR${INSTALL_DIR}/"
else
    echo "Error: server dist not found at $SCRIPT_DIR/../server/dist/"
    echo "Run: cd server && npm run build"
    exit 1
fi

# --- 4. systemd service ---
cat > "$BUILD_DIR/etc/systemd/system/gca-server.service" << EOF
[Unit]
Description=GCA Control Plane (gca-server)
After=network.target

[Service]
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-/etc/gca-server/token
ExecStart=/usr/bin/node ${INSTALL_DIR}/gca-server.js
Restart=on-failure
RestartSec=5
User=gca
Group=gca

[Install]
WantedBy=multi-user.target
EOF

# --- 5. postinst script ---
cat > "$BUILD_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e

# Generate token if not exists
TOKEN_DIR="/etc/gca-server"
TOKEN_FILE="$TOKEN_DIR/token"
if [ ! -f "$TOKEN_FILE" ]; then
    mkdir -p "$TOKEN_DIR"
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "GCA_SERVER_TOKEN=$(cat $TOKEN_FILE)" > "$TOKEN_DIR/token"
    echo "Token generated: $TOKEN_FILE"
fi

# Enable and start service
systemctl daemon-reload
systemctl enable gca-server
systemctl restart gca-server || true

echo ""
echo "========================================"
echo " gca-server installed successfully!"
echo "========================================"
echo " Token: $(cat $TOKEN_FILE)"
echo " Port:  18790"
echo ""
echo " Manage: systemctl status/restart/stop gca-server"
echo " Logs:   journalctl -u gca-server -f"
echo ""
EOF
chmod 755 "$BUILD_DIR/DEBIAN/postinst"

# --- 6. build .deb ---
dpkg-deb --build "$BUILD_DIR" "$DEB"

echo ""
echo "=== Done: $DEB ==="
ls -lh "$DEB"
echo ""
echo "Install: sudo dpkg -i $DEB"