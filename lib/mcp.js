// Hola · 外部工具连接（MCP）：老板在设置 → 连接里接上任意 MCP 服务（钉钉、飞书、数据库、公司内部系统……），
// 队友干活时就能用。服务只由 Hola 自己连（本机命令或远程网址），队友拿到的是 Hola 转过去的工具：
// 命令行队友（Claude / Codex）通过 tools/hola-mcp-proxy.js，API 队友在 Hola 里直接调用。
// 这样不管哪位队友用，发消息、改数据之前都能先问老板，也都记在进度里。
// 连接信息（含密钥）存在 data/mcp.json，不发给页面：页面只看到名字和"已填"。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, IS_WIN, PORT, ROOT, T, broadcast, wick } = require('./core');
const { cleanEnv, killTree, resolveCmd, spawnMember } = require('./members');
const { convDir } = require('./convs');
const { approve, dropAsks } = require('./browser');

const FILE = path.join(DATA_DIR, 'mcp.json');
const VERSION = '2025-06-18';
const CALL_MS = 120000;
const IDLE_MS = 10 * 60 * 1000; // 本机服务 10 分钟没人用就关掉，下次用再开

let store = { servers: [] };
try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!Array.isArray(store.servers)) store.servers = []; } catch (_) {}
function save() { fs.writeFileSync(FILE, JSON.stringify(store, null, 2)); }

const SLUG = /[^a-z0-9_]+/g;
const slug = (s) => String(s || '').toLowerCase().replace(SLUG, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'mcp';

// 常用服务的模板：设置页"添加"里直接选，填几个空就能用
const presets = () => [
  { key: 'dingtalk', name: T('钉钉', 'DingTalk'), kind: 'stdio', command: 'npx', args: ['-y', 'dingtalk-mcp@latest'],
    env: { DINGTALK_Client_ID: '', DINGTALK_Client_Secret: '', ACTIVE_PROFILES: 'dingtalk-contacts,dingtalk-robot-send-message,dingtalk-tasks,dingtalk-calendar', ROBOT_CODE: '', DINGTALK_AGENT_ID: '' },
    secret: ['DINGTALK_Client_Secret'],
    help: T('在钉钉开放平台建一个企业内部应用，"凭证与基础信息"里有 Client ID 和 Client Secret；ACTIVE_PROFILES 选要开的功能（通讯录、机器人发消息、待办、日程……，写 ALL 全开），每项都要在应用里加对应权限。发消息要填 ROBOT_CODE，发工作通知要填 DINGTALK_AGENT_ID。需要电脑装有 Node.js。',
      'Create an internal app on the DingTalk open platform; its Client ID and Client Secret are under "Credentials". ACTIVE_PROFILES picks the features (contacts, robot messages, tasks, calendar…, ALL for everything); each needs the matching permission in the app. Sending messages needs ROBOT_CODE, work notifications need DINGTALK_AGENT_ID. Needs Node.js on this PC.'),
    link: 'https://open.dingtalk.com/document/ai-dev/dingtalk-server-api-mcp-overview' },
  { key: 'remote', name: T('远程 MCP（网址）', 'Remote MCP (URL)'), kind: 'http', url: '', headers: { Authorization: '' }, secret: ['Authorization'],
    help: T('服务商给的 MCP 网址（一般以 /mcp 结尾）；需要密钥时填在 Authorization，比如 "Bearer 你的密钥"。', 'The MCP URL your provider gives you (usually ends in /mcp); put a key in Authorization, e.g. "Bearer your-key".') },
  { key: 'local', name: T('本机命令', 'Local command'), kind: 'stdio', command: 'npx', args: [], env: {},
    help: T('按服务说明填命令和参数，比如 npx -y 某个包名。', 'Fill in the command and arguments from the server\'s docs, e.g. npx -y some-package.') },
];

// ---------------------------------------------------------------- 给页面看的样子（不含密钥）

const isSecretKey = (k) => /secret|token|key|password|passwd|authorization|cookie/i.test(k);
const hint = (v) => (v ? '••••' + String(v).slice(-4) : '');
function publicServer(s) {
  const mask = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, isSecretKey(k) ? { set: !!v, hint: hint(v) } : v]));
  return {
    id: s.id, name: s.name, kind: s.kind, preset: s.preset || '', on: s.on !== false, who: s.who || 'all', ask: s.ask || 'write',
    command: s.command || '', args: s.args || [], url: s.url || '', env: mask(s.env), headers: mask(s.headers),
    tools: (s.tools || []).map((t) => ({ name: t.name, description: t.description || '', write: !!t.write, off: !!t.off })),
    toolsAt: s.toolsAt || 0, error: s.error || '', state: conns.has(s.id) ? 'running' : 'idle',
  };
}
const publicMcp = () => ({ servers: store.servers.map(publicServer), presets: presets().map(({ key, name, kind, command, args, url, env, headers, help, link }) => ({ key, name, kind, command, args, url, env, headers, help, link })) });
function broadcastMcp() { broadcast({ type: 'mcp', mcp: publicMcp() }); }

// 保存：密钥字段留空 = 保持原来的值（页面拿不到原值）
function saveServer(input) {
  const prev = store.servers.find((s) => s.id === input.id);
  const keep = (o, old) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v && typeof v === 'object' ? (old || {})[k] || '' : String(v == null ? '' : v)]));
  const s = {
    id: prev ? prev.id : (slug(['local', 'remote', ''].includes(input.preset || '') ? input.name : input.preset) + '_' + crypto.randomBytes(2).toString('hex')),
    name: String(input.name || '').trim().slice(0, 40) || 'MCP',
    preset: String(input.preset || (prev && prev.preset) || ''),
    kind: input.kind === 'http' ? 'http' : 'stdio',
    command: String(input.command || '').trim(), args: Array.isArray(input.args) ? input.args.map(String) : [],
    url: String(input.url || '').trim(),
    env: keep(input.env, prev && prev.env), headers: keep(input.headers, prev && prev.headers),
    on: input.on !== false, who: Array.isArray(input.who) ? input.who.map(String) : 'all',
    ask: ['write', 'always', 'never'].includes(input.ask) ? input.ask : 'write',
  };
  if (s.kind === 'http' && !/^https?:\/\//i.test(s.url)) throw new Error(T('网址要以 http:// 或 https:// 开头', 'The URL must start with http:// or https://'));
  if (s.kind === 'stdio' && !s.command) throw new Error(T('请填写命令', 'Please fill in the command'));
  const same = prev && JSON.stringify([prev.kind, prev.command, prev.args, prev.url, prev.env, prev.headers]) === JSON.stringify([s.kind, s.command, s.args, s.url, s.env, s.headers]);
  if (same) { s.tools = prev.tools; s.toolsAt = prev.toolsAt; s.error = prev.error; }
  else if (prev && prev.tools) s.tools = prev.tools.map((t) => ({ ...t })), s.toolsAt = 0;
  if (prev) Object.assign(prev, s); else store.servers.push(s);
  if (!same) close(s.id);
  save();
  broadcastMcp();
  return s;
}
function removeServer(id) {
  close(id);
  store.servers = store.servers.filter((s) => s.id !== id);
  save();
  broadcastMcp();
}
function setTool(id, tool, patch) {
  const s = store.servers.find((x) => x.id === id);
  const t = s && (s.tools || []).find((x) => x.name === tool);
  if (!t) return false;
  if ('off' in patch) t.off = !!patch.off;
  if ('write' in patch) t.write = !!patch.write, t.writeSet = true;
  save();
  broadcastMcp();
  return true;
}

// 从 Claude 桌面版 / Cursor / 粘贴的配置里导入（{ mcpServers: { 名字: { command, args, env } 或 { url, headers } } }）
function parseImport(text) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { throw new Error(T('不是有效的 JSON', 'Not valid JSON')); }
  const list = (j && (j.mcpServers || j.servers || (j.mcp && j.mcp.servers))) || j;
  if (!list || typeof list !== 'object') return [];
  return Object.entries(list).filter(([, v]) => v && typeof v === 'object' && (v.command || v.url || v.serverUrl)).map(([name, v]) => (v.command
    ? { name, kind: 'stdio', command: String(v.command), args: (v.args || []).map(String), env: v.env || {} }
    : { name, kind: 'http', url: String(v.url || v.serverUrl), headers: v.headers || {} }));
}
function importCandidates() {
  const home = require('os').homedir();
  const files = [
    ['Claude', IS_WIN ? path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json') : path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
    ['Cursor', path.join(home, '.cursor', 'mcp.json')],
    ['Claude Code', path.join(home, '.claude.json')],
  ];
  const out = [];
  for (const [from, f] of files) {
    try { for (const s of parseImport(fs.readFileSync(f, 'utf8'))) out.push({ ...s, from }); } catch (_) {}
  }
  const have = new Set(store.servers.map((s) => s.name));
  return out.filter((s) => !have.has(s.name)).map((s) => ({ ...s, env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, isSecretKey(k) ? { set: !!v, hint: hint(v) } : v])), headers: Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, { set: !!v, hint: hint(v) }])) }));
}
// 导入时密钥要从原文件里取（页面只看到"已填"）
function importServers(names) {
  const home = require('os').homedir();
  const all = [];
  for (const f of [IS_WIN ? path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json') : path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), path.join(home, '.cursor', 'mcp.json'), path.join(home, '.claude.json')]) {
    try { all.push(...parseImport(fs.readFileSync(f, 'utf8'))); } catch (_) {}
  }
  const added = [];
  for (const n of names || []) { const s = all.find((x) => x.name === n); if (s && !store.servers.some((x) => x.name === n)) added.push(saveServer(s)); }
  return added;
}

// ---------------------------------------------------------------- 连接（本机命令走标准输入输出，网址走 Streamable HTTP）

const conns = new Map(); // id → Conn

class Conn {
  constructor(s) { this.s = s; this.seq = 0; this.wait = new Map(); this.child = null; this.session = ''; this.used = Date.now(); this.err = ''; }
  async start() {
    if (this.s.kind === 'http') return this.init();
    let cmd = this.s.command, env = { ...cleanEnv(), ...(this.s.env || {}) };
    // 命令是 node 但电脑上没装：桌面版用 Hola 自己（Electron 当 Node 跑）
    let r = await resolveCmd(cmd);
    if (!r && cmd === 'node') { r = { file: process.execPath, shell: false }; env.ELECTRON_RUN_AS_NODE = '1'; }
    if (!r) throw new Error(/^(npx|node|npm)$/.test(cmd) ? T(`找不到 ${cmd}：这个服务需要电脑装有 Node.js（nodejs.org 下载，装完重启 Hola）。`, `${cmd} not found: this server needs Node.js on this PC (download from nodejs.org, then restart Hola).`) : T(`找不到命令 ${cmd}`, `Command not found: ${cmd}`));
    const child = spawnMember({ resolved: r }, this.s.args || [], { cwd: DATA_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this.onMsg(line); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { this.err = (this.err + d).slice(-2000); });
    child.on('error', (e) => this.fail(e.message));
    child.on('exit', (code) => this.fail(T(`服务退出了（代码 ${code}）`, `The server exited (code ${code})`) + (this.err ? '：' + this.err.trim().split('\n').slice(-3).join(' ') : '')));
    return this.init();
  }
  onMsg(line) {
    let m;
    try { m = JSON.parse(line); } catch (_) { return; }
    if (m.id !== undefined && this.wait.has(m.id)) { const w = this.wait.get(m.id); this.wait.delete(m.id); clearTimeout(w.timer); m.error ? w.no(new Error(m.error.message || 'MCP error')) : w.ok(m.result); }
    else if (m.method && m.id !== undefined) this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } }); // 服务反过来问（采样等）：不支持
  }
  fail(why) {
    for (const w of this.wait.values()) { clearTimeout(w.timer); w.no(new Error(why)); }
    this.wait.clear();
    if (conns.get(this.s.id) === this) conns.delete(this.s.id);
  }
  write(o) { if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(o) + '\n'); }
  async post(o) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': VERSION, ...(this.s.headers || {}) };
    for (const k of Object.keys(h)) if (!h[k]) delete h[k];
    if (this.session) h['Mcp-Session-Id'] = this.session;
    const r = await fetch(this.s.url, { method: 'POST', headers: h, body: JSON.stringify(o), signal: AbortSignal.timeout(CALL_MS) });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (o.id === undefined) return null;
    if (r.status === 401 || r.status === 403) throw new Error(T(`服务拒绝了（HTTP ${r.status}）：密钥不对或没有权限`, `Refused (HTTP ${r.status}): wrong key or no permission`));
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const body = await r.text();
    let msg = null;
    if (/text\/event-stream/i.test(r.headers.get('content-type') || '')) {
      for (const ev of body.split(/\r?\n\r?\n/)) {
        const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === o.id) msg = m; } catch (_) {}
      }
    } else { try { msg = JSON.parse(body); } catch (_) {} }
    if (Array.isArray(msg)) msg = msg.find((m) => m.id === o.id);
    if (!msg) throw new Error(T('服务的回答看不懂', 'Could not read the server\'s answer'));
    if (msg.error) throw new Error(msg.error.message || 'MCP error');
    return msg.result;
  }
  request(method, params) {
    this.used = Date.now();
    const id = ++this.seq;
    if (this.s.kind === 'http') return this.post({ jsonrpc: '2.0', id, method, params });
    return new Promise((ok, no) => {
      // 第一次用 npx 要先下载，国内网络可能要好几分钟
      const timer = setTimeout(() => { this.wait.delete(id); no(new Error(T('服务太久没回答', 'The server took too long to answer'))); }, method === 'initialize' ? 180000 : CALL_MS);
      this.wait.set(id, { ok, no, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { return this.s.kind === 'http' ? this.post({ jsonrpc: '2.0', method, params }).catch(() => {}) : this.write({ jsonrpc: '2.0', method, params }); }
  async init() {
    // npx 第一次要下载，给足时间
    const r = await this.request('initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'hola', version: '1' } });
    this.info = r || {};
    await this.notify('notifications/initialized', {});
    return this;
  }
  async listTools() {
    const out = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      out.push(...((r && r.tools) || []));
      cursor = r && r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
  stop() { this.fail(T('已关闭', 'Closed')); if (this.child) killTree(this.child); this.child = null; if (this.s.kind === 'http' && this.session) fetch(this.s.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.session, ...(this.s.headers || {}) } }).catch(() => {}); }
}

const starting = new Map();
async function conn(s) {
  const have = conns.get(s.id);
  if (have) return have;
  if (starting.has(s.id)) return starting.get(s.id);
  const p = (async () => {
    const c = new Conn(s);
    conns.set(s.id, c);
    try { await c.start(); return c; } catch (e) { c.stop(); conns.delete(s.id); throw e; }
  })();
  starting.set(s.id, p);
  try { return await p; } finally { starting.delete(s.id); broadcastMcp(); }
}
function close(id) { const c = conns.get(id); if (c) { conns.delete(id); c.stop(); } }
function closeAll() { for (const id of [...conns.keys()]) close(id); }
setInterval(() => { for (const [id, c] of conns) if (c.s.kind === 'stdio' && Date.now() - c.used > IDLE_MS) close(id); }, 60000).unref();

// 只读还是会动东西：服务自己标了就听它的，没标就看名字
const READ_NAME = /^(get|list|search|query|read|fetch|find|describe|show|view|check|count|lookup|retrieve|download|export)[_A-Z-]|^(get|list|search|query|read)$/i;
const isWrite = (t) => { const a = t.annotations || {}; if (a.readOnlyHint === true) return false; if (a.readOnlyHint === false || a.destructiveHint) return true; return !READ_NAME.test(t.name); };

// 测试连接：连上 → 列出工具 → 记下来（老板之前手动改过的"只读 / 会改动"和停用的保留）
async function testServer(id) {
  const s = store.servers.find((x) => x.id === id);
  if (!s) throw new Error('not found');
  close(id);
  try {
    const c = await conn(s);
    const tools = await c.listTools();
    const old = new Map((s.tools || []).map((t) => [t.name, t]));
    s.tools = tools.map((t) => { const o = old.get(t.name) || {}; return { name: t.name, description: String(t.description || '').slice(0, 1000), inputSchema: t.inputSchema || { type: 'object', properties: {} }, write: o.writeSet ? o.write : isWrite(t), writeSet: !!o.writeSet, off: !!o.off }; });
    s.toolsAt = Date.now();
    s.error = '';
    s.serverName = (c.info && c.info.serverInfo && c.info.serverInfo.name) || '';
  } catch (e) {
    s.error = String(e && e.message || e).slice(0, 600);
  }
  save();
  broadcastMcp();
  return publicServer(s);
}

// ---------------------------------------------------------------- 队友能用哪些

function serversFor(m) {
  if (!wick('mcp')) return [];
  return store.servers.filter((s) => s.on !== false && (s.tools || []).some((t) => !t.off) && (s.who === 'all' || (Array.isArray(s.who) && s.who.includes(m.id))));
}
const mcpNames = (m) => serversFor(m).map((s) => s.name);
// 工具名 = 连接的编号 + 两个下划线 + 服务里的名字（两个服务有同名工具也分得开）；只能是字母数字下划线，最长 64
const toolName = (s, t) => `${s.id}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
function toolsFor(m) {
  const out = [];
  for (const s of serversFor(m)) for (const t of s.tools) if (!t.off) out.push({ name: toolName(s, t), server: s, tool: t, description: `【${s.name}】${t.description || t.name}${t.write ? T('（会改动外部数据，Hola 会先问老板）', ' (changes outside data; Hola asks the boss first)') : ''}`, inputSchema: t.inputSchema });
  return out;
}

// 每次运行一张一次性通行证
const passes = new Map(); // token → { conv, member, name, msg }
function issueMcpPass(c, m) {
  if (!toolsFor(m).length) return null;
  const token = crypto.randomBytes(24).toString('hex');
  passes.set(token, { conv: c.id, member: m.id, name: m.name });
  return token;
}
function revokeMcpPass(token) { if (passes.delete(token)) dropAsks(token); }
function revokeMcpConv(id) { for (const [t, p] of passes) if (p.conv === id) revokeMcpPass(t); }

const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const short = (a) => { const s = JSON.stringify(a || {}); return s.length > 300 ? s.slice(0, 300) + '…' : s; };
async function callMcp(token, name, args) {
  const who = passes.get(token);
  if (!who) return text(T('这次运行已经结束，外部工具不能再用了。', 'This run has ended; outside tools are no longer available.'), true);
  const m = { id: who.member };
  const hit = toolsFor(m).find((x) => x.name === name);
  if (!hit) return text(T('没有这个工具：', 'No such tool: ') + name, true);
  const { server: s, tool: t } = hit;
  const mustAsk = s.ask === 'always' || (s.ask !== 'never' && t.write);
  if (mustAsk) {
    const detail = T(`用「${s.name}」的 ${t.name}：${short(args)}`, `Use ${t.name} on "${s.name}": ${short(args)}`);
    if (!(await approve(token, who, detail, false, 'mcp', s.ask === 'always'))) return text(T('老板没有同意这次操作。', 'The boss did not allow this.'), true);
    if (!passes.has(token)) return text(T('这次运行已经结束。', 'This run has ended.'), true);
  }
  try {
    const c = await conn(s);
    const r = await c.request('tools/call', { name: t.name, arguments: args || {} });
    return { content: (r && r.content) || [], ...(r && r.isError ? { isError: true } : {}) };
  } catch (e) {
    return text(T(`「${s.name}」出错了：`, `"${s.name}" failed: `) + (e && e.message || e), true);
  }
}

// 命令行队友：挂上 Hola 的转接服务（tools/hola-mcp-proxy.js），它只列出这位队友能用的工具，调用都转回 Hola
function withMcp(c, m, args, work) {
  if (!work || !['claude-stream', 'codex-json'].includes(m.parser)) return null;
  const token = issueMcpPass(c, m);
  if (!token) return null;
  const exe = process.execPath, script = path.join(ROOT, 'tools', 'hola-mcp-proxy.js');
  const env = { ELECTRON_RUN_AS_NODE: '1', HOLA_URL: `http://127.0.0.1:${PORT}`, HOLA_MCP_TOKEN: token };
  if (m.parser === 'codex-json') {
    // 和团队工具一样：Codex 安全模式下 MCP 工具要人批准，后台运行批不了，只在完全权限时挂
    if (!args.includes('--dangerously-bypass-approvals-and-sandbox') || [exe, script].some((p) => p.includes("'"))) { revokeMcpPass(token); return null; }
    const k = 'mcp_servers.hola_mcp.';
    const cfg = ['-c', `${k}command='${exe}'`, '-c', `${k}args=['${script}']`, '-c', `${k}env={${Object.entries(env).map(([a, b]) => `${a}='${b}'`).join(',')}}`, '-c', `${k}startup_timeout_sec=30`, '-c', `${k}tool_timeout_sec=600`];
    const at = args.indexOf('exec');
    return { args: at >= 0 ? [...args.slice(0, at), ...cfg, ...args.slice(at)] : [...cfg, ...args], env: {}, done() { revokeMcpPass(token); } };
  }
  const file = path.join(convDir(c), '.hola', `mcp-${m.id}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'hola-mcp': { command: exe, args: [script], env } } }));
  const out = [...args];
  const i = out.findIndex((x) => x === '--allowedTools' || x === '--allowed-tools');
  if (i >= 0 && out[i + 1] && !/mcp__hola-mcp/.test(out[i + 1])) out[i + 1] += ',mcp__hola-mcp';
  const rel = path.relative(convDir(c), file);
  if (out[out.length - 2] === '--mcp-config' || (out.lastIndexOf('--mcp-config') >= 0 && out.slice(out.lastIndexOf('--mcp-config') + 1).every((x) => /\.json$/i.test(x)))) out.push(rel);
  else out.push('--mcp-config', rel);
  return { args: out, env: {}, done() { revokeMcpPass(token); try { fs.unlinkSync(file); } catch (_) {} } };
}
// 转接服务来要工具清单
function proxyTools(token) {
  const who = passes.get(token);
  if (!who) return [];
  return toolsFor({ id: who.member }).map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema && typeof x.inputSchema === 'object' ? x.inputSchema : { type: 'object', properties: {} } }));
}

module.exports = { presets, publicMcp, broadcastMcp, saveServer, removeServer, setTool, testServer, parseImport, importCandidates, importServers, closeAll, mcpNames, toolsFor, issueMcpPass, revokeMcpPass, revokeMcpConv, callMcp, withMcp, proxyTools };
