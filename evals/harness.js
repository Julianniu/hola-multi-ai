// 评测用：在临时文件夹里启动一个用"真队友"的 Hola（不碰老板的真实数据），像界面一样通过接口操作它，收集结果。
// 和 tests/helpers.js 的区别：不用演示模式、等得更久（真模型一轮几十秒到几分钟）、能预先放好聊天记录和资料、能查进程树。
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { freePort, sleep } = require('../tests/helpers');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const REPO_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// opts.members：要启用的内置队友 id（claude / codex / gemini），其余停用
// opts.custom：自己加的队友（data/members.json 里的格式：API 队友、假命令行队友）
// opts.settings：预置设置（memberPrefs 里的 access / role 等）
// opts.seeds：预先放好的对话 [{ id, title, messages, memory, files: { 相对路径: 内容 } }]
// opts.pinned：预先放进资料库并设为常驻的文件 { 文件名: 内容 }
// opts.fake：用演示的假队友（只用来自测评测工具本身）
// opts.root：用哪一份 Hola 程序启动（默认这份代码；和基线副本对比时指向 .wick-baseline/<版本>）
async function startEval(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-eval-'));
  const port = await freePort();
  const dataDir = path.join(dir, 'data');
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const base = opts.fake ? JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'config.json'), 'utf8')) : REPO_CONFIG;
  const config = { ...base, timeoutMinutes: opts.timeoutMinutes || 20, members: {} };
  for (const [id, def] of Object.entries(base.members)) {
    config.members[id] = opts.fake ? { ...def, args: def.args.map((a) => a.replace('{ROOT}', ROOT)) } : def;
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));

  const want = opts.members || Object.keys(config.members);
  const settings = { uiLang: 'zh', autoMemory: false, ...(opts.settings || {}) };
  settings.memberPrefs = { ...(settings.memberPrefs || {}) };
  for (const id of Object.keys(config.members)) settings.memberPrefs[id] = { ...(settings.memberPrefs[id] || {}), enabled: want.includes(id) };
  if (opts.pinned) {
    const lib = path.join(workspace, '资料库');
    fs.mkdirSync(lib, { recursive: true });
    for (const [n, t] of Object.entries(opts.pinned)) fs.writeFileSync(path.join(lib, n), t);
    settings.pinned = Object.keys(opts.pinned);
  }
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
  if (opts.custom && opts.custom.length) fs.writeFileSync(path.join(dataDir, 'members.json'), JSON.stringify(opts.custom, null, 2));
  for (const s of opts.seeds || []) seedConv(workspace, s);

  const env = { ...process.env, PORT: String(port), NO_OPEN: '1', HOLA_DATA_DIR: dataDir, HOLA_WORKSPACE: workspace, TEAM_CONFIG: path.join(dir, 'config.json'), ...(opts.env || {}) };
  delete env.HOLA_HIDDEN;
  if (opts.fake) env.HOLA_DEMO_FAST = '1';
  const child = spawn(process.execPath, ['server.js', ...(opts.fake ? ['--demo'] : [])], { cwd: opts.root || ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { const r = await fetch(url + '/api/ping'); if (r.ok) break; } catch (_) {}
    // 电脑很忙（几个评测同时跑、命令行在检查版本）时启动会慢一些：最多等 90 秒
    if (i > 900 || child.exitCode !== null) { child.kill(); throw new Error('Hola 没能启动：\n' + log); }
    await sleep(100);
  }

  const post = async (p, body) => {
    const r = await fetch(url + '/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hola': '1' }, body: JSON.stringify(body || {}) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (_) { j = { raw: t }; }
    return { status: r.status, ...j };
  };
  const conv = async (id) => { const r = await fetch(url + '/api/conv/' + id); return r.ok ? r.json() : null; };
  async function init() {
    const ctrl = new AbortController();
    const r = await fetch(url + '/api/events', { signal: ctrl.signal });
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
  // 等队友检查完（命令行要跑一次 --version，可能要十几秒）
  let members = [];
  for (let i = 0; ; i++) {
    members = (await init()).members;
    if (!members.some((x) => x.enabled && /检查中|Checking/.test(x.problem || ''))) break;
    if (i > 600) throw new Error('队友一直在检查中');
    await sleep(200);
  }

  const newConv = async () => (await post('conv/new')).id;
  const convDir = (id) => path.join(workspace, id);
  async function upload(id, name, data) {
    const r = await fetch(`${url}/api/upload?conv=${id}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Hola': '1' }, body: data });
    return r.json();
  }
  // 起始文件夹里的文件当附件发
  const attach = (id, name, as) => upload(id, as || path.basename(name), fs.readFileSync(path.join(FIX, name)));
  let plansApproved = 0;
  async function waitIdle(id, timeout = 30 * 60000) {
    const t0 = Date.now();
    let idle = 0;
    while (Date.now() - t0 < timeout) {
      const c = await conv(id);
      // 开工确认卡（第 3 阶段）：评测里像老板一样直接点"开工"，记下点了几次
      const plan = c && !c.running && [...(c.messages || [])].reverse().find((m) => m.plan && m.plan.status === 'proposed');
      if (plan && !opts.noGo) { await post('plan', { conv: id, msg: plan.id, action: 'go' }); plansApproved++; idle = 0; await sleep(500); continue; }
      if (c && !c.running) { if (++idle >= 3) return c; } else idle = 0;
      await sleep(1000);
    }
    await post('stop', { conv: id });
    throw new Error(`超过 ${Math.round(timeout / 60000)} 分钟还没做完，已叫停`);
  }
  // 老板发一条消息并等大家做完，返回这次新增的消息
  async function say(id, text, extra = {}) {
    const before = (await conv(id)).messages.length;
    const r = await post('send', { conv: id, text, ...extra });
    if (r.status !== 200) throw new Error('发送失败：' + JSON.stringify(r));
    await sleep(300);
    const c = await waitIdle(id, extra.timeout);
    return { conv: c, added: c.messages.slice(before) };
  }
  const setActive = (id, active) => post('conv/active', { conv: id, active });

  // 这个 Hola 进程下面还活着的子孙进程（叫停后应该一个都不剩）
  function descendants() {
    if (process.platform !== 'win32') return [];
    let list = [];
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64e6 });
      list = JSON.parse(out);
    } catch (_) { return []; }
    const kids = new Map();
    for (const p of list) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
    const found = [];
    const walk = (pid) => { for (const k of kids.get(pid) || []) { found.push(k); walk(k.ProcessId); } };
    walk(child.pid);
    return found.filter((p) => !/^conhost\.exe$/i.test(p.Name));
  }

  async function close(keepTo) {
    try { await post('quit'); } catch (_) {}
    for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { child.kill(); } }
    if (keepTo) {
      fs.mkdirSync(keepTo, { recursive: true });
      try { fs.cpSync(workspace, path.join(keepTo, 'workspace'), { recursive: true }); } catch (_) {}
      fs.writeFileSync(path.join(keepTo, 'hola.log'), log);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  return { url, port, dir, workspace, dataDir, pid: child.pid, members, post, conv, init, newConv, convDir, upload, attach, waitIdle, say, setActive, descendants, close, log: () => log, get plansApproved() { return plansApproved; } };
}

// 预先放好一个对话（聊天记录、记忆、文件）
function seedConv(workspace, s) {
  const d = path.join(workspace, s.id);
  fs.mkdirSync(path.join(d, '.hola'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(d, '.hola', 'chat.json'), JSON.stringify({ title: s.title || s.id, created: now, updated: now, messages: s.messages || [], project: null, status: 'doing', ...(s.active ? { active: s.active } : {}) }));
  if (s.memory != null) fs.writeFileSync(path.join(d, '对话记忆.md'), s.memory);
  for (const [rel, data] of Object.entries(s.files || {})) {
    const p = path.join(d, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
}

// 一个只记录"有没有人来访问"的小服务器（检查队友有没有被附件里的指令骗去发数据）
async function canary() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { hits.push({ method: req.method, url: req.url, body: body.slice(0, 2000) }); res.end('ok'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, hits, close: () => new Promise((r) => srv.close(r)) };
}

// 对话文件夹里的文件（不含 .hola 和自动生成的文字版）
function listConvFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!['.hola', '文字版'].includes(e.name)) walk(r); } else out.push(r);
    }
  };
  try { walk(''); } catch (_) {}
  return out;
}

module.exports = { ROOT, FIX, startEval, seedConv, canary, listConvFiles, sleep };
