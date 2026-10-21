// 自动测试的公用工具：在临时文件夹里启动一个 Hola（演示模式，假队友秒回），像用户一样通过接口操作它，测完删掉。
// 只用 Node 自带的东西，不需要安装任何依赖。运行全部测试：node --test tests/
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { makeZip } = require('../tools/zip');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// opts.root：从哪份 Hola 启动（默认就是这份代码）；opts.config：自定义队友配置；opts.settings：预置设置；opts.env：额外环境变量
async function startHola(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-test-'));
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), NO_OPEN: '1', HOLA_DEMO_FAST: '1',
    HOLA_DATA_DIR: path.join(dir, 'data'), HOLA_WORKSPACE: path.join(dir, 'workspace'), ...(opts.env || {}),
  };
  delete env.HOLA_HIDDEN;
  delete env.TEAM_CONFIG;
  fs.mkdirSync(env.HOLA_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.HOLA_DATA_DIR, 'settings.json'), JSON.stringify({ uiLang: 'zh', ...(opts.settings || {}) }));
  if (opts.config) {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify(opts.config));
    env.TEAM_CONFIG = f;
  }
  const child = spawn(process.execPath, ['server.js', '--demo'], { cwd: opts.root || ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { const r = await fetch(base + '/api/ping'); if (r.ok) break; } catch (_) {}
    if (i > 150 || child.exitCode !== null) { child.kill(); throw new Error('Hola 没能启动：\n' + log); }
    await sleep(100);
  }

  const post = async (p, body, headers = {}) => {
    const r = await fetch(base + '/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hola': '1', ...headers }, body: JSON.stringify(body || {}) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (_) { j = { raw: t }; }
    return { status: r.status, ...j };
  };
  const conv = async (id) => { const r = await fetch(base + '/api/conv/' + id); return r.ok ? r.json() : { status: r.status }; };
  const newConv = async (project) => (await post('conv/new', project ? { project } : {})).id;
  // 等这个对话里所有人都干完（连续几次查到"没在跑"才算）
  async function waitIdle(id, timeout = 60000) {
    const t0 = Date.now();
    let idle = 0;
    while (Date.now() - t0 < timeout) {
      const c = await conv(id);
      if (!c.running) { if (++idle >= 3) return c; } else idle = 0;
      await sleep(80);
    }
    throw new Error('等太久了，对话还没结束：' + id + '\n' + log.slice(-2000));
  }
  // 发一条消息并等大家做完，返回这次新增的消息
  async function ask(id, text) {
    const before = (await conv(id)).messages.length;
    const r = await post('send', { conv: id, text });
    if (r.status !== 200) throw new Error('发送失败：' + JSON.stringify(r));
    const c = await waitIdle(id);
    return { conv: c, added: c.messages.slice(before) };
  }
  // 页面一打开收到的第一条推送（队友、设置、版本标识等）
  async function init() {
    const ctrl = new AbortController();
    const r = await fetch(base + '/api/events', { signal: ctrl.signal });
    const reader = r.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      const i = buf.indexOf('\n\n');
      if (i >= 0) { ctrl.abort(); return JSON.parse(buf.slice(0, i).replace(/^data: /, '')); }
    }
    throw new Error('没收到 init');
  }
  async function upload(id, name, data) {
    const r = await fetch(`${base}/api/upload?conv=${id}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Hola': '1' }, body: data });
    return r.json();
  }
  // 刚启动时队友还在"检查中"，等检查完再开始测
  for (let i = 0; ; i++) {
    const m = (await init()).members;
    if (!m.some((x) => x.enabled && /检查中|Checking/.test(x.problem || ''))) break;
    if (i > 100) throw new Error('队友一直在检查中：' + JSON.stringify(m.map((x) => x.problem)));
    await sleep(100);
  }
  async function stop() {
    if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { base, port, dir, workspace: env.HOLA_WORKSPACE, dataDir: env.HOLA_DATA_DIR, post, conv, newConv, waitIdle, ask, init, upload, stop, log: () => log };
}

// Word 测试文件：zip 里装 XML（zip 打包用 tools/zip.js）
function makeDocx(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

module.exports = { ROOT, sleep, startHola, makeZip, makeDocx, freePort };
