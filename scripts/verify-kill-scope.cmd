@echo off
REM GCA 审查验证（2026-08-12）：退出清理范围（C10 修复 - 不再按镜像名 taskkill）
REM 前置：target\release\gca-agent.exe 已构建；桌面端尚未运行
set EXE=..\target\release\gca-agent.exe
if not exist %EXE% (
  echo 未找到 %EXE% - 先构建：cargo build --release -p gca-agent --bins
  pause
  exit /b 1
)
echo.
echo 启动「带标记」副本（模拟桌面端拉起的 agent，GCA_SPAWNED_BY=99999）...
start "" /b cmd /c "set GCA_SPAWNED_BY=99999&& set GCA_AGENT_PORT=3005&& %EXE%"
echo 启动「无标记」副本（模拟同机的无关同名进程）...
start "" /b cmd /c "set GCA_AGENT_PORT=3006&& %EXE%"
timeout /t 2 /nobreak >nul
echo.
echo 当前 gca-agent 进程：
tasklist | findstr /i gca-agent
echo.
echo 现在打开桌面端并正常退出（托盘菜单「退出」），然后按任意键检查...
pause
tasklist | findstr /i gca-agent
echo.
echo 预期：仅「带标记」副本被清理；无标记副本仍存活
echo （旧版按镜像名 taskkill /IM 会误杀两者）
pause
