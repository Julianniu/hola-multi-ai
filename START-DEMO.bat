@echo off
chcp 65001 >nul
title Hola 演示模式（不需要任何 AI 账号）
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装 https://nodejs.org/ 的 LTS 版本。
  pause
  exit /b 1
)
echo 演示模式：队友按预设剧本回答，用来体验界面和协作流程，不会调用真实 AI。
node server.js --demo
pause
