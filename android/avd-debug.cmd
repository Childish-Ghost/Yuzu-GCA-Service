@echo off
REM avd-debug.cmd — AVD 端口转发 + logcat 调试
REM 运行后：主机 127.0.0.1:3003 可访问 AVD 的 MCP Server
REM        实时显示 AVD 的 GCA 相关日志

set ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe

echo === 1. 检查 AVD 连接 ===
%ADB% devices
echo.

echo === 2. 端口转发：主机 3003 → AVD 3003 ===
%ADB% forward tcp:3003 tcp:3003
%ADB% forward --list
echo.

echo === 3. 实时 logcat（Ctrl+C 停止）===
%ADB% logcat -s GCA:* GCA-Screenshot:* GCA-A11y:* GCA-Native:* AndroidRuntime:* -v time