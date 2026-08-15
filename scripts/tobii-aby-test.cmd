@echo off
REM ============================================================
REM  Tobii A/B 实验：停用/恢复 Tobii 服务（判断终端弹窗是否与其相关）
REM  用法：tobii-aby-test.cmd off  → 停止 Tobii 服务（下次启动仍会自动启）
REM        tobii-aby-test.cmd on   → 恢复 Tobii 服务
REM  实验方案：停用 1-2 天，期间用终端多切几次 shell（cmd/powershell），
REM  观察是否还出现 Application Error 弹窗。然后恢复。
REM  需要管理员权限（右键 → 以管理员身份运行）。
REM ============================================================

net session >nul 2>&1
if errorlevel 1 (
    echo 需要管理员权限！请右键 → 以管理员身份运行。
    pause
    exit /b 1
)

if /i "%~1"=="off" (
    echo 停止 Tobii 服务（可随时用 on 恢复）...
    sc stop "Tobii Service" >nul 2>&1
    sc stop "TobiiAY5P" >nul 2>&1
    echo 已停止。用终端切换几次 shell 观察是否还弹窗。
) else if /i "%~1"=="on" (
    echo 恢复 Tobii 服务...
    sc start "Tobii Service" >nul 2>&1
    sc start "TobiiAY5P" >nul 2>&1
    echo 已恢复。
) else (
    echo 用法：tobii-aby-test.cmd off / on
)
pause
