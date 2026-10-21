// 内置浏览器（桌面版外壳这一侧）：在 Hola 窗口右侧分屏里摆一个真正的网页窗口。
// 这里只提供最基本的动作（打开网址、在网页里执行脚本、点一下、输入文字、截图），
// 怎么"读网页、给元素编号、先问老板再点"这些逻辑在 lib/browser.js 里（那边跟着程序自动更新）。
'use strict';
const { app, WebContentsView, session } = require('electron');

// 网页不许碰本机：localhost、127.x、[::1]、0.0.0.0、本地文件（Hola 自己的后台也在本机，不能让网页去碰）
// HOLA_BROWSER_ALLOW：测试用，开发版才认，放行一个本机测试网站
const ALLOW = !app.isPackaged && process.env.HOLA_BROWSER_ALLOW ? String(process.env.HOLA_BROWSER_ALLOW).replace(/\/+$/, '') : '';
function allowed(url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (ALLOW && u.origin === ALLOW) return true;
  if (['data:', 'blob:', 'about:'].includes(u.protocol)) return true;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return !(h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '0.0.0.0' || h === '::1' || h === '::' || /^::ffff:127\./.test(h) || /^::ffff:7f/.test(h));
}

// getWin：取 Hola 的主窗口（窗口可能重开）
function createBrowser(getWin) {
  const ses = session.fromPartition('persist:hola-browser');
  // 网页要摄像头、麦克风、定位、通知等权限：一律不给
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // 所有请求都过一遍（包括跳转、网页里的图片和脚本请求），本机地址一律拦下
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !allowed(d.url) }));
  // 有的网站看到"Electron"就不让登录：用跟普通 Chrome 一样的标识
  ses.setUserAgent(ses.getUserAgent().replace(/ (Electron|hola|Hola)\/\S+/g, ''));

  let view = null, shown = false;
  const state = () => {
    if (!view) return { url: '', title: '', loading: false, canBack: false, canForward: false };
    const wc = view.webContents, h = wc.navigationHistory;
    return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canBack: h.canGoBack(), canForward: h.canGoForward() };
  };
  const send = (extra) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('hola:browser-state', { ...state(), ...extra }); };

  function ensure() {
    const w = getWin();
    if (view && !view.webContents.isDestroyed()) return view;
    view = new WebContentsView({ webPreferences: { partition: 'persist:hola-browser', sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } });
    view.setBackgroundColor('#ffffff');
    // 还没摆进分屏时也给一个大小，队友在后台用它时才截得了图
    view.setBounds({ x: 0, y: 0, width: 1100, height: 760 });
    view.setVisible(false);
    const wc = view.webContents;
    // 网页想开新窗口：就在这个浏览器里打开
    wc.setWindowOpenHandler(({ url }) => { if (allowed(url) && /^https?:/i.test(url)) wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(ev, () => send());
    if (w) w.contentView.addChildView(view);
    return view;
  }

  // 等网页加载完（最多 ms 毫秒）
  async function waitIdle(ms) {
    const wc = ensure().webContents;
    const end = Date.now() + (ms || 10000);
    await new Promise((r) => setTimeout(r, 150));
    while (wc.isLoading() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }

  return {
    v: 1,
    allowed,
    state,
    // 分屏里浏览器区域的位置（页面坐标）；null = 收起。zoom：Hola 页面自己的缩放
    setBounds(rect, zoom) {
      const v = ensure();
      if (!rect) { shown = false; v.setVisible(false); return; }
      const z = zoom || 1, n = (x) => Math.max(0, Math.round(Number(x) * z || 0));
      v.setBounds({ x: n(rect.x), y: n(rect.y), width: Math.max(1, n(rect.width)), height: Math.max(1, n(rect.height)) });
      shown = true;
      v.setVisible(true);
    },
    // 让 Hola 页面把浏览器分屏打开（队友打开网页时，老板能看到它在干什么）
    reveal() { if (!shown) send({ reveal: true }); },
    async navigate(url) {
      if (!allowed(url) || !/^https?:/i.test(url)) return { error: 'blocked' };
      const wc = ensure().webContents;
      try { await Promise.race([wc.loadURL(url), new Promise((r) => setTimeout(r, 20000))]); }
      catch (e) { if (!/ERR_ABORTED/.test(String(e && e.message))) return { error: String(e && e.message || e) }; }
      return {};
    },
    back() { const h = ensure().webContents.navigationHistory; if (h.canGoBack()) h.goBack(); },
    forward() { const h = ensure().webContents.navigationHistory; if (h.canGoForward()) h.goForward(); },
    reload() { ensure().webContents.reload(); },
    waitIdle,
    exec(js) { return ensure().webContents.executeJavaScript(js, true); },
    // 用真实的鼠标事件点一下（坐标是网页里的位置）
    click(x, y) {
      const wc = ensure().webContents;
      x = Math.round(x); y = Math.round(y);
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    insertText(t) { return ensure().webContents.insertText(String(t)); },
    pressEnter() {
      const wc = ensure().webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    },
    // 截图：太宽的缩到 1280，存成 JPEG，省得发给队友时太大
    async capture() {
      const img = await ensure().webContents.capturePage(undefined, { stayHidden: true });
      if (img.isEmpty()) return null;
      const s = img.getSize();
      const out = s.width > 1280 ? img.resize({ width: 1280 }) : img;
      return { data: out.toJPEG(75).toString('base64'), mimeType: 'image/jpeg', width: out.getSize().width, height: out.getSize().height };
    },
  };
}

module.exports = { createBrowser, allowed };
