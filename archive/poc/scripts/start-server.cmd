@echo off
REM GCA MCP Server auto-start wrapper (registered by gca service install)
cd /d D:\Yuzu-GCA-Service\poc
if not exist logs mkdir logs
npm run dev >> logs\service.log 2>&1
