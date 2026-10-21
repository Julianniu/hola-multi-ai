// Hola · 对话：对话的存取、项目、文件列表、Office 转文字、收取 AI 生成的媒体
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const office = require('../office');
const { DATA_DIR, EN, MEMORY_NAME, T, WORKSPACE, broadcast, cfg, fileExists } = require('./core');
const { enabledIds, members } = require('./members');

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
// 图片的"文字版"是能看图的队友写的图片说明（给看不到图片的队友读）
function imageNoteRel(rel) { return `${TEXT_DIR}/${rel.replace(/[\\/]/g, '__')}.说明.md`; }
function textVersionRel(c, rel) {
  if (IMG_EXT.test(rel)) return fileExists(path.join(convDir(c), imageNoteRel(rel))) ? imageNoteRel(rel) : '';
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

// 新附件进了对话文件夹之后的收尾：Office 转文字版，返回附件信息。上传和"从资料库发给队友"都走这里
function finishAttachment(c, rel) {
  convertOffice(c, rel);
  return fileInfo(c, rel);
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

function transcriptMd(c) {
  return `# ${c.title}\n\n` + c.messages.filter((m) => m.text || (m.attachments || []).length).map((m) =>
    `### ${nameOf(m.from)} · ${new Date(m.ts).toLocaleString('zh-CN', { hour12: false })}\n\n${m.text}\n` +
    (m.options || []).map((o) => `- **方案${o.key}**${m.decided === o.key ? '（老板选了这个）' : ''}：${o.text}\n`).join('') +
    [...(m.attachments || []), ...(m.files || [])].map((f) => `- 📎 ${f.path}`).join('\n')).join('\n');
}

function safeJoin(base, rel) {
  const p = path.resolve(base, rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function uniqueName(dir, name) {
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120) || 'file';
  let n = name, i = 1;
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  while (fs.existsSync(path.join(dir, n))) n = `${stem} (${i++})${ext}`;
  return n;
}

function activeIds(c) { return enabledIds().filter((id) => members[id].online && (!c.active || c.active.includes(id))); }

module.exports = { imageNoteRel, finishAttachment, convs, convDir, metaFile, newId, loadConvs, rt, MEMORY_TEMPLATE, MEMORY_TEMPLATE_EN, memTemplate, PROJECTS_FILE, projects, saveProjects, broadcastProjects, projectOf, memSection, projectText, createConv, saveTimers, saveConv, convSummary, convList, broadcastConvList, broadcastState, nameOf, newMsg, update, sys, clip, addProc, listFiles, IMG_EXT, VIDEO_EXT, AUDIO_EXT, MEDIA_EXT, fileInfo, TEXT_DIR, PREVIEW_EXT, textVersionRel, convertOffice, OUT_DIR, MAGIC, sameFileExists, stamp, saveCaptured, importPath, captureFromJson, captureFromText, snapshotDirs, mediaWatchDirs, listingText, readMemory, transcriptMd, safeJoin, uniqueName, activeIds };
