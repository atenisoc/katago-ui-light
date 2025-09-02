@echo off
set PORT=5173
set LOG=C:\tools\katago3\katago-ui\cloudflared.log
set CF="C:\Program Files\Cloudflare\cloudflared\cloudflared.exe"
if not exist %CF% set CF=cloudflared

:loop
echo ==== %DATE% %TIME% start ==== >> "%LOG%"
%CF% tunnel --no-autoupdate --metrics localhost:0 --url http://localhost:%PORT% >> "%LOG%" 2>&1
echo [cloudflared exited] restarting in 5s... >> "%LOG%"
timeout /t 5 >nul
goto loop
