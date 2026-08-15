@echo off
REM GCA step 2 prep: install this machine's SSH public key into the VM.
REM Password is asked interactively by ssh, never stored.
type %USERPROFILE%\.ssh\id_ed25519.pub | ssh <SSH用户名>@<网关IP> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_INSTALLED"
echo.
echo If you saw KEY_INSTALLED above, tell the AI to continue.
pause
