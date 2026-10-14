@echo off
chcp 65001 >nul
title Hola 调试模式 / Debug mode (closing this window stops Hola)
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\agy\bin;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装 https://nodejs.org/ 的 LTS 版本。
  echo Node.js not found. Please install the LTS version from https://nodejs.org/ first.
  pause
  exit /b 1
)
node server.js
pause
