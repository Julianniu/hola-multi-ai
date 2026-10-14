@echo off
chcp 65001 >nul
title Hola（调试模式：会显示运行日志，关掉这个窗口 Hola 就停止）
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\agy\bin;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装 https://nodejs.org/ 的 LTS 版本。
  pause
  exit /b 1
)
node server.js
pause
