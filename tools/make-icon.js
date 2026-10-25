// 用 Electron 把标志画成各种尺寸的图标（只在换 logo 时运行一次，结果提交进仓库）：
//   build/icon.png      1024×1024，Mac 安装包要的大图标
//   hola.ico            Windows 安装包、桌面快捷方式用（16–256 每个尺寸单独按原尺寸画，不是从大图缩小，所以小图标也清楚）
//   desktop/hola.ico    同上，给窗口和任务栏用（打包时 desktop/ 会带进去）
//   desktop/tray.ico    右下角托盘用：和桌面图标一样（白底黑线，老板定的），在深浅任务栏上都看得清
//   public/favicon.png  64×64；public/icon-192.png  192×192（Mac / Linux 的窗口图标）
// V3 标志是白底上的黑色线条：尺寸越小，线条越粗、中间的点越大、三个圆放大一点（不然 16 像素时线条只剩半个像素）
// 用法：npx electron tools/make-icon.js
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGO = fs.readFileSync(path.join(ROOT, 'public', 'logo.svg'), 'utf8');

function tileSvg(px) {
  let s = LOGO.replace(/width="\d+" height="\d+"/, `width="${px}" height="${px}"`);
  if (px <= 48) {
    const sw = px <= 16 ? 18 : px <= 20 ? 16.5 : px <= 24 ? 15 : px <= 32 ? 13.5 : 12, dot = px <= 16 ? 18 : px <= 24 ? 16 : px <= 32 ? 14 : 13;
    const k = px <= 16 ? 1.16 : px <= 24 ? 1.12 : px <= 32 ? 1.07 : 1.03;
    const tf = `transform="translate(128 128) scale(${k}) translate(-128 -128)"`;
    s = s.replace('stroke="#16181C" stroke-width="11">', `stroke="#16181C" stroke-width="${sw}" ${tf}>`).replace('<circle cx="128" cy="131" r="12"', `<circle ${tf} cx="128" cy="131" r="${dot}"`);
  }
  return s;
}
const traySvg = tileSvg;

// 在页面的 canvas 上按目标像素直接画 SVG（矢量按这个尺寸栅格化），不受屏幕缩放影响
async function render(win, svg, px) {
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const data = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.width = ${px}; img.height = ${px}; img.src = ${JSON.stringify(url)}; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = ${px};
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${px}, ${px});
    return c.toDataURL('image/png');
  })()`);
  return Buffer.from(data.split(',')[1], 'base64');
}

// ICO 文件：每个尺寸存一张 PNG（Windows Vista 起都支持）
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([px, png], i) => {
    const o = 6 + i * 16;
    head[o] = px >= 256 ? 0 : px; head[o + 1] = px >= 256 ? 0 : px;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(off, o + 12);
    off += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p[1])]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const big = await render(win, tileSvg(1024), 1024);
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), big);
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const tiles = [];
  for (const px of sizes) tiles.push([px, await render(win, tileSvg(px), px)]);
  const appIco = ico(tiles);
  fs.writeFileSync(path.join(ROOT, 'hola.ico'), appIco);
  fs.writeFileSync(path.join(ROOT, 'desktop', 'hola.ico'), appIco);
  const trays = [];
  for (const px of [16, 20, 24, 32, 40, 48, 64]) trays.push([px, await render(win, traySvg(px), px)]);
  fs.writeFileSync(path.join(ROOT, 'desktop', 'tray.ico'), ico(trays));
  fs.writeFileSync(path.join(ROOT, 'public', 'favicon.png'), await render(win, tileSvg(64), 64));
  fs.writeFileSync(path.join(ROOT, 'public', 'icon-192.png'), await render(win, tileSvg(192), 192));
  fs.writeFileSync(path.join(ROOT, 'docs', 'logo.png'), await render(win, tileSvg(256), 256)); // README 顶上的标志
  // 检查用：把托盘和小尺寸图标放大并排存一张（不提交）
  if (process.env.ICON_PREVIEW) {
    const parts = [...tiles.filter(([p]) => p <= 48), ...trays.filter(([p]) => p <= 32)];
    fs.writeFileSync(process.env.ICON_PREVIEW, JSON.stringify(parts.map(([p, b]) => [p, b.toString('base64')])));
  }
  console.log('icons:', sizes.join(', '), '+ tray');
  app.quit();
});
