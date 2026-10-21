// Hola 桌面版外壳（Electron）：在本机启动 Hola 的后台，再用独立窗口打开界面。
// 后台代码（server.js、lib/、public/）和压缩包版完全一样，这里只负责：选数据放哪、找空闲端口、开窗口、管外链。
'use strict';
const { app, BrowserWindow, Menu, shell, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');
const nodeNet = require('net'); // 查空闲端口用（Electron 的 net 用来联网）

const updater = require('./updater');

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
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

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
    // Mac 上没有"编辑"菜单的话，Cmd+C / Cmd+V 用不了
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
      icon: path.join(CODE_DIR, 'public', 'icon-192.png'), autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: !process.env.HOLA_TEST_HIDDEN },
    });
    // HOLA_TEST_HIDDEN：自动测试时窗口不弹出来，免得打扰正在用电脑的人
    if (!process.env.HOLA_TEST_HIDDEN) win.once('ready-to-show', () => win.show());
    // 外部网址用系统浏览器打开；Hola 自己的页面（比如"在新窗口打开"预览）开在新窗口里
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(base + '/')) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: path.join(CODE_DIR, 'public', 'icon-192.png') } };
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith(base + '/')) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    win.on('closed', () => { win = null; });
    win.loadURL(base + '/');
  }

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('io.github.julianniu.hola');
    buildMenu();
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
        dialog.showErrorBox('Hola', T(`Hola 已经在运行了（可能是压缩包版的 Hola，地址 http://localhost:${l.port}）。同一份数据不能同时开两个，请先退出另一个（设置 → 退出 Hola）。`,
          `Hola is already running (perhaps the zip version, at http://localhost:${l.port}). The same data can't be open twice; quit the other one first (Settings → Quit Hola).`));
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
      dialog.showErrorBox('Hola', `Hola 没能启动 / Hola could not start:\n\n${e && e.stack || e}`);
      return app.quit();
    }
    const base = `http://127.0.0.1:${port}`;
    if (!(await waitReady(base))) {
      if (code.updated) return rollback();
      let log = '';
      try { log = fs.readFileSync(path.join(DATA_DIR, 'hola.log'), 'utf8').slice(-1500); } catch (_) {}
      dialog.showErrorBox('Hola', `Hola 的后台没有响应 / Hola's backend did not respond.\n\n${log}`);
      return app.quit();
    }
    if (UPDATES) updater.markStarted(APPS_DIR);
    createWindow(base);
    if (UPDATES) {
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
  async function checkUpdates(currentVersion) {
    const apiUrl = !app.isPackaged && process.env.HOLA_UPDATE_URL ? process.env.HOLA_UPDATE_URL : updater.API;
    const r = await updater.checkForUpdate({ fetch: (u, o) => net.fetch(u, o), apiUrl, currentVersion, shellVersion: app.getVersion(), appsDir: APPS_DIR, pubKey: UPDATE_PUBKEY });
    if (process.env.HOLA_TEST_HIDDEN) return; // 自动测试点不了系统弹窗
    if (!win || r.version === asked || (r.status !== 'ready' && r.status !== 'needs-shell')) return;
    asked = r.version;
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
