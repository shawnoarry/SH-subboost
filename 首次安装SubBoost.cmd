@echo off
setlocal
title SubBoost Setup
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0data\runtime\node\node.exe" (
  "%~dp0data\runtime\node\node.exe" "%~dp0scripts\windows-setup.cjs"
) else (
  node.exe "%~dp0scripts\windows-setup.cjs"
)
if errorlevel 1 (
  echo Setup did not finish. Keep the files and ask Codex to inspect them.
  pause
  exit /b 1
)
call "%~dp0启动SubBoost.cmd"
