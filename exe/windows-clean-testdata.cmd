@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\windows\clean-testdata.ps1" %*
set "code=%ERRORLEVEL%"
pause
exit /b %code%