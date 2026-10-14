// Hola · 光辉联合
// 老板（你）指挥地位平等的 AI 队友：Claude、Codex、Gemini，以及你自己接入的其他 AI
// 零依赖，只需要 Node.js。启动：node server.js（平时双击桌面的 Hola 图标即可）

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const office = require('./office');

const ROOT = __dirname;
const IS_WIN = process.platform === 'win32';
// node server.js --demo：用内置的演示队友，不需要任何账号就能体验
const DEMO = process.argv.includes('--demo');
const CONFIG_PATH = process.env.TEAM_CONFIG ? path.resolve(process.env.TEAM_CONFIG) : path.join(ROOT, DEMO ? 'demo' : '', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
const PORT = Number(process.env.PORT || cfg.port || 3456);
const WORKSPACE = path.resolve(ROOT, cfg.workspace || 'workspace');
const DATA_DIR = path.join(ROOT, DEMO ? 'data-demo' : 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TRASH = path.join(WORKSPACE, '.trash');
const MEMORY_NAME = '对话记忆.md';
const ATTACH_DIR = '附件';
const TIMEOUT_MS = Number(cfg.timeoutMinutes || 20) * 60 * 1000;
const HIDDEN = process.env.HOLA_HIDDEN === '1';
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

if (HIDDEN) {
  const logFile = path.join(DATA_DIR, 'hola.log');
  try { if (fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.old'); } catch (_) {}
  const write = (lvl, args) => fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${lvl} ${args.map(String).join(' ')}\n`);
  console.log = (...a) => write('info', a);
  console.error = (...a) => write('error', a);
}
process.on('uncaughtException', (e) => console.error('uncaught', e && e.stack || e));

// ---------------------------------------------------------------- 设置

const DEFAULT_SETTINGS = { maxDiscussRounds: 3, conclusionBy: 'claude', maxAutoTurns: 10, autoMemory: true, strengths: {}, memberPrefs: {} };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }

// ---------------------------------------------------------------- 老板的个人资料

const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
const PROFILE_FIELDS = ['name', 'callMe', 'title', 'org', 'industry', 'bio', 'detail', 'tone', 'format', 'language', 'debate', 'extra'];
let profile = {};
try { profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')); } catch (_) {}
function saveProfile() { fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2)); }
function avatarFile() {
  for (const ext of ['png', 'jpg', 'webp']) { const f = path.join(DATA_DIR, 'avatar.' + ext); if (fileExists(f)) return f; }
  return null;
}
function publicProfile() {
  const f = avatarFile();
  let v = 0; try { v = f ? Math.round(fs.statSync(f).mtimeMs) : 0; } catch (_) {}
  return { ...profile, avatar: f ? `/avatar?v=${v}` : '' };
}

const PREF_TEXT = {
  detail: { brief: '回答尽量简短，先给结论，能一句话说清就不要三句', balanced: '回答详略适中', thorough: '回答详细全面，把理由和细节讲透' },
  tone: { pro: '语气正式、专业', casual: '语气轻松、口语化，像同事聊天' },
  format: { lists: '多用表格和清单，方便快速扫读', prose: '多用成段的文字，少用列表' },
  language: { zh: '默认用中文回答', en: '默认用英文回答', follow: '跟随老板使用的语言回答' },
};

function profileText() {
  const p = profile;
  const who = [
    p.name && `名字：${p.name}`, p.callMe && `希望被称呼为：${p.callMe}`,
    p.title && `职位：${p.title}`, p.org && `公司 / 团队：${p.org}`, p.industry && `行业：${p.industry}`,
    p.bio && `关于老板：${p.bio}`,
  ].filter(Boolean);
  const prefs = ['detail', 'tone', 'format', 'language'].map((k) => PREF_TEXT[k][p[k]]).filter(Boolean);
  if (p.extra) prefs.push(...String(p.extra).split(/\n+/).map((x) => x.trim()).filter(Boolean));
  if (!who.length && !prefs.length) return '';
  return `【老板是谁】
${who.length ? who.map((x) => '- ' + x).join('\n') : '- （没填）'}

【老板的长期偏好（所有对话都适用，务必遵守）】
${prefs.length ? prefs.map((x) => '- ' + x).join('\n') : '- （没填）'}

`;
}

function debateText() {
  return {
    gentle: '老板希望讨论温和一些：以补充和完善为主，只在明显有问题时才提反对。',
    sharp: '老板希望讨论尖锐一些：主动唱反调，找出别人方案里最薄弱的地方，不要轻易同意。',
  }[profile.debate] || '';
}

// ---------------------------------------------------------------- 成员

// 内置队友来自 config.json；老板后来添加的队友（API 或命令行）存在 data/members.json
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const DEFAULT_COLORS = { claude: '#FF5A4E', codex: '#22D39A', gemini: '#3D7BFF' };
const PALETTE = ['#A26BFA', '#F5A524', '#FF6FB5', '#2EC4D6', '#8BC34A', '#FF8A3D', '#7C8CFF', '#E2C044'];
const PARSERS = ['plain', 'claude-stream', 'codex-json', 'agy-json'];
let customMembers = [];
try { customMembers = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); } catch (_) {}
function saveCustomMembers() { fs.writeFileSync(MEMBERS_FILE, JSON.stringify(customMembers, null, 2)); }

const members = {};
let ORDER = [];
function buildMembers() {
  const prev = { ...members };
  for (const k of Object.keys(members)) delete members[k];
  const add = (id, def, builtin) => {
    const pref = settings.memberPrefs[id] || {};
    const old = prev[id];
    const same = old && JSON.stringify(old.def) === JSON.stringify(def);
    const m = members[id] = {
      ...def, id, def, builtin, type: def.type === 'api' ? 'api' : 'cli',
      color: pref.color || def.color || DEFAULT_COLORS[id] || PALETTE[0],
      enabled: builtin ? pref.enabled !== false && def.enabled !== false : def.enabled !== false,
      online: same ? old.online : false, version: same ? old.version : '', problem: same ? old.problem : '检查中…',
      resolved: same ? old.resolved : null, changed: !same || (old && old.enabled !== (builtin ? pref.enabled !== false && def.enabled !== false : def.enabled !== false)),
    };
    if (m.type === 'api') m.readOnly = true;
    // Codex 能直接看图片：用 --image= 把老板发的图片交给它
    if (m.cmd === 'codex' && !m.imageFlag) Object.assign(m, { imageFlag: '--image=', imageFlagAfter: 'exec' });
  };
  for (const [id, m] of Object.entries(cfg.members)) add(id, m, true);
  for (const m of customMembers) add(m.id, m, false);
  ORDER = Object.keys(members);
}
buildMembers();
const strengthsOf = (m) => settings.strengths[m.id] || m.strengths || '';
const enabledIds = () => ORDER.filter((id) => members[id].enabled);

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }

function whereAll(cmd) {
  return new Promise((res) =>
    execFile('where', [cmd], { windowsHide: true }, (err, out) =>
      res(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))));
}

async function resolveCmd(cmd) {
  if (!IS_WIN) return { file: cmd, shell: false };
  if (/[\\/]/.test(cmd)) return fileExists(cmd) ? { file: cmd, shell: /\.(cmd|bat)$/i.test(cmd) } : null;
  // 自己按 PATH 查找，避免 where 的 GBK 输出把中文路径弄成乱码
  const found = [];
  for (const dir of String(process.env.PATH || process.env.Path || '').split(';')) {
    const d = dir.trim().replace(/^"|"$/g, '');
    if (!d) continue;
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const f = path.join(d, cmd + ext);
      if (fileExists(f)) found.push(f);
    }
  }
  const home = os.homedir();
  found.push(...[
    path.join(home, '.local', 'bin', cmd + '.exe'),
    path.join(process.env.APPDATA || '', 'npm', cmd + '.cmd'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', cmd, cmd + '.exe'),
    path.join(process.env.LOCALAPPDATA || '', cmd, 'bin', cmd + '.exe'),
  ].filter(fileExists));
  if (!found.length) found.push(...(await whereAll(cmd)).filter(fileExists));
  const pick = found.find((p) => /\.exe$/i.test(p)) || found.find((p) => /\.(cmd|bat)$/i.test(p));
  return pick ? { file: pick, shell: /\.(cmd|bat)$/i.test(pick) } : null;
}

function winQuote(a) {
  if (/^[A-Za-z0-9_\-./:\\=]+$/.test(a)) return a;
  return '"' + String(a).replace(/"/g, '\\"') + '"';
}

function spawnMember(m, args, opts) {
  let file = m.resolved.file;
  let finalArgs = args;
  const o = { windowsHide: true, ...opts };
  if (m.resolved.shell) {
    file = '"' + file + '"';
    finalArgs = args.map(winQuote);
    o.shell = true;
  }
  return spawn(file, finalArgs, o);
}

function decodeOut(buf) {
  const u = buf.toString('utf8');
  if (!u.includes('�')) return u;
  try { return new TextDecoder('gbk').decode(buf); } catch (_) { return u; }
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function cleanEnv() {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };
  if (cfg.useSubscriptionOnly !== false) delete env.ANTHROPIC_API_KEY; // Claude 只用订阅登录
  delete env.HOLA_HIDDEN;
  return env;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {} }
  else { try { child.kill('SIGTERM'); } catch (_) {} }
}

async function checkMember(m) {
  m.online = false;
  m.changed = false;
  if (!m.enabled) { m.problem = '已停用'; return; }
  m.problem = '检查中…';
  if (m.type === 'api') {
    const a = m.api || {};
    const local = /localhost|127\.0\.0\.1/.test(a.baseUrl || '');
    if (!a.baseUrl || !a.model || (!a.apiKey && !local)) { m.problem = '还没填完整：需要接口地址、模型名和 API Key'; return; }
    m.online = true; m.problem = ''; m.version = a.model;
    return;
  }
  if (!m.cmd) { m.problem = '还没填命令'; return; }
  const r = await resolveCmd(m.cmd);
  if (!r) { m.problem = `没找到 ${m.cmd} 命令：还没安装，或装完后要重新打开 Hola`; return; }
  m.resolved = r;
  if (m.versionCheck === false) { m.online = true; m.problem = ''; m.version = path.basename(r.file); return; }
  await new Promise((resolve) => {
    const chunks = [];
    let child;
    try { child = spawnMember(m, ['--version'], { cwd: WORKSPACE, env: cleanEnv() }); }
    catch (e) { m.problem = '无法启动：' + e.message; return resolve(); }
    const t = setTimeout(() => killTree(child), 30000);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('error', (e) => { m.problem = '无法启动：' + e.message; });
    child.on('close', (code) => {
      clearTimeout(t);
      const out = stripAnsi(decodeOut(Buffer.concat(chunks))).trim();
      if (code === 0) { m.online = true; m.problem = ''; m.version = out.split(/\r?\n/).pop().slice(0, 60); }
      else if (m.problem === '检查中…') m.problem = `${m.cmd} --version 运行失败：` + out.slice(0, 200);
      resolve();
    });
  });
}

async function checkAll() {
  broadcast({ type: 'members', members: publicMembers() });
  await Promise.all(Object.values(members).map(checkMember));
  broadcast({ type: 'members', members: publicMembers() });
}

function joinArgs(args) { return (args || []).map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' '); }
function splitArgs(str) {
  const out = []; let cur = ''; let q = null; let has = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) { if (ch === '\\' && str[i + 1] === q) { cur += q; i++; } else if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
function keyHint(k) { return k ? (k.length > 10 ? k.slice(0, 3) + '…' + k.slice(-4) : '已填写') : ''; }

function publicMembers() {
  return ORDER.map((id) => members[id]).map((m) => ({
    id: m.id, name: m.name, color: m.color, strengths: strengthsOf(m), readOnly: !!m.readOnly,
    online: m.online, version: m.version, problem: m.problem, type: m.type, builtin: !!m.builtin, enabled: m.enabled,
    edit: m.type === 'api'
      ? { baseUrl: (m.api || {}).baseUrl || '', model: (m.api || {}).model || '', keyHint: keyHint((m.api || {}).apiKey), temperature: (m.api || {}).temperature ?? '' }
      : { cmd: m.cmd || '', argsText: joinArgs(m.args), parser: m.parser || 'plain', readOnly: !!m.readOnly, versionCheck: m.versionCheck !== false },
  }));
}

function checkChanged() {
  const list = Object.values(members).filter((m) => m.changed);
  broadcast({ type: 'members', members: publicMembers() });
  Promise.all(list.map(checkMember)).then(() => broadcast({ type: 'members', members: publicMembers() }));
}

// ---------------------------------------------------------------- 推送

const clients = new Set();
let lastClientAt = Date.now();
function broadcast(evt) {
  const data = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const res of clients) res.write(data);
}

// ---------------------------------------------------------------- 对话

const convs = new Map(); // id -> conv

function convDir(c) { return path.join(WORKSPACE, c.id); }
function metaFile(c) { return path.join(convDir(c), '.hola', 'chat.json'); }

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

function loadConvs() {
  for (const name of fs.readdirSync(WORKSPACE)) {
    if (name.startsWith('.')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(WORKSPACE, name, '.hola', 'chat.json'), 'utf8'));
      const c = { ...data, id: name, rt: null };
      for (const m of c.messages) if (m.status === 'running') { m.status = 'stopped'; if (!m.text) m.text = '（Hola 重启，中断了）'; }
      c.seq = c.messages.reduce((n, m) => Math.max(n, Number(String(m.id).split('-')[1]) || 0), 0);
      convs.set(name, c);
    } catch (_) {}
  }
}

function rt(c) {
  if (!c.rt) c.rt = { jobs: [], running: false, children: new Set(), gen: 0, hops: 0, working: new Set(), phase: '' };
  return c.rt;
}

const MEMORY_TEMPLATE = `# 对话记忆

## 目标与背景

## 老板的偏好与要求

## 已经定下的结论

## 进度与待办

## 重要文件
`;

function createConv(title) {
  const c = { id: newId(), title: title || '新对话', created: Date.now(), updated: Date.now(), messages: [], seq: 0, rt: null };
  fs.mkdirSync(path.join(convDir(c), '.hola'), { recursive: true });
  fs.writeFileSync(path.join(convDir(c), MEMORY_NAME), MEMORY_TEMPLATE);
  convs.set(c.id, c);
  saveConv(c, true);
  broadcastConvList();
  return c;
}

const saveTimers = new Map();
function saveConv(c, now) {
  const doSave = () => {
    saveTimers.delete(c.id);
    try {
      const { rt: _rt, seq: _seq, ...data } = c;
      fs.mkdirSync(path.dirname(metaFile(c)), { recursive: true });
      fs.writeFileSync(metaFile(c), JSON.stringify(data));
      fs.writeFileSync(path.join(convDir(c), '.hola', '聊天记录.md'), transcriptMd(c));
    } catch (e) { console.error('保存对话失败', e.message); }
  };
  clearTimeout(saveTimers.get(c.id));
  if (now) doSave(); else saveTimers.set(c.id, setTimeout(doSave, 400));
}

function convSummary(c) {
  const r = c.rt;
  return {
    id: c.id, title: c.title, updated: c.updated, created: c.created,
    running: !!(r && r.running), working: r ? [...r.working] : [], phase: r ? r.phase : '', active: c.active || null,
  };
}

function convList() {
  return [...convs.values()].sort((a, b) => b.updated - a.updated).map(convSummary);
}
function broadcastConvList() { broadcast({ type: 'convs', convs: convList() }); }
function broadcastState(c) { broadcast({ type: 'state', conv: convSummary(c) }); }

function nameOf(from) {
  if (from === 'boss') return '老板';
  if (from === 'system') return '系统';
  return (members[from] || cfg.members[from] || { name: from }).name;
}

function newMsg(c, from, text, extra = {}) {
  const msg = { id: `m-${++c.seq}`, from, text: text || '', ts: Date.now(), status: 'done', process: [], ...extra };
  c.messages.push(msg);
  c.updated = Date.now();
  broadcast({ type: 'msg', conv: c.id, msg });
  saveConv(c);
  return msg;
}
function update(c, msg) { broadcast({ type: 'msg', conv: c.id, msg }); saveConv(c); }
function sys(c, text, extra) { return newMsg(c, 'system', text, extra); }

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + `…（后面还有 ${s.length - n} 字，已省略）` : s;
}

function addProc(c, msg, kind, text) {
  text = String(text || '').trim();
  if (!text) return;
  const item = { k: kind, t: clip(text, 3000) };
  msg.process.push(item);
  if (msg.process.length > 500) msg.process.splice(0, msg.process.length - 500);
  broadcast({ type: 'proc', conv: c.id, id: msg.id, item });
}

// ---------------------------------------------------------------- 文件

function listFiles(c) {
  const out = new Map();
  const base = convDir(c);
  const walk = (dir, depth) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (it.name.startsWith('.') || it.name === 'node_modules' || it.name === '__pycache__') continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { if (depth < 4) walk(full, depth + 1); continue; }
      if (out.size > 2000) return;
      try { const st = fs.statSync(full); out.set(path.relative(base, full).split(path.sep).join('/'), st.mtimeMs + ':' + st.size); } catch (_) {}
    }
  };
  walk(base, 0);
  return out;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|aac|flac)$/i;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|aac|flac|pdf)$/i;
function fileInfo(c, rel) {
  let size = 0;
  try { size = fs.statSync(path.join(convDir(c), rel)).size; } catch (_) {}
  const tv = textVersionRel(c, rel);
  return { path: rel, name: path.basename(rel), size, image: IMG_EXT.test(rel), video: VIDEO_EXT.test(rel), audio: AUDIO_EXT.test(rel),
    preview: PREVIEW_EXT.test(rel), textVersion: tv || undefined };
}

// ---------------------------------------------------------------- Word / Excel / PPT 转文字
// 队友里不是每个都能直接读 Office 文件，所以 Hola 自己转一份文字版放在"文字版"文件夹里，大家都读这个。
const TEXT_DIR = '文字版';
const PREVIEW_EXT = /\.(docx|xlsx|pptx|pdf|csv|tsv|md|txt|json)$/i;
function textVersionRel(c, rel) {
  if (!office.OFFICE_EXT.test(rel)) return '';
  const tv = `${TEXT_DIR}/${rel.replace(/[\\/]/g, '__')}.md`;
  return fileExists(path.join(convDir(c), tv)) ? tv : '';
}
function convertOffice(c, rel) {
  if (!office.OFFICE_EXT.test(rel)) return '';
  try {
    const doc = office.readOffice(path.join(convDir(c), rel));
    const tv = `${TEXT_DIR}/${rel.replace(/[\\/]/g, '__')}.md`;
    fs.mkdirSync(path.join(convDir(c), TEXT_DIR), { recursive: true });
    fs.writeFileSync(path.join(convDir(c), tv), office.toMarkdown(doc, path.basename(rel)));
    return tv;
  } catch (e) { console.error('转换失败', rel, e.message); return ''; }
}

// ---------------------------------------------------------------- 收取 AI 生成的媒体
// 有些 AI 把生成的图片放在事件数据里（base64），或者存到对话文件夹以外的地方。
// 这里把它们都收进本对话的"产出"文件夹，群里才能直接看到、下载。
const OUT_DIR = '产出';
const MAGIC = [['iVBORw0KGgo', 'png'], ['/9j/', 'jpg'], ['UklGR', 'webp'], ['R0lGOD', 'gif']];

function sameFileExists(c, buf) {
  const base = convDir(c);
  for (const [rel] of listFiles(c)) {
    try {
      const f = path.join(base, rel);
      if (fs.statSync(f).size === buf.length && crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex') === crypto.createHash('md5').update(buf).digest('hex')) return true;
    } catch (_) {}
  }
  return false;
}

function stamp() { return new Date().toTimeString().slice(0, 8).replace(/:/g, ''); }

function saveCaptured(c, m, msg, buf, ext) {
  if (!buf || buf.length < 200 || sameFileExists(c, buf)) return;
  const dir = path.join(convDir(c), OUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = uniqueName(dir, `${m.name}-生成-${stamp()}.${ext}`);
  fs.writeFileSync(path.join(dir, name), buf);
  const rel = `${OUT_DIR}/${name}`;
  (msg.captured = msg.captured || []).push(rel);
  addProc(c, msg, 'tool', '收到生成的文件，已放进对话文件夹：' + rel);
}

function importPath(c, m, msg, p) {
  try {
    p = String(p).trim().replace(/^file:\/\/\/?/, '').replace(/^["'`(（]+|["'`)）,，。.]+$/g, '');
    if (!MEDIA_EXT.test(p) || !path.isAbsolute(p)) return;
    const full = path.resolve(p);
    if (full.startsWith(convDir(c) + path.sep)) return; // 已经在对话文件夹里
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > 300e6) return;
    if (msg.startedAt && st.mtimeMs < msg.startedAt - 5 * 60 * 1000) return; // 只收这次新生成的
    const buf = fs.readFileSync(full);
    if (sameFileExists(c, buf)) return;
    const dir = path.join(convDir(c), OUT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const name = uniqueName(dir, path.basename(full));
    fs.writeFileSync(path.join(dir, name), buf);
    (msg.captured = msg.captured || []).push(`${OUT_DIR}/${name}`);
    addProc(c, msg, 'tool', `把 ${full} 复制进对话文件夹：${OUT_DIR}/${name}`);
  } catch (_) {}
}

function captureFromJson(c, m, msg, o, depth = 0) {
  if (!o || depth > 8) return;
  if (typeof o === 'string') {
    if (o.length > 1500) {
      const d = o.match(/^data:(image|video|audio)\/([a-z0-9.+-]+);base64,/i);
      if (d) return saveCaptured(c, m, msg, Buffer.from(o.slice(d[0].length), 'base64'), d[2].replace('jpeg', 'jpg').replace('mpeg', 'mp3'));
      const hit = MAGIC.find(([sig]) => o.startsWith(sig));
      if (hit && /^[A-Za-z0-9+/=\s]+$/.test(o.slice(0, 4000))) return saveCaptured(c, m, msg, Buffer.from(o, 'base64'), hit[1]);
    } else if (o.length < 600 && MEDIA_EXT.test(o) && (/^[A-Za-z]:[\\/]/.test(o) || o.startsWith('/') || o.startsWith('file:'))) {
      importPath(c, m, msg, o);
    }
    return;
  }
  if (Array.isArray(o)) { for (const x of o) captureFromJson(c, m, msg, x, depth + 1); return; }
  if (typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (k === 'aggregated_output' || k === 'command') continue; // 命令输出里的路径不算
    captureFromJson(c, m, msg, v, depth + 1);
  }
}

function captureFromText(c, m, msg, text) {
  const re = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|mnt)\/|file:\/\/\/?)[^\s"'`<>|*?\n]+?\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|aac|flac|pdf)/gi;
  for (const mt of String(text || '').match(re) || []) importPath(c, m, msg, mt);
}

function snapshotDirs(dirs) {
  const out = new Map();
  for (const d of dirs) {
    const walk = (dir, depth) => {
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const it of items) {
        const f = path.join(dir, it.name);
        if (it.isDirectory()) { if (depth < 3) walk(f, depth + 1); }
        else if (MEDIA_EXT.test(it.name)) { try { out.set(f, fs.statSync(f).mtimeMs); } catch (_) {} }
      }
    };
    walk(d, 0);
  }
  return out;
}

function mediaWatchDirs(m) {
  const dirs = (m.mediaDirs || []).map((d) => d.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (m.cmd === 'codex') dirs.push(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images'));
  return dirs;
}

function listingText(c) {
  const files = [...listFiles(c).keys()].filter((f) => f !== MEMORY_NAME && !f.startsWith(TEXT_DIR + '/'));
  const line = (f) => { const tv = textVersionRel(c, f); return '- ' + f + (tv ? `（文字版：${tv}）` : ''); };
  return files.length ? files.slice(0, 80).map(line).join('\n') + (files.length > 80 ? `\n…（共 ${files.length} 个文件）` : '') : '（还没有文件）';
}

function readMemory(c) {
  try { return fs.readFileSync(path.join(convDir(c), MEMORY_NAME), 'utf8'); } catch (_) { return ''; }
}

// ---------------------------------------------------------------- 输出解析

function makeParser(kind, c, msg) {
  const texts = [];
  let finalText = '';
  const tryJSON = (line) => { try { return JSON.parse(line); } catch (_) { return null; } };
  const P = (k, t) => addProc(c, msg, k, t);

  if (kind === 'claude-stream') {
    return {
      line(line) {
        if (!line.trim()) return;
        const o = tryJSON(line);
        if (!o) return P('log', line);
        if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          for (const x of o.message.content) {
            if (x.type === 'thinking' && x.thinking) P('think', x.thinking);
            else if (x.type === 'text' && x.text) texts.push(x.text);
            else if (x.type === 'tool_use') P('tool', describeTool(c, x.name, x.input));
          }
        } else if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
          for (const x of o.message.content) {
            if (x.type === 'tool_result') {
              const t = Array.isArray(x.content) ? x.content.map((y) => y.text || '').join('\n') : x.content;
              P(x.is_error ? 'error' : 'result', clip(t, 600));
            }
          }
        } else if (o.type === 'result') {
          if (typeof o.result === 'string') finalText = o.result;
          if (o.is_error) P('error', o.result || o.subtype || '出错了');
        }
      },
      finish() { return (finalText || texts[texts.length - 1] || '').trim(); },
    };
  }

  if (kind === 'codex-json') {
    return {
      line(line) {
        if (!line.trim()) return;
        const o = tryJSON(line);
        if (!o) return P('log', line);
        captureFromJson(c, memberOf(msg), msg, o);
        const it = o.item || null;
        if (it && o.type === 'item.started' && it.type === 'command_execution') P('tool', '运行命令：' + it.command);
        else if (it && o.type === 'item.completed') {
          if (it.type === 'reasoning') P('think', it.text);
          else if (it.type === 'agent_message') texts.push(it.text);
          else if (it.type === 'command_execution') P(it.exit_code ? 'error' : 'result', clip(it.aggregated_output || `退出码 ${it.exit_code}`, 600));
          else if (it.type === 'file_change') P('tool', '修改文件：' + (it.changes || []).map((x) => `${x.path}（${x.kind}）`).join('，'));
          else if (it.type === 'web_search') P('tool', '联网搜索：' + (it.query || ''));
          else if (it.type === 'mcp_tool_call') P('tool', `调用工具：${it.server || ''} ${it.tool || ''}`);
          else if (it.type === 'error') P('error', it.message);
        } else if (o.type === 'turn.failed' || o.type === 'error') P('error', (o.error && o.error.message) || o.message || line);
      },
      finish() { return (texts[texts.length - 1] || '').trim(); },
    };
  }

  if (kind === 'agy-json') {
    const lines = [];
    return {
      line(line) { if (line.trim()) lines.push(line); },
      finish() {
        const all = lines.join('\n').trim();
        const env = (t) => { const o = tryJSON(t); return o && typeof o === 'object' && 'response' in o ? o : null; };
        let e = env(all);
        for (let i = lines.length - 1; i >= 0 && !e; i--) e = env(lines[i]);
        if (e) captureFromJson(c, memberOf(msg), msg, e);
        if (!e) { if (all) P('log', all); return all; }
        if (e.status && e.status !== 'SUCCESS') P('error', '状态：' + e.status);
        return String(e.response || '').trim();
      },
    };
  }

  return { // plain
    line(line) { texts.push(line); },
    finish() { return texts.join('\n').trim(); },
  };
}

function memberOf(msg) { return members[msg.from] || { name: msg.from }; }

function describeTool(c, name, input) {
  input = input || {};
  const p = input.file_path || input.path || input.pattern || input.url || input.query || input.command || '';
  const label = { Read: '读取', Write: '写入', Edit: '修改', Glob: '查找文件', Grep: '搜索内容', WebSearch: '联网搜索', WebFetch: '打开网页', Bash: '运行命令', PowerShell: '运行命令' }[name] || name;
  return `${label}：${String(p).split(convDir(c)).join('.')}`;
}

// ---------------------------------------------------------------- 调用命令行

function runCli(c, m, prompt, msg, images) {
  return new Promise((resolve) => {
    const r = rt(c);
    const outFile = path.join(convDir(c), '.hola', `out-${m.id}-${Date.now()}.txt`);
    const viaArg = m.args.includes('{PROMPT}');
    let args = m.args.map((a) => (a === '{PROMPT}' ? prompt : a.replace('{OUTFILE}', outFile).replace('{WORKSPACE}', convDir(c)).replace('{ROOT}', ROOT)));
    if (m.imageFlag && images.length) {
      const extra = images.map((p) => m.imageFlag + p);
      const at = Math.max(0, m.imageFlagAfter ? args.indexOf(m.imageFlagAfter) + 1 : 0);
      args = [...args.slice(0, at), ...extra, ...args.slice(at)];
    }
    let child;
    let settled = false;
    let errTail = '';
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      r.children.delete(child);
      resolve(res);
    };
    try { child = spawnMember(m, args, { cwd: convDir(c), env: cleanEnv() }); }
    catch (e) { return resolve({ code: -1, text: '', err: e.message }); }
    r.children.add(child);
    const timer = setTimeout(() => { addProc(c, msg, 'error', `超过 ${cfg.timeoutMinutes || 20} 分钟没做完，强制结束。`); killTree(child); }, TIMEOUT_MS);
    const parser = makeParser(m.parser, c, msg);
    let outBuf = '';
    let errBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      outBuf += d;
      let i;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const line = stripAnsi(outBuf.slice(0, i).replace(/\r$/, ''));
        outBuf = outBuf.slice(i + 1);
        parser.line(line);
      }
    });
    child.stderr.on('data', (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = stripAnsi(errBuf.slice(0, i).replace(/\r$/, '')).trim();
        errBuf = errBuf.slice(i + 1);
        if (line) { addProc(c, msg, 'log', line); errTail = (errTail + '\n' + line).slice(-800); }
      }
    });
    child.stdin.on('error', () => {});
    if (viaArg) child.stdin.end(); else child.stdin.end(prompt, 'utf8');
    child.on('error', (e) => finish({ code: -1, text: '', err: e.message }));
    child.on('close', (code) => {
      if (outBuf.trim()) parser.line(stripAnsi(outBuf));
      if (errBuf.trim()) { addProc(c, msg, 'log', stripAnsi(errBuf)); errTail += '\n' + errBuf; }
      let text = parser.finish();
      try { const f = fs.readFileSync(outFile, 'utf8').trim(); if (f) text = f; fs.unlinkSync(outFile); } catch (_) {}
      finish({ code, text, err: errTail.trim() });
    });
  });
}

// ---------------------------------------------------------------- 调用 API（OpenAI 兼容）

function apiExtras(c) {
  const lastBoss = [...c.messages].reverse().find((x) => x.from === 'boss');
  const atts = (lastBoss && lastBoss.attachments) || [];
  if (!atts.length) return '';
  const parts = atts.map((a) => {
    const tv = textVersionRel(c, a.path);
    if (tv) { try { return `\n--- 附件 ${a.name}（已转成文字）---\n` + clip(fs.readFileSync(path.join(convDir(c), tv), 'utf8'), 60000); } catch (_) {} }
    if (/\.(txt|md|csv|json|tsv|html?|xml|ya?ml|js|ts|py)$/i.test(a.path) && a.size < 60000) {
      try { return `\n--- 附件 ${a.name} 的内容 ---\n` + fs.readFileSync(path.join(convDir(c), a.path), 'utf8'); } catch (_) {}
    }
    return `\n--- 附件 ${a.name}：${a.image ? '图片' : '文件'}，你看不到内容，可以参考能读文件的队友的描述 ---`;
  });
  return '\n\n【老板这次发的附件】' + parts.join('\n');
}

async function runApi(c, m, prompt, msg) {
  const a = m.api || {};
  const ctrl = new AbortController();
  const handle = { abort: () => ctrl.abort() };
  const r = c ? rt(c) : null;
  if (r) r.children.add(handle);
  const proc = (k, t) => { if (c && msg) addProc(c, msg, k, t); };
  const timer = setTimeout(() => { proc('error', `超过 ${cfg.timeoutMinutes || 20} 分钟没做完，强制结束。`); ctrl.abort(); }, c ? TIMEOUT_MS : 60000);
  let text = '', err = '', think = '';
  const flushThink = (force) => { if (think && (force || think.length > 500)) { proc('think', think); think = ''; } };
  try {
    const body = { model: a.model, stream: true, messages: [{ role: 'user', content: prompt }] };
    if (a.temperature !== '' && a.temperature != null && !isNaN(+a.temperature)) body.temperature = +a.temperature;
    proc('tool', `调用接口：${a.model}`);
    const res = await fetch(String(a.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(a.apiKey ? { Authorization: 'Bearer ' + a.apiKey } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const raw = await res.text();
      let detail = raw.slice(0, 300);
      try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error)) || j.message || detail; } catch (_) {}
      const hint = { 401: 'API Key 不对或已失效', 402: '账户余额不足', 403: '没有权限使用这个模型', 404: '接口地址或模型名不对', 429: '调用太频繁，或额度用完了' }[res.status];
      err = `${hint ? hint + '。' : ''}接口返回 HTTP ${res.status}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    } else if (!String(res.headers.get('content-type') || '').includes('event-stream')) {
      const o = await res.json();
      const mo = (o.choices && o.choices[0] && o.choices[0].message) || {};
      if (mo.reasoning_content) proc('think', mo.reasoning_content);
      text = mo.content || '';
      if (o.error) err = o.error.message || JSON.stringify(o.error);
    } else {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          let o; try { o = JSON.parse(d); } catch (_) { continue; }
          if (o.error) { err = o.error.message || JSON.stringify(o.error); continue; }
          const delta = (o.choices && o.choices[0] && (o.choices[0].delta || o.choices[0].message)) || {};
          if (delta.reasoning_content || delta.reasoning) { think += delta.reasoning_content || delta.reasoning; flushThink(false); }
          if (delta.content) text += delta.content;
        }
      }
      flushThink(true);
    }
    if (!text && !err) err = '接口没有返回内容';
  } catch (e) {
    err = e.name === 'AbortError' ? '已停止' : '连不上接口：' + ((e.cause && (e.cause.code || e.cause.message)) || e.message);
  }
  clearTimeout(timer);
  if (r) r.children.delete(handle);
  return { code: err ? 1 : 0, text: text.trim(), err };
}

async function runMember(c, m, prompt, msg, images) {
  if (m.type === 'api') return runApi(c, m, prompt + apiExtras(c), msg);
  const dirs = mediaWatchDirs(m);
  const before = dirs.length ? snapshotDirs(dirs) : null;
  const res = await runCli(c, m, prompt, msg, images);
  if (before) for (const [f, t] of snapshotDirs(dirs)) if (before.get(f) !== t) importPath(c, m, msg, f);
  captureFromText(c, m, msg, res.text);
  return res;
}

async function testMember(m) {
  if (m.type === 'api') {
    const res = await runApi(null, m, '这是一次连接测试，请只回复：OK', null);
    m.online = !res.err; m.problem = res.err || ''; m.version = (m.api || {}).model || '';
    return res.err ? { ok: false, error: res.err } : { ok: true, text: res.text.slice(0, 200) };
  }
  await checkMember(m);
  return m.online ? { ok: true, text: m.version || '命令可以运行' } : { ok: false, error: m.problem };
}

// ---------------------------------------------------------------- 提示词

let curActive = null;
function rosterText(selfId) {
  return enabledIds().map((id) => members[id]).map((m) =>
    `- ${m.name}${m.id === selfId ? '（就是你）' : ''}：${strengthsOf(m)}` +
    (m.type === 'api' ? '。通过 API 接入：不能读写文件、不能联网，只能根据群聊内容思考和写作' : m.readOnly ? '。只读：能读文件、查资料，不能写文件' : '') +
    (!m.online ? '。【当前不在线】' : curActive && !curActive.includes(m.id) ? '。【这次没有参与】' : '')).join('\n');
}

function msgLine(m) {
  const files = (m.attachments || []).concat(m.files || []);
  const att = files.length ? `\n（${m.from === 'boss' ? '附件' : '产出文件'}：${files.map((f) => f.path + (f.textVersion ? `，文字版 ${f.textVersion}` : '')).join('；')}）` : '';
  const ph = m.reason === 'initial' ? ' · 独立作答' : m.reason === 'discuss' ? ` · 讨论第${m.round}轮${m.stance === 'object' ? ' · 有异议' : m.stance === 'agree' ? ' · 同意' : ''}` : m.reason === 'conclusion' ? ' · 团队结论' : '';
  return `[${nameOf(m.from)}${ph}] ${clip(m.text, 4000)}${att}`;
}

function transcript(c) {
  const msgs = c.messages.filter((m) => (m.text || (m.attachments || []).length) && m.status !== 'running' && m.reason !== 'memory');
  let pick = msgs.slice(-50);
  const firstBoss = msgs.find((m) => m.from === 'boss');
  if (firstBoss && !pick.includes(firstBoss)) pick = [firstBoss, { from: 'system', text: '（中间较早的记录已省略，要点见对话记忆）' }, ...pick];
  return pick.map(msgLine).join('\n\n');
}

function transcriptMd(c) {
  return `# ${c.title}\n\n` + c.messages.filter((m) => m.text || (m.attachments || []).length).map((m) =>
    `### ${nameOf(m.from)} · ${new Date(m.ts).toLocaleString('zh-CN', { hour12: false })}\n\n${m.text}\n` +
    [...(m.attachments || []), ...(m.files || [])].map((f) => `- 📎 ${f.path}`).join('\n')).join('\n');
}

const TAG_NEED = /^[ \t>*_]*【?\s*需要讨论\s*】?\s*[:：]?\s*(是|否)\s*[*_]*\s*$/m;
const TAG_STANCE = /^[ \t>*_]*【?\s*立场\s*】?\s*[:：]?\s*(同意|有异议)\s*[*_]*\s*$/m;

function phaseGuide(c, m, turn) {
  const names = (ids) => ids.map(nameOf).join('、');
  switch (turn.reason) {
    case 'initial':
      return `老板发了新消息，没有点名，参与的队友同时、独立作答（这一轮你看不到其他队友的回答）。
请从你的长处出发，给出你自己的观点、答案或方案。
这是讨论阶段：可以读文件、查资料，但先不要生成正式的交付文件——等团队讨论出共识后再动手。
回复的最后单独一行必须是下面二选一：
【需要讨论】是　——问题有取舍、需要判断、大家很可能有不同看法
【需要讨论】否　——简单问候、事实性问题、或答案很明确`;
    case 'discuss':
      return `现在是团队内部讨论第 ${turn.round} 轮，老板不参与，靠你们自己的判断形成共识。
请认真读队友在前面几轮说的话：
- 指出你认同的有价值的部分（可以吸收进自己的方案）；
- 指出你不同意的地方，并给出理由；
- 补充大家都漏掉的关键点；必要时修正你自己的立场。
目标是得出一个最好的团队结论，不是礼貌附和：有实质分歧就说清楚，被说服了就直接说"我同意 X 的看法"。只谈有意义的点，简洁。${debateText() ? '\n' + debateText() : ''}
这一轮也不要生成正式交付文件。
回复的最后单独一行必须是下面二选一：
【立场】同意　——你认为团队已经可以形成一致结论（哪怕措辞细节不同）
【立场】有异议　——还有值得继续讨论的实质分歧`;
    case 'conclusion':
      return `团队讨论结束：${turn.consensus ? '大家已经达成共识' : `讨论了 ${turn.rounds} 轮，仍有分歧`}。由你代表团队，给老板写最终结论。
- 开头直接给出答案、方案或决定，吸收讨论中有价值的部分，不要复述过程。
- ${turn.consensus ? '可以用一两句话点出讨论中最关键的取舍。' : '简要列出没谈拢的分歧和各方理由，再给出你建议老板怎么选。'}
- 如果结论需要动手执行（做文件、写代码、出图等），在最后按分工写"@名字 + 具体任务"，队友会自动接手；你也可以自己做你那部分。`;
    case 'mention':
      return turn.after && turn.after.length
        ? `老板按顺序点名，你排在 ${names(turn.after)} 之后：先看他们刚做完的部分，再接着做你的。`
        : `老板点名让你来做。`;
    case 'handoff':
      return `${nameOf(turn.by)} 在群里 @ 了你，请接着处理交给你的部分。`;
    default:
      return '';
  }
}

function agentPrompt(c, m, turn) {
  curActive = c.active || null;
  const discussing = turn.reason === 'initial' || turn.reason === 'discuss';
  return `你是 Hola 团队里的 ${m.name}。Hola 是几位 AI 平等协作的团队，老板（用户）是包工头：他用 @ 指定谁来做、按什么顺序做；没点名时，参与的队友先各自思考，再自己讨论出结论。

团队成员：
${rosterText(m.id)}

基本规则：
1. 大家地位平等，各自发挥长处：可以补充、质疑、接着往下做，不要重复队友已经说过的话。
2. ${discussing ? '讨论阶段提到队友时直接写名字就行，不要用 @（@ 表示正式交活）。' : '需要队友动手时，写"@名字 + 具体要做的事"，他会自动接手。只在真的需要对方动手时才 @，不要 @ 自己，也不要 @ 标着"这次没有参与"的队友。'}
3. ${m.type === 'api' ? '你是通过 API 接入的，不能读写文件、不能联网：只根据群聊内容和附在最后的附件文字来思考和写作；需要做文件或查资料时，请能做的队友来做。' : `当前目录是这个对话的专属文件夹。交付物放在这里，取清楚的文件名，并在回复里写明。生成的图片、视频、音频也一定要保存到当前目录（不要只留在你自己的界面或临时目录里），老板才能在群里直接看到和下载。老板发来的附件在"${ATTACH_DIR}"文件夹里。Word、Excel、PPT 文件都有系统自动转好的文字版（在"${TEXT_DIR}"文件夹，文件列表里有标注），读不了原文件时就读文字版。`}
4. "${MEMORY_NAME}"是本对话的记忆：系统会在每轮结束后自动整理，你不用改它，但要遵守里面记下的偏好和结论。
5. 用中文，像在工作群里说话：先给结论，简洁具体。

${profileText()}【本对话记忆（${MEMORY_NAME}）】
${clip(readMemory(c), 6000) || '（空）'}

【当前文件夹里的文件】
${listingText(c)}

===== 群聊记录 =====
${transcript(c)}
===== 记录结束 =====

现在轮到你（${m.name}）。${phaseGuide(c, m, turn)}`;
}

// ---------------------------------------------------------------- 点名与调度

const ALL_WORDS = ['全员', '所有人', '大家', 'all'];
function mentionsIn(text, selfId) {
  const found = [];
  let all = false;
  const re = /@\s*([A-Za-z0-9\u4e00-\u9fa5._-]+)/g;
  let mt;
  while ((mt = re.exec(text || ''))) {
    const w = mt[1].toLowerCase();
    if (ALL_WORDS.some((a) => w.startsWith(a))) { all = true; continue; }
    const id = enabledIds().sort((a, b) => members[b].name.length - members[a].name.length)
      .find((k) => w.startsWith(members[k].name.toLowerCase().replace(/\s+/g, '')) || w === k);
    if (id && id !== selfId && !found.includes(id)) found.push(id);
  }
  return { ids: found, all };
}

function activeIds(c) { return enabledIds().filter((id) => members[id].online && (!c.active || c.active.includes(id))); }

function onBossMessage(c, text, attachments) {
  newMsg(c, 'boss', text, { attachments });
  if (c.title === '新对话' && text) {
    c.title = text.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 20) || '新对话';
    saveConv(c);
  }
  broadcastConvList();
  const r = rt(c);
  const { ids, all } = mentionsIn(text, null);
  if (!ids.length && !activeIds(c).length) { sys(c, '这次没有可以干活的队友：要么都没勾选参与，要么不在线。在输入框下方的"参与"里选几位，或者点右上角的光点看原因。'); return; }

  if (ids.length && !all) {
    // 点了名：按 @ 的先后顺序依次来
    ids.forEach((id, i) => r.jobs.push({ type: 'turn', member: id, reason: 'mention', after: ids.slice(0, i) }));
    r.hops = 0;
  } else if (r.running && r.phase === 'discuss') {
    sys(c, '大家会在下一轮讨论里看到老板这条消息。');
    return;
  } else {
    r.jobs.push({ type: 'discuss' });
    r.hops = 0;
  }
  if (!r.running) pump(c); else broadcastState(c);
}

async function pump(c) {
  const r = rt(c);
  if (r.running) return;
  const myGen = r.gen;
  r.running = true;
  broadcastState(c);
  broadcastConvList();
  while (myGen === r.gen) {
    while (r.jobs.length && myGen === r.gen) {
      const job = r.jobs.shift();
      if (job.type === 'discuss') { await runDiscussion(c, myGen); continue; }
      const m = members[job.member];
      if (!m || !m.online) { sys(c, `${m ? m.name : job.member} 不在线，跳过。`); continue; }
      r.phase = job.reason;
      const before = listFiles(c);
      const msg = await agentTurn(c, m, job, myGen);
      if (!msg) continue;
      attachFiles(c, before, [msg]);
      queueHandoffs(c, m, msg);
    }
    if (myGen !== r.gen) return;
    if (settings.autoMemory !== false && needsMemory(c)) await updateMemory(c, myGen);
    if (!r.jobs.length) break;
  }
  if (myGen !== r.gen) return;
  r.running = false;
  r.phase = '';
  broadcastState(c);
  broadcastConvList();
}

async function parallelRound(c, ids, turnFor, myGen) {
  const before = listFiles(c);
  const msgs = (await Promise.all(ids.map((id) => agentTurn(c, members[id], turnFor(id), myGen)))).filter(Boolean);
  if (myGen === rt(c).gen) attachFiles(c, before, msgs);
  return msgs;
}

async function runDiscussion(c, myGen) {
  const r = rt(c);
  let ids = activeIds(c);
  if (!ids.length) return;
  const flow = crypto.randomBytes(3).toString('hex');

  r.phase = 'initial';
  broadcastState(c);
  const first = await parallelRound(c, ids, () => ({ reason: 'initial', flow, round: 0 }), myGen);
  if (myGen !== r.gen) return;
  const ok = first.filter((m) => m.status === 'done');
  if (ok.length < 2) return; // 只有一个人能答，就不讨论了
  if (!ok.some((m) => m.needDiscuss === true)) return; // 大家都认为不需要讨论

  ids = ok.map((m) => m.from);
  const maxRounds = Math.max(1, Math.min(6, Number(settings.maxDiscussRounds) || 3));
  let consensus = false;
  let rounds = 0;
  for (let k = 1; k <= maxRounds; k++) {
    sys(c, k === 1 ? `有值得讨论的地方，进入内部讨论 · 第 1 轮` : `还有分歧，继续讨论 · 第 ${k} 轮`, { divider: true });
    r.phase = 'discuss';
    broadcastState(c);
    const msgs = await parallelRound(c, ids, () => ({ reason: 'discuss', flow, round: k }), myGen);
    if (myGen !== r.gen) return;
    rounds = k;
    const done = msgs.filter((m) => m.status === 'done');
    if (!done.length) return;
    if (done.every((m) => m.stance !== 'object')) { consensus = true; break; }
  }

  const pref = settings.conclusionBy;
  const writer = (ids.includes(pref) && pref) || ids[0];
  sys(c, consensus ? `达成共识，由 ${nameOf(writer)} 整理团队结论` : `讨论 ${rounds} 轮仍有分歧，由 ${nameOf(writer)} 整理结论并写明分歧`, { divider: true });
  r.phase = 'conclusion';
  broadcastState(c);
  const before = listFiles(c);
  const msg = await agentTurn(c, members[writer], { reason: 'conclusion', flow, consensus, rounds }, myGen);
  if (!msg || myGen !== r.gen) return;
  attachFiles(c, before, [msg]);
  queueHandoffs(c, members[writer], msg);
}

function attachFiles(c, before, msgs) {
  const changed = [...listFiles(c).entries()]
    .filter(([f, sig]) => before.get(f) !== sig && f !== MEMORY_NAME && !f.startsWith(ATTACH_DIR + '/') && !f.startsWith(TEXT_DIR + '/'))
    .map(([f]) => f);
  for (const f of changed) convertOffice(c, f);
  if (!changed.length || !msgs.length) return;
  const left = new Set(changed);
  for (const msg of msgs) {
    const mine = msgs.length === 1 ? changed : changed.filter((f) => (msg.captured || []).includes(f) || (msg.text || '').includes(path.basename(f)));
    if (!mine.length) continue;
    msg.files = mine.map((f) => fileInfo(c, f)).slice(0, 30);
    mine.forEach((f) => left.delete(f));
    update(c, msg);
  }
  if (left.size) sys(c, `这一轮新增或修改了：${[...left].slice(0, 12).join('、')}`);
}

function queueHandoffs(c, m, msg) {
  const r = rt(c);
  if (msg.status !== 'done') return;
  const { ids } = mentionsIn(msg.text, m.id);
  const act = activeIds(c);
  for (const id of ids) {
    if (r.jobs.some((q) => q.type === 'turn' && q.member === id)) continue;
    if (!act.includes(id)) { sys(c, `${nameOf(id)} 这次没有参与（或不在线），${nameOf(m.id)} 交给 Ta 的活没有派出去。需要的话，老板可以直接 @ Ta。`); continue; }
    if (r.hops >= settings.maxAutoTurns) {
      sys(c, `队友之间已经自动接力 ${settings.maxAutoTurns} 次了，先停一下，等老板看一眼再继续。`);
      r.jobs = r.jobs.filter((q) => q.reason !== 'handoff');
      break;
    }
    r.hops++;
    r.jobs.push({ type: 'turn', member: id, reason: 'handoff', by: m.id });
  }
}

// ---------------------------------------------------------------- 自动记忆

function seqOf(m) { return Number(String(m.id).split('-')[1]) || 0; }

function newSinceMemory(c) {
  const mark = c.memMark || 0;
  return c.messages.filter((m) => seqOf(m) > mark && m.reason !== 'memory' && m.status !== 'running' &&
    (m.from === 'boss' || (members[m.from] && m.status === 'done'))).slice(-60);
}

function needsMemory(c) {
  const fresh = newSinceMemory(c);
  return fresh.some((m) => m.from !== 'boss') && activeIds(c).length > 0;
}

function memoryPrompt(c, fresh) {
  const lines = fresh.map((m) => {
    const files = [...(m.attachments || []), ...(m.files || [])].map((f) => f.path);
    return msgLine(m) + (files.length && !msgLine(m).includes('（') ? `\n（文件：${files.join('，')}）` : '');
  }).join('\n\n');
  return `你是 Hola 团队的"记忆整理员"。Hola 里每个对话都有一份独立的记忆，队友每次发言前都会先读它；聊天记录太长时，较早的内容只能靠这份记忆延续。
你的任务：把下面"新增对话"里值得长期记住的内容，合并进"当前记忆"，输出更新后的完整记忆。

只记长期有用的东西：
- 目标与背景：这个对话在做什么项目、给谁、为什么。
- 老板的偏好与要求：老板明确说过的要求、口味、禁忌、格式偏好（只记老板说过的，不要替他推断）。
- 已经定下的结论：团队结论、老板拍板的决定（写结论本身，不写讨论过程）。
- 进度与待办：做到哪一步、还有什么没做、谁负责。
- 重要文件：交付文件和关键附件的文件名，以及一句话说明是什么。

规则：
- 合并、去重、压缩：新信息推翻旧信息时，直接改成新的，不要留着矛盾的两条。总长度尽量控制在 1500 字以内。
- 寒暄、过程性讨论、没有结论的发散，都不要记。
- 老板的个人资料和长期偏好另有地方保存，不用重复记；只记跟这个对话有关的。
- 不要修改任何文件、不要运行命令，只输出文字。
- 如果新增对话里没有任何值得记的内容，只输出一行：【无需更新】

输出格式（严格遵守）：
第一行：【本次变化】用一句话说明这次记了什么
然后输出完整记忆，放在 <<<记忆 和 记忆>>> 之间，使用这个结构：
<<<记忆
# 对话记忆

## 目标与背景
……
## 老板的偏好与要求
……
## 已经定下的结论
……
## 进度与待办
……
## 重要文件
……
记忆>>>

【当前记忆】
${readMemory(c) || MEMORY_TEMPLATE}

【新增对话】
${lines}`;
}

async function updateMemory(c, myGen) {
  const r = rt(c);
  const fresh = newSinceMemory(c);
  const lastSeq = Math.max(...c.messages.map(seqOf));
  const pref = settings.conclusionBy;
  const act = activeIds(c);
  const keeperId = (act.includes(pref) && pref) || act[0];
  if (!keeperId) return;
  const m = members[keeperId];
  r.phase = 'memory';
  const msg = newMsg(c, m.id, '', { status: 'running', startedAt: Date.now(), reason: 'memory' });
  r.working.add(m.id);
  broadcastState(c);
  const res = await runMember(c, m, memoryPrompt(c, fresh), msg, []);
  r.working.delete(m.id);
  if (myGen !== r.gen) return;
  msg.endedAt = Date.now();
  const out = res.text || '';
  const body = out.match(/<<<\s*记忆\s*\n([\s\S]*?)\n?\s*记忆\s*>>>/);
  const change = (out.match(/【本次变化】\s*(.+)/) || [])[1];
  if (/【无需更新】/.test(out) && !body) {
    msg.text = '这一轮没有需要长期记住的新内容。';
    msg.status = 'done';
    msg.memoryChanged = false;
  } else if (body && body[1].trim().length > 20) {
    const file = path.join(convDir(c), MEMORY_NAME);
    try {
      const hist = path.join(convDir(c), '.hola', 'memory-history');
      fs.mkdirSync(hist, { recursive: true });
      const old = readMemory(c);
      if (old) fs.writeFileSync(path.join(hist, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`), old);
      fs.writeFileSync(file, body[1].trim() + '\n');
      msg.text = change ? change.trim() : '已更新对话记忆。';
      msg.status = 'done';
      msg.memoryChanged = true;
    } catch (e) {
      msg.text = '写入对话记忆失败：' + e.message;
      msg.status = 'error';
    }
  } else {
    msg.text = '整理记忆没成功，下一轮会再试。' + (res.err ? '\n' + clip(res.err, 300) : '');
    msg.status = 'error';
  }
  if (msg.status !== 'error') c.memMark = lastSeq;
  update(c, msg);
  if (msg.memoryChanged) broadcast({ type: 'memory', conv: c.id, memory: readMemory(c) });
  broadcastState(c);
}

function extractTags(text) {
  let need = null, stance = null;
  const n = text.match(TAG_NEED);
  if (n) { need = n[1] === '是'; text = text.replace(TAG_NEED, ''); }
  const st = text.match(TAG_STANCE);
  if (st) { stance = st[1] === '同意' ? 'agree' : 'object'; text = text.replace(TAG_STANCE, ''); }
  return { text: text.trim(), need, stance };
}

async function agentTurn(c, m, turn, myGen) {
  const r = rt(c);
  const msg = newMsg(c, m.id, '', { status: 'running', startedAt: Date.now(), reason: turn.reason, by: turn.by || null, round: turn.round, flow: turn.flow || null, consensus: turn.consensus });
  r.working.add(m.id);
  broadcastState(c);
  const lastBoss = [...c.messages].reverse().find((x) => x.from === 'boss');
  const images = (lastBoss && lastBoss.attachments || []).filter((a) => a.image).map((a) => path.join(convDir(c), a.path));
  const res = await runMember(c, m, agentPrompt(c, m, turn), msg, images);
  r.working.delete(m.id);
  if (myGen !== r.gen) return null;
  msg.endedAt = Date.now();
  if (res.text) {
    const tags = extractTags(res.text);
    let text = tags.text;
    if (turn.reason === 'initial') msg.needDiscuss = tags.need === true;
    if (turn.reason === 'discuss') msg.stance = tags.stance || 'agree';
    if (m.readOnly) {
      const mem = text.match(/(^|\n)\s*记忆[:：]\s*(.+)\s*$/);
      if (mem) {
        try { fs.appendFileSync(path.join(convDir(c), MEMORY_NAME), `- ${mem[2].trim()}（${m.name}）\n`); } catch (_) {}
        addProc(c, msg, 'tool', '记入对话记忆：' + mem[2].trim());
        text = text.slice(0, mem.index).trim() || text;
      }
    }
    msg.text = text;
    msg.status = res.code === 0 ? 'done' : 'error';
  } else {
    msg.status = 'error';
    msg.text = '没能完成，出错了。' + (res.err ? '\n\n错误信息：\n' + clip(res.err, 800) : '') +
      `\n\n常见原因：登录过期（在终端运行一次 ${m.cmd} 重新登录），或订阅额度用完。`;
  }
  update(c, msg);
  broadcastState(c);
  return msg;
}

function stopConv(c, note) {
  const r = rt(c);
  r.gen++;
  r.jobs = [];
  for (const ch of r.children) { if (ch.abort) ch.abort(); else killTree(ch); }
  r.children.clear();
  r.working.clear();
  r.running = false;
  r.phase = '';
  for (const m of c.messages) if (m.status === 'running') { m.status = 'stopped'; if (!m.text) m.text = '（被老板叫停）'; update(c, m); }
  if (note) sys(c, note);
  broadcastState(c);
  broadcastConvList();
}

function anyRunning() { return [...convs.values()].some((c) => c.rt && c.rt.running); }

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac',
};

function sendFile(res, file, download, trusted, req) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
    if (!trusted && (ext === '.html' || ext === '.svg')) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'";
    if (download || !MIME[ext]) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
    // 支持分段读取，视频才能拖动进度条
    const range = req && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size > 0) {
      let start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function safeJoin(base, rel) {
  const p = path.resolve(base, rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { b += d; if (b.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
  });
}

function openPath(p) {
  const cmd = IS_WIN ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { spawn(cmd, [p], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
}

function uniqueName(dir, name) {
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120) || 'file';
  let n = name, i = 1;
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  while (fs.existsSync(path.join(dir, n))) n = `${stem} (${i++})${ext}`;
  return n;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(res, path.join(ROOT, 'public', 'index.html'), false, true);
    if (url.pathname === '/api/ping') return json({ ok: true, app: 'hola' });
    if (url.pathname === '/avatar') { const f = avatarFile(); if (!f) { res.writeHead(404); return res.end(); } return sendFile(res, f, false, true); }
    if (/^\/(logo\.svg|favicon\.png|icon-192\.png)$/.test(url.pathname)) return sendFile(res, path.join(ROOT, 'public', url.pathname.slice(1)), false, true);
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ type: 'init', convs: convList(), members: publicMembers(), settings, profile: publicProfile(), workspace: WORKSPACE }) + '\n\n');
      clients.add(res);
      lastClientAt = Date.now();
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); lastClientAt = Date.now(); });
      return;
    }
    let mt = url.pathname.match(/^\/api\/conv\/([\w-]+)$/);
    if (mt) {
      const c = convs.get(mt[1]);
      if (!c) return json({ error: 'not found' }, 404);
      return json({ ...convSummary(c), messages: c.messages, memory: readMemory(c) });
    }
    mt = url.pathname.match(/^\/preview\/([\w-]+)\/(.+)$/);
    if (mt) {
      const c = convs.get(mt[1]);
      const rel = decodeURIComponent(mt[2]);
      const p = c && safeJoin(convDir(c), rel);
      if (!p || p.includes(path.sep + '.hola') || !fileExists(p)) { res.writeHead(404); return res.end('not found'); }
      const page = (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" }); res.end(html); };
      const name = path.basename(p);
      try {
        if (office.OFFICE_EXT.test(p)) return page(office.toHtml(office.readOffice(p), name));
        if (/\.(csv|tsv)$/i.test(p)) {
          const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
          const sep = /\.tsv$/i.test(p) ? '\t' : ',';
          const rows = txt.split(/\r?\n/).filter((l) => l.length).slice(0, 1000).map((l) => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; });
          return page(office.previewPage(name, '表格预览（最多显示 1000 行）', office.htmlTable(rows, true)));
        }
        if (/\.(md|txt|json)$/i.test(p)) return page(office.previewPage(name, '文本预览', `<pre>${office.esc(fs.readFileSync(p, 'utf8').slice(0, 500000))}</pre>`));
      } catch (e) { return page(office.previewPage(name, '没法预览这个文件', `<p>${office.esc(e.message)}。可以下载原文件查看。</p>`)); }
      res.writeHead(302, { Location: `/files/${c.id}/${rel.split('/').map(encodeURIComponent).join('/')}` });
      return res.end();
    }
    mt = url.pathname.match(/^\/files\/([\w-]+)\/(.+)$/);
    if (mt) {
      const c = convs.get(mt[1]);
      const p = c && safeJoin(convDir(c), decodeURIComponent(mt[2]));
      if (!p || p.includes(path.sep + '.hola')) { res.writeHead(404); return res.end(); }
      return sendFile(res, p, url.searchParams.has('download'), false, req);
    }
    res.writeHead(404);
    return res.end('not found');
  }

  if (req.method === 'POST' && (url.pathname.startsWith('/api/'))) {
    // 只接受 Hola 自己页面发来的请求
    const origin = req.headers.origin;
    const okOrigin = !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!okOrigin || req.headers['x-hola'] !== '1') { res.writeHead(403); return res.end('forbidden'); }

    if (url.pathname === '/api/profile/avatar') {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[String(req.headers['content-type']).split(';')[0]];
      if (!ext) { res.writeHead(400); return res.end('only png/jpeg/webp'); }
      const chunks = []; let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 5e6) req.destroy(); else chunks.push(d); });
      req.on('end', () => {
        for (const e of ['png', 'jpg', 'webp']) { try { fs.unlinkSync(path.join(DATA_DIR, 'avatar.' + e)); } catch (_) {} }
        fs.writeFileSync(path.join(DATA_DIR, 'avatar.' + ext), Buffer.concat(chunks));
        broadcast({ type: 'profile', profile: publicProfile() });
        json({ ok: true, profile: publicProfile() });
      });
      return;
    }

    if (url.pathname === '/api/upload') {
      const c = convs.get(url.searchParams.get('conv'));
      if (!c) return json({ error: 'no conv' }, 404);
      const dir = path.join(convDir(c), ATTACH_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const name = uniqueName(dir, url.searchParams.get('name') || 'file');
      const dest = path.join(dir, name);
      const ws = fs.createWriteStream(dest);
      let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 500e6) { req.destroy(); ws.destroy(); fs.rm(dest, () => {}); } });
      req.pipe(ws);
      ws.on('finish', () => { convertOffice(c, `${ATTACH_DIR}/${name}`); json(fileInfo(c, `${ATTACH_DIR}/${name}`)); });
      ws.on('error', (e) => json({ error: e.message }, 500));
      return;
    }

    const body = await readBody(req);
    const c = body.conv ? convs.get(body.conv) : null;
    switch (url.pathname) {
      case '/api/conv/new': return json({ id: createConv().id });
      case '/api/conv/rename':
        if (c && body.title) { c.title = String(body.title).slice(0, 60); saveConv(c); broadcastConvList(); }
        return json({ ok: true });
      case '/api/conv/delete':
        if (c) {
          stopConv(c);
          clearTimeout(saveTimers.get(c.id));
          saveTimers.delete(c.id);
          // 彻底删除：聊天记录、对话记忆、记忆历史版本、附件和产出文件全部删掉，不可恢复
          try { fs.rmSync(convDir(c), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { return json({ error: '有文件正被占用，没删干净：' + e.message }, 500); }
          convs.delete(c.id);
          broadcastConvList();
        }
        return json({ ok: true });
      case '/api/send': {
        if (!c) return json({ error: 'no conv' }, 404);
        const text = String(body.text || '').trim();
        const atts = (Array.isArray(body.attachments) ? body.attachments : [])
          .filter((a) => a && a.path && safeJoin(convDir(c), a.path)).map((a) => fileInfo(c, a.path));
        if (text || atts.length) onBossMessage(c, text, atts);
        return json({ ok: true });
      }
      case '/api/stop':
        if (c) stopConv(c, '老板叫停了，大家先停手。');
        return json({ ok: true });
      case '/api/profile': {
        const d = body.profile || {};
        for (const k of PROFILE_FIELDS) if (typeof d[k] === 'string') profile[k] = d[k].trim().slice(0, k === 'bio' || k === 'extra' ? 2000 : 100);
        if (body.removeAvatar) for (const e of ['png', 'jpg', 'webp']) { try { fs.unlinkSync(path.join(DATA_DIR, 'avatar.' + e)); } catch (_) {} }
        saveProfile();
        broadcast({ type: 'profile', profile: publicProfile() });
        return json({ ok: true, profile: publicProfile() });
      }
      case '/api/memory':
        if (c && typeof body.text === 'string') {
          const hist = path.join(convDir(c), '.hola', 'memory-history');
          fs.mkdirSync(hist, { recursive: true });
          const old = readMemory(c);
          if (old && old !== body.text) fs.writeFileSync(path.join(hist, `${new Date().toISOString().replace(/[:.]/g, '-')}-老板修改前.md`), old);
          fs.writeFileSync(path.join(convDir(c), MEMORY_NAME), body.text);
        }
        return json({ ok: true, memory: c ? readMemory(c) : '' });
      case '/api/open':
        openPath(c ? (body.file ? safeJoin(convDir(c), body.file) || convDir(c) : convDir(c)) : WORKSPACE);
        return json({ ok: true });
      case '/api/conv/active':
        if (c && Array.isArray(body.active)) {
          c.active = body.active.filter((id) => members[id]);
          saveConv(c);
          broadcastState(c);
        }
        return json({ ok: true });
      case '/api/members/save': {
        const d = body.member || {};
        const name = String(d.name || '').trim();
        if (!/^[A-Za-z0-9一-龥._-]{1,20}$/.test(name)) return json({ error: '名字只能用中英文、数字和 . _ -，不能有空格，最多 20 个字' }, 400);
        if (ORDER.some((id) => id !== d.id && members[id].name.toLowerCase() === name.toLowerCase())) return json({ error: '已经有同名的队友了' }, 400);
        const color = /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : null;
        let savedId = d.id;
        if (d.id && members[d.id] && members[d.id].builtin) {
          settings.memberPrefs[d.id] = { ...(settings.memberPrefs[d.id] || {}), ...(color ? { color } : {}), ...(typeof d.enabled === 'boolean' ? { enabled: d.enabled } : {}) };
          if (typeof d.strengths === 'string') settings.strengths[d.id] = d.strengths.slice(0, 300);
          saveSettings();
        } else {
          let cm = customMembers.find((x) => x.id === d.id);
          if (!cm) {
            if (d.type === 'api' && !d.apiKey && !/localhost|127\.0\.0\.1/.test(d.baseUrl || '')) return json({ error: '请填写 API Key' }, 400);
            cm = { id: 'm' + crypto.randomBytes(3).toString('hex'), color: color || PALETTE[customMembers.length % PALETTE.length] };
            customMembers.push(cm);
          }
          savedId = cm.id;
          cm.name = name;
          if (color) cm.color = color;
          if (typeof d.strengths === 'string') cm.strengths = d.strengths.slice(0, 300);
          if (typeof d.enabled === 'boolean') cm.enabled = d.enabled;
          delete settings.strengths[cm.id];
          if (d.type === 'api') {
            const old = cm.api || {};
            cm.type = 'api';
            cm.api = { baseUrl: String(d.baseUrl || '').trim(), model: String(d.model || '').trim(), apiKey: d.apiKey ? String(d.apiKey).trim() : old.apiKey || '', temperature: d.temperature ?? '' };
            delete cm.cmd; delete cm.args; delete cm.parser; delete cm.readOnly; delete cm.versionCheck;
          } else if (d.type === 'cli') {
            cm.type = 'cli';
            cm.cmd = String(d.cmd || '').trim();
            cm.args = splitArgs(String(d.argsText || ''));
            cm.parser = PARSERS.includes(d.parser) ? d.parser : 'plain';
            cm.readOnly = !!d.readOnly;
            cm.versionCheck = d.versionCheck !== false;
            delete cm.api;
          }
          saveCustomMembers();
        }
        buildMembers();
        checkChanged();
        return json({ ok: true, id: savedId });
      }
      case '/api/members/delete': {
        const i = customMembers.findIndex((x) => x.id === body.id);
        if (i >= 0) { customMembers.splice(i, 1); saveCustomMembers(); buildMembers(); checkChanged(); }
        return json({ ok: true });
      }
      case '/api/members/test': {
        const m = members[body.id];
        if (!m) return json({ ok: false, error: '找不到这位队友' });
        const out = await testMember(m);
        broadcast({ type: 'members', members: publicMembers() });
        return json(out);
      }
      case '/api/recheck':
        checkAll();
        return json({ ok: true });
      case '/api/settings':
        if (body.maxDiscussRounds) settings.maxDiscussRounds = Math.max(1, Math.min(6, Number(body.maxDiscussRounds) || 3));
        if (body.conclusionBy && members[body.conclusionBy]) settings.conclusionBy = body.conclusionBy;
        if (typeof body.autoMemory === 'boolean') settings.autoMemory = body.autoMemory;
        if (body.maxAutoTurns) settings.maxAutoTurns = Math.max(0, Math.min(50, Number(body.maxAutoTurns) || 10));
        if (body.strengths && typeof body.strengths === 'object') {
          for (const [k, v] of Object.entries(body.strengths)) if (members[k]) settings.strengths[k] = String(v).slice(0, 300);
        }
        saveSettings();
        broadcast({ type: 'settings', settings, members: publicMembers() });
        return json({ ok: true });
      case '/api/quit':
        json({ ok: true });
        for (const cc of convs.values()) if (cc.rt && cc.rt.running) stopConv(cc);
        setTimeout(() => process.exit(0), 300);
        return;
    }
  }
  res.writeHead(404);
  res.end('not found');
});

loadConvs();

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log(`Hola 已启动：${link}  工作文件夹：${WORKSPACE}`);
  if (!HIDDEN) {
    console.log('\n  关掉这个窗口 Hola 就会停止。平时双击桌面的 Hola 图标更方便。\n');
    if (!process.env.NO_OPEN) {
      if (IS_WIN) spawn('cmd', ['/c', 'start', '', link], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else if (process.platform === 'darwin') spawn('open', [link], { detached: true, stdio: 'ignore' }).unref();
    }
  }
  checkAll();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`端口 ${PORT} 已被占用：Hola 可能已经在运行了，直接打开 http://localhost:${PORT} 即可。`);
  else console.error(e);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});

// 静默运行时：窗口全部关掉、也没有活在跑，30 分钟后自动退出
if (HIDDEN) {
  setInterval(() => {
    if (!clients.size && !anyRunning() && Date.now() - lastClientAt > 30 * 60 * 1000) process.exit(0);
  }, 60 * 1000);
}
