@echo off
REM GCA 审查验证（2026-08-12）：mDNS 局域网发现（INT-004 / 决策 13）
REM 前置：VM 上 gca-server 已更新并运行（含 mDNS 发布）
echo.
echo ============================================
echo   GCA 审查验证 - mDNS 局域网发现
echo ============================================
echo.
echo 1. 确认 VM 上 gca-server 已更新并运行（含 mDNS 发布）
echo 2. 重启本机桌面端（mDNS 功能需重启生效）
echo 3. 登录页使用「扫描局域网」或等待自动发现
echo    预期：自动列出 VM 的 gca-server 地址
echo.
echo 附加验证（S4 畸形包防护）：
echo   在任意局域网机器执行：
echo   node -e "require('dgram').createSocket('udp4').send(Buffer.from([0,1,0,0,0,1,0,0,0,0,0,0,0xC0,0x0C,0,12,0,1]),5353,'224.0.0.251')"
echo   预期：gca-server 不响应畸形包且服务不中断（旧版事件循环卡死，HTTP 全停）
pause
