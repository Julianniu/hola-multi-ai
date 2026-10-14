@echo off
chcp 65001 >nul
title 登录 Gemini / Sign in to Gemini (Antigravity CLI)
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
echo.
echo Google 已停止让个人订阅使用 Gemini CLI，改用 Antigravity CLI（命令叫 agy），模型还是 Gemini。
echo Google no longer lets personal subscriptions use the Gemini CLI. The Antigravity CLI (agy) replaces it; the model is still Gemini.
echo.
where agy >nul 2>nul
if errorlevel 1 (
  echo ===== 正在安装 Antigravity CLI / Installing the Antigravity CLI =====
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"
  set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
)
where agy >nul 2>nul
if errorlevel 1 (
  echo.
  echo 安装好像没成功，请截图后到 GitHub Issues 提问。
  echo Installation didn't seem to work. Take a screenshot and ask in GitHub Issues.
  pause
  exit /b 1
)
echo.
echo  1. 浏览器会自动打开，用你订阅了 Google AI Pro 的 Google 账号登录。
echo     A browser opens. Sign in with the Google account that has Google AI Pro.
echo  2. 回到这个窗口，如果出现设置向导，按提示选推荐项。
echo     Back here, if a setup wizard appears, pick the recommended options.
echo  3. 看到输入界面后，输入 /quit 回车退出（不行就试 /exit）。
echo     When you see the input box, type /quit and press Enter (or /exit).
echo.
pause
agy
echo.
echo 好了，可以关掉这个窗口。 / Done, you can close this window.
pause
