@echo off
REM ============================================================
REM 安装 NSIS 3（打包 GCA Windows 安装程序所需）
REM 需要管理员权限（自动请求 UAC），通过 choco 安装
REM 安装完成后在仓库根目录执行编译：
REM   "C:\ProgramData\chocolatey\lib\nsis\tools\NSIS\makensis.exe" releases\gca-installer.nsi
REM ============================================================

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 需要管理员权限，正在请求 UAC 弹窗，请点「是」...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

where choco >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 choco。请先安装 Chocolatey: https://chocolatey.org/install
    pause
    exit /b 1
)

echo [1/2] 安装 NSIS 3（choco install nsis）...
choco install nsis -y
if errorlevel 1 (
    echo [错误] choco 安装 NSIS 失败，请查看上方输出。
    pause
    exit /b 1
)

echo.
echo [2/2] 安装完成。编译 GCA 安装程序的命令：
echo.
echo   "C:\ProgramData\chocolatey\lib\nsis\tools\NSIS\makensis.exe" D:\Yuzu-GCA-Service\releases\gca-installer.nsi
echo.
pause
