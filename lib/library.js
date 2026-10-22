// Hola · 图片库 / 文件库：老板自己上传的文件 + 所有对话里的附件和队友做出来的文件，集中在一处看、预览、发给队友
'use strict';
const fs = require('fs');
const path = require('path');
const office = require('../office');
const { WORKSPACE, ATTACH_DIR, saveSettings, settings } = require('./core');
const { decodeOut } = require('./members');
const { clip, convs, convDir, safeJoin, uniqueName, finishAttachment } = require('./convs');

// ---------------------------------------------------------------- 资料库
// 自己上传的文件放在工作文件夹里的"资料库"（用户在文件管理器里也能找到）。
// 对话里的文件不复制，只是列出来：删掉对话，它的文件也就从库里消失（说删就删）。
const LIBRARY_DIR = path.join(WORKSPACE, '资料库');
const LIB_IMG = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const LIB_PREVIEW = /\.(docx|xlsx|pptx|pdf|csv|tsv|md|txt|json)$/i;
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

function libStat(p) { try { const st = fs.statSync(p); return st.isFile() ? st : null; } catch (_) { return null; } }

// 库里的每一项：id 用来"发给队友""删除"时找回它
function listLibrary() {
  const items = [];
  let names = [];
  try { names = fs.readdirSync(LIBRARY_DIR); } catch (_) {}
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const st = libStat(path.join(LIBRARY_DIR, name));
    if (!st) continue;
    const pinned = pinnedNames().includes(name);
    items.push({ id: 'lib:' + name, name, size: st.size, mtime: st.mtimeMs, from: 'upload', image: LIB_IMG.test(name),
      preview: LIB_PREVIEW.test(name), url: `/library/${enc(name)}`, previewUrl: `/library-preview/${enc(name)}`,
      pinnable: PIN_EXT.test(name), pinned, ...(pinned ? { chars: docText(path.join(LIBRARY_DIR, name)).length } : {}) });
  }
  for (const c of convs.values()) {
    const seen = new Set();
    for (const m of c.messages || []) {
      for (const f of [...(m.attachments || []), ...(m.files || [])]) {
        if (!f || !f.path || seen.has(f.path)) continue;
        seen.add(f.path);
        const st = libStat(path.join(convDir(c), f.path));
        if (!st) continue;
        items.push({ id: `conv:${c.id}:${f.path}`, name: path.basename(f.path), size: st.size, mtime: st.mtimeMs, from: m.from,
          conv: { id: c.id, title: c.title }, image: LIB_IMG.test(f.path), preview: LIB_PREVIEW.test(f.path),
          url: `/files/${c.id}/${enc(f.path)}`, previewUrl: `/preview/${c.id}/${enc(f.path)}` });
      }
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

// 根据 id 找到文件在磁盘上的位置（找不到或越界都返回 null）
function libraryFile(id) {
  const s = String(id || '');
  if (s.startsWith('lib:')) {
    const p = safeJoin(LIBRARY_DIR, s.slice(4));
    return p && p !== LIBRARY_DIR && libStat(p) ? p : null;
  }
  const m = s.match(/^conv:([\w-]+):(.+)$/);
  if (!m) return null;
  const c = convs.get(m[1]);
  const p = c && safeJoin(convDir(c), m[2]);
  return p && !p.includes(path.sep + '.hola') && libStat(p) ? p : null;
}

// 发给队友：复制进当前对话的"附件"文件夹，走和上传附件完全一样的收尾（Office 转文字版等）
function attachFromLibrary(c, id) {
  const src = libraryFile(id);
  if (!src) return null;
  const dir = path.join(convDir(c), ATTACH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = uniqueName(dir, path.basename(src));
  fs.copyFileSync(src, path.join(dir, name));
  return finishAttachment(c, `${ATTACH_DIR}/${name}`);
}

function deleteFromLibrary(id) {
  const s = String(id || '');
  if (!s.startsWith('lib:')) return false; // 对话里的文件不在这里删
  const p = libraryFile(s);
  if (!p) return false;
  fs.rmSync(p, { force: true });
  setPinned(s, false);
  return true;
}

// ---------------------------------------------------------------- 团队常驻资料
// 资料库里的文件可以设为"常驻"：所有对话的所有队友每次干活都会看到（品牌调性、禁用词、产品资料……）。
// 每份资料每次都要发给每位队友，所以有总字数上限，界面上显示字数提醒老板。
const PIN_EXT = /\.(docx|xlsx|pptx|md|markdown|txt|csv|tsv|json)$/i;
const PIN_BUDGET = 12000;
const pinCache = new Map();
function pinnedNames() { return Array.isArray(settings.pinned) ? settings.pinned : []; }
function docText(p) {
  let st;
  try { st = fs.statSync(p); } catch (_) { return ''; }
  const hit = pinCache.get(p);
  if (hit && hit.mtime === st.mtimeMs) return hit.text;
  let text = '';
  try { text = office.OFFICE_EXT.test(p) ? office.toMarkdown(office.readOffice(p), path.basename(p)) : decodeOut(fs.readFileSync(p)).replace(/^\ufeff/, ''); } catch (_) {}
  pinCache.set(p, { mtime: st.mtimeMs, text: text.trim() });
  return text.trim();
}
function setPinned(id, on) {
  const s = String(id || '');
  if (!s.startsWith('lib:')) return false;
  const name = s.slice(4);
  if (on && (!PIN_EXT.test(name) || !libraryFile(s))) return false;
  const list = pinnedNames().filter((n) => n !== name);
  if (on) list.push(name);
  if (list.length === pinnedNames().length && !on && !pinnedNames().includes(name)) return true;
  settings.pinned = list;
  saveSettings();
  return true;
}
// 拼进提示词的一段；没有常驻资料时是空的（提示词和以前一字不差）
function pinnedText() {
  const docs = pinnedNames().map((name) => {
    const p = safeJoin(LIBRARY_DIR, name);
    const text = p && libStat(p) ? docText(p) : '';
    return text ? { name, text } : null;
  }).filter(Boolean);
  if (!docs.length) return '';
  const share = Math.floor(PIN_BUDGET / docs.length);
  return `【团队常驻资料】老板放在资料库里的长期参考资料，所有对话都适用：干活时遵守里面的要求，参考里面的信息。
${docs.map((d) => `--- ${d.name} ---\n${clip(d.text, share)}`).join('\n\n')}

`;
}

module.exports = { LIBRARY_DIR, PIN_BUDGET, listLibrary, libraryFile, attachFromLibrary, deleteFromLibrary, setPinned, pinnedText };
