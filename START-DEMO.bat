@echo off
chcp 65001 >nul
title Hola 演示模式 / Demo mode (no AI accounts needed)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装 https://nodejs.org/ 的 LTS 版本。
  echo Node.js not found. Please install the LTS version from https://nodejs.org/ first.
  pause
  exit /b 1
)
echo 演示模式：队友按预设剧本回答，不会调用真实 AI。
echo Demo mode: teammates follow a script and no real AI is called.
node server.js --demo
pause
