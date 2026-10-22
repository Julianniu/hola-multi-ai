// 桌面版（Electron）：真的把 Hola 应用打开，像人一样打字、点按钮、看预览，再切到英文找漏翻的中文。
// 需要先 npm install（装 electron 和 playwright-core）；没装的话这组测试自动跳过，其他测试照常跑。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { ROOT, freePort } = require('./helpers');

// 内置浏览器测试用的小网站（开发版允许用 HOLA_BROWSER_ALLOW 放行这一个本机地址）
const SITE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>测试网页</title></head><body><h1>耳机比价</h1><p>这是一段正文，用来测试读网页。</p>'
  + '<input id="q" placeholder="搜索"><button id="go" onclick="document.getElementById(\'out\').textContent=\'已提交：\'+document.getElementById(\'q\').value">提交</button>'
  + '<p id="out"></p><a href="/page2">第二页</a></body></html>';
function startSite() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.url === '/page2' ? '<!doctype html><meta charset="utf-8"><title>第二页</title><p>第二页的内容</p>' : SITE_HTML);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
// 像 Claude 那样启动内置浏览器的工具服务（MCP），用 JSON-RPC 跟它说话
function mcpClient(cfgFile) {
  const sv = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers['hola-browser'];
  const ch = spawn(sv.command, sv.args, { env: { ...process.env, ...sv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const waiting = new Map();
  ch.stdout.setEncoding('utf8');
  ch.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
  });
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args || {} })).result;
  return { rpc, call, close: () => ch.kill() };
}
const textOf = (r) => r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');

let electronPath = null, pw = null;
try { electronPath = require('electron'); pw = require('playwright-core'); } catch (_) {}
const skip = !electronPath || !pw || !fs.existsSync(String(electronPath)) ? '没装 electron / playwright-core（npm install 后才测桌面版）' : false;
// 在 GitHub 上发版时（HOLA_REQUIRE_APP=1）桌面版测试必须真的跑，不许跳过
if (skip && process.env.HOLA_REQUIRE_APP) require('node:test').it('桌面版测试必须能跑', () => { throw new Error(skip); });

describe('桌面版', { skip }, () => {
  let app, page, dir, site, errors = [];
  // 测打包好的应用时，开发版才有的"放行本机测试网站"不起作用：只测拦截和工具服务本身
  const PACKAGED = !!process.env.HOLA_APP_EXE;
  const $text = (sel) => page.locator(sel).first().innerText();
  async function ask(text) {
    await page.fill('#input', text);
    await page.click('#sendBtn');
  }
  const waitIdle = () => page.waitForFunction(() => !document.body.classList.contains('busy') && !document.querySelector('.row .working'), null, { timeout: 30000 });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-app-'));
    site = await startSite();
    // 界面语言固定成中文：不然会跟着电脑的系统语言走（GitHub 的云电脑是英文），测试里的中文判断就对不上了
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify({ uiLang: 'zh' }));
    // HOLA_APP_EXE：测打包好的应用（比如 dist/win-unpacked/Hola.exe），确认打包时没漏文件
    const exe = process.env.HOLA_APP_EXE;
    app = await pw._electron.launch({
      executablePath: exe || electronPath, args: exe ? [] : [ROOT], cwd: exe ? path.dirname(exe) : ROOT,
      env: { ...process.env, HOLA_DEMO: '1', HOLA_DEMO_FAST: '1', HOLA_TEST_HIDDEN: '1', PORT: String(await freePort()),
        HOLA_DATA_DIR: path.join(dir, 'data'), HOLA_WORKSPACE: path.join(dir, 'workspace'), HOLA_USER_DATA: path.join(dir, 'userdata'),
        HOLA_BROWSER_ALLOW: `http://127.0.0.1:${site.address().port}` },
    });
    page = await app.firstWindow();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text() + (m.location() && m.location().url ? ' @ ' + m.location().url : '')); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  });
  after(async () => {
    if (app) await app.close();
    if (site) site.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it('打开应用：窗口标题、版本标识、三位队友在线', async () => {
    assert.equal(await page.title(), 'Hola');
    // 版本号平时不在侧栏，在设置窗口底部；侧栏只在"被改过"时才提醒
    assert.equal(await page.locator('#buildTag').isHidden(), true);
    assert.match(await page.locator('#sVersion').textContent(), /(开发版|官方版)/);
    assert.equal(await page.locator('#meSub').isHidden(), true, '没填职位时不显示"点这里设置"之类的提示');
    await page.waitForFunction(() => /3\/3/.test(document.querySelector('#whoText').textContent), null, { timeout: 15000 });
  });

  it('不点名提问：讨论出结论，接力做出文件，在右侧分屏预览', async () => {
    await ask('新品耳机首发该怎么推广');
    await page.waitForSelector('.row.concl .concl-head', { timeout: 30000 });
    const pv = page.locator('[data-preview]').first();
    await pv.waitFor({ timeout: 30000 });
    await pv.click();
    await page.waitForSelector('#split:not([hidden])');
    assert.equal(await $text('#spName'), '结论要点.csv');
    const frame = page.frameLocator('#spFrame');
    await frame.locator('table').waitFor();
    assert.match(await frame.locator('table').innerText(), /设定成本上限/);
    await page.click('#spClose');
    assert.equal(await page.locator('#split').isHidden(), true);
  });

  it('谈不拢：出现拍板卡片，点方案后按决定分工', async () => {
    await page.click('#newConv');
    await ask('新品耳机首发该怎么推广，有分歧就让我拍板');
    const btn = page.locator('[data-decide][data-key="B"]');
    await btn.waitFor({ timeout: 30000 });
    assert.match(await $text('.decide-h'), /请你拍板/);
    await btn.click();
    await page.waitForSelector('.row .decide-h.done', { timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.row .meta')].some((m) => /交给 Ta/.test(m.textContent)), null, { timeout: 30000 });
  });

  it('标题栏：系统标题栏换成 Hola 自己的顶栏，能拖动窗口，按钮和弹窗不受影响', async () => {
    const r = await page.evaluate(() => {
      const region = (sel) => getComputedStyle(document.querySelector(sel)).webkitAppRegion || getComputedStyle(document.querySelector(sel)).getPropertyValue('app-region');
      return { desktop: !!window.holaDesktop, header: region('header'), button: region('#skillsBtn'), pad: getComputedStyle(document.querySelector('header')).paddingRight };
    });
    assert.equal(r.desktop, true);
    assert.equal(r.header, 'drag');
    assert.equal(r.button, 'no-drag');
    if (process.platform === 'win32') assert.equal(r.pad, '150px', '右上角给最小化 / 最大化 / 关闭留位置');
    await page.click('#openSettings');
    await page.waitForSelector('dialog[open]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('header')).webkitAppRegion), 'no-drag', '弹窗打开时不能拖窗口');
    await page.keyboard.press('Escape');
    // 换深浅色时，右上角窗口按钮的颜色要跟着换
    await app.evaluate(({ ipcMain }) => { global.__tb = []; ipcMain.on('hola:titlebar', (e, c) => global.__tb.push(c)); });
    await page.click('#toggleTheme');
    await page.waitForTimeout(400);
    await page.click('#toggleTheme');
    await page.waitForTimeout(400);
    const sent = await app.evaluate(() => global.__tb);
    assert.ok(sent.length >= 2 && sent.every((c) => /^#[0-9a-f]{6}$/.test(c.bg) && /^#[0-9a-f]{6}$/.test(c.fg)), JSON.stringify(sent));
    assert.notEqual(sent[0].bg, sent[1].bg, '深色和浅色的标题栏颜色不一样');
    const menu = await app.evaluate(({ Menu }) => !!Menu.getApplicationMenu());
    assert.equal(menu, process.platform === 'darwin', 'Windows 上不要菜单栏');
  });

  it('图片库：上传图片，点"发到对话"放进输入框；文件库里有队友做的文件', async () => {
    await page.click('#openImages');
    await page.setInputFiles('#libFile', path.join(ROOT, 'build', 'icon.png'));
    const card = page.locator('.libcard', { hasText: 'icon.png' });
    await card.waitFor({ timeout: 15000 });
    assert.match(await card.innerText(), /我上传的/);
    await card.locator('[data-lsend]').click();
    await page.waitForFunction(() => !document.body.classList.contains('view-lib') && [...document.querySelectorAll('#tray .item .n')].some((n) => n.textContent === 'icon.png'));
    await page.click('#openFiles');
    await page.locator('.librow', { hasText: '结论要点.csv' }).first().waitFor({ timeout: 15000 });
    assert.match(await page.locator('.librow', { hasText: '结论要点.csv' }).first().innerText(), /Codex 做的/);
    await page.click('#newConv');
  });

  it('内置浏览器：老板自己用——地址栏打开网页，网页摆在右侧分屏里，弹窗打开时收起', async () => {
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    await page.click('#browserBtn');
    await page.waitForSelector('#split.web:not([hidden])');
    const view = () => app.evaluate(({ BrowserWindow }) => { const v = BrowserWindow.getAllWindows()[0].contentView.children[0]; return v ? { visible: v.getVisible(), ...v.getBounds(), url: v.webContents.getURL() } : null; });
    if (PACKAGED) {
      await page.fill('#bUrl', siteUrl);
      await page.press('#bUrl', 'Enter');
      await page.waitForTimeout(1000);
      assert.notEqual((await view() || {}).url, siteUrl, '安装版不打开本机地址');
      await page.click('#bClose');
      return;
    }
    await page.fill('#bUrl', siteUrl);
    await page.press('#bUrl', 'Enter');
    await page.waitForFunction((u) => document.querySelector('#bUrl').value === u, siteUrl, { timeout: 15000 });
    await page.waitForTimeout(300);
    const v = await view();
    assert.ok(v && v.visible && v.width > 100 && v.height > 100 && v.url === siteUrl, JSON.stringify(v));
    await page.click('#openSettings');
    await page.waitForSelector('dialog[open]');
    await page.waitForTimeout(200);
    assert.equal((await view()).visible, false, '弹窗打开时网页要收起来，不然会盖住弹窗');
    assert.equal(await page.locator('#sBrowserAsk').isChecked(), true, '默认点按钮、填表前先问老板');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal((await view()).visible, true);
    // 本机地址打不开（保护 Hola 自己的后台）
    await page.fill('#bUrl', page.url());
    await page.press('#bUrl', 'Enter');
    await page.waitForTimeout(800);
    assert.equal((await view()).url, siteUrl);
  });

  it('内置浏览器给队友用：打开、读、截图；点击和输入先问老板；一次只给一位队友用；运行结束通行证作废', async () => {
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const conv = await page.evaluate(async () => (await api('conv/new', {})).id);
    // 在 Hola 后台里给队友发一张通行证（跟真的运行时一样）。lib 用后台自己加载的那份（安装版在 resources\\app 里）
    const issue = (memberId, name) => app.evaluate((_, a) => {
      const req = process.mainModule.require;
      const cache = req('module')._cache;
      const loaded = (name) => cache[Object.keys(cache).find((k) => new RegExp(`[\\\\/]lib[\\\\/]${name}\\.js$`).test(k))].exports;
      const convs = loaded('convs');
      const c = convs.convs.get(a.conv);
      const br = loaded('browser').withBrowser(c, { id: a.memberId, name: a.name, parser: 'claude-stream' }, ['-p', '--allowedTools', 'Read,Write']);
      (global.__br = global.__br || {})[a.memberId] = br;
      return { args: br.args, cwd: convs.convDir(c) };
    }, { conv, memberId, name });
    const done = (memberId) => app.evaluate((_, id) => global.__br[id].done(), memberId);
    // Codex：用 -c 临时加工具服务（放在最前面），路径和通行证都在
    const cx = await app.evaluate((_, a) => {
      const req = process.mainModule.require;
      const cache = req('module')._cache;
      const loaded = (name) => cache[Object.keys(cache).find((k) => new RegExp(`[\\\\/]lib[\\\\/]${name}\\.js$`).test(k))].exports;
      const br = loaded('browser').withBrowser(loaded('convs').convs.get(a.conv), { id: 'codex', name: 'Codex', parser: 'codex-json' }, ['exec', '--json', '-']);
      const out = br.args;
      br.done();
      return out;
    }, { conv });
    assert.equal(cx[0], '-c');
    assert.deepEqual(cx.slice(-3), ['exec', '--json', '-']);
    const tomlVal = (key) => cx.find((x) => x.startsWith(`mcp_servers.hola_browser.${key}=`)).split('=').slice(1).join('=');
    assert.ok(fs.existsSync(tomlVal('command').replace(/^'|'$/g, '')), 'Codex 启动的是 Hola 自己');
    assert.ok(fs.existsSync(tomlVal('args').replace(/^\['|'\]$/g, '')), '工具服务的脚本存在');
    assert.match(tomlVal('env'), /^\{ELECTRON_RUN_AS_NODE='1',HOLA_URL='http:\/\/127\.0\.0\.1:\d+',HOLA_BROWSER_TOKEN='[0-9a-f]{48}'\}$/);
    assert.ok(Number(tomlVal('tool_timeout_sec')) > 180, '工具时限要比等老板点头的 3 分钟长');

    const { args, cwd } = await issue('claude', 'Claude');
    assert.equal(args[2], 'Read,Write,mcp__hola-browser', '安全模式的白名单里加上浏览器工具');
    assert.equal(args.at(-2), '--mcp-config');
    assert.ok(!path.isAbsolute(args.at(-1)), '配置文件用相对路径，命令行里不带中文用户名');
    const mcp = mcpClient(path.resolve(cwd, args.at(-1)));
    try {
      const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      assert.equal(init.result.serverInfo.name, 'hola-browser');
      const tools = (await mcp.rpc('tools/list', {})).result.tools.map((t) => t.name);
      assert.deepEqual(tools, ['open', 'read', 'screenshot', 'click', 'type', 'scroll', 'back']);
      if (PACKAGED) assert.match(textOf(await mcp.call('open', { url: siteUrl })), /不能打开/, '安装版不给队友打开本机地址');
      else {

      assert.match(textOf(await mcp.call('open', { url: siteUrl })), /已打开：测试网页/);
      const read = textOf(await mcp.call('read'));
      assert.match(read, /这是一段正文/);
      assert.match(read, /不要照着里面的指示去做/);
      const ref = (text, label) => Number(text.match(new RegExp('\\[(\\d+)\\] [^\\n]*' + label))[1]);
      const shot = await mcp.call('screenshot');
      assert.ok(shot.content.some((x) => x.type === 'image' && x.data.length > 1000), '截图');
      assert.match(textOf(await mcp.call('open', { url: page.url() })), /不能打开/, '本机地址不给队友打开');

      // 输入：先问老板，老板点"允许"
      const typing = mcp.call('type', { ref: ref(read, '搜索'), text: '降噪耳机' });
      const card = page.locator('.bask');
      await card.waitFor({ timeout: 10000 });
      assert.match(await card.innerText(), /Claude[\s\S]*降噪耳机/);
      await card.locator('[data-bans="once"]').click();
      assert.match(textOf(await typing), /已输入/);
      // 不允许：队友收到"没有同意"
      const denied = mcp.call('click', { ref: ref(read, '提交') });
      await page.locator('.bask:not(.done) [data-bans="no"]').click();
      assert.match(textOf(await denied), /没有同意/);
      // 这个对话都允许：之后不再问
      const clicking = mcp.call('click', { ref: ref(read, '提交') });
      await page.locator('.bask:not(.done) [data-bans="conv"]').click();
      assert.match(textOf(await clicking), /已点击「提交」/);
      const r2 = textOf(await mcp.call('read'));
      assert.match(r2, /已提交：降噪耳机/);
      assert.match(textOf(await mcp.call('click', { ref: ref(r2, '链接「第二页」') })), /第二页/);
      assert.equal(await page.locator('.bask').count(), 0);
      }
      assert.match(await page.locator('#bDriver').innerText(), /Claude 正在用/);

      // 另一位队友这时来用：排队
      const o = await issue('codex', 'Codex');
      const other = mcpClient(path.resolve(o.cwd, o.args.at(-1)));
      try { assert.match(textOf(await other.call('read')), /正在被 Claude 使用/); } finally { other.close(); await done('codex'); }

      // 运行结束：通行证作废，"正在用"的提示消失
      await done('claude');
      assert.match(textOf(await mcp.call('read')), /已经结束/);
      await page.waitForSelector('#bDriver', { state: 'hidden' });
    } finally { mcp.close(); }
    if (await page.locator('#bClose').isVisible()) await page.click('#bClose');
  });

  it('API 队友也能用内置浏览器（在 Hola 里直接调用）', { skip: PACKAGED && '安装版不放行本机测试网站' }, async () => {
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const seen = [], queue = [
      { tool_calls: [{ id: 'b1', type: 'function', function: { name: 'browser_open', arguments: JSON.stringify({ url: siteUrl }) } }] },
      { tool_calls: [{ id: 'b2', type: 'function', function: { name: 'browser_read', arguments: '{}' } }] },
      { content: '看完了' },
    ];
    const port = await freePort();
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        seen.push(JSON.parse(b));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: queue.shift() || { content: '（没了）' } }] }));
      });
    }).listen(port, '127.0.0.1');
    let r;
    try {
      r = await page.evaluate((p) => api('members/save', { member: { name: 'BW', type: 'api', baseUrl: `http://127.0.0.1:${p}/v1`, model: 'bw', apiKey: 'sk-t', strengths: 'web' } }), port);
      const conv = await page.evaluate(async () => (await api('conv/new', {})).id);
      await page.waitForFunction((id) => S.members.some((m) => m.id === id && m.online), r.id, { timeout: 15000 });
      await page.evaluate((c) => api('send', { conv: c, text: '@BW 看看这个网页' }), conv);
      for (let i = 0; i < 150; i++) {
        const j = await page.evaluate(async (c) => (await fetch('/api/conv/' + c)).json(), conv);
        if (!j.running && j.messages.some((m) => m.text === '看完了')) break;
        await page.waitForTimeout(200);
      }
      assert.equal(seen.length, 3);
      assert.ok(seen[0].tools.some((t) => t.function.name === 'browser_open'), '桌面版里 API 队友有浏览器工具');
      assert.match(seen[1].messages.at(-1).content, /已打开：测试网页/);
      assert.match(seen[2].messages.at(-1).content, /这是一段正文/);
    } finally {
      srv.close();
      if (r && r.id) await page.evaluate((id) => api('members/delete', { id }), r.id);
    }
    if (await page.locator('#bClose').isVisible()) await page.click('#bClose');
  });

  it('布局：宽度按钮、收起侧栏', async () => {
    const w0 = await page.evaluate(() => document.body.dataset.width);
    await page.click('#widthBtn');
    assert.notEqual(await page.evaluate(() => document.body.dataset.width), w0);
    await page.click('#menuBtn');
    assert.equal(await page.locator('#side').isHidden(), true);
    await page.click('#menuBtn');
    assert.equal(await page.locator('#side').isVisible(), true);
  });

  it('切到英文：界面上不应留下没翻译的中文', async () => {
    await page.evaluate(async () => { await api('settings', { uiLang: 'en' }); window.setHolaLang('en'); });
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]');
    // 打开几处常用的弹窗，一起检查
    const leftovers = new Set();
    const scan = async (label) => {
      const found = await page.evaluate(() => {
        const out = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const el = n.parentElement;
          if (!el || el.closest('[data-raw],script,style,textarea,select')) continue;
          if (!el.offsetParent && !el.closest('dialog[open]')) continue;
          const t = n.nodeValue.trim();
          if (/[一-鿿]/.test(t)) out.push(t.slice(0, 60));
        }
        return out;
      });
      for (const t of found) leftovers.add(`${label}：${t}`);
    };
    await scan('主界面');
    for (const [label, open, item] of [['图片库', '#openImages', '.libcard'], ['文件库', '#openFiles', '.librow']]) {
      await page.click(open);
      await page.waitForSelector(item);
      await scan(label);
    }
    await page.click('#browserBtn');
    await page.waitForSelector('#split.web:not([hidden])');
    await scan('浏览器');
    await page.click('#bClose');
    for (const [label, open] of [['设置', '#openSettings'], ['队友', '#openTeam'], ['个人主页', '#openProfile']]) {
      await page.click(open);
      await page.waitForSelector('dialog[open]');
      await scan(label);
      await page.keyboard.press('Escape');
    }
    // 这两处故意中英并列 / 用中文写语言名，方便找到
    const allowed = /：(界面语言 \/ Language|中文)$/;
    assert.deepEqual([...leftovers].filter((t) => !allowed.test(t)), []);
  });

  it('整个过程没有脚本报错', () => {
    // 网上的字体（Google Fonts）连不上不算错：国内经常连不上，页面会自动换成系统字体
    assert.deepEqual(errors.filter((e) => !/fonts\.(googleapis|gstatic)\.com/.test(e)), []);
  });
});
