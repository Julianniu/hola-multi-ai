@echo off
chcp 65001 >nul
title Hola - 第一次安装
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\agy\bin;%PATH%"
echo.
echo ===== 第 1 步：检查 Node.js =====
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。马上为你打开下载页：请下载 LTS 版本安装，一路点"下一步"，然后重新双击本文件。
  start "" https://nodejs.org/
  pause
  exit /b 1
)
node --version
echo.
echo ===== 第 2 步：安装 Claude Code 和 Codex 的命令行版本 =====
echo 需要联网，大约 1 到 5 分钟……
call npm install -g @anthropic-ai/claude-code @openai/codex
if errorlevel 1 (
  echo 安装出错了，请检查网络后重试。
  pause
  exit /b 1
)
echo.
echo ===== 第 3 步：安装 Antigravity CLI（Gemini 的命令行，个人订阅用这个）=====
where agy >nul 2>nul
if errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"
echo.
echo ===== 第 4 步：登录 Codex（ChatGPT 账号）=====
echo 浏览器会打开 ChatGPT 登录页。登录后看到输入框，输入 /exit 回车回到这里。
pause
call codex
echo.
echo ===== 第 5 步：登录 Claude（Claude 订阅账号）=====
echo 选择用 Claude 账号（subscription）登录。看到输入框后输入 /exit 回车。
pause
call claude
echo.
echo ===== 第 6 步：登录 Gemini（Google 账号）=====
echo 浏览器会打开 Google 登录页。看到输入框后输入 /quit 回车。
pause
set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
agy
echo.
echo ===== 第 7 步：创建桌面图标 =====
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-shortcut.ps1"
echo.
echo 全部完成！以后双击桌面上的 Hola 图标即可。
echo 没有哪家的账号也没关系，没登录的队友会显示为不在线，不影响其他人。
pause
