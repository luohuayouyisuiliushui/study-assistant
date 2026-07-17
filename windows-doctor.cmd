@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\doctor.ps1" %*
set "code=%ERRORLEVEL%"
pause
exit /b %code%
