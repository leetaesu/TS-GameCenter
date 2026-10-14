@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 goto NODE_MISSING

echo [TS GAME CENTER] Starting local server...
echo Keep this window open while playing. Press Ctrl+C to stop.
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:5007'"
node.exe server.js
goto SERVER_STOPPED

:NODE_MISSING
echo [TS GAME CENTER] Node.js is not installed.
echo Install Node.js LTS from https://nodejs.org/ and run this file again.
pause
exit /b 1

:SERVER_STOPPED
echo.
echo Server stopped.
pause
endlocal
