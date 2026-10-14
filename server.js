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

const DEFAULT_SETTINGS = { uiLang: '', maxDiscussRounds: 3, conclusionBy: 'claude', maxAutoTurns: 10, autoMemory: true, showProcess: false, strengths: {}, memberPrefs: {} };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
// 界面语言：zh / en。T('中文', 'English') 按当前语言取一句
const EN = () => settings.uiLang === 'en';
const syncLang = () => { office.lang = EN() ? 'en' : 'zh'; };
syncLang();
const T = (zh, en) => (EN() ? en : zh);
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

// 权限：认得的三种命令行（Claude / Codex / Antigravity）可以在界面上一键切换"安全"和"完全权限"，
// 不用再手改 config.json。老板没切换过时，按 config.json 里写的参数判断当前是哪种。
const FULL_FLAG = { 'claude-stream': '--dangerously-skip-permissions', 'codex-json': '--dangerously-bypass-approvals-and-sandbox', 'agy-json': '--dangerously-skip-permissions' };
const SAFE_ARGS = { 'claude-stream': ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch'], 'codex-json': ['--sandbox', 'workspace-write'], 'agy-json': [] };
const ACCESS_FLAGS = { 'claude-stream': ['--permission-mode', '--allowedTools', '--allowed-tools'], 'codex-json': ['--sandbox', '-s'], 'agy-json': [] };
function accessOf(def) {
  if (def.type === 'api' || !FULL_FLAG[def.parser]) return null;
  const a = def.args || [];
  const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : ''; };
  const full = a.includes(FULL_FLAG[def.parser]) || (def.parser === 'claude-stream' && val('--permission-mode') === 'bypassPermissions') ||
    (def.parser === 'codex-json' && /danger-full-access/.test(val('--sandbox') + val('-s')));
  return full ? 'full' : 'safe';
}
function withAccess(def, want) {
  const p = def.parser;
  let args = [];
  const src = def.args || [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === FULL_FLAG[p] || (p === 'codex-json' && src[i] === '--full-auto')) continue;
    if (ACCESS_FLAGS[p].includes(src[i])) { i++; continue; }
    args.push(src[i]);
  }
  const add = want === 'full' ? [FULL_FLAG[p]] : SAFE_ARGS[p];
  const at = p === 'codex-json' && args.includes('exec') ? args.indexOf('exec') + 1 : p === 'claude-stream' && args.includes('-p') ? args.indexOf('-p') + 1 : args.length;
  args = [...args.slice(0, at), ...add, ...args.slice(at)];
  // Antigravity 不加完全权限时没法在后台确认写文件，只能当只读队友
  return { args, readOnly: p === 'agy-json' ? want !== 'full' : want === 'full' ? false : !!def.readOnly };
}

// 模型：认得的三种命令行可以在界面上选模型，存在 settings.memberPrefs[id].model（空 = 用工具自己的默认设置）
const MODEL_FLAG = { 'claude-stream': '--model', 'codex-json': '-m', 'agy-json': '--model' };
// 模型名会拼进命令行（.cmd 要经过 cmd.exe），只允许安全字符
const MODEL_RE = /^[A-Za-z0-9._:/\[\]-]{1,80}$/;
const isModelFlag = (a, parser) => a === '--model' || (parser === 'codex-json' && a === '-m');
function modelInArgs(args, parser) {
  const i = (args || []).findIndex((a) => isModelFlag(a, parser));
  return i >= 0 ? args[i + 1] || '' : '';
}
function withModel(args, parser, model) {
  const out = [];
  for (let i = 0; i < args.length; i++) { if (isModelFlag(args[i], parser)) { i++; continue; } out.push(args[i]); }
  const at = parser === 'codex-json' && out.includes('exec') ? out.indexOf('exec') + 1 : parser === 'claude-stream' && out.includes('-p') ? out.indexOf('-p') + 1 : out.length;
  return [...out.slice(0, at), MODEL_FLAG[parser], model, ...out.slice(at)];
}
// 思考深度：Claude / Antigravity 用 --effort，Codex 用 -c model_reasoning_effort=…；只接受下面这几个值
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const isEffortArg = (args, i, parser) => parser === 'codex-json'
  ? (args[i] === '-c' || args[i] === '--config') && /^model_reasoning_effort=/.test(args[i + 1] || '')
  : args[i] === '--effort';
function effortInArgs(args, parser) {
  const i = (args || []).findIndex((_, k) => isEffortArg(args, k, parser));
  return i >= 0 ? String(args[i + 1] || '').replace(/^model_reasoning_effort=/, '').replace(/"/g, '') : '';
}
function withEffort(args, parser, effort) {
  const out = [];
  for (let i = 0; i < args.length; i++) { if (isEffortArg(args, i, parser)) { i++; continue; } out.push(args[i]); }
  const add = parser === 'codex-json' ? ['-c', 'model_reasoning_effort=' + effort] : ['--effort', effort];
  const at = parser === 'codex-json' && out.includes('exec') ? out.indexOf('exec') + 1 : parser === 'claude-stream' && out.includes('-p') ? out.indexOf('-p') + 1 : out.length;
  return [...out.slice(0, at), ...add, ...out.slice(at)];
}
// Codex 没选模型 / 思考深度时，用的是它自己 config.toml 里的设置
function codexConfig(key) {
  try {
    const t = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
    const mt = t.match(new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]+)"', 'm'));
    return mt ? mt[1] : '';
  } catch (_) { return ''; }
}
const codexDefaultModel = () => codexConfig('model');

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
    m.access = accessOf(def);
    if (m.access && (pref.access === 'full' || pref.access === 'safe') && pref.access !== m.access) {
      Object.assign(m, withAccess(def, pref.access));
      m.access = pref.access;
    }
    if (m.type === 'api') m.model = (def.api || {}).model || '';
    else if (MODEL_FLAG[def.parser]) {
      if (pref.model && MODEL_RE.test(pref.model)) m.args = withModel(m.args || [], def.parser, pref.model);
      if (EFFORTS.includes(pref.effort)) m.args = withEffort(m.args || [], def.parser, pref.effort);
      m.model = modelInArgs(m.args, def.parser);
      m.effort = effortInArgs(m.args, def.parser);
    }
    // Codex 能直接看图片：用 --image= 把老板发的图片交给它
    if (m.cmd === 'codex' && !m.imageFlag) Object.assign(m, { imageFlag: '--image=', imageFlagAfter: 'exec' });
  };
  for (const [id, m] of Object.entries(cfg.members)) add(id, m, true);
  for (const m of customMembers) add(m.id, m, false);
  ORDER = Object.keys(members);
}
buildMembers();
const STRENGTHS_EN = {
  claude: 'Planning and breaking down work, writing and strategy, reasoning, quality review',
  codex: 'Writing code, running scripts, spreadsheets and data, file conversion, small tools',
  gemini: 'Reading and summarising long material, images and video, web research',
};
const strengthsOf = (m) => settings.strengths[m.id] || (EN() && m.builtin && STRENGTHS_EN[m.id]) || m.strengths || '';
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
  if (!m.enabled) { m.problem = T('已停用', 'Disabled'); return; }
  m.problem = T('检查中…', 'Checking…');
  if (m.type === 'api') {
    const a = m.api || {};
    const local = /localhost|127\.0\.0\.1/.test(a.baseUrl || '');
    if (!a.baseUrl || !a.model || (!a.apiKey && !local)) { m.problem = T('还没填完整：需要接口地址、模型名和 API Key', 'Incomplete: needs an API address, model name and API key'); return; }
    m.online = true; m.problem = ''; m.version = a.model;
    return;
  }
  if (!m.cmd) { m.problem = T('还没填命令', 'No command set'); return; }
  const r = await resolveCmd(m.cmd);
  if (!r) { m.problem = T(`没找到 ${m.cmd} 命令：还没安装，或装完后要重新打开 Hola`, `Can't find the ${m.cmd} command: not installed yet, or Hola needs a restart after installing`); return; }
  m.resolved = r;
  if (m.versionCheck === false) { m.online = true; m.problem = ''; m.version = path.basename(r.file); return; }
  await new Promise((resolve) => {
    const chunks = [];
    let child;
    try { child = spawnMember(m, ['--version'], { cwd: WORKSPACE, env: cleanEnv() }); }
    catch (e) { m.problem = T('无法启动：', 'Failed to start: ') + e.message; return resolve(); }
    const t = setTimeout(() => killTree(child), 30000);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('error', (e) => { m.problem = T('无法启动：', 'Failed to start: ') + e.message; });
    child.on('close', (code) => {
      clearTimeout(t);
      const out = stripAnsi(decodeOut(Buffer.concat(chunks))).trim();
      if (code === 0) { m.online = true; m.problem = ''; m.version = out.split(/\r?\n/).pop().slice(0, 60); }
      else if (/^(检查中…|Checking…)$/.test(m.problem)) m.problem = T(`${m.cmd} --version 运行失败：`, `${m.cmd} --version failed: `) + out.slice(0, 200);
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

// 编辑队友时的模型下拉：Claude 用别名；Codex 读它自己的模型列表；Antigravity 运行 agy models（联网，缓存 10 分钟）
let agyModels = { at: 0, list: [] };
async function modelChoices(m) {
  const r = await modelChoicesRaw(m);
  const pref = settings.memberPrefs[m.id] || {};
  // 思考深度：Codex 每个模型支持的档位不同（efforts 按模型给），其他两家固定这几档
  const base = EFFORTS.slice(0, 5);
  return { ...r, current: pref.model || '', effort: pref.effort || '', efforts: r.efforts || { '': base }, effortHint: r.effortHint || '' };
}
async function modelChoicesRaw(m) {
  if (m.parser === 'claude-stream') return { defaultHint: '', choices: ['fable', 'opus', 'sonnet'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) };
  if (m.parser === 'codex-json') {
    let choices = [];
    const efforts = {};
    try {
      const j = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'));
      const list = (j.models || []).filter((x) => x && x.slug && x.visibility === 'list');
      choices = list.map((x) => ({ id: x.slug, label: x.display_name || x.slug }));
      for (const x of list) efforts[x.slug] = (x.supported_reasoning_levels || []).map((e) => e.effort).filter((e) => EFFORTS.includes(e));
    } catch (_) {}
    efforts[''] = efforts[codexDefaultModel()] || EFFORTS.slice(0, 5);
    return { defaultHint: codexDefaultModel(), choices, efforts, effortHint: codexConfig('model_reasoning_effort') };
  }
  if (m.parser === 'agy-json') {
    if (Date.now() - agyModels.at > 600000 && m.resolved) {
      const out = await new Promise((resolve) => {
        const chunks = [];
        let child;
        try { child = spawnMember(m, ['models'], { cwd: WORKSPACE, env: cleanEnv() }); } catch (_) { return resolve(''); }
        const t = setTimeout(() => killTree(child), 20000);
        child.stdout.on('data', (d) => chunks.push(d));
        child.on('error', () => resolve(''));
        child.on('close', () => { clearTimeout(t); resolve(stripAnsi(decodeOut(Buffer.concat(chunks)))); });
      });
      const list = out.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length >= 2 && MODEL_RE.test(p[0].trim()))
        .map(([id, label]) => ({ id: id.trim(), label: label.trim(), other: !/^gemini/i.test(id.trim()) }));
      if (list.length) agyModels = { at: Date.now(), list };
    }
    return { defaultHint: '', choices: agyModels.list };
  }
  return { defaultHint: '', choices: [] };
}

function publicMembers() {
  return ORDER.map((id) => members[id]).map((m) => ({
    id: m.id, name: m.name, color: m.color, strengths: strengthsOf(m), readOnly: !!m.readOnly,
    online: m.online, version: m.version, problem: m.problem, type: m.type, builtin: !!m.builtin, enabled: m.enabled, access: m.access,
    model: m.model || '', effort: m.effort || '', modelPick: m.type !== 'api' && !!MODEL_FLAG[m.parser],
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

const MEMORY_TEMPLATE_EN = `# Conversation memory

## Goal and background

## Boss's preferences and requirements

## Decisions made

## Progress and to-dos

## Key files
`;
const memTemplate = () => (EN() ? MEMORY_TEMPLATE_EN : MEMORY_TEMPLATE);

// ---------------------------------------------------------------- 项目（把相关的对话 / 任务归到一起）

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
let projects = [];
try { projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch (_) {}
function saveProjects() { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2)); }
function broadcastProjects() { broadcast({ type: 'projects', projects }); }
const projectOf = (c) => (c && c.project ? projects.find((p) => p.id === c.project) : null);

// 同一项目里的其他任务各自定下了什么，节选它们对话记忆里的"已定结论"和"进度"
function memSection(text, names) {
  const parts = String(text || '').split(/\n(?=## )/);
  return parts.filter((x) => names.some((n) => x.startsWith('## ' + n))).map((x) => x.replace(/^## [^\n]*\n/, '').trim()).filter((x) => x && !/^…+$/.test(x)).join('\n');
}
function projectText(c) {
  const p = projectOf(c);
  if (!p) return '';
  const sibs = [...convs.values()].filter((x) => x.project === p.id && x.id !== c.id).sort((a, b) => b.updated - a.updated).slice(0, 12);
  const lines = sibs.map((x) => {
    const got = memSection(readMemory(x), ['已经定下的结论', '进度与待办', 'Decisions made', 'Progress and to-dos']);
    return `- 「${x.title}」（${x.status === 'done' ? '已完成' : '进行中'}，文件夹 ../${x.id}/）${got ? '：' + clip(got.replace(/\n+/g, '；'), 400) : ''}`;
  });
  return `【所属项目：${p.name}】这个对话是项目里的一个任务。做事要服务于项目目标，和同项目其他任务的结论保持一致；需要时可以读它们文件夹里的文件。
项目说明：${p.brief || '（老板还没写）'}
${lines.length ? '同项目的其他任务：\n' + lines.join('\n') : '这是项目里的第一个任务。'}

`;
}

function createConv(title, project) {
  const c = { id: newId(), title: title || T('新对话', 'New chat'), created: Date.now(), updated: Date.now(), messages: [], seq: 0, rt: null, project: project && projects.some((p) => p.id === project) ? project : null, status: 'doing' };
  fs.mkdirSync(path.join(convDir(c), '.hola'), { recursive: true });
  fs.writeFileSync(path.join(convDir(c), MEMORY_NAME), memTemplate());
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
    id: c.id, title: c.title, updated: c.updated, created: c.created, project: c.project || null, status: c.status || 'doing',
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
  const item = { k: kind, t: clip(text, 3000), ts: Date.now() };
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

// 用量统一记成 { input（含缓存）, cached, output }，各家口径不同，在这里换算
function addUsage(msg, u) {
  if (!msg || !u) return;
  const n = (x) => (Number.isFinite(+x) ? +x : 0);
  const cur = msg.usage || { input: 0, cached: 0, output: 0 };
  msg.usage = { input: cur.input + n(u.input), cached: cur.cached + n(u.cached), output: cur.output + n(u.output) };
}

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
        } else if (o.type === 'system' && o.subtype === 'init' && o.model) {
          msg.model = o.model;
        } else if (o.type === 'result') {
          const u = o.usage || {};
          // Claude 的 input_tokens 不含缓存读写，要加上
          if (o.usage) addUsage(msg, { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), cached: u.cache_read_input_tokens, output: u.output_tokens });
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
        if (o.type === 'turn.completed' && o.usage) addUsage(msg, { input: o.usage.input_tokens, cached: o.usage.cached_input_tokens, output: o.usage.output_tokens });
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
        if (e && e.usage) addUsage(msg, { input: e.usage.input_tokens, cached: e.usage.cache_read_tokens, output: e.usage.output_tokens });
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
    const body = { model: a.model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: prompt }] };
    if (a.temperature !== '' && a.temperature != null && !isNaN(+a.temperature)) body.temperature = +a.temperature;
    proc('tool', `调用接口：${a.model}`);
    const call = () => fetch(String(a.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(a.apiKey ? { Authorization: 'Bearer ' + a.apiKey } : {}) },
      body: JSON.stringify(body),
    });
    let res = await call();
    let raw = '';
    // 个别服务商不认 stream_options（用来要用量），去掉再试一次
    if (res.status === 400) { raw = await res.text(); if (/stream_options|include_usage/i.test(raw)) { delete body.stream_options; res = await call(); raw = ''; } }
    // 有的服务商每个分片都带累计用量：只取最后一次，不累加
    const usageOf = (u) => u && msg && (delete msg.usage, addUsage(msg, { input: u.prompt_tokens, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens, output: u.completion_tokens }));
    if (!res.ok) {
      raw = raw || await res.text();
      let detail = raw.slice(0, 300);
      try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error)) || j.message || detail; } catch (_) {}
      const hint = (EN() ? { 401: 'Invalid or expired API key', 402: 'Insufficient balance', 403: 'No permission to use this model', 404: 'Wrong API address or model name', 429: 'Rate limited, or out of quota' } : { 401: 'API Key 不对或已失效', 402: '账户余额不足', 403: '没有权限使用这个模型', 404: '接口地址或模型名不对', 429: '调用太频繁，或额度用完了' })[res.status];
      err = `${hint ? hint + T('。', '. ') : ''}${T('接口返回', 'API returned')} HTTP ${res.status}${T('：', ': ')}${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    } else if (!String(res.headers.get('content-type') || '').includes('event-stream')) {
      const o = await res.json();
      usageOf(o.usage);
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
          if (o.usage) usageOf(o.usage);
          const delta = (o.choices && o.choices[0] && (o.choices[0].delta || o.choices[0].message)) || {};
          if (delta.reasoning_content || delta.reasoning) { think += delta.reasoning_content || delta.reasoning; flushThink(false); }
          if (delta.content) text += delta.content;
        }
      }
      flushThink(true);
    }
    if (!text && !err) err = T('接口没有返回内容', 'The API returned nothing');
  } catch (e) {
    err = e.name === 'AbortError' ? T('已停止', 'Stopped') : T('连不上接口：', "Can't reach the API: ") + ((e.cause && (e.cause.code || e.cause.message)) || e.message);
  }
  clearTimeout(timer);
  if (r) r.children.delete(handle);
  return { code: err ? 1 : 0, text: text.trim(), err };
}

async function runMember(c, m, prompt, msg, images) {
  // 记下这次实际用的模型（之后改了设置，旧消息仍显示当时的模型）；Claude 会在输出里报告更准确的名字
  if (msg) {
    msg.model = m.model || (m.parser === 'codex-json' ? codexDefaultModel() : '') || undefined;
    msg.effort = m.effort || (m.parser === 'codex-json' ? codexConfig('model_reasoning_effort') : '') || undefined;
  }
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
  const ph = m.reason === 'initial' ? ' · 独立作答' : m.reason === 'discuss' ? ` · 讨论第${m.round}轮${m.stance === 'object' ? ' · 有异议' : m.stance === 'agree' ? ' · 同意' : ''}` : m.reason === 'conclusion' ? (m.awaitDecision ? ' · 团队结论（有分歧，请老板拍板）' : ' · 团队结论') : m.reason === 'decided' ? ' · 按老板拍板执行' : m.reason === 'decision' ? ' · 拍板' : '';
  const opts = (m.options || []).length ? '\n' + m.options.map((o) => `【方案${o.key}】${o.text}`).join('\n') : '';
  return `[${nameOf(m.from)}${ph}] ${clip(m.text, 4000)}${opts}${att}`;
}

function transcript(c) {
  const msgs = c.messages.filter((m) => (m.text || (m.attachments || []).length) && m.status !== 'running' && m.reason !== 'memory' && m.reason !== 'skill');
  let pick = msgs.slice(-50);
  const firstBoss = msgs.find((m) => m.from === 'boss');
  if (firstBoss && !pick.includes(firstBoss)) pick = [firstBoss, { from: 'system', text: '（中间较早的记录已省略，要点见对话记忆）' }, ...pick];
  return pick.map(msgLine).join('\n\n');
}

function transcriptMd(c) {
  return `# ${c.title}\n\n` + c.messages.filter((m) => m.text || (m.attachments || []).length).map((m) =>
    `### ${nameOf(m.from)} · ${new Date(m.ts).toLocaleString('zh-CN', { hour12: false })}\n\n${m.text}\n` +
    (m.options || []).map((o) => `- **方案${o.key}**${m.decided === o.key ? '（老板选了这个）' : ''}：${o.text}\n`).join('') +
    [...(m.attachments || []), ...(m.files || [])].map((f) => `- 📎 ${f.path}`).join('\n')).join('\n');
}

const TAG_NEED = /^[ \t>*_]*【?\s*需要讨论\s*】?\s*[:：]?\s*(是|否)\s*[*_]*\s*$/m;
const TAG_STANCE = /^[ \t>*_]*【?\s*立场\s*】?\s*[:：]?\s*(同意|有异议)\s*[*_]*\s*$/m;
const TAG_OPTION = /^[ \t>*_#-]*(?:\d+[.、)）]\s*)?[ \t*_]*【\s*方案\s*([A-Da-dＡ-Ｄａ-ｄ1-4１-４])\s*】\s*[:：]?\s*(.+?)\s*[*_]*\s*$/gm;

// 没谈拢时，结论里的【方案A】… 行拆出来做成按钮
function extractOptions(text) {
  const options = [];
  const out = text.replace(TAG_OPTION, (_, k, t) => {
    let key = k.replace(/[Ａ-Ｚａ-ｚ１-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).toUpperCase();
    if (/\d/.test(key)) key = 'ABCD'[Number(key) - 1];
    if (!options.some((o) => o.key === key)) options.push({ key, text: t.replace(/^\*+|\*+$/g, '').trim().slice(0, 300) });
    return '';
  });
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), options };
}

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
      if (!turn.consensus) return `团队讨论结束：讨论了 ${turn.rounds} 轮，仍有分歧。由你代表团队给老板写结论，请老板拍板。
- 开头用一两句话说清楚大家在哪些地方已经一致、卡在哪个分歧上，不要复述过程。
- 把可选的做法整理成 2～3 个方案，每个方案单独一行，严格用这个格式（标签保持中文，哪怕你用英文回复）：
【方案A】一句话说清这个方案（支持：名字、名字）
【方案B】……
- 方案行之后，简要写各方的理由，再写一句你建议老板选哪个、为什么。
- 老板拍板之前谁都不动手：这次不要 @ 任何人，也不要生成正式交付文件。`;
      return `团队讨论结束：大家已经达成共识。由你代表团队，给老板写最终结论。
- 开头直接给出答案、方案或决定，吸收讨论中有价值的部分，不要复述过程。
- 可以用一两句话点出讨论中最关键的取舍。
- 如果结论需要动手执行（做文件、写代码、出图等），在最后按分工写"@名字 + 具体任务"，队友会自动接手；你也可以自己做你那部分。`;
    case 'decided':
      return `团队讨论没谈拢，老板已经拍板（见群聊最后一条老板的消息）。不要再讨论，照老板的决定执行：
- 开头一句话复述老板的决定。
- 需要动手的部分按分工写"@名字 + 具体任务"，队友会自动接手；你也可以自己做你那部分。
- 如果老板这条消息其实还没做决定（只是追问、或者补充了要求），就直接回答他，这次不要 @ 任何人，也不要开始做交付文件。`;
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

const LOGIN_BAT = { claude: 'Login-Claude.bat', codex: 'Login-Codex.bat', gemini: 'Login-Gemini.bat' };
function loginHint(m) {
  if (m.type === 'api') return T('\n\n常见原因：API Key 不对、余额不足，或模型名写错了。', '\n\nCommon causes: wrong API key, no balance left, or a wrong model name.');
  const how = LOGIN_BAT[m.id] ? T(`双击 Hola 文件夹里的 ${LOGIN_BAT[m.id]} 重新登录`, `double-click ${LOGIN_BAT[m.id]} in the Hola folder to sign in again`)
    : T(`在终端运行一次 ${m.cmd} 重新登录`, `run ${m.cmd} once in a terminal to sign in again`);
  const picked = (settings.memberPrefs[m.id] || {}).model;
  return T(`\n\n常见原因：登录过期（${how}），或订阅额度用完。`, `\n\nCommon causes: the sign-in expired (${how}), or the subscription quota ran out.`) +
    (picked ? T(`也可能是选的模型 ${picked} 这个订阅用不了：到"队友 → 编辑"把模型改回"默认"。`, ` Or the chosen model ${picked} isn't available on this subscription: set it back to "Default" under Teammates → Edit.`) : '');
}
function replyLangRule() {
  if (profile.language === 'en') return '用英文（English）回复。';
  if (profile.language === 'zh') return '用中文回复。';
  if (profile.language === 'follow') return '用老板最近一条消息所用的语言回复。';
  return EN() ? '老板使用英文界面：用英文（English）回复，除非老板用中文跟你说话。' : '用中文回复，除非老板用其他语言跟你说话。';
}

function agentPrompt(c, m, turn) {
  curActive = c.active || null;
  const discussing = turn.reason === 'initial' || turn.reason === 'discuss' || (turn.reason === 'conclusion' && !turn.consensus);
  return `你是 Hola 团队里的 ${m.name}。Hola 是几位 AI 平等协作的团队，老板（用户）是包工头：他用 @ 指定谁来做、按什么顺序做；没点名时，参与的队友先各自思考，再自己讨论出结论。

团队成员：
${rosterText(m.id)}

基本规则：
1. 大家地位平等，各自发挥长处：可以补充、质疑、接着往下做，不要重复队友已经说过的话。
2. ${discussing ? '讨论阶段提到队友时直接写名字就行，不要用 @（@ 表示正式交活）。' : '需要队友动手时，写"@名字 + 具体要做的事"，他会自动接手。只在真的需要对方动手时才 @，不要 @ 自己，也不要 @ 标着"这次没有参与"的队友。'}
3. ${m.type === 'api' ? '你是通过 API 接入的，不能读写文件、不能联网：只根据群聊内容和附在最后的附件文字来思考和写作；需要做文件或查资料时，请能做的队友来做。' : `当前目录是这个对话的专属文件夹。交付物放在这里，取清楚的文件名，并在回复里写明。生成的图片、视频、音频也一定要保存到当前目录（不要只留在你自己的界面或临时目录里），老板才能在群里直接看到和下载。老板发来的附件在"${ATTACH_DIR}"文件夹里。Word、Excel、PPT 文件都有系统自动转好的文字版（在"${TEXT_DIR}"文件夹，文件列表里有标注），读不了原文件时就读文字版。`}
4. "${MEMORY_NAME}"是本对话的记忆：系统会在每轮结束后自动整理，你不用改它，但要遵守里面记下的偏好和结论。
5. ${replyLangRule()}像在工作群里说话：先给结论，简洁具体。
6. 下面有【Hola 技能库】时：动手前看一眼，任务符合某个技能就照着做；用了的话，在回复第一行单独写"【技能】技能名"。

${profileText()}${projectText(c)}${skillsPromptText(c, m)}【本对话记忆（${MEMORY_NAME}）】
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
  const pending = pendingDecision(c);
  const { ids, all } = mentionsIn(text, null);
  // 有一条结论在等老板拍板时，没 @ 人的回复就当作拍板
  const isDecision = !!(pending && text && !ids.length && !all);
  newMsg(c, 'boss', text, { attachments, ...(isDecision ? { reason: 'decision' } : {}) });
  if ((c.title === '新对话' || c.title === 'New chat') && text) {
    c.title = text.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, EN() ? 40 : 20) || T('新对话', 'New chat');
    saveConv(c);
  }
  broadcastConvList();
  const r = rt(c);
  if (isDecision) { decide(c, pending); return; }
  if (pending) { pending.decided = 'other'; update(c, pending); }
  if (!ids.length && !activeIds(c).length) { sys(c, T('这次没有可以干活的队友：要么都没勾选参与，要么不在线。在输入框下方的"参与"里选几位，或者点右上角的光点看原因。', 'No teammate can take this: none are selected, or none are online. Pick some under "Working" below the input box, or click the lights at the top right to see why.')); return; }

  if (ids.length && !all) {
    // 点了名：按 @ 的先后顺序依次来
    ids.forEach((id, i) => r.jobs.push({ type: 'turn', member: id, reason: 'mention', after: ids.slice(0, i) }));
    r.hops = 0;
  } else if (r.running && r.phase === 'discuss') {
    sys(c, T('大家会在下一轮讨论里看到老板这条消息。', 'The team will see this message in the next discussion round.'));
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
      if (job.type === 'skill') { await distillSkill(c, myGen, job); continue; }
      const m = members[job.member];
      if (!m || !m.online) { sys(c, T(`${m ? m.name : job.member} 不在线，跳过。`, `${m ? m.name : job.member} is offline, skipped.`)); continue; }
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
    sys(c, k === 1 ? T('有值得讨论的地方，进入内部讨论 · 第 1 轮', 'Worth discussing: internal discussion · round 1') : T(`还有分歧，继续讨论 · 第 ${k} 轮`, `Still disagreeing: discussion · round ${k}`), { divider: true });
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
  sys(c, consensus ? T(`达成共识，由 ${nameOf(writer)} 整理团队结论`, `Consensus reached, ${nameOf(writer)} writes the team conclusion`) : T(`讨论 ${rounds} 轮仍有分歧，由 ${nameOf(writer)} 整理结论并写明分歧`, `Still split after ${rounds} rounds, ${nameOf(writer)} writes the conclusion and notes the disagreement`), { divider: true });
  r.phase = 'conclusion';
  broadcastState(c);
  const before = listFiles(c);
  const msg = await agentTurn(c, members[writer], { reason: 'conclusion', flow, consensus, rounds }, myGen);
  if (!msg || myGen !== r.gen) return;
  attachFiles(c, before, [msg]);
  if (consensus) { queueHandoffs(c, members[writer], msg); return; }
  // 没谈拢：先停下等老板拍板，哪怕结论里 @ 了人也不派活
  if (msg.status !== 'done') return;
  msg.awaitDecision = true;
  update(c, msg);
}

// 等老板拍板的那条结论（之后老板还没说过话）
function pendingDecision(c) {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.from === 'boss') return null;
    if (m.reason === 'conclusion') return m.awaitDecision && !m.decided ? m : null;
  }
  return null;
}

// 老板拍板：记下决定，交给写结论的那位按决定分工
function decide(c, concl, key) {
  concl.decided = key || 'custom';
  update(c, concl);
  const writer = members[concl.from] && members[concl.from].online && activeIds(c).includes(concl.from) ? concl.from : activeIds(c)[0];
  if (!writer) { sys(c, T('现在没有在线的队友可以执行。', 'No teammate is online to carry this out.')); return; }
  const r = rt(c);
  r.jobs.push({ type: 'turn', member: writer, reason: 'decided' });
  r.hops = 0;
  if (!r.running) pump(c); else broadcastState(c);
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
  if (left.size) sys(c, T(`这一轮新增或修改了：${[...left].slice(0, 12).join('、')}`, `Added or changed this round: ${[...left].slice(0, 12).join(', ')}`));
}

function queueHandoffs(c, m, msg) {
  const r = rt(c);
  if (msg.status !== 'done') return;
  const { ids } = mentionsIn(msg.text, m.id);
  const act = activeIds(c);
  for (const id of ids) {
    if (r.jobs.some((q) => q.type === 'turn' && q.member === id)) continue;
    if (!act.includes(id)) { sys(c, T(`${nameOf(id)} 这次没有参与（或不在线），${nameOf(m.id)} 交给 Ta 的活没有派出去。需要的话，老板可以直接 @ Ta。`, `${nameOf(id)} isn't working on this (or is offline), so ${nameOf(m.id)}'s hand-off wasn't sent. @ them directly if you want them in.`)); continue; }
    if (r.hops >= settings.maxAutoTurns) {
      sys(c, T(`队友之间已经自动接力 ${settings.maxAutoTurns} 次了，先停一下，等老板看一眼再继续。`, `Teammates have handed off ${settings.maxAutoTurns} times in a row. Pausing here so you can take a look.`));
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
  return c.messages.filter((m) => seqOf(m) > mark && m.reason !== 'memory' && m.reason !== 'skill' && m.status !== 'running' &&
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
- ${EN() ? '记忆内容和【本次变化】那句话都用英文写，五个小标题沿用当前记忆里的英文标题。' : '记忆内容用中文写。'}

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
${readMemory(c) || memTemplate()}

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
    msg.text = T('这一轮没有需要长期记住的新内容。', 'Nothing new worth remembering this round.');
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
      msg.text = change ? change.trim() : T('已更新对话记忆。', 'Conversation memory updated.');
      msg.status = 'done';
      msg.memoryChanged = true;
    } catch (e) {
      msg.text = T('写入对话记忆失败：', 'Failed to write memory: ') + e.message;
      msg.status = 'error';
    }
  } else {
    msg.text = T('整理记忆没成功，下一轮会再试。', "Couldn't update memory, will retry next round.") + (res.err ? '\n' + clip(res.err, 300) : '');
    msg.status = 'error';
  }
  if (msg.status !== 'error') c.memMark = lastSeq;
  update(c, msg);
  if (msg.memoryChanged) broadcast({ type: 'memory', conv: c.id, memory: readMemory(c) });
  broadcastState(c);
}

// ---------------------------------------------------------------- 技能库（所有对话、所有队友共用）
// 每个技能是 data/skills/<id>/SKILL.md（和 Claude Skills 一样的格式：开头 name / description，后面是做法），
// 同一文件夹里还可以放模板、脚本等文件。队友干活前会看技能索引，用到时读 SKILL.md。

const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const SKILLS_META = path.join(DATA_DIR, 'skills-meta.json');
let skillMeta = {};
try { skillMeta = JSON.parse(fs.readFileSync(SKILLS_META, 'utf8')); } catch (_) {}
function saveSkillMeta() { fs.writeFileSync(SKILLS_META, JSON.stringify(skillMeta, null, 2)); }

function parseSkill(text) {
  text = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const out = { name: '', description: '', body: fm ? fm[2] : text };
  if (fm) {
    let key = null;
    for (const line of fm[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (kv) { key = kv[1].toLowerCase(); const v = kv[2].trim().replace(/^["']|["']$/g, ''); if (key === 'name') out.name = v; else if (key === 'description') out.description = v === '|' || v === '>' ? '' : v; }
      else if (key === 'description' && line.trim()) out.description += (out.description ? ' ' : '') + line.trim();
    }
  }
  if (!out.name) { const h = out.body.match(/^#\s+(.+)$/m); if (h) out.name = h[1].trim(); }
  out.body = out.body.trim();
  return out;
}
const yamlStr = (s) => (/^[\w一-鿿][^:#\n]*$/.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s));
function skillText(sk) { return `---\nname: ${yamlStr(sk.name)}\ndescription: ${yamlStr(sk.description.replace(/\s*\n\s*/g, ' '))}\n---\n\n${sk.body.trim()}\n`; }

function skillSlug(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'skill';
  let id = base, n = 2;
  while (fs.existsSync(path.join(SKILLS_DIR, id))) id = `${base}-${n++}`;
  return id;
}
function skillFiles(dir) {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (r !== 'SKILL.md') out.push(r); } };
  try { walk(dir, ''); } catch (_) {}
  return out.slice(0, 50);
}
function listSkills() {
  let dirs = [];
  try { dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch (_) {}
  return dirs.map((id) => {
    const f = path.join(SKILLS_DIR, id, 'SKILL.md');
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
    const sk = parseSkill(txt);
    const meta = skillMeta[id] || {};
    return { id, name: sk.name || id, description: sk.description, body: sk.body, enabled: meta.enabled !== false, uses: meta.uses || 0, lastUsed: meta.lastUsed || 0, source: meta.source || '', fromConv: meta.fromConv || '', updatedAt: fs.statSync(f).mtimeMs, files: skillFiles(path.join(SKILLS_DIR, id)) };
  }).filter(Boolean).sort((a, b) => (b.lastUsed || b.updatedAt) - (a.lastUsed || a.updatedAt));
}
function broadcastSkills() { broadcast({ type: 'skills', skills: listSkills() }); }

function writeSkill(sk, meta = {}) {
  const name = String(sk.name || '').trim().slice(0, 60);
  if (!name) throw new Error(T('请填写技能名称', 'Please enter a skill name'));
  const description = String(sk.description || '').trim().slice(0, 600);
  const body = String(sk.body || '').trim().slice(0, 60000);
  if (!body) throw new Error(T('请填写技能的具体做法', 'Please write the instructions'));
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  let id = sk.id && /^[\w一-鿿.-]+$/.test(sk.id) && fs.existsSync(path.join(SKILLS_DIR, sk.id)) ? sk.id : null;
  if (!id) { const same = listSkills().find((x) => x.name.toLowerCase() === name.toLowerCase()); id = same ? same.id : skillSlug(name); }
  const dir = path.join(SKILLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  try {
    const old = fs.readFileSync(file, 'utf8');
    const hist = path.join(SKILLS_DIR, '.history', id);
    fs.mkdirSync(hist, { recursive: true });
    fs.writeFileSync(path.join(hist, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`), old);
  } catch (_) {}
  fs.writeFileSync(file, skillText({ name, description, body }));
  skillMeta[id] = { ...(skillMeta[id] || {}), ...meta };
  if (typeof sk.enabled === 'boolean') skillMeta[id].enabled = sk.enabled;
  saveSkillMeta();
  return id;
}

function importSkill(buf, filename) {
  if (/\.zip$/i.test(filename)) {
    const zip = office.readZip(buf);
    const mdName = zip.names().filter((n) => /(^|\/)SKILL\.md$/i.test(n)).sort((a, b) => a.length - b.length)[0];
    if (!mdName) throw new Error(T('压缩包里没找到 SKILL.md', 'No SKILL.md found in the zip'));
    const prefix = mdName.slice(0, mdName.length - 'SKILL.md'.length);
    const sk = parseSkill(zip.text(mdName));
    if (!sk.name) sk.name = prefix.split('/').filter(Boolean).pop() || filename.replace(/\.zip$/i, '');
    const id = writeSkill(sk, { source: 'import' });
    const dir = path.join(SKILLS_DIR, id);
    for (const n of zip.names()) {
      if (!n.startsWith(prefix) || n.endsWith('/') || n === mdName) continue;
      const rel = n.slice(prefix.length);
      const dest = safeJoin(dir, rel);
      if (!dest || rel.split('/').some((p) => p.startsWith('.'))) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, zip.bytes(n));
    }
    return id;
  }
  const sk = parseSkill(buf.toString('utf8'));
  if (!sk.name) sk.name = filename.replace(/\.(md|markdown|txt)$/i, '').replace(/^SKILL$/i, 'skill');
  return writeSkill(sk, { source: 'import' });
}

// 每次干活前，把启用的技能同步到对话文件夹的 .hola/skills 里，所有命令行队友都能用相对路径读到
function syncSkillsTo(c) {
  const dest = path.join(convDir(c), '.hola', 'skills');
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
  const list = listSkills().filter((s) => s.enabled);
  for (const s of list) { try { fs.cpSync(path.join(SKILLS_DIR, s.id), path.join(dest, s.id), { recursive: true }); } catch (_) {} }
  return list;
}

function skillsPromptText(c, m) {
  const list = listSkills().filter((s) => s.enabled);
  if (!list.length) return '';
  if (m.type === 'api') {
    let budget = 24000;
    const parts = [];
    for (const s of list) {
      const txt = `### ${s.name}\n适用：${s.description || '（未写）'}\n${s.body}`;
      if (txt.length > budget) { parts.push(`### ${s.name}\n适用：${s.description}\n（内容太长，没有附上）`); continue; }
      budget -= txt.length; parts.push(txt);
    }
    return `【Hola 技能库】团队共用的做事方法。任务符合某个技能的"适用"说明时，就按它的做法来：\n${parts.join('\n\n')}\n\n`;
  }
  return `【Hola 技能库】团队共用的做事方法（老板和队友沉淀下来的）。任务符合某个技能的说明时，先读它的 SKILL.md 再动手，同一文件夹里的模板、脚本按 SKILL.md 说的用：\n` +
    list.map((s) => `- ${s.name}：${s.description || '（没写适用场景，读 SKILL.md 判断）'}（.hola/skills/${s.id}/SKILL.md）`).join('\n') + '\n\n';
}

const TAG_SKILL = /^[ \t>*_]*【\s*(?:技能|用了技能|Skill)\s*】\s*[:：]?\s*(.+?)\s*[*_]*\s*$/m;
function noteSkillUse(text, msg) {
  const mt = text.match(TAG_SKILL);
  if (!mt) return text;
  const all = listSkills();
  const names = mt[1].split(/[、,，;；]/).map((x) => x.trim().replace(/^[「"']|[」"']$/g, '')).filter(Boolean);
  const used = [];
  for (const n of names) {
    const s = all.find((x) => x.name.toLowerCase() === n.toLowerCase() || x.id === n);
    if (s) { used.push({ id: s.id, name: s.name }); skillMeta[s.id] = { ...(skillMeta[s.id] || {}), uses: (skillMeta[s.id]?.uses || 0) + 1, lastUsed: Date.now() }; }
  }
  if (used.length) { msg.skills = used; saveSkillMeta(); broadcastSkills(); }
  return text.replace(TAG_SKILL, '').trim();
}

function distillPrompt(c, fromMsg) {
  const existing = listSkills().map((s) => `- ${s.name}：${s.description}`).join('\n') || '（还没有）';
  const focus = fromMsg ? `\n【老板想沉淀的这条结论】\n[${nameOf(fromMsg.from)}] ${clip(fromMsg.text, 6000)}\n` : '';
  return `你是 Hola 团队的"技能整理员"。Hola 有一个所有对话、所有队友共用的技能库：每个技能是一份可以反复使用的做事方法，下次遇到同类任务，队友会先读它再动手。
老板希望把这个对话里的做法沉淀成一个技能。请从下面的对话记忆和群聊记录里提炼：

- 这是哪一类任务（写清楚什么时候该用这个技能，方便队友判断）；
- 做这类任务的步骤和分工（谁擅长哪一步）；
- 质量标准、老板明确提过的偏好和禁忌；
- 这次踩过的坑、讨论中得出的关键判断；
- 需要的话，给出输出模板或检查清单。

规则：
- 写成通用的方法，不要写成这一次的流水账；这次特有的具体数字、名字只作为例子出现。
- 只写老板说过的偏好，不要替他推断。
- 如果技能库里已经有同一类技能，就用完全相同的名称，把新经验合并进去，输出合并后的完整版本。
- 不要修改任何文件、不要运行命令，只输出文字。${EN() ? '\n- 技能内容用英文写。' : '\n- 技能内容用中文写。'}

输出格式（严格遵守）：
第一行：【本次变化】用一句话说明这个技能是什么
然后：
<<<技能
name: 技能名称（简短，10 个字以内）
description: 一句话说明什么时候用它
---
# 技能名称
（具体做法，Markdown）
技能>>>

【技能库里已有的技能】
${existing}
${focus}
【本对话记忆】
${clip(readMemory(c), 6000) || '（空）'}

【群聊记录】
${transcript(c)}`;
}

async function distillSkill(c, myGen, job) {
  const r = rt(c);
  const act = activeIds(c);
  const pref = settings.conclusionBy;
  const keeperId = (act.includes(pref) && pref) || act[0];
  if (!keeperId) { sys(c, T('没有在线的队友，没法整理技能。', 'No teammate is online to write the skill.')); return; }
  const m = members[keeperId];
  const fromMsg = job.fromMsg ? c.messages.find((x) => x.id === job.fromMsg) : null;
  r.phase = 'skill';
  const msg = newMsg(c, m.id, '', { status: 'running', startedAt: Date.now(), reason: 'skill' });
  r.working.add(m.id);
  broadcastState(c);
  const res = await runMember(c, m, distillPrompt(c, fromMsg), msg, []);
  r.working.delete(m.id);
  if (myGen !== r.gen) return;
  msg.endedAt = Date.now();
  const out = res.text || '';
  const block = out.match(/<<<\s*技能\s*\n([\s\S]*?)\n?\s*技能\s*>>>/);
  const change = (out.match(/【本次变化】\s*(.+)/) || [])[1];
  if (block) {
    const raw = block[1].trim();
    const sk = parseSkill(raw.startsWith('---') ? raw : '---\n' + raw.replace(/\n---\n/, '\n---\n'));
    try {
      const existed = listSkills().find((x) => x.name.toLowerCase() === (sk.name || '').toLowerCase());
      const id = writeSkill(sk, { source: 'conversation', fromConv: c.title });
      msg.skillId = id;
      msg.skillName = sk.name;
      msg.skillUpdated = !!existed;
      msg.text = change ? change.trim() : sk.description;
      msg.status = 'done';
      broadcastSkills();
    } catch (e) { msg.text = T('保存技能失败：', 'Failed to save the skill: ') + e.message; msg.status = 'error'; }
  } else {
    msg.text = T('整理技能没成功，可以再试一次。', "Couldn't write the skill, please try again.") + (res.err ? '\n' + clip(res.err, 300) : '');
    msg.status = 'error';
  }
  update(c, msg);
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
  if (m.type !== 'api') syncSkillsTo(c);
  const res = await runMember(c, m, agentPrompt(c, m, turn), msg, images);
  r.working.delete(m.id);
  if (myGen !== r.gen) return null;
  msg.endedAt = Date.now();
  if (res.text) {
    const tags = extractTags(res.text);
    let text = noteSkillUse(tags.text, msg);
    if (turn.reason === 'initial') msg.needDiscuss = tags.need === true;
    if (turn.reason === 'discuss') msg.stance = tags.stance || 'agree';
    if (turn.reason === 'conclusion' && !turn.consensus) { const o = extractOptions(text); text = o.text || text; msg.options = o.options; }
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
    msg.text = T('没能完成，出错了。', "Couldn't finish, something went wrong.") + (res.err ? T('\n\n错误信息：\n', '\n\nError:\n') + clip(res.err, 800) : '') +
      loginHint(m);
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
    if (/^\/(logo\.svg|favicon\.png|icon-192\.png|i18n\.js)$/.test(url.pathname)) return sendFile(res, path.join(ROOT, 'public', url.pathname.slice(1)), false, true);
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ type: 'init', convs: convList(), members: publicMembers(), settings, profile: publicProfile(), skills: listSkills(), projects, workspace: WORKSPACE }) + '\n\n');
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
          return page(office.previewPage(name, T('表格预览（最多显示 1000 行）', 'Table preview (up to 1000 rows)'), office.htmlTable(rows, true)));
        }
        if (/\.(md|txt|json)$/i.test(p)) return page(office.previewPage(name, T('文本预览', 'Text preview'), `<pre>${office.esc(fs.readFileSync(p, 'utf8').slice(0, 500000))}</pre>`));
      } catch (e) { return page(office.previewPage(name, T('没法预览这个文件', "Can't preview this file"), `<p>${office.esc(e.message)}${T('。可以下载原文件查看。', '. Download the original file to view it.')}</p>`)); }
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

    if (url.pathname === '/api/skills/import') {
      const chunks = []; let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 20e6) req.destroy(); else chunks.push(d); });
      req.on('end', () => {
        try { const id = importSkill(Buffer.concat(chunks), url.searchParams.get('name') || 'SKILL.md'); broadcastSkills(); json({ ok: true, id }); }
        catch (e) { json({ error: e.message }, 400); }
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
      case '/api/conv/new': return json({ id: createConv(null, body.project).id });
      case '/api/conv/project':
        if (c) { c.project = body.project && projects.some((p) => p.id === body.project) ? body.project : null; saveConv(c); broadcastConvList(); }
        return json({ ok: true });
      case '/api/conv/status':
        if (c && (body.status === 'done' || body.status === 'doing')) { c.status = body.status; saveConv(c); broadcastConvList(); }
        return json({ ok: true });
      case '/api/projects/save': {
        const d = body.project || {};
        const name = String(d.name || '').trim().slice(0, 40);
        if (!name) return json({ error: T('请填写项目名称', 'Please enter a project name') }, 400);
        let p = projects.find((x) => x.id === d.id);
        if (!p) { p = { id: 'p' + crypto.randomBytes(4).toString('hex'), createdAt: Date.now() }; projects.push(p); }
        p.name = name;
        p.brief = String(d.brief || '').trim().slice(0, 3000);
        saveProjects(); broadcastProjects();
        return json({ ok: true, id: p.id });
      }
      case '/api/projects/delete': {
        const i = projects.findIndex((x) => x.id === body.id);
        if (i >= 0) {
          projects.splice(i, 1); saveProjects();
          for (const x of convs.values()) if (x.project === body.id) { x.project = null; saveConv(x); }
          broadcastProjects(); broadcastConvList();
        }
        return json({ ok: true });
      }
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
      case '/api/decide': {
        if (!c) return json({ error: 'no conv' }, 404);
        const concl = c.messages.find((m) => m.id === body.msg);
        if (!concl || concl !== pendingDecision(c)) return json({ error: T('这条结论已经拍过板了', 'This has already been decided') }, 400);
        const opt = (concl.options || []).find((o) => o.key === body.option);
        if (!opt) return json({ error: 'no option' }, 400);
        const what = opt.text.replace(/\s*[（(]\s*(支持|support)[^）)]*[）)]\s*$/i, '') || opt.text;
        newMsg(c, 'boss', T(`拍板：选方案${opt.key}（${what}）`, `Decision: option ${opt.key} (${what})`), { reason: 'decision' });
        decide(c, concl, opt.key);
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
        const access = d.access === 'full' || d.access === 'safe' ? d.access : null;
        const model = typeof d.cliModel === 'string' ? d.cliModel.trim() : null;
        if (model && !MODEL_RE.test(model)) return json({ error: T('模型名只能用英文字母、数字和 . _ - : /', 'Model names can only use letters, digits and . _ - : /') }, 400);
        const effort = typeof d.cliEffort === 'string' ? d.cliEffort : null;
        if (effort && !EFFORTS.includes(effort)) return json({ error: 'bad effort' }, 400);
        const setPrefs = (id) => {
          const p = { ...(settings.memberPrefs[id] || {}), ...(access ? { access } : {}) };
          if (model !== null) { if (model) p.model = model; else delete p.model; }
          if (effort !== null) { if (effort) p.effort = effort; else delete p.effort; }
          settings.memberPrefs[id] = p;
        };
        if (d.id && members[d.id] && members[d.id].builtin) {
          settings.memberPrefs[d.id] = { ...(settings.memberPrefs[d.id] || {}), ...(color ? { color } : {}), ...(typeof d.enabled === 'boolean' ? { enabled: d.enabled } : {}) };
          setPrefs(d.id);
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
          if (access || model !== null || effort !== null) { setPrefs(cm.id); saveSettings(); }
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
      case '/api/models': {
        const m = members[body.id];
        if (!m) return json({ error: T('找不到这位队友', 'Teammate not found') }, 404);
        return json(await modelChoices(m));
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
        if (typeof body.showProcess === 'boolean') settings.showProcess = body.showProcess;
        if (body.uiLang === 'zh' || body.uiLang === 'en') { settings.uiLang = body.uiLang; syncLang(); checkAll(); }
        if (body.maxAutoTurns) settings.maxAutoTurns = Math.max(0, Math.min(50, Number(body.maxAutoTurns) || 10));
        if (body.strengths && typeof body.strengths === 'object') {
          for (const [k, v] of Object.entries(body.strengths)) if (members[k]) settings.strengths[k] = String(v).slice(0, 300);
        }
        saveSettings();
        broadcast({ type: 'settings', settings, members: publicMembers() });
        return json({ ok: true });
      case '/api/skills/save':
        try { const id = writeSkill(body.skill || {}, (body.skill || {}).id ? {} : { source: 'manual' }); broadcastSkills(); return json({ ok: true, id }); }
        catch (e) { return json({ error: e.message }, 400); }
      case '/api/skills/toggle':
        if (body.id && fs.existsSync(path.join(SKILLS_DIR, String(body.id)))) { skillMeta[body.id] = { ...(skillMeta[body.id] || {}), enabled: !!body.enabled }; saveSkillMeta(); broadcastSkills(); }
        return json({ ok: true });
      case '/api/skills/delete': {
        const dir = body.id && safeJoin(SKILLS_DIR, String(body.id));
        if (dir && dir !== SKILLS_DIR && !String(body.id).startsWith('.')) { fs.rmSync(dir, { recursive: true, force: true }); delete skillMeta[body.id]; saveSkillMeta(); broadcastSkills(); }
        return json({ ok: true });
      }
      case '/api/skills/open': {
        const dir = body.id ? safeJoin(SKILLS_DIR, String(body.id)) : SKILLS_DIR;
        fs.mkdirSync(dir || SKILLS_DIR, { recursive: true });
        openPath(dir || SKILLS_DIR);
        return json({ ok: true });
      }
      case '/api/skills/distill':
        if (!c) return json({ error: 'no conv' }, 404);
        rt(c).jobs.push({ type: 'skill', fromMsg: body.msg || null });
        pump(c);
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
