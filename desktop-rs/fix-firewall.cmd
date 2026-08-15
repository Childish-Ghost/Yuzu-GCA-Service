@echo off
REM 放行 gca-agent.exe 入站（本机设备端 MCP 服务，VM gca-server 需要访问）
REM 双击运行即可——脚本会自动请求管理员权限（弹出 UAC 确认框，点「是」）

REM 自动提升：非管理员时用 PowerShell 重新以管理员启动本脚本
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 正在请求管理员权限，请在 UAC 弹窗中点「是」...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo 删除旧规则（杀软/系统自动加的阻止规则）...
netsh advfirewall firewall delete rule name="gca-agent" >nul 2>&1

echo 添加放行规则（release + debug 两个路径）...
netsh advfirewall firewall add rule name="gca-agent" dir=in action=allow program="%~dp0..\target\release\gca-agent.exe" enable=yes >nul 2>&1
netsh advfirewall firewall add rule name="gca-agent" dir=in action=allow program="%~dp0..\target\debug\gca-agent.exe" enable=yes >nul 2>&1

echo 验证...
netsh advfirewall firewall show rule name="gca-agent" | findstr /C:"操作" | findstr /C:"允许" >nul && echo OK: 规则已放行 || echo 检查失败：请确认 UAC 弹窗中点了「是」

pause
