@echo off
setlocal
rem ============================================================
rem  X / Instagram downloader - local web UI
rem  Starts a tiny server and opens the browser.
rem
rem  (ASCII-only: cmd.exe reads batch files in the OEM codepage)
rem ============================================================

set "HERE=%~dp0"
cd /d "%HERE%"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js was not found in PATH.
    echo   Install Node 18+ and try again.
    echo.
    pause
    exit /b 1
)

echo.
echo   Starting the local UI, the browser will open in a second...
echo   Close this window to stop the server.
echo.

node "%HERE%igx-server.mjs"
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" echo   Server exited with code %CODE%
pause
exit /b %CODE%
