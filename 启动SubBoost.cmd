@echo off
setlocal
title SubBoost
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0data\runtime\node\node.exe" (
  "%~dp0data\runtime\node\node.exe" "%~dp0scripts\windows-local.cjs" %*
  if errorlevel 1 (
    echo SubBoost could not start. See the message above.
    pause
    exit /b 1
  )
  exit /b 0
)
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.13+ or 24 and try again.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\windows-local.cjs" %*
if errorlevel 1 (
  echo.
  echo SubBoost could not start. See the message above.
  pause
  exit /b 1
)
