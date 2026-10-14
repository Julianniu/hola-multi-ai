#!/bin/bash
# Hola 第一次安装（Mac）/ First-time setup (Mac)
# 第一次请在"终端"里输入 bash 加一个空格，把本文件拖进终端窗口，回车。
# First time: in Terminal, type "bash " (with a space), drag this file into the window, press Enter.

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
cd "$HOLA_DIR" || exit 1

say "" "===== 第 1 步：检查 Node.js / Step 1: check Node.js ====="
need_node
node --version

# 下载来的文件带有隔离标记、可能也没有执行权限：处理一下，以后就能直接双击 .command 文件
xattr -dr com.apple.quarantine "$HOLA_DIR" 2>/dev/null
chmod +x "$HOLA_DIR"/mac/*.command "$HOLA_DIR"/mac/*.sh 2>/dev/null

say "" "===== 第 2 步：安装 Claude Code 和 Codex 命令行 / Step 2: install the Claude Code and Codex CLIs ====="
missing=""
command -v claude >/dev/null 2>&1 || missing="$missing @anthropic-ai/claude-code"
command -v codex >/dev/null 2>&1 || missing="$missing @openai/codex"
if [ -n "$missing" ]; then
  say "需要联网，大约 1 到 5 分钟…… / Needs internet, about 1 to 5 minutes..."
  # 装到 ~/.hola-tools，不需要管理员密码 / Installs into ~/.hola-tools, no admin password needed
  if ! npm install -g --prefix "$HOME/.hola-tools" $missing; then
    say "安装出错了，请检查网络后重试。 / Installation failed. Check your connection and try again."
    pause_here
    exit 1
  fi
else
  say "已经装好了。 / Already installed."
fi

say "" "===== 第 3 步：安装 Antigravity CLI（Gemini）/ Step 3: install the Antigravity CLI (Gemini) ====="
if command -v agy >/dev/null 2>&1; then
  say "已经装好了。 / Already installed."
else
  curl -fsSL https://antigravity.google/cli/install.sh | bash
fi

say "" "===== 第 4 步：登录 Codex（ChatGPT 账号）/ Step 4: sign in to Codex (ChatGPT account) ====="
say "浏览器会打开 ChatGPT 登录页。登录后看到输入框，输入 /exit 回车回到这里。" \
    "A ChatGPT sign-in page opens. After signing in, when you see the input box, type /exit and press Enter."
pause_here
codex

say "" "===== 第 5 步：登录 Claude（订阅账号）/ Step 5: sign in to Claude (subscription account) ====="
say "选择用 Claude 账号（subscription）登录。看到输入框后输入 /exit 回车。" \
    "Choose \"Claude account with subscription\". When you see the input box, type /exit and press Enter."
pause_here
(unset ANTHROPIC_API_KEY; claude)

say "" "===== 第 6 步：登录 Gemini（Google 账号）/ Step 6: sign in to Gemini (Google account) ====="
say "浏览器会打开 Google 登录页。看到输入框后输入 /quit 回车。" \
    "A Google sign-in page opens. When you see the input box, type /quit and press Enter."
pause_here
agy

say "" "===== 第 7 步：创建 Hola 应用 / Step 7: create the Hola app ====="
bash "$HOLA_DIR/mac/make-app.sh"

say "" "全部完成！以后在\"启动台\"或桌面上点 Hola 图标即可。" \
    "All done! From now on, open Hola from Launchpad or the icon on your desktop." \
    "没有哪家的账号也没关系，没登录的队友会显示为不在线，不影响其他人。" \
    "Missing an account is fine: that teammate shows as offline and the others still work."
pause_here
