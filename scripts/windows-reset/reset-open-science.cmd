@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0reset-open-science.ps1" %*
set "resetExit=%ERRORLEVEL%"
echo.
pause
exit /b %resetExit%
