@echo off
REM GCA autostart installer - run once by double-clicking
copy /y "D:\Yuzu-GCA-Service\poc\scripts\gca-server.vbs" "C:\Users\Middl\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\gca-server.vbs"
if exist "C:\Users\Middl\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\gca-server.vbs" (echo GCA autostart registered OK) else (echo FAILED)
pause
