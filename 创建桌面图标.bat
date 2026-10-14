@echo off
chcp 65001 >nul
title 创建 Hola 桌面图标
cd /d "%~dp0"
echo.
echo 正在桌面和开始菜单创建 Hola 图标……
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-shortcut.ps1"
if errorlevel 1 (
  echo.
  echo 创建失败了，请把这个窗口截图发给 Claude。
  pause
  exit /b 1
)
echo.
echo 好了！以后双击桌面上的 Hola 图标就能打开。
echo 如果这个文件夹以后挪了位置，重新双击本文件一次即可。
echo.
pause
