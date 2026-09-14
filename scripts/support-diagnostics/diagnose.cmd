@echo off
setlocal
if "%~1"=="" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1" -LogPath "%~1"
)
set "diagnosticExit=%ERRORLEVEL%"
if not "%diagnosticExit%"=="0" echo Diagnostic collection did not complete. See README.md.
if not "%OPEN_SCIENCE_DIAG_NO_PAUSE%"=="1" pause
exit /b %diagnosticExit%
