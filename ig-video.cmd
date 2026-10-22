@echo off
setlocal EnableDelayedExpansion
rem ============================================================
rem  Instagram downloader helper
rem
rem  Mode 1: drag ONE .txt of CDN urls  -> list / download
rem  Mode 2: double-click -> copy the urls to clipboard, Enter
rem
rem  (this file is intentionally ASCII-only: cmd.exe reads batch
rem   files in the OEM codepage, so Chinese here breaks)
rem ============================================================

set "HERE=%~dp0"
set "FIRST=%~1"
set "DROPDIR=%~dp1"

if "%~1"=="" goto :interactive
if not exist "!FIRST!" (
    echo   Drag a .txt file containing the copied urls onto this file.
    pause
    goto :end
)

echo.
echo   Source: !FIRST!
echo.
echo     [1] list what was found      (default)
echo     [2] download the best match
echo     [3] pick a media id from the list
echo.
set /p "PICK=  choose 1/2/3> "
echo.

set "OUTDIR=!DROPDIR!"
if "!OUTDIR:~-1!"=="\" set "OUTDIR=!OUTDIR:~0,-1!"

if "!PICK!"=="2" (
    node "%HERE%igd.mjs" --from "!FIRST!" --out-dir "!OUTDIR!"
) else if "!PICK!"=="3" (
    set /p "ASSET=  media id> "
    node "%HERE%igd.mjs" --from "!FIRST!" --asset "!ASSET!" --out-dir "!OUTDIR!"
) else (
    node "%HERE%igd.mjs" --from "!FIRST!" --list
)
set "CODE=%ERRORLEVEL%"
echo.
if not "!CODE!"=="0" echo   exit code: !CODE!  ^(0=ok 2=input 4=no track 5=download 7=missing ffmpeg^)
pause
goto :end

:interactive
echo.
echo   ================================================
echo     Instagram downloader
echo   ================================================
echo.
echo   1. Open the reel in your logged-in browser, let it play.
echo   2. F12 -^> Network -^> filter "mp4" -^> Ctrl+A -^> Ctrl+C
echo      (or right-click -^> Copy -^> Copy all as cURL)
echo   3. Come back here and press Enter. The clipboard is read for you.
echo.
pause
echo.
echo     [1] list what was found      (default)
echo     [2] download the best match
echo.
set /p "PICK=  choose 1/2> "
echo.

if "!PICK!"=="2" (
    node "%HERE%igd.mjs" --clip --out-dir "%CD%"
) else (
    node "%HERE%igd.mjs" --clip --list
)
set "CODE=%ERRORLEVEL%"
echo.
if not "!CODE!"=="0" echo   exit code: !CODE!
pause
goto :end

:end
endlocal
exit /b
