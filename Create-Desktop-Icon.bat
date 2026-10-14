@echo off
chcp 65001 >nul
title 创建 Hola 桌面图标 / Create the Hola desktop icon
cd /d "%~dp0"
echo.
echo 正在桌面和开始菜单创建 Hola 图标…… / Creating the Hola icon on the desktop and Start menu...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-shortcut.ps1"
if errorlevel 1 (
  echo.
  echo 创建失败了，请截图后到 GitHub Issues 提问。 / It failed. Take a screenshot and ask in GitHub Issues.
  pause
  exit /b 1
)
echo.
echo 好了！以后双击桌面上的 Hola 图标就能打开。 / Done! Double-click the Hola icon on your desktop from now on.
echo 如果这个文件夹以后挪了位置，重新双击本文件一次即可。 / If you move this folder, run this file again.
echo.
pause
