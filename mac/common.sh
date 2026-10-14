#!/bin/bash
# Hola 的 Mac 脚本共用部分：找到 Hola 文件夹，补全 PATH。
# 注意：Mac 自带的是 bash 3.2，这里不要用新版 bash 才有的写法。

HOLA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 各家命令行常见的安装位置；~/.hola-tools 是 SETUP 给 Claude Code / Codex 用的安装目录（不需要管理员密码）
export PATH="$HOME/.local/bin:$HOME/.hola-tools/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"

say() { printf '%s\n' "$@"; }

pause_here() {
  printf '\n%s' "按回车继续 / Press Enter to continue... "
  read -r _
}

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    say "没有找到 Node.js。马上为你打开下载页：请下载 LTS 版本安装，然后重新运行本脚本。" \
        "Node.js not found. Opening the download page: install the LTS version, then run this script again."
    open "https://nodejs.org/" 2>/dev/null
    pause_here
    exit 1
  fi
}
