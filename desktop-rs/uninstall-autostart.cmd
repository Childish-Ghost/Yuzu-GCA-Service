@echo off
REM 移除 GCA Desktop 开机自启（当前用户）

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "GCA Desktop" /f >nul 2>&1
if %errorlevel% equ 0 (
    echo 已移除开机自启
) else (
    echo 未找到自启项（可能尚未安装）
)
pause
