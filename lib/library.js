// Hola · 图片库 / 文件库：老板自己上传的文件 + 所有对话里的附件和队友做出来的文件，集中在一处看、预览、发给队友
'use strict';
const fs = require('fs');
const path = require('path');
const { WORKSPACE, ATTACH_DIR } = require('./core');
const { convs, convDir, safeJoin, uniqueName, finishAttachment } = require('./convs');

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
    items.push({ id: 'lib:' + name, name, size: st.size, mtime: st.mtimeMs, from: 'upload', image: LIB_IMG.test(name),
      preview: LIB_PREVIEW.test(name), url: `/library/${enc(name)}`, previewUrl: `/library-preview/${enc(name)}` });
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
  return true;
}

module.exports = { LIBRARY_DIR, listLibrary, libraryFile, attachFromLibrary, deleteFromLibrary };
