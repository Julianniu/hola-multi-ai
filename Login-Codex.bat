@echo off
chcp 65001 >nul
title 登录 Codex / Sign in to Codex
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%USERPROFILE%\.local\bin;%PATH%"
echo.
where codex >nul 2>nul
if errorlevel 1 (
  echo ===== 正在安装 Codex 命令行 / Installing the Codex CLI =====
  call npm install -g @openai/codex
)
echo.
echo  1. 浏览器会打开 ChatGPT 登录页，选 Sign in with ChatGPT，用你订阅了 Plus / Pro 的账号登录。
echo     A ChatGPT sign-in page opens. Choose "Sign in with ChatGPT" and use your Plus / Pro account.
echo  2. 回到这个窗口，看到输入框后输入 /exit 回车。
echo     Back here, when you see the input box, type /exit and press Enter.
echo.
pause
call codex
echo.
echo 好了，可以关掉这个窗口。 Done, you can close this window.
pause
