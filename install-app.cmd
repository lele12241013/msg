@echo off
setlocal
cd /d "%~dp0"

if not exist "dist\PopupRemoto.exe" (
  echo Gerando executavel...
  call npm run build
  if errorlevel 1 exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-app.ps1"