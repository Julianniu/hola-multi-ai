#!/bin/bash
# 登录 Claude（Mac）/ Sign in to Claude (Mac)

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
cd "$HOLA_DIR" || exit 1
say ""
if [ -n "$ANTHROPIC_API_KEY" ]; then
  say "【注意】这台电脑设置了 ANTHROPIC_API_KEY，它会让 Claude 走 API 按量计费。这个窗口里已临时屏蔽它。" \
      "[Note] ANTHROPIC_API_KEY is set on this computer, which makes Claude use pay-as-you-go API billing. It is ignored in this window." ""
  unset ANTHROPIC_API_KEY
fi
if ! command -v claude >/dev/null 2>&1; then
  need_node
  say "===== 正在安装 Claude Code 命令行 / Installing the Claude Code CLI ====="
  npm install -g --prefix "$HOME/.hola-tools" @anthropic-ai/claude-code
fi
say " 1. 先输入 /logout 回车，退出 API 计费的登录。" \
    "    Type /logout and press Enter to leave any API-billing sign-in." \
    " 2. 再输入 /login 回车，选 Claude account with subscription（订阅账号），回车。" \
    "    Type /login, choose \"Claude account with subscription\" and press Enter." \
    " 3. 在浏览器里用你平时的 Claude 账号授权。" \
    "    Approve in the browser with your usual Claude account." \
    " 4. 输入 /status 应显示 Pro / Max 等订阅，而不是 API Usage Billing。" \
    "    /status should show your Pro / Max subscription, not \"API Usage Billing\"." \
    " 5. 确认后输入 /exit 回车退出。 / Then type /exit and press Enter." ""
claude
say "" "好了，可以关掉这个窗口。 / Done, you can close this window."
pause_here
