@echo off
chcp 65001 >nul
title 登录 Claude
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%USERPROFILE%\.local\bin;%PATH%"
echo.
if defined ANTHROPIC_API_KEY (
  echo 【注意】这台电脑设置了 ANTHROPIC_API_KEY（API 密钥），它会让 Claude 走 API 按量计费。
  echo 这个窗口里已临时屏蔽它；要彻底去掉，请把这段截图发给 Claude。
  set "ANTHROPIC_API_KEY="
  echo.
)
echo 正在打开 Claude 命令行……
echo  1. 先输入 /logout 回车，退出 API 计费的登录。
echo  2. 再输入 /login 回车，用上下键选 Claude account with subscription（订阅账号），回车。
echo  3. 浏览器里用你平时的 Claude 账号授权。
echo  4. 窗口顶部（或输入 /status）应显示 Pro / Max 等订阅，而不是 API Usage Billing。
echo  5. 确认后输入 /exit 回车退出。
echo.
call claude
echo.
echo Claude 已退出，可以关掉这个窗口了。
pause
