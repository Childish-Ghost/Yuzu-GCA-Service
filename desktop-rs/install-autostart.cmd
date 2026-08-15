@echo off
REM 开机自启：登录后自动启动 GCA Desktop（启动后自动带起本机 agent）
REM 双击运行即可（当前用户级，无需管理员）

set "EXE=%~dp0..\target\release\gca-desktop-rs.exe"
if not exist "%EXE%" (
    echo 未找到 release 构建：%EXE%
    echo 请先在仓库根目录执行: cargo build --release --workspace
    pause
    exit /b 1
)

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "GCA Desktop" /t REG_SZ /d "\"%EXE%\"" /f

echo.
echo 已安装开机自启（当前用户）：
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "GCA Desktop"
pause
