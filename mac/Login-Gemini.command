#!/bin/bash
# 登录 Gemini（Mac，Antigravity CLI）/ Sign in to Gemini (Mac, Antigravity CLI)

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
cd "$HOLA_DIR" || exit 1
say "" "Google 已停止让个人订阅使用 Gemini CLI，改用 Antigravity CLI（命令叫 agy），模型还是 Gemini。" \
    "Google no longer lets personal subscriptions use the Gemini CLI. The Antigravity CLI (agy) replaces it; the model is still Gemini." ""
if ! command -v agy >/dev/null 2>&1; then
  say "===== 正在安装 Antigravity CLI / Installing the Antigravity CLI ====="
  curl -fsSL https://antigravity.google/cli/install.sh | bash
fi
if ! command -v agy >/dev/null 2>&1; then
  say "" "安装好像没成功，请截图后到 GitHub Issues 提问。" \
      "Installation didn't seem to work. Take a screenshot and ask in GitHub Issues."
  pause_here
  exit 1
fi
say "" " 1. 浏览器会自动打开，用你订阅了 Google AI Pro 的 Google 账号登录。" \
    "    A browser opens. Sign in with the Google account that has Google AI Pro." \
    " 2. 回到这个窗口，如果出现设置向导，按提示选推荐项。" \
    "    Back here, if a setup wizard appears, pick the recommended options." \
    " 3. 看到输入界面后，输入 /quit 回车退出（不行就试 /exit）。" \
    "    When you see the input box, type /quit and press Enter (or /exit)."
pause_here
agy
say "" "好了，可以关掉这个窗口。 / Done, you can close this window."
pause_here
