@echo off
rem comfy-panel-standalone launcher. Relative paths: works after copying the whole folder.
rem IMPORTANT: keep this file ASCII-only AND CRLF.
rem   cmd.exe reads .cmd in the OEM code page (936/GBK on Chinese Windows);
rem   UTF-8 Chinese text here gets mis-parsed and the launcher dies with exit 9009.
rem   All Chinese messages are printed by scripts\start.ps1 (UTF-8 with BOM).
rem v2.0.1: the default launch is FULLY HIDDEN - no console window stays in the
rem   foreground, so accidentally closing a console can no longer kill the backend.
rem   Fatal startup errors pop a MessageBox from start.ps1. Pass -Foreground to get
rem   the old visible-console behavior (developer mode).
setlocal
set "HERE=%~dp0"
if exist "%HERE%..\scripts\start.ps1" (
  set "SCRIPT=%HERE%..\scripts\start.ps1"
) else (
  set "SCRIPT=%HERE%scripts\start.ps1"
)
if not exist "%SCRIPT%" (
  echo [launcher] scripts\start.ps1 not found next to this file.
  pause
  exit /b 1
)
echo %* | find /i "-Foreground" >nul
if %ERRORLEVEL%==0 goto foreground
rem hidden launch (default): the cmd window closes at once; PowerShell runs with
rem -WindowStyle Hidden; the backend keeps running even if every window is closed.
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" conhost --headless pwsh -NoProfile -NoLogo -ExecutionPolicy Bypass -WindowStyle Hidden -File "%SCRIPT%" %*
) else (
  start "" conhost --headless powershell -NoProfile -NoLogo -ExecutionPolicy Bypass -WindowStyle Hidden -File "%SCRIPT%" %*
)
endlocal
exit /b 0
:foreground
rem visible console (developer mode): run inline, errors stay visible here.
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [launcher] start failed, exit code %CODE%.
  echo   - no network for the portable Node bootstrap, or
  echo   - the port is already in use by another program.
  echo   Details: see the logs folder of this project.
  pause
)
endlocal
exit /b %CODE%
