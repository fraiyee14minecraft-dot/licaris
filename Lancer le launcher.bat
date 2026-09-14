@echo off
cd /d "%~dp0"
if exist "release\0.5.0\win-unpacked\Licaris Launcher.exe" (
  start "" "release\0.5.0\win-unpacked\Licaris Launcher.exe"
) else (
  call npm start
  if errorlevel 1 pause
)
