#!/bin/bash
# 在这台 Mac 上生成 Hola.app（放在"应用程序"里，桌面也放一个），点它就在后台启动 Hola 并打开窗口。
# 相当于 Windows 版的 Hola.vbs + 桌面图标。在本机生成，所以不会被系统当成"来历不明的下载"拦住。
# Creates Hola.app on this Mac (in ~/Applications, plus a desktop link). Equivalent to Hola.vbs + desktop icon on Windows.

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

APP="$HOME/Applications/Hola.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" || exit 1

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Hola</string>
  <key>CFBundleDisplayName</key><string>Hola</string>
  <key>CFBundleIdentifier</key><string>io.github.julianniu.hola</string>
  <key>CFBundleExecutable</key><string>Hola</string>
  <key>CFBundleIconFile</key><string>hola</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
PLIST

# 启动脚本里写死 Hola 文件夹的位置：用单引号包起来，空格、中文都安全（Mac 自带的旧版 bash 用 %q 会把中文转坏）
Q_DIR="'$(printf '%s' "$HOLA_DIR" | sed "s/'/'\\\\''/g")'"
{
  echo '#!/bin/bash'
  echo "HOLA_DIR=$Q_DIR"
  cat <<'RUN'
# 从访达 / 启动台打开时 PATH 很短：补上常见位置，再借用登录 shell 的 PATH（nvm、Homebrew 等）
export PATH="$HOME/.local/bin:$HOME/.hola-tools/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"
LOGIN_PATH="$(/bin/zsh -ilc 'printf %s "$PATH"' 2>/dev/null)"
[ -n "$LOGIN_PATH" ] && export PATH="$PATH:$LOGIN_PATH"

alert() { osascript -e "display alert \"Hola\" message \"$1\"" >/dev/null 2>&1; }

PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HOLA_DIR/config.json" | head -n 1)"
[ -n "$PORT" ] || PORT=3456
URL="http://localhost:$PORT/"
ping_hola() { curl -s -m 1 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null | grep -q hola; }

if ! ping_hola; then
  if [ ! -d "$HOLA_DIR" ]; then
    alert "找不到 Hola 文件夹（$HOLA_DIR）。如果你移动过它，请重新运行 mac/SETUP.command。 / The Hola folder has moved. Run mac/SETUP.command again."
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    alert "没有找到 Node.js。请先安装 Node.js（nodejs.org 下载 LTS 版），再打开 Hola。 / Node.js was not found. Install the LTS version from nodejs.org, then open Hola again."
    exit 1
  fi
  cd "$HOLA_DIR" || exit 1
  HOLA_HIDDEN=1 NO_OPEN=1 nohup node server.js >/dev/null 2>&1 &
  disown 2>/dev/null
  i=0
  while [ $i -lt 60 ]; do
    sleep 0.25
    ping_hola && break
    i=$((i + 1))
  done
  if ! ping_hola; then
    alert "Hola 没能启动。打开 Hola 文件夹里的 mac/START.command 查看具体报错。 / Hola could not start. Open mac/START.command in the Hola folder to see the error."
    exit 1
  fi
fi

# 有 Chrome / Edge 就用独立窗口打开，否则用默认浏览器
for b in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [ -d "/Applications/$b.app" ] || [ -d "$HOME/Applications/$b.app" ]; then
    open -na "$b" --args --app="$URL" --window-size=1300,880
    exit 0
  fi
done
open "$URL"
RUN
} > "$APP/Contents/MacOS/Hola"
chmod +x "$APP/Contents/MacOS/Hola"

# 图标：用 docs/logo.png 生成 .icns；失败也不影响使用
ICONSET="$(mktemp -d)/hola.iconset"
if mkdir -p "$ICONSET" 2>/dev/null; then
  for s in 16 32 128 256; do
    sips -z $s $s "$HOLA_DIR/docs/logo.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
    d=$((s * 2))
    [ $d -le 256 ] && sips -z $d $d "$HOLA_DIR/docs/logo.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/hola.icns" >/dev/null 2>&1
fi
touch "$APP"

# 桌面上放一个指向它的图标 / Desktop link
if [ -d "$HOME/Desktop" ] && [ ! -e "$HOME/Desktop/Hola" ]; then
  ln -s "$APP" "$HOME/Desktop/Hola" 2>/dev/null
fi

say "已创建：$APP（启动台和桌面上都能找到 Hola）" "Created: $APP (find Hola in Launchpad and on your desktop)"
