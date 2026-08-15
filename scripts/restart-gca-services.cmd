@echo off
REM ============================================================
REM  重启 GCA 服务（应用修复生效：终端子进程弹窗抑制 + 死会话自动重生）
REM  运行后自动：退出桌面端 + agent/term → 重新构建 release → 重新打开桌面端
REM ============================================================
cd /d D:\Yuzu-GCA-Service

echo [1/3] 退出 GCA 进程（desktop + agent + term）...
taskkill /IM gca-desktop-rs.exe /T /F >nul 2>&1
taskkill /IM gca-agent.exe /T /F >nul 2>&1
taskkill /IM gca-term.exe /T /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] 重新构建 release（gca-agent + gca-term）...
cargo build --release -p gca-agent -p gca-desktop-rs
if errorlevel 1 (
    echo 构建失败，请检查上方错误。
    pause
    exit /b 1
)

echo [3/3] 重新启动 GCA Desktop ...
start "" "D:\Yuzu-GCA-Service\target\release\gca-desktop-rs.exe"
echo 完成。桌面端会自动拉起 agent/term。
