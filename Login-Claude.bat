@echo off
chcp 65001 >nul
title 登录 Claude / Sign in to Claude
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%USERPROFILE%\.local\bin;%PATH%"
echo.
if defined ANTHROPIC_API_KEY (
  echo 【注意】这台电脑设置了 ANTHROPIC_API_KEY，它会让 Claude 走 API 按量计费。这个窗口里已临时屏蔽它。
  echo [Note] ANTHROPIC_API_KEY is set on this computer, which makes Claude use pay-as-you-go API billing. It is ignored in this window.
  set "ANTHROPIC_API_KEY="
  echo.
)
echo  1. 先输入 /logout 回车，退出 API 计费的登录。
echo     Type /logout and press Enter to leave any API-billing sign-in.
echo  2. 再输入 /login 回车，选 Claude account with subscription（订阅账号），回车。
echo     Type /login, choose "Claude account with subscription" and press Enter.
echo  3. 在浏览器里用你平时的 Claude 账号授权。
echo     Approve in the browser with your usual Claude account.
echo  4. 输入 /status 应显示 Pro / Max 等订阅，而不是 API Usage Billing。
echo     /status should show your Pro / Max subscription, not "API Usage Billing".
echo  5. 确认后输入 /exit 回车退出。 / Then type /exit and press Enter.
echo.
call claude
echo.
echo 好了，可以关掉这个窗口。 / Done, you can close this window.
pause
