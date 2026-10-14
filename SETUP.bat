@echo off
chcp 65001 >nul
title Hola - 第一次安装 / First-time setup
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%USERPROFILE%\.local\bin;%LOCALAPPDATA%\agy\bin;%PATH%"
echo.
echo ===== 第 1 步：检查 Node.js / Step 1: check Node.js =====
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。马上为你打开下载页：请下载 LTS 版本安装，一路点"下一步"，然后重新双击本文件。
  echo Node.js not found. Opening the download page: install the LTS version, then double-click this file again.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
node --version
echo.
echo ===== 第 2 步：安装 Claude Code 和 Codex 命令行 / Step 2: install the Claude Code and Codex CLIs =====
echo 需要联网，大约 1 到 5 分钟…… / Needs internet, about 1 to 5 minutes...
call npm install -g @anthropic-ai/claude-code @openai/codex
if errorlevel 1 (
  echo 安装出错了，请检查网络后重试。 / Installation failed. Check your connection and try again.
  pause
  exit /b 1
)
echo.
echo ===== 第 3 步：安装 Antigravity CLI（Gemini）/ Step 3: install the Antigravity CLI (Gemini) =====
where agy >nul 2>nul
if errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"
echo.
echo ===== 第 4 步：登录 Codex（ChatGPT 账号）/ Step 4: sign in to Codex (ChatGPT account) =====
echo 浏览器会打开 ChatGPT 登录页。登录后看到输入框，输入 /exit 回车回到这里。
echo A ChatGPT sign-in page opens. After signing in, when you see the input box, type /exit and press Enter.
pause
call codex
echo.
echo ===== 第 5 步：登录 Claude（订阅账号）/ Step 5: sign in to Claude (subscription account) =====
echo 选择用 Claude 账号（subscription）登录。看到输入框后输入 /exit 回车。
echo Choose "Claude account with subscription". When you see the input box, type /exit and press Enter.
pause
call claude
echo.
echo ===== 第 6 步：登录 Gemini（Google 账号）/ Step 6: sign in to Gemini (Google account) =====
echo 浏览器会打开 Google 登录页。看到输入框后输入 /quit 回车。
echo A Google sign-in page opens. When you see the input box, type /quit and press Enter.
pause
set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
agy
echo.
echo ===== 第 7 步：创建桌面图标 / Step 7: create the desktop icon =====
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-shortcut.ps1"
echo.
echo 全部完成！以后双击桌面上的 Hola 图标即可。
echo All done! From now on, double-click the Hola icon on your desktop.
echo 没有哪家的账号也没关系，没登录的队友会显示为不在线，不影响其他人。
echo Missing an account is fine: that teammate shows as offline and the others still work.
pause
