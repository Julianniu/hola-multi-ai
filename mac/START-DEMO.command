#!/bin/bash
# Hola 演示模式（Mac）：队友按预设剧本回答，不需要任何 AI 账号。
# Demo mode (Mac): teammates follow a script, no AI accounts needed.

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
cd "$HOLA_DIR" || exit 1
need_node
say "演示模式：队友按预设剧本回答，不会调用真实 AI。" "Demo mode: teammates follow a script and no real AI is called."
node server.js --demo
pause_here
