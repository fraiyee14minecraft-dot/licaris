@echo off
cd /d "%~dp0"
call npm ci --no-audit --no-fund
if errorlevel 1 goto failure
call npm run dist
if errorlevel 1 goto failure
explorer "%~dp0release\0.6.1"
exit /b 0
:failure
echo La construction a echoue. Consulte le message ci-dessus.
pause
exit /b 1
