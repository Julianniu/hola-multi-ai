@echo off
chcp 65001 >nul
title 安装并登录 Gemini（Antigravity CLI）
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
echo.
echo Google 已停止让个人订阅使用 Gemini CLI，改用新的 Antigravity CLI（命令叫 agy），模型还是 Gemini。
echo.
where agy >nul 2>nul
if errorlevel 1 (
  echo ===== 正在安装 Antigravity CLI，需要联网，请稍等 =====
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"
  set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"
)
where agy >nul 2>nul
if errorlevel 1 (
  echo.
  echo 安装好像没成功。请把这个窗口截图发给 Claude。
  pause
  exit /b 1
)
echo.
echo ===== 登录 =====
echo  1. 浏览器会自动打开，用你订阅了 Google AI Pro 的那个 Google 账号登录。
echo  2. 回到这个窗口，如果出现设置向导，按提示选推荐项。
echo  3. 看到可以输入文字的界面后，输入 /quit 回车退出（不行就试 /exit）。
echo.
pause
agy
echo.
echo 好了，可以关掉这个窗口。
pause
