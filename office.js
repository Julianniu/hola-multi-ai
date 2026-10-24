// 零依赖读取 Word / Excel / PowerPoint（.docx / .xlsx / .pptx）
// 这三种文件本质上是 zip 压缩包里装着 XML，这里自己解压、取出文字和表格。
'use strict';
const tt = (zh, en) => (module.exports.lang === 'en' ? en : zh);
const fs = require('fs');
const zlib = require('zlib');

// ---------------------------------------------------------------- zip

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(tt('不是有效的 Office 文件（zip 结构损坏）', 'Not a valid Office file (damaged zip structure)'));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    files.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => files.has(name),
    names: () => [...files.keys()],
    bytes(name) {
      const f = files.get(name);
      if (!f) return null;
      const lh = f.local;
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.slice(start, start + f.csize);
      return f.method === 8 ? zlib.inflateRawSync(data) : data;
    },
    text(name) { const b = this.bytes(name); return b ? b.toString('utf8') : ''; },
  };
}

// ---------------------------------------------------------------- xml 小工具

function decode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}
const attr = (xml, name) => { const m = xml.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? decode(m[1]) : ''; };

function rels(zip, path) {
  const map = {};
  const xml = zip.text(path);
  for (const m of xml.match(/<Relationship\b[^>]*>/g) || []) map[attr(m, 'Id')] = attr(m, 'Target');
  return map;
}
function resolve(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('/');
}

// ---------------------------------------------------------------- Word

function docxParagraph(p) {
  let out = '';
  for (const m of p.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:t\b[^>]*\/>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g) || []) {
    if (m.startsWith('<w:tab')) out += '\t';
    else if (m.startsWith('<w:br') || m.startsWith('<w:cr')) out += '\n';
    else out += decode(m.replace(/^<w:t\b[^>]*>/, '').replace(/<\/w:t>$/, '').replace(/^<w:t\b[^>]*\/>$/, ''));
  }
  return out;
}

function readDocx(zip) {
  const xml = zip.text('word/document.xml');
  const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [, xml])[1];
  const blocks = [];
  for (const part of body.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/)) {
    if (part.startsWith('<w:tbl>')) {
      const rows = (part.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []).map((tr) =>
        (tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map((tc) => (tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []).map(docxParagraph).join(' ').trim()));
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    for (const p of part.match(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) || []) {
      const text = docxParagraph(p).trim();
      if (!text) continue;
      const style = attr((p.match(/<w:pStyle\b[^>]*>/) || [''])[0], 'w:val');
      const hm = /^(Title|标题)$/i.test(style) ? [style, '0'] : style.match(/^(?:heading|标题)\s*(\d)$/i) || (/^[1-6]$/.test(style) ? [style, style] : null);
      const list = /<w:numPr>/.test(p) || /^List/i.test(style);
      if (hm) blocks.push({ type: 'h', level: Math.min(4, Number(hm[1])), text });
      else blocks.push({ type: list ? 'li' : 'p', text });
    }
  }
  return { kind: 'docx', blocks };
}

// ---------------------------------------------------------------- Excel

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || ['A'])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(zip, opts = {}) {
  // 有的工具（比如 Codex 用的 Open XML SDK）写出的 Excel，标签都带 x: 前缀（<x:row>、<x:c>），去掉再读，否则读出来是空的
  const raw = zip;
  zip = { ...raw, text: (n) => raw.text(n).replace(/<(\/?)x:/g, '<$1') };
  const maxRows = opts.maxRows || 500;
  const maxCols = opts.maxCols || 40;
  const shared = [];
  const ss = zip.text('xl/sharedStrings.xml');
  for (const si of ss.match(/<si\b[\s\S]*?<\/si>/g) || []) {
    shared.push((si.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => decode(t.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))).join(''));
  }
  // 日期在 Excel 里存的是数字，要靠单元格格式判断
  const styles = zip.text('xl/styles.xml');
  const customFmt = {};
  for (const f of styles.match(/<numFmt\b[^>]*>/g) || []) customFmt[attr(f, 'numFmtId')] = attr(f, 'formatCode');
  const xfs = ((styles.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/) || [''])[0].match(/<xf\b[^>]*>/g) || []).map((x) => attr(x, 'numFmtId'));
  const isDateFmt = (id) => {
    const n = Number(id);
    if ((n >= 14 && n <= 22) || (n >= 27 && n <= 36) || (n >= 45 && n <= 47) || (n >= 50 && n <= 58)) return true;
    const code = (customFmt[id] || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[ymdhs年月日]/i.test(code) && !/^[#0.,%]+$/.test(code);
  };
  const wb1904 = /date1904="(1|true)"/.test(zip.text('xl/workbook.xml'));
  const serialToDate = (v, withTime) => {
    const ms = Math.round((Number(v) - (wb1904 ? -1462 : 25569)) * 86400000);
    const d = new Date(ms);
    if (isNaN(d)) return v;
    const iso = d.toISOString();
    return withTime && Number(v) % 1 ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
  };
  const wb = zip.text('xl/workbook.xml');
  const r = rels(zip, 'xl/_rels/workbook.xml.rels');
  const sheets = [];
  for (const s of wb.match(/<sheet\b[^>]*>/g) || []) {
    const name = attr(s, 'name');
    const target = r[attr(s, 'r:id')];
    if (!target) continue;
    const xml = zip.text(resolve('xl/workbook.xml', target));
    const rows = [];
    let truncated = false;
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || []) {
      const ri = Number(attr(row, 'r')) - 1;
      if (rows.length >= maxRows) { truncated = true; break; }
      const cells = [];
      for (const c of row.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []) {
        const ci = colIndex(attr(c, 'r'));
        if (ci >= maxCols) { truncated = true; continue; }
        const t = attr(c, 't');
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1];
        let val;
        if (t === 's') val = shared[Number(v)] || '';
        else if (t === 'inlineStr') val = (c.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map((x) => decode(x.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))).join('');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== '' && isDateFmt(xfs[Number(attr(c, 's')) || 0]) && /^-?\d+(\.\d+)?$/.test(v)) val = serialToDate(v, true);
        else val = decode(v);
        if (val === '' && /<f\b/.test(c)) val = '=' + decode((c.match(/<f\b[^>]*>([\s\S]*?)<\/f>/) || [, ''])[1]);
        if (/^-?\d+\.\d{9,}$/.test(val)) val = String(Math.round(Number(val) * 1e6) / 1e6);
        cells[ci] = val;
      }
      if (Number.isFinite(ri) && ri >= 0) rows[ri] = cells; else rows.push(cells);
    }
    const dense = rows.filter(Boolean).map((cells) => Array.from({ length: cells.length }, (_, i) => cells[i] ?? ''));
    const width = Math.max(0, ...dense.map((x) => x.length));
    sheets.push({ name, rows: dense.map((x) => x.concat(Array(width - x.length).fill(''))), truncated });
  }
  return { kind: 'xlsx', sheets };
}

// ---------------------------------------------------------------- PowerPoint

// 预览用：一页里的文字框、表格、图片，按在页面上的位置从上到下、从左到右排好（文字版不用这些）
const PPT_IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };
const IMG_MAX = 8e6, IMGS_MAX = 60e6;
// 页码是"自动页码"字段，不算这一页的内容
const noSlideNum = (xml) => xml.replace(/<a:fld\b[^>]*type="slidenum"[^>]*>[\s\S]*?<\/a:fld>/g, '');
function pptxText(xml) {
  return (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\b[\s\S]*?<\/a:p>/g) || []).map((p) => ({
    text: (p.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map((t) => decode(t.slice(5, -6))).join('').trim(),
    lvl: Number(attr((p.match(/<a:pPr\b[^>]*>/) || [''])[0], 'lvl')) || 0,
  })).filter((p) => p.text);
}
function pptxItems(zip, path, budget) {
  const xml = noSlideNum(zip.text(path)).replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const r = rels(zip, path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'));
  const image = (rid) => {
    const target = r[rid];
    if (!target) return null;
    const file = resolve(path, target);
    const ext = file.split('.').pop().toLowerCase();
    const name = file.split('/').pop();
    if (!PPT_IMG[ext]) return { t: 'img', name, skip: 'format' };
    const b = zip.bytes(file);
    if (!b) return null;
    if (b.length > IMG_MAX || budget.left < b.length) return { t: 'img', name, skip: 'size' };
    budget.left -= b.length;
    return { t: 'img', name, src: `data:${PPT_IMG[ext]};base64,${b.toString('base64')}` };
  };
  const pos = (s) => { const m = s.match(/<a:off\b[^>]*>/); return m ? { x: Number(attr(m[0], 'x')) || 0, y: Number(attr(m[0], 'y')) || 0 } : null; };
  const items = [];
  const bg = (xml.match(/<p:bg>[\s\S]*?<\/p:bg>/) || [''])[0].match(/<a:blip\b[^>]*r:embed="([^"]+)"/);
  if (bg) { const im = image(bg[1]); if (im) items.push({ ...im, bg: true, y: -2, x: 0 }); }
  for (const m of xml.match(/<p:(sp|pic|graphicFrame)\b[\s\S]*?<\/p:\1>/g) || []) {
    const kind = m.slice(3, m.search(/[\s>]/));
    const ph = (m.match(/<p:ph\b[^>]*>/) || [''])[0];
    const title = /type="(title|ctrTitle)"/.test(ph);
    // 占位符（标题、正文）的位置写在版式里，这页里没有：标题放最上面，其他放在标题下面
    const p = pos(m) || (title ? { x: 0, y: -1 } : ph ? { x: 0, y: -0.5 } : { x: 0, y: 1e12 });
    if (kind === 'graphicFrame') {
      const tbl = m.match(/<a:tbl>[\s\S]*<\/a:tbl>/);
      if (tbl) items.push({ t: 'table', ...p, rows: (tbl[0].match(/<a:tr\b[\s\S]*?<\/a:tr>/g) || []).map((tr) => (tr.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) || []).map((tc) => pptxText(tc).map((x) => x.text).join('\n'))) });
      continue;
    }
    const blip = m.match(/<a:blip\b[^>]*r:embed="([^"]+)"/);
    if (blip) { const im = image(blip[1]); if (im) items.push({ ...im, ...p }); }
    if (kind === 'sp') { const paras = pptxText(m); if (paras.length) items.push({ t: 'text', ...p, title, paras }); }
  }
  return items.map((it, i) => ({ ...it, i })).sort((a, b) => (Math.abs(a.y - b.y) < 2e5 ? a.x - b.x : a.y - b.y) || a.i - b.i);
}

function readPptx(zip, opts = {}) {
  const pres = zip.text('ppt/presentation.xml');
  const r = rels(zip, 'ppt/_rels/presentation.xml.rels');
  let targets = (pres.match(/<p:sldId\b[^>]*>/g) || []).map((s) => r[attr(s, 'r:id')]).filter(Boolean).map((t) => resolve('ppt/presentation.xml', t));
  if (!targets.length) targets = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  const budget = { left: IMGS_MAX };
  const slides = targets.map((path, i) => {
    const xml = noSlideNum(zip.text(path));
    const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\b[\s\S]*?<\/a:p>/g) || [])
      .map((p) => (p.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map((t) => decode(t.slice(5, -6))).join('').trim())
      .filter(Boolean);
    const notesRel = rels(zip, path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'));
    const notesTarget = Object.values(notesRel).find((t) => /notesSlide/.test(t));
    let notes = '';
    if (notesTarget) {
      const nx = zip.text(resolve(path, notesTarget));
      notes = (nx.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map((t) => decode(t.slice(5, -6))).join('').replace(/^\d+$/, '').trim();
    }
    const slide = { n: i + 1, title: paras[0] || '', paras, notes };
    if (opts.visual) { try { slide.items = pptxItems(zip, path, budget); } catch (_) {} }
    return slide;
  });
  return { kind: 'pptx', slides };
}

// ---------------------------------------------------------------- 对外

const OFFICE_EXT = /\.(docx|xlsx|pptx)$/i;

function readOffice(file, opts) {
  const zip = readZip(fs.readFileSync(file));
  const ext = file.toLowerCase().split('.').pop();
  if (ext === 'docx') return readDocx(zip);
  if (ext === 'xlsx') return readXlsx(zip, opts);
  if (ext === 'pptx') return readPptx(zip, opts);
  throw new Error(tt('不支持的格式', 'Unsupported format'));
}

const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
function mdTable(rows) {
  if (!rows.length) return '';
  const w = Math.max(...rows.map((r) => r.length));
  const pad = (r) => r.concat(Array(w - r.length).fill(''));
  return [pad(rows[0]), Array(w).fill('---'), ...rows.slice(1).map(pad)].map((r) => '| ' + r.map(mdCell).join(' | ') + ' |').join('\n');
}

function toMarkdown(doc, title) {
  const out = [tt(`# ${title}（自动转换的文字版）`, `# ${title} (automatic text version)`), ''];
  if (doc.kind === 'docx') {
    for (const b of doc.blocks) {
      if (b.type === 'h') out.push('#'.repeat(b.level + 1) + ' ' + b.text, '');
      else if (b.type === 'li') out.push('- ' + b.text);
      else if (b.type === 'table') out.push('', mdTable(b.rows), '');
      else out.push(b.text, '');
    }
  } else if (doc.kind === 'xlsx') {
    for (const s of doc.sheets) {
      out.push(tt(`## 工作表：${s.name}`, `## Sheet: ${s.name}`), '', s.rows.length ? mdTable(s.rows) : tt('（空）', '(empty)'), '');
      if (s.truncated) out.push(tt('（表格太大，只转换了前 500 行、前 40 列，完整数据请看原文件）', '(Sheet too large: only the first 500 rows and 40 columns were converted. See the original file for everything.)'), '');
    }
  } else if (doc.kind === 'pptx') {
    for (const s of doc.slides) {
      out.push(tt(`## 第 ${s.n} 页${s.title ? '：' + s.title : ''}`, `## Slide ${s.n}${s.title ? ': ' + s.title : ''}`), '', ...s.paras.slice(s.title ? 1 : 0).map((p) => '- ' + p), '');
      if (s.notes) out.push(tt(`备注：${s.notes}`, `Notes: ${s.notes}`), '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function htmlTable(rows, header) {
  if (!rows.length) return `<p class="muted">${tt('（空）', '(empty)')}</p>`;
  const [h, ...rest] = header ? rows : [null, ...rows];
  return `<div class="tw"><table>${h ? `<thead><tr>${h.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// PPT 一页的内容：标题、文字（保留层级缩进）、表格、图片（几张挨着的图片排成一组）
function slideItemsHtml(items) {
  let out = '', imgs = '';
  const flush = () => { if (imgs) { out += `<div class="imgs">${imgs}</div>`; imgs = ''; } };
  for (const it of items) {
    if (it.t === 'img') {
      imgs += it.src ? `<img src="${it.src}" alt="${esc(it.name)}">`
        : `<div class="noimg">${it.skip === 'format' ? tt(`图片 ${esc(it.name)} 的格式在预览里显示不了`, `Picture ${esc(it.name)} can't be shown in the preview`) : tt(`图片 ${esc(it.name)} 太大，预览里没有显示`, `Picture ${esc(it.name)} is too large to show in the preview`)}</div>`;
      continue;
    }
    flush();
    if (it.t === 'table') out += htmlTable(it.rows, true);
    else if (it.title) out += `<h2>${it.paras.map((p) => esc(p.text)).join('<br>')}</h2>`;
    else out += it.paras.map((p) => `<p${p.lvl ? ` style="padding-left:${Math.min(p.lvl, 6) * 18}px"` : ''}>${esc(p.text)}</p>`).join('');
  }
  flush();
  return out;
}

function toHtml(doc, title, theme) {
  let body = '';
  if (doc.kind === 'docx') {
    let inList = false;
    for (const b of doc.blocks) {
      if (b.type !== 'li' && inList) { body += '</ul>'; inList = false; }
      if (b.type === 'h') body += `<h${b.level + 1}>${esc(b.text)}</h${b.level + 1}>`;
      else if (b.type === 'li') { if (!inList) { body += '<ul>'; inList = true; } body += `<li>${esc(b.text)}</li>`; }
      else if (b.type === 'table') body += htmlTable(b.rows, true);
      else body += `<p>${esc(b.text).replace(/\n/g, '<br>')}</p>`;
    }
    if (inList) body += '</ul>';
    body = `<article class="doc">${body || `<p class="muted">${tt('文档里没有读到文字。', 'No text found in this document.')}</p>`}</article>`;
  } else if (doc.kind === 'xlsx') {
    body = `<nav>${doc.sheets.map((s, i) => `<a href="#s${i}">${esc(s.name)}</a>`).join('')}</nav>` +
      doc.sheets.map((s, i) => `<section id="s${i}"><h2>${esc(s.name)}</h2>${htmlTable(s.rows, true)}${s.truncated ? `<p class="muted">${tt('表格太大，这里只显示前 500 行、前 40 列。', 'Sheet too large: showing the first 500 rows and 40 columns.')}</p>` : ''}</section>`).join('');
  } else if (doc.kind === 'pptx') {
    body = doc.slides.map((s) => `<section class="slide"><span class="no">${s.n}</span>${s.items && s.items.length ? slideItemsHtml(s.items) : `${s.title ? `<h2>${esc(s.title)}</h2>` : ''}${s.paras.slice(s.title ? 1 : 0).map((p) => `<p>${esc(p)}</p>`).join('')}`}${s.notes ? `<div class="notes">${tt('备注：', 'Notes: ')}${esc(s.notes)}</div>` : ''}</section>`).join('') || `<p class="muted">${tt('没有读到幻灯片内容。', 'No slide content found.')}</p>`;
    if (doc.slides.some((s) => s.items)) return previewPage(title, tt(`共 ${doc.slides.length} 页 · 预览显示每页的文字、表格和图片，排版和动画以原文件为准。`, `${doc.slides.length} slides · The preview shows each slide's text, tables and pictures. Layout and animations may differ from the original.`), body, theme);
  }
  return previewPage(title, tt('预览只显示文字和表格，图片、排版和图表请下载原文件查看。', 'The preview shows text and tables only. Download the original for images, layout and charts.'), body, theme);
}

// theme：跟着 Hola 的浅色 / 深色走（不传就跟系统）
function previewPage(title, note, body, theme) {
  return `<!doctype html><html lang="${tt('zh-CN', 'en')}"${theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--ink:#1A1C1F;--ink2:#5E626A;--ink3:#93969F;--line:#E6E7EA;--wash:#F2F3F5;--paper:#F7F7F8;--card:#FFFFFF}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--ink:#ECECEE;--ink2:#A3A6AE;--ink3:#6F737C;--line:#2E2F34;--wash:#26272B;--paper:#17181A;--card:#1F2023}}
:root[data-theme=dark]{--ink:#ECECEE;--ink2:#A3A6AE;--ink3:#6F737C;--line:#2E2F34;--wash:#26272B;--paper:#17181A;--card:#1F2023}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.75 "Segoe UI Variable Text","Segoe UI","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
header{position:sticky;top:0;background:var(--paper);border-bottom:1px solid var(--line);padding:12px 22px;z-index:2}
header b{font-size:15px} header small{display:block;color:var(--ink3);font-size:12px}
main{max-width:960px;margin:0 auto;padding:20px 22px 60px}
.doc{max-width:760px;margin:0 auto}
h1,h2,h3,h4,h5{line-height:1.4;margin:1.2em 0 .5em} h2{font-size:18px} h3{font-size:16px}
p{margin:0 0 .8em} .muted{color:var(--ink3)}
.tw{overflow-x:auto;margin:.6em 0 1.2em;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;font-size:13.5px;min-width:100%}
th,td{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top;white-space:pre-wrap}
th{background:var(--wash);font-weight:600;position:sticky;top:0}
nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px} nav a{padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--ink2);text-decoration:none;font-size:13px}
.slide{position:relative;border:1px solid var(--line);border-radius:12px;padding:18px 22px 14px;margin:0 0 14px;background:var(--card)}
.slide .no{position:absolute;right:14px;top:10px;color:var(--ink3);font-size:12px}
.slide h2{margin:0 0 .6em}
.slide p{margin:0 0 .45em}
.imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:.4em 0 .9em}
.imgs:has(>:only-child){grid-template-columns:1fr}
.imgs img{display:block;width:100%;max-height:420px;object-fit:contain;border-radius:8px;background:var(--wash)}
.noimg{display:grid;place-items:center;min-height:90px;padding:10px;border:1px dashed var(--line);border-radius:8px;color:var(--ink3);font-size:12.5px;text-align:center}
.notes{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);color:var(--ink2);font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;font:13.5px/1.65 Consolas,Menlo,monospace}
</style></head><body><header><b>${esc(title)}</b><small>${esc(note)}</small></header><main>${body}</main></body></html>`;
}

module.exports = { lang: 'zh', readZip, OFFICE_EXT, readOffice, toMarkdown, toHtml, previewPage, htmlTable, esc };
