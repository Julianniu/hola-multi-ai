// Hola · 队友：内置 + 自己加的队友，权限 / 模型 / 思考深度参数，查找和启动命令行，检查在线
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { DATA_DIR, EN, IS_WIN, T, WORKSPACE, broadcast, cfg, fileExists, settings } = require('./core');

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
const ORDER = [];
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
  ORDER.splice(0, ORDER.length, ...Object.keys(members)); // 原地更新：别的模块拿到的是同一个数组
}
buildMembers();
const STRENGTHS_EN = {
  claude: 'Planning and breaking down work, writing and strategy, reasoning, quality review',
  codex: 'Writing code, running scripts, spreadsheets and data, file conversion, small tools',
  gemini: 'Reading and summarising long material, images and video, web research',
};
const strengthsOf = (m) => settings.strengths[m.id] || (EN() && m.builtin && STRENGTHS_EN[m.id]) || m.strengths || '';
const enabledIds = () => ORDER.filter((id) => members[id].enabled);

function whereAll(cmd) {
  return new Promise((res) =>
    execFile('where', [cmd], { windowsHide: true }, (err, out) =>
      res(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))));
}

async function resolveCmd(cmd) {
  if (!IS_WIN) {
    if (cmd.includes('/')) return fileExists(cmd) ? { file: cmd, shell: false } : null;
    const hit = String(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, cmd)).find(fileExists);
    return hit ? { file: hit, shell: false } : null;
  }
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
  // Mac / Linux：让它自成一个进程组，叫停时能连同它启动的子进程一起结束
  if (!IS_WIN) o.detached = true;
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
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} } }
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
      ? { baseUrl: (m.api || {}).baseUrl || '', model: (m.api || {}).model || '', keyHint: keyHint((m.api || {}).apiKey), temperature: (m.api || {}).temperature ?? '', vision: !!(m.api || {}).vision }
      : { cmd: m.cmd || '', argsText: joinArgs(m.args), parser: m.parser || 'plain', readOnly: !!m.readOnly, versionCheck: m.versionCheck !== false },
  }));
}

function checkChanged() {
  const list = Object.values(members).filter((m) => m.changed);
  broadcast({ type: 'members', members: publicMembers() });
  Promise.all(list.map(checkMember)).then(() => broadcast({ type: 'members', members: publicMembers() }));
}

module.exports = { MEMBERS_FILE, DEFAULT_COLORS, PALETTE, PARSERS, customMembers, saveCustomMembers, FULL_FLAG, SAFE_ARGS, ACCESS_FLAGS, accessOf, withAccess, MODEL_FLAG, MODEL_RE, isModelFlag, modelInArgs, withModel, EFFORTS, isEffortArg, effortInArgs, withEffort, codexConfig, codexDefaultModel, members, ORDER, buildMembers, STRENGTHS_EN, strengthsOf, enabledIds, whereAll, resolveCmd, winQuote, spawnMember, decodeOut, stripAnsi, cleanEnv, killTree, checkMember, checkAll, joinArgs, splitArgs, keyHint, agyModels, modelChoices, modelChoicesRaw, publicMembers, checkChanged };
