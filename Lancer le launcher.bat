@echo off
cd /d "%~dp0"
if exist "release\0.3.1\win-unpacked\Cobblemon Launcher.exe" (
  start "" "release\0.3.1\win-unpacked\Cobblemon Launcher.exe"
) else (
  call npm start
  if errorlevel 1 pause
)
