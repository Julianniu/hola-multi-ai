// 用 Electron 把 public/logo.svg 画成 1024×1024 的 PNG（Mac 安装包要的大图标）→ build/icon.png
// 用法：npx electron tools/make-icon.js   （只在换 logo 时运行一次，结果提交进仓库）
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'public', 'logo.svg'), 'utf8').replace(/width="\d+" height="\d+"/, 'width="1024" height="1024"');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  console.log('build/icon.png', img.getSize());
  app.quit();
});
