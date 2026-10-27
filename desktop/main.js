// Hola 桌面版外壳（Electron）：在本机启动 Hola 的后台，再用独立窗口打开界面。
// 后台代码（server.js、lib/、public/）和压缩包版完全一样，这里只负责：选数据放哪、找空闲端口、开窗口、管外链。
'use strict';
const { app, BrowserWindow, Menu, Tray, shell, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const nodeNet = require('net'); // 查空闲端口用（Electron 的 net 用来联网）

const updater = require('./updater');
const { createBrowser } = require('./browser');

const CODE_DIR = path.join(__dirname, '..');
const DEMO = process.env.HOLA_DEMO === '1' || process.argv.includes('--demo');

// 只开一个 Hola：再次打开时把已有的窗口叫到前面
// 测试用：把应用数据目录（设置、更新、单实例锁）换到临时文件夹，不碰真在用的那份
if (process.env.HOLA_USER_DATA) app.setPath('userData', process.env.HOLA_USER_DATA);
// 测试用：只有开发版（没打包）才允许换成测试钥匙；安装版永远只认内置的作者公钥
const UPDATE_PUBKEY = !app.isPackaged && process.env.HOLA_UPDATE_PUBKEY ? process.env.HOLA_UPDATE_PUBKEY : undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  app.on('second-instance', () => showWin());
  // 窗口可能缩在右下角托盘里（看不见）：拿出来、还原、放到最前面
  function showWin() { if (!win) return; if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.focus(); }

  // 数据放哪：设置、API Key 等在系统的应用数据目录；对话文件夹在"文档/Hola"，方便自己找到和备份。
  // 应用数据目录里的 location.json 可以改到别处，比如继续用压缩包版 Hola 的文件夹：
  // { "dataDir": "D:\\ai-team\\data", "workspace": "D:\\ai-team\\workspace", "config": "D:\\ai-team\\config.json" }
  let loc = {};
  if (!DEMO) { try { loc = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'location.json'), 'utf8')); } catch (_) {} }
  const DATA_DIR = process.env.HOLA_DATA_DIR || loc.dataDir || path.join(app.getPath('userData'), DEMO ? 'data-demo' : 'data');
  const WORKSPACE = process.env.HOLA_WORKSPACE || loc.workspace || path.join(app.getPath('documents'), DEMO ? 'Hola 演示' : 'Hola');

  // Mac 从程序坞打开时 PATH 很短：借用登录 shell 的 PATH，才找得到 claude、codex、agy 和 node
  if (process.platform === 'darwin') {
    try {
      const p = require('child_process').execFileSync('/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { timeout: 5000 }).toString().trim();
      if (p) process.env.PATH = p + ':' + (process.env.PATH || '');
    } catch (_) {}
  }

  const portFree = (p) => new Promise((resolve) => {
    const s = nodeNet.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
  async function pickPort() {
    if (process.env.PORT) return Number(process.env.PORT);
    // 优先用 3456（演示 3457）；被占用（比如还开着压缩包版 Hola）就换一个空闲的
    const want = DEMO ? 3457 : 3456;
    for (let p = want; p < want + 40; p++) if (await portFree(p)) return p;
    return 0;
  }
  async function waitReady(base) {
    for (let i = 0; i < 150; i++) {
      try { const r = await fetch(base + '/api/ping'); if (r.ok && (await r.json()).app === 'hola') return true; } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  function buildMenu() {
    const mac = process.platform === 'darwin';
    // Windows：窗口顶上不要菜单栏（标题栏由 Hola 自己画）；复制粘贴等快捷键照样能用
    if (!mac) return Menu.setApplicationMenu(null);
    // Mac 的菜单在屏幕最上方，必须有"编辑"菜单，Cmd+C / Cmd+V 才能用
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(mac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { label: '视图 / View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
      { role: 'windowMenu' },
    ]));
  }

  function createWindow(base) {
    win = new BrowserWindow({
      width: 1300, height: 880, minWidth: 720, minHeight: 520, title: 'Hola', show: false,
      icon: WIN_ICON, autoHideMenuBar: true,
      // 不用系统自带的标题栏：Windows 只保留右上角的最小化 / 最大化 / 关闭（颜色跟着 Hola 的主题），Mac 保留左上角的红黄绿三个按钮
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      // 外壳 3.0 起 Windows 不再用系统画的窗口按钮：页面在右上角自己画一个玻璃胶囊（最小化 / 最大化 / 关闭），四周的缝一样宽
      ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: !process.env.HOLA_TEST_HIDDEN },
    });
    // HOLA_TEST_HIDDEN：自动测试时窗口不弹出来，免得打扰正在用电脑的人
    if (!process.env.HOLA_TEST_HIDDEN) win.once('ready-to-show', () => { win.show(); setTimeout(hideSplash, 150); });
    // 外部网址用系统浏览器打开；Hola 自己的页面（比如"在新窗口打开"预览）开在新窗口里
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(base + '/')) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: WIN_ICON } };
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith(base + '/')) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    win.on('focus', () => win.flashFrame(false));
    // 页面自己画的"最大化 / 还原"按钮要知道现在是不是最大化
    const winState = () => { if (!win.isDestroyed()) win.webContents.send('hola:win-state', { max: win.isMaximized() }); };
    win.on('maximize', winState); win.on('unmaximize', winState);
    // Windows：点右上角的 X 只是缩到右下角托盘，后台继续干活；真正退出用托盘图标的右键菜单
    win.on('close', (e) => {
      if (quitting || !tray) return;
      e.preventDefault();
      win.hide();
      if (!hintShown) { hintShown = true; balloon(T('Hola 还在右下角运行，队友会继续干活。右键托盘图标可以退出。', 'Hola is still running in the tray and your teammates keep working. Right-click the tray icon to quit.')); }
    });
    win.on('closed', () => { win = null; });
    win.loadURL(base + '/');
  }

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; });
  // 设置里点"退出 Hola"时后台直接结束进程：顺手把托盘图标收掉，免得右下角留个点不动的空图标
  process.on('exit', () => { try { if (tray) tray.destroy(); } catch (_) {} });

  // ---------------- 右下角托盘（只在 Windows）：关窗口 = 缩到这里；单击打开；右键 → 打开 / 退出
  const WIN_ICON = process.platform === 'win32' ? path.join(__dirname, 'hola.ico') : path.join(CODE_DIR, 'public', 'icon-192.png');
  let tray = null, quitting = false, hintShown = false, baseUrl = '';
  function balloon(content) {
    if (!tray || process.env.HOLA_TEST_HIDDEN) return;
    try { tray.displayBalloon({ title: 'Hola', content, iconType: 'none', noSound: true }); } catch (_) {}
  }
  // 启动前出问题时的提示窗：不用系统自带的对话框，画一个和 Hola 弹窗一样的小窗口（浮层玻璃）。
  // 关掉（点按钮、按 Esc 或回车）后才继续；自动测试时不弹
  function shellBox(title, body, detail) {
    return new Promise((resolve) => {
      if (process.env.HOLA_TEST_HIDDEN) return resolve();
      try {
        const { nativeTheme } = require('electron');
        const dark = nativeTheme.shouldUseDarkColors;
        const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const c = dark ? { bg: 'rgba(38,39,43,.94)', ink: '#ECECEE', ink2: '#A3A6AE', ring: 'rgba(255,255,255,.12)', btn: '#ECECEE', btnTx: '#17181A', pre: 'rgba(255,255,255,.06)' }
          : { bg: 'rgba(255,255,255,.96)', ink: '#1A1C1F', ink2: '#5E626A', ring: 'rgba(26,28,31,.12)', btn: '#1A1C1F', btnTx: '#FFFFFF', pre: 'rgba(26,28,31,.05)' };
        const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font:13.5px/1.6 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;color:${c.ink};overflow:hidden}
.box{position:absolute;inset:14px;border-radius:16px;background:${c.bg};box-shadow:0 0 0 .5px ${c.ring},0 12px 30px rgba(0,0,0,.25);padding:20px 22px 16px;display:flex;flex-direction:column;-webkit-app-region:drag}
h1{margin:0 0 8px;font-size:15px;font-weight:600}p{margin:0;color:${c.ink2}}
pre{flex:1;min-height:0;overflow:auto;margin:10px 0 0;padding:8px 10px;border-radius:10px;background:${c.pre};font:11.5px/1.5 Consolas,monospace;white-space:pre-wrap;-webkit-app-region:no-drag}
.f{display:flex;justify-content:flex-end;margin-top:14px}a{-webkit-app-region:no-drag;text-decoration:none;background:${c.btn};color:${c.btnTx};padding:6px 16px;border-radius:999px;font-weight:500;outline:none}a:focus-visible{box-shadow:0 0 0 3px ${c.ring}}
</style></head><body><div class="box"><h1>${esc(title)}</h1><p>${esc(body)}</p>${detail ? `<pre>${esc(detail)}</pre>` : '<div style="flex:1"></div>'}<div class="f"><a href="hola:close" id="ok">${esc(T('知道了', 'OK'))}</a></div></div>
<script>document.getElementById('ok').focus();addEventListener('keydown',e=>{if(e.key==='Escape'||e.key==='Enter')location.href='hola:close'})</script></body></html>`;
        const w = new BrowserWindow({ width: 500, height: detail ? 380 : 230, frame: false, transparent: true, resizable: false, show: false, icon: WIN_ICON, title: 'Hola', webPreferences: { sandbox: true, contextIsolation: true } });
        w.webContents.on('will-navigate', (e) => { e.preventDefault(); w.close(); });
        // 先让提示窗出来再关开屏（反过来的话窗口一个不剩，程序会直接退出）
        w.once('ready-to-show', () => { w.show(); hideSplash(); });
        w.on('closed', () => resolve());
        w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      } catch (_) { dialog.showErrorBox(title, [body, detail].filter(Boolean).join('\n\n')); resolve(); }
    });
  }
  // 开屏（外壳 3.1）：双击图标后马上出一个小窗口，Hola 的线条标志一笔一笔画出来、三颗水银合拢，
  // 盖住后台启动的这两三秒；主窗口画好了再关掉它（主窗口里页面自己还有一层开屏，盖住第一次加载）
  let splash = null;
  function showSplash() {
    if (process.env.HOLA_TEST_HIDDEN) return;
    try {
      const { nativeTheme } = require('electron');
      const dark = nativeTheme.shouldUseDarkColors;
      const c = dark ? { bg: 'rgba(30,31,35,.94)', ink: '#ECECEE', ink3: '#8A8E96', ring: 'rgba(255,255,255,.12)', a: '#F4F5F7', b: '#6B6F77' }
        : { bg: 'rgba(246,247,249,.96)', ink: '#1A1C1F', ink3: '#8A8E96', ring: 'rgba(26,28,31,.10)', a: '#FFFFFF', b: '#8D929B' };
      const sub = T('光辉联合', 'Team of AIs');
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif}
.box{position:absolute;inset:16px;border-radius:28px;background:${c.bg};box-shadow:0 0 0 .5px ${c.ring},0 18px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;-webkit-app-region:drag}
svg{width:96px;height:96px;color:${c.ink}}
.l{fill:none;stroke:currentColor;stroke-width:14;stroke-dasharray:330;stroke-dashoffset:330;animation:draw 1.1s cubic-bezier(.6,.1,.3,1) forwards}
.l:nth-child(2){animation-delay:.18s}.l:nth-child(3){animation-delay:.36s}
.d{fill:currentColor;transform-origin:128px 131px;transform:scale(0);animation:pop .5s cubic-bezier(.3,1.6,.5,1) 1.1s forwards}
.drops{position:relative;width:90px;height:26px;margin-top:6px}
.drops i{position:absolute;top:5px;width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,${c.a},${c.b} 70%);box-shadow:inset 0 -1px 2px rgba(0,0,0,.25),0 2px 4px rgba(0,0,0,.18);animation:gather 2.4s ease-in-out infinite alternate}
.drops i:nth-child(1){left:8px;--x:29px}.drops i:nth-child(2){left:37px;--x:0px}.drops i:nth-child(3){left:66px;--x:-29px}
b{font-weight:600;font-size:20px;letter-spacing:.06em;color:${c.ink};margin-top:6px}
span{font-size:12px;letter-spacing:.2em;color:${c.ink3}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes pop{to{transform:scale(1)}}
@keyframes gather{0%,15%{transform:translateX(0) scale(1)}85%,100%{transform:translateX(var(--x)) scale(.82)}}
</style></head><body><div class="box"><svg viewBox="0 0 256 256"><g><circle class="l" cx="128" cy="104" r="52"/><circle class="l" cx="103" cy="147" r="52"/><circle class="l" cx="153" cy="147" r="52"/></g><circle class="d" cx="128" cy="131" r="12"/></svg><div class="drops"><i></i><i></i><i></i></div><b>Hola</b><span>${sub}</span></div></body></html>`;
      splash = new BrowserWindow({ width: 300, height: 320, frame: false, transparent: true, resizable: false, movable: true, show: false, skipTaskbar: true, icon: WIN_ICON, title: 'Hola', webPreferences: { sandbox: true, contextIsolation: true } });
      splash.once('ready-to-show', () => { if (splash) splash.show(); });
      splash.on('closed', () => { splash = null; });
      splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    } catch (_) { splash = null; }
  }
  function hideSplash() { if (splash && !splash.isDestroyed()) splash.close(); splash = null; }
  // 彻底退出：先请后台把正在跑的队友（claude / codex / agy 进程）都叫停，再关掉整个程序
  async function quitAll() {
    quitting = true;
    if (tray) { tray.destroy(); tray = null; }
    try { if (baseUrl) await fetch(baseUrl + '/api/quit', { method: 'POST', headers: { 'X-Hola': '1', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) }); } catch (_) {}
    setTimeout(() => app.exit(0), 1500);
  }
  function createTray() {
    if (process.platform !== 'win32' || tray) return;
    tray = new Tray(path.join(__dirname, 'tray.ico'));
    tray.setToolTip('Hola');
    const menu = () => Menu.buildFromTemplate([
      { label: T('打开 Hola', 'Open Hola'), click: showWin },
      { type: 'separator' },
      { label: T('退出 Hola', 'Quit Hola'), click: quitAll },
    ]);
    tray.on('click', showWin);
    tray.on('balloon-click', showWin);
    // 右键时再生成菜单：界面语言可能刚换过
    tray.on('right-click', () => tray.popUpContextMenu(menu()));
  }

  // 页面换了深浅色：标题栏右上角按钮的颜色跟着换（只接受 #RRGGBB）
  const { ipcMain } = require('electron');
  ipcMain.on('hola:titlebar', (e, c) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const ok = (x) => /^#[0-9a-f]{6}$/i.test(String(x || ''));
    if (w && process.platform !== 'darwin' && c && ok(c.bg) && ok(c.fg)) { try { w.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: 44 }); } catch (_) {} }
  });

  // 内置浏览器：只听 Hola 主窗口的（"在新窗口打开"的预览页也带着这个小口子，但不许它们控制浏览器）
  let browser = null;
  const fromMain = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  // 页面自己画的窗口按钮（Windows）：最小化 / 最大化 / 关闭（关闭 = 缩到托盘，和以前点 X 一样）
  ipcMain.on('hola:win', (e, op) => {
    if (!fromMain(e)) return;
    if (op === 'min') win.minimize();
    else if (op === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (op === 'close') win.close();
  });
  ipcMain.handle('hola:win-state', (e) => (fromMain(e) ? { max: win.isMaximized() } : null));
  ipcMain.on('hola:browser-bounds', (e, rect) => {
    if (!browser || !fromMain(e)) return;
    const ok = rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k]));
    browser.setBounds(ok ? rect : null, win.webContents.getZoomFactor());
  });
  ipcMain.on('hola:attention', (e) => {
    if (!fromMain(e) || win.isFocused()) return;
    if (!win.isVisible()) balloon(T('有事需要你看一下，点这里打开 Hola。', 'Something needs your attention. Click to open Hola.'));
    else win.flashFrame(true);
  });
  // 更新提示用 Hola 自己画的弹窗：页面说"我会画"，外壳就把消息交给页面；老版本的页面不会说，外壳照旧用系统弹窗
  let pageUpdates = false, pendingUpdate = null;
  ipcMain.on('hola:ui', (e, info) => { if (fromMain(e) && info && info.updates) pageUpdates = true; });
  ipcMain.on('hola:update-answer', (e, a) => {
    if (!fromMain(e)) return;
    // 点"稍后"不清掉：老板之后还能在设置里点"立即重启 / 去下载"（设置里的按钮也走这里）
    const r = pendingUpdate || (updState.status === 'ready' || updState.status === 'needs-shell' ? updState : null);
    if (!r || a === 'later') return;
    pendingUpdate = null;
    if (a === 'restart' && r.status === 'ready') { quitting = true; app.relaunch(); app.exit(0); }
    else if (a === 'download' && r.status === 'needs-shell' && /^https:\/\//.test(String(r.page || ''))) shell.openExternal(r.page);
  });
  ipcMain.handle('hola:browser', async (e, a) => {
    if (!browser || !fromMain(e) || !a) return null;
    if (a.op === 'open') {
      // 老板在地址栏里输的：像网址就打开，不像就用必应搜一下
      let u = String(a.url || '').trim();
      if (!u) return browser.state();
      if (!/^https?:\/\//i.test(u)) u = /^[^\s/]+\.[a-z]{2,}(\/|$|:)/i.test(u) ? 'https://' + u : 'https://www.bing.com/search?q=' + encodeURIComponent(u);
      const r = await browser.navigate(u);
      return { ...browser.state(), error: r.error };
    }
    if (a.op === 'back') browser.back();
    else if (a.op === 'forward') browser.forward();
    else if (a.op === 'reload') browser.reload();
    return browser.state();
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('io.github.julianniu.hola');
    buildMenu();
    showSplash();
    const port = await pickPort();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE, { recursive: true });
    Object.assign(process.env, { PORT: String(port), HOLA_DATA_DIR: DATA_DIR, HOLA_WORKSPACE: WORKSPACE, NO_OPEN: '1', HOLA_HIDDEN: process.env.HOLA_SHOW_LOG ? '' : '1' });
    // 高级用户可以在数据目录放一份自己的 config.json（比如改命令或参数）
    const userConfig = loc.config || path.join(DATA_DIR, 'config.json');
    if (!process.env.TEAM_CONFIG && fs.existsSync(userConfig)) process.env.TEAM_CONFIG = userConfig;
    if (DEMO && !process.argv.includes('--demo')) process.argv.push('--demo');

    // 同一份数据已经有 Hola 在用（比如还开着压缩包版）：提示一下，不再启动第二个
    try {
      const l = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hola.lock'), 'utf8'));
      const j = await (await fetch(`http://127.0.0.1:${l.port}/api/ping`, { signal: AbortSignal.timeout(1500) })).json();
      if (j.app === 'hola' && path.resolve(String(j.data || '')) === path.resolve(DATA_DIR)) {
        await shellBox(T('Hola 已经开着了', 'Hola is already running'), T(`可能是压缩包版的 Hola（地址 http://localhost:${l.port}）。同一份资料不能同时开两个，请先退出另一个（设置 → 退出 Hola）。`,
          `Perhaps the zip version, at http://localhost:${l.port}. The same data can't be open twice; quit the other one first (Settings → Quit Hola).`));
        return app.quit();
      }
    } catch (_) {}

    // 用哪份程序：安装包自带的，或者自动更新下载好、核对通过的新版本
    const code = UPDATES ? updater.chooseCodeDir({ bundledDir: CODE_DIR, appsDir: APPS_DIR, pubKey: UPDATE_PUBKEY }) : { dir: CODE_DIR, updated: false, version: bundledVersion() };
    // 新版本起不来：标记为坏版本，重启回到安装包自带的版本
    // （自动测试时只退出不重启，方便测试接着检查）
    const rollback = () => { updater.markBad(APPS_DIR, code.version); if (!process.env.HOLA_TEST_HIDDEN) app.relaunch(); app.exit(0); };
    try {
      require(path.join(code.dir, 'server.js'));
    } catch (e) {
      if (code.updated) return rollback();
      await shellBox(T('Hola 没能启动', 'Hola could not start'), T('出错的详细信息在下面，可以截图发给作者。', 'Details are below; you can send a screenshot to the author.'), String(e && e.stack || e));
      return app.quit();
    }
    const base = `http://127.0.0.1:${port}`;
    if (!(await waitReady(base))) {
      if (code.updated) return rollback();
      let log = '';
      try { log = fs.readFileSync(path.join(DATA_DIR, 'hola.log'), 'utf8').slice(-1500); } catch (_) {}
      await shellBox(T('Hola 的后台没有响应', "Hola's backend did not respond"), T('最近的日志在下面，可以截图发给作者。', 'The latest log is below; you can send a screenshot to the author.'), log);
      return app.quit();
    }
    if (UPDATES) updater.markStarted(APPS_DIR);
    baseUrl = base;
    createWindow(base);
    createTray();
    // 把内置浏览器交给后台（用后台所在那份程序里的 lib/browser.js；老版本程序没有这个文件就算了）
    browser = createBrowser(() => win);
    try { require(path.join(code.dir, 'lib', 'browser.js')).setBackend(browser); } catch (_) {}
    if (UPDATES) {
      runningVersion = code.version;
      setTimeout(() => checkUpdates(code.version), Number(process.env.HOLA_UPDATE_DELAY_MS) || 8000);
      setInterval(() => checkUpdates(code.version), 6 * 3600 * 1000);
    }
  });

  // ---------------- 自动更新（只在安装版里开；演示模式不开；HOLA_UPDATE_URL 只在开发时用来测试）
  const UPDATES = !DEMO && !process.env.HOLA_NO_UPDATE && (app.isPackaged || !!process.env.HOLA_UPDATE_URL);
  const APPS_DIR = path.join(app.getPath('userData'), 'app');
  function bundledVersion() { try { return JSON.parse(fs.readFileSync(path.join(CODE_DIR, 'release.json'), 'utf8')).version; } catch (_) { return '0.0.0'; } }
  function T(zh, en) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8')).uiLang === 'en' ? en : zh; } catch (_) { return zh; } }
  let asked = '';
  // 检查更新的状态（设置里的"检查更新"显示它）；每次检查的结果都记进 app-data 的 update.log，查不到时能看出原因
  let updState = { status: 'idle' }, updRunning = null, runningVersion = null;
  function sendUpd(u) { if (win && !win.isDestroyed()) win.webContents.send('hola:update-progress', u); }
  function logUpdate(r, manual) {
    try {
      const f = path.join(app.getPath('userData'), 'update.log');
      try { if (fs.statSync(f).size > 200e3) fs.writeFileSync(f, ''); } catch (_) {}
      fs.appendFileSync(f, `${new Date().toISOString()} ${manual ? 'manual' : 'auto'} ${r.status}${r.version ? ' ' + r.version : ''}${r.via ? ' via ' + r.via : ''}${r.error ? ' — ' + r.error : ''}\n`);
    } catch (_) {}
  }
  function checkUpdates(currentVersion, manual) {
    if (updRunning) return updRunning;
    // 新版本已经下好、等重启：不用再下一次
    if (manual && updState.status === 'ready') return Promise.resolve(updState);
    updRunning = runCheck(currentVersion, manual).finally(() => { updRunning = null; });
    return updRunning;
  }
  async function runCheck(currentVersion, manual) {
    const dev = !app.isPackaged;
    const apiUrl = dev && process.env.HOLA_UPDATE_URL ? process.env.HOLA_UPDATE_URL : updater.API;
    const pageUrl = dev && process.env.HOLA_UPDATE_PAGE ? process.env.HOLA_UPDATE_PAGE : updater.PAGE;
    const onProgress = (u) => { updState = { ...u, at: updState.at }; sendUpd(updState); };
    const r = await updater.checkForUpdate({ fetch: (u, o) => net.fetch(u, o), apiUrl, pageUrl, currentVersion, shellVersion: app.getVersion(), appsDir: APPS_DIR, pubKey: UPDATE_PUBKEY, onProgress });
    updState = { status: r.status, version: r.version ? String(r.version) : '', error: r.error || '', page: r.page || '', at: Date.now() };
    sendUpd(updState);
    logUpdate(r, manual);
    if (r.status === 'ready' || r.status === 'needs-shell') pendingUpdate = r;
    // 老板自己点的"检查更新"：结果就显示在设置里（重启 / 去下载的按钮也在那儿），不再另外弹窗
    if (manual) { if (r.version) asked = r.version; return updState; }
    await promptUpdate(r);
    return updState;
  }
  ipcMain.handle('hola:update-check', (e) => {
    if (!fromMain(e)) return null;
    if (!UPDATES || !runningVersion) return { status: 'error', error: T('这一份 Hola 不能自动更新（开发版或演示模式）', 'This copy of Hola cannot update itself (development copy or demo mode)'), at: Date.now() };
    return checkUpdates(runningVersion, true);
  });
  ipcMain.handle('hola:update-state', (e) => (fromMain(e) ? updState : null));
  async function promptUpdate(r) {
    if (process.env.HOLA_TEST_HIDDEN) return; // 自动测试点不了系统弹窗
    if (!win || r.version === asked || (r.status !== 'ready' && r.status !== 'needs-shell')) return;
    asked = r.version;
    if (pageUpdates) {
      pendingUpdate = r;
      win.webContents.send('hola:update', { status: r.status, version: String(r.version) });
      if (!win.isVisible()) balloon(T(`Hola ${r.version} 已经准备好，点这里打开 Hola。`, `Hola ${r.version} is ready. Click to open Hola.`));
      return;
    }
    if (r.status === 'ready') {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info', buttons: [T('立即重启', 'Restart now'), T('稍后', 'Later')], defaultId: 0, cancelId: 1,
        message: T(`Hola ${r.version} 已经准备好`, `Hola ${r.version} is ready`),
        detail: T('新版本已下载并通过官方签名核对，重启 Hola 后生效。正在干的活会被叫停。', 'The new version has been downloaded and its official signature verified. It takes effect when Hola restarts. Work in progress will be stopped.'),
      });
      if (response === 0) { app.relaunch(); app.exit(0); }
    } else {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info', buttons: [T('去下载', 'Download'), T('稍后', 'Later')], defaultId: 0, cancelId: 1,
        message: T(`Hola ${r.version} 发布了`, `Hola ${r.version} is out`),
        detail: T('这次更新需要下载新的安装包。点"去下载"会打开下载页，安装新版本时你的对话和设置都会保留。', 'This update needs the new installer. "Download" opens the download page; your chats and settings are kept when you install it.'),
      });
      if (response === 0) shell.openExternal(r.page);
    }
  }
}
