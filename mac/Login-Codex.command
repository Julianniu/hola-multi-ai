#!/bin/bash
# 登录 Codex（Mac）/ Sign in to Codex (Mac)

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
cd "$HOLA_DIR" || exit 1
say ""
if ! command -v codex >/dev/null 2>&1; then
  need_node
  say "===== 正在安装 Codex 命令行 / Installing the Codex CLI ====="
  npm install -g --prefix "$HOME/.hola-tools" @openai/codex
fi
say "" " 1. 浏览器会打开 ChatGPT 登录页，选 Sign in with ChatGPT，用你订阅了 Plus / Pro 的账号登录。" \
    "    A ChatGPT sign-in page opens. Choose \"Sign in with ChatGPT\" and use your Plus / Pro account." \
    " 2. 回到这个窗口，看到输入框后输入 /exit 回车。" \
    "    Back here, when you see the input box, type /exit and press Enter."
pause_here
codex
say "" "好了，可以关掉这个窗口。 / Done, you can close this window."
pause_here
