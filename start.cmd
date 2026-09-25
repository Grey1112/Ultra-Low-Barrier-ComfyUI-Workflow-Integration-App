@echo off
rem comfy-panel-standalone launcher. Relative paths: works after copying the whole folder.
rem IMPORTANT: keep this file ASCII-only AND CRLF.
rem   cmd.exe reads .cmd in the OEM code page (936/GBK on Chinese Windows);
rem   UTF-8 Chinese text here gets mis-parsed and the launcher dies with exit 9009.
rem   All Chinese messages are printed by scripts\start.ps1 (UTF-8 with BOM).
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
