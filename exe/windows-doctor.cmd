@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\windows\doctor.ps1" %*
set "code=%ERRORLEVEL%"
pause
exit /b %code%