// 判分用的小工具：比较文字、找新文件、读 Office 表格、看回复里有没有"假装做了"
'use strict';
const fs = require('fs');
const path = require('path');
const { readOffice } = require('../office');
const { listConvFiles } = require('./harness');

// 比较前先统一：全角转半角、去空白、统一 ¥ 和 ×、小写
function norm(s) {
  return String(s || '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[￥]/g, '¥').replace(/[xX*✕]/g, '×').replace(/\s+/g, '').toLowerCase();
}
const has = (text, needle) => norm(text).includes(norm(needle));

// 这次对话里队友发的消息（不含记忆整理、看图说明、技能整理）
const work = (msgs) => (msgs || []).filter((m) => m.from !== 'boss' && m.from !== 'system' && !['memory', 'describe', 'skill'].includes(m.reason));
const lastWork = (msgs, from) => { const w = work(msgs).filter((m) => !from || m.from === from); return w[w.length - 1] || null; };

// 对话文件夹里新产生的某类文件（不算老板发的附件）
function outFiles(dir, ext, opts = {}) {
  return listConvFiles(dir).filter((f) => f.toLowerCase().endsWith(ext) && !f.startsWith('附件/') && !(opts.exclude || []).includes(f));
}
// 有的工具（比如 Codex 用的 Open XML SDK）写出的 Office 文件，标签都带 x: 这类前缀（<x:row>）。
// Hola 自己的读取器（office.js）目前不认，读出来是空的——这是 Hola 的问题，判分时不能因此冤枉队友：
// 先按原样读，读不出内容就去掉前缀再读一次。
function unprefixed(file) {
  const { readZip } = require('../office');
  const { makeZip } = require('../lib/office-write');
  const zip = readZip(fs.readFileSync(file));
  const files = {};
  for (const n of zip.names()) {
    files[n] = /\.xml$/.test(n) ? zip.text(n).replace(/<(\/?)x:/g, '<$1').replace(/\sxmlns:x="/g, ' xmlns="') : zip.bytes(n);
  }
  const tmp = path.join(require('os').tmpdir(), `hola-eval-${process.pid}-${Date.now()}${path.extname(file)}`);
  fs.writeFileSync(tmp, makeZip(files));
  try { return readOffice(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}
const empty = (o) => !o || (o.sheets && !o.sheets.some((s) => s.rows.length)) || (o.blocks && !o.blocks.length) || (o.slides && !o.slides.length);
function office(file) {
  let o = null;
  try { o = readOffice(file); } catch (_) {}
  if (empty(o)) { try { const u = unprefixed(file); if (!empty(u)) return u; } catch (_) {} }
  return o;
}
// 表格里的所有行（所有工作表连在一起）。用 Python（openpyxl）写的表常常只有公式、没有算好的值（"=C2*0.35"），
// Excel / WPS 打开时会自己算出来——判分时按 Excel 看到的样子算一遍简单公式（四则运算、SUM），不冤枉队友
function sheetRows(file) {
  const o = office(file);
  return o && o.sheets ? o.sheets.flatMap((s) => evalSheet(s.rows)) : [];
}
const colIdx = (l) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function evalSheet(rows) {
  const cell = (ref, depth) => {
    const mt = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!mt) return NaN;
    const v = (rows[Number(mt[2]) - 1] || [])[colIdx(mt[1])];
    return /^=/.test(String(v)) ? calc(String(v), depth + 1) : num(v);
  };
  const calc = (f, depth = 0) => {
    if (depth > 20) return NaN;
    let e = String(f).slice(1).toUpperCase().replace(/\$/g, '');
    e = e.replace(/SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)/g, (_, c1, r1, c2, r2) => {
      let s = 0;
      for (let r = Number(r1); r <= Number(r2); r++) for (let k = colIdx(c1); k <= colIdx(c2); k++) { const x = cell(String.fromCharCode(65 + k) + r, depth); if (Number.isFinite(x)) s += x; }
      return `(${s})`;
    });
    e = e.replace(/ROUND\(/g, '\u0001(').replace(/[A-Z]+\d+/g, (ref) => `(${cell(ref, depth)})`).replace(/\u0001/g, 'R');
    if (!/^[\d.+\-*/() eE,R]+$/.test(e)) return NaN;
    const R = (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n;
    try { return Number(Function('R', `"use strict";return (${e});`)(R)); } catch (_) { return NaN; }
  };
  return rows.map((r) => r.map((v) => { if (!/^=/.test(String(v))) return v; const x = calc(v); return Number.isFinite(x) ? String(Math.round(x * 1e6) / 1e6) : v; }));
}
// 一个格子里的数字（去掉 ¥ 、逗号、元）
function num(cell) {
  const m = String(cell == null ? '' : cell).replace(/[,，¥￥元\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
const near = (a, b, tol = 0.5) => Number.isFinite(a) && Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 0.001);
// 某一行里有没有和期望值接近的数字
const rowHas = (row, want, tol) => row.some((c) => near(num(c), want, tol));

// 文档里的全部文字
function docText(file) {
  const o = office(file);
  if (!o) return '';
  if (o.blocks) return o.blocks.map((b) => b.text || (b.rows ? b.rows.map((r) => r.join(' ')).join('\n') : '')).join('\n');
  if (o.slides) return o.slides.map((s) => (s.paras || s.texts || []).join('\n')).join('\n');
  if (o.sheets) return o.sheets.map((s) => s.rows.map((r) => r.join(' ')).join('\n')).join('\n');
  return '';
}

// 回复里说"已保存 / 已生成"之类，但文件其实不存在 = 假装做了
function claimsDone(text) {
  return /(已|已经)(保存|写入|生成|创建|存好|写好)|保存(好|成功)|已为你(保存|创建|生成)/.test(text || '') && !/(无法|不能|没法|做不到|没有权限|只读)/.test(text || '');
}

// 只留文案本身：去掉队友自己核对规矩的那几行（"全文没有用'最'字""价格按你最新的说法写成…"），
// 否则说明里提到的"最""¥"会被误判成文案违规
const META = /规矩|规则|规定|要求|说法|写法|没有用|没用|没有出现|全文|全篇|核对|照做|已按|按你|按照你|按老板/;
function copyOnly(t) {
  return String(t || '').split(/\r?\n/).filter((line) => !META.test(line)).join('\n');
}

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } };
const exists = (p) => fs.existsSync(p);

module.exports = { norm, has, work, lastWork, outFiles, office, sheetRows, num, near, rowHas, docText, claimsDone, copyOnly, read, exists, path };
