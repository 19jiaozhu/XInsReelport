@echo off
setlocal EnableDelayedExpansion
rem ============================================================
rem  X video direct-link helper
rem
rem  Mode 1: drag ONE link  -> print the best direct link
rem  Mode 2: drag ONE .txt  -> batch: download every link in it
rem  Mode 3: double-click   -> paste links, then choose an action
rem
rem  (this file is intentionally ASCII-only: cmd.exe reads batch
rem   files in the OEM codepage, so Chinese here breaks)
rem ============================================================

set "HERE=%~dp0"
set "FIRST=%~1"
set "DROPDIR=%~dp1"
set "EXTRA="
set "INTERACTIVE="
set "MODE="

if "%~1"=="" (
    set "INTERACTIVE=1"
    goto :ask
)

rem ---- collect the rest of the dropped items ----
shift
:collect
if "%~1"=="" goto :dispatch
set "EXTRA=!EXTRA! "%~1""
shift
goto :collect

:dispatch
rem A dropped file -> treat as a list file; keep the other dropped files too.
set "LISTFILE="
set "URLS="
if exist "!FIRST!" (
    set "LISTFILE=!FIRST!"
    goto :run
)
set "URLS=!FIRST!"

:run
echo.
if defined LISTFILE (
    echo   List: !LISTFILE!
    rem Download next to the dropped list file, not into the script folder.
    set "OUTDIR=!DROPDIR!"
    if "!OUTDIR:~-1!"=="\" set "OUTDIR=!OUTDIR:~0,-1!"
    echo   Downloading every link in it to: !OUTDIR!
    echo.
    node "%HERE%xvideo.mjs" --file "!LISTFILE!" --download --out "!OUTDIR!" --proxy auto !EXTRA!
) else (
    node "%HERE%xvideo.mjs" "!URLS!" !EXTRA!
)
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" echo   exit code: %CODE%  ^(0=ok 2=bad input 3=api failed 4=no video 5=download failed 6=some failed 7=proxy/node^)
if defined INTERACTIVE pause

:end
endlocal
exit /b

:ask
echo.
echo   ================================================
echo     X video helper
echo   ================================================
echo.
echo   Paste one or more X / Twitter links, then Enter.
echo   Separate several links with spaces.
echo.
set /p "URLS=  links> "
if "!URLS!"=="" (
    echo   No link given.
    goto :end
)
echo.
echo   What to do?
echo     [1] print the best direct link      (default)
echo     [2] list every quality level
echo     [3] download the best quality here
echo.
set /p "PICK=  choose 1/2/3> "
echo.

if "!PICK!"=="2" (
    node "%HERE%xvideo.mjs" "!URLS!" --all
) else if "!PICK!"=="3" (
    node "%HERE%xvideo.mjs" "!URLS!" --download --proxy auto
) else (
    node "%HERE%xvideo.mjs" "!URLS!"
)
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo   exit code: %CODE%
pause
goto :end
