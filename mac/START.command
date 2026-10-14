#!/bin/bash
# Hola 调试模式（Mac）：在这个窗口里运行，能看到报错；关掉窗口 Hola 也会停。
# Debug mode (Mac): runs in this window so you can see errors. Closing the window stops Hola.

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
cd "$HOLA_DIR" || exit 1
need_node
node server.js
pause_here
