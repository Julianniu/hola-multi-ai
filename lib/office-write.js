// Hola · 生成 Word / Excel / PPT（零依赖）：队友写 Markdown，这里变成正式的 Office 文件。
// 只做常用的格式：标题、段落、加粗 / 斜体、列表、表格；Excel 每个表格一个工作表；PPT 每个标题一页。
// 也放着通用的 zip 打包（程序更新包、测试用的 Word 文件也用它）。
'use strict';
const zlib = require('zlib');

// ---------------------------------------------------------------- zip

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// files：{ "路径/文件名": Buffer 或字符串 }
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const data = zlib.deflateRawSync(raw), nameBuf = Buffer.from(name, 'utf8'), crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  const n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------- Markdown 拆块

// XML 里不允许的控制字符去掉，再转义
const x = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// 一行里的 **加粗**、*斜体*、`代码`、[文字](链接) → [{ text, b, i }]
function inlineRuns(s) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    if (m[1] || m[2]) out.push({ text: m[1] || m[2], b: true });
    else if (m[3]) out.push({ text: m[3], i: true });
    else if (m[4]) out.push({ text: m[4], code: true });
    else out.push({ text: `${m[5]}（${m[6]}）` });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.filter((r) => r.text);
}
const plain = (s) => inlineRuns(s).map((r) => r.text).join('');

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

// Markdown → [{ type: h|p|li|ol|table|hr, level, text, rows }]
function mdBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { // 代码块：原样一行一段
      flush();
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) blocks.push({ type: 'p', text: lines[i], code: true });
      continue;
    }
    if (!l.trim()) { flush(); continue; }
    let m;
    if ((m = l.match(/^\s*(#{1,6})\s+(.*)$/))) { flush(); blocks.push({ type: 'h', level: m[1].length, text: m[2].replace(/\s*#+\s*$/, '') }); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { flush(); blocks.push({ type: 'hr' }); continue; }
    if (isTableRow(l)) {
      flush();
      const rows = [];
      for (; i < lines.length && isTableRow(lines[i]); i++) if (!isSep(lines[i])) rows.push(splitRow(lines[i]));
      i--;
      blocks.push({ type: 'table', rows });
      continue;
    }
    if ((m = l.match(/^(\s*)[-*+•]\s+(.*)$/))) { flush(); blocks.push({ type: 'li', level: Math.min(2, Math.floor(m[1].length / 2)), text: m[2] }); continue; }
    if ((m = l.match(/^(\s*)\d+[.)、]\s+(.*)$/))) { flush(); blocks.push({ type: 'ol', level: Math.min(2, Math.floor(m[1].length / 2)), text: m[2] }); continue; }
    if ((m = l.match(/^\s*>\s?(.*)$/))) { flush(); blocks.push({ type: 'p', text: m[1], quote: true }); continue; }
    para.push(l.trim());
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------- Word

const FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑" w:cs="Calibri"/>';

function wRuns(text, extra) {
  return inlineRuns(text).map((r) => {
    const pr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '') + (extra || '');
    return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`;
  }).join('');
}
function wPara(text, style, opts = {}) {
  const ppr = (style ? `<w:pStyle w:val="${style}"/>` : '') + (opts.num ? `<w:numPr><w:ilvl w:val="${opts.lvl || 0}"/><w:numId w:val="${opts.num}"/></w:numPr>` : '') + (opts.ppr || '');
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${wRuns(text, opts.rpr)}</w:p>`;
}
function wTable(rows) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const w = Math.floor(9000 / cols);
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('');
  const trs = rows.map((r, ri) => `<w:tr>${Array.from({ length: cols }, (_, ci) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>${wPara(r[ci] || '', null, ri === 0 ? { rpr: '<w:b/>' } : {})}</w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="autofit"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + w + '"/>'.repeat(cols)}</w:tblGrid>${trs}</w:tbl><w:p/>`;
}

function writeDocx(md) {
  const blocks = mdBlocks(md);
  let body = '', nextNum = 3, curOl = null;
  const nums = []; // 每个编号列表单独从 1 开始
  for (const b of blocks) {
    if (b.type !== 'ol') curOl = null;
    if (b.type === 'h') body += wPara(b.text, b.level === 1 ? 'Heading1' : b.level === 2 ? 'Heading2' : 'Heading3');
    else if (b.type === 'li') body += wPara(b.text, 'ListParagraph', { num: 1, lvl: b.level });
    else if (b.type === 'ol') {
      if (!curOl) { curOl = nextNum++; nums.push(curOl); }
      body += wPara(b.text, 'ListParagraph', { num: curOl, lvl: b.level });
    } else if (b.type === 'table') body += wTable(b.rows);
    else if (b.type === 'hr') body += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>';
    else body += wPara(b.text, null, b.code ? { rpr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' } : b.quote ? { ppr: '<w:ind w:left="420"/>', rpr: '<w:color w:val="595959"/>' } : {});
  }
  const lvls = (fmt) => [0, 1, 2].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${fmt === 'bullet' ? ['•', '◦', '▪'][l] : `%${l + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${420 * (l + 1)}" w:hanging="420"/></w:pPr>${fmt === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr>' : ''}</w:lvl>`).join('');
  const numbering = `${XML}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet')}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    nums.map((n) => `<w:num w:numId="${n}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('') +
    `</w:numbering>`;
  const heading = (id, name, size, before) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${id.slice(-1) - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  const styles = `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    heading('Heading1', 'heading 1', 36, 360) + heading('Heading2', 'heading 2', 30, 240) + heading('Heading3', 'heading 3', 26, 200) +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>` +
    `</w:styles>`;
  const doc = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body || '<w:p/>'}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return makeZip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
    'word/document.xml': doc,
    'word/styles.xml': styles,
    'word/numbering.xml': numbering,
  });
}

// ---------------------------------------------------------------- Excel

// Markdown 里的表格（前面最近的标题当工作表名）或者 CSV → [{ name, rows }]
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  const sep = (s.split('\n')[0].match(/\t/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function sheetsFrom(content) {
  const blocks = mdBlocks(content);
  const sheets = [];
  let title = '';
  for (const b of blocks) {
    if (b.type === 'h') title = plain(b.text);
    if (b.type === 'table') sheets.push({ name: title || `Sheet${sheets.length + 1}`, rows: b.rows.map((r) => r.map(plain)) });
  }
  if (sheets.length) return sheets;
  const rows = parseCsv(content);
  return [{ name: 'Sheet1', rows }];
}
const colName = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const textWidth = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);

function writeXlsx(sheets) {
  const used = new Set();
  const list = (sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]).map((sh, i) => {
    let name = String(sh.name || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(name.toLowerCase())) name = name.slice(0, 28) + `(${i + 1})`;
    used.add(name.toLowerCase());
    return { name, rows: sh.rows || [] };
  });
  const files = {};
  list.forEach((sh, si) => {
    const cols = Math.max(0, ...sh.rows.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, c) => Math.min(60, Math.max(8, ...sh.rows.map((r) => textWidth(r[c] ?? '') + 2))));
    const rowsXml = sh.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
      const s = String(v ?? '');
      if (s === '') return '';
      // 纯数字存成数字（Excel 里能直接求和）；以 0 开头的编号、超长数字保持文字
      if (ri > 0 && /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(s.trim())) return `<c r="${ref}"${st}><v>${s.trim()}</v></c>`;
      return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${x(s)}</t></is></c>`;
    }).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      (sh.rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '') +
      (cols ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '') +
      `<sheetData>${rowsXml}</sheetData></worksheet>`;
  });
  Object.assign(files, {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + `</Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      list.map((sh, i) => `<sheet name="${x(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + `</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="2"><font><sz val="11"/><name val="微软雅黑"/></font><font><b/><sz val="11"/><name val="微软雅黑"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  });
  return makeZip(files);
}

// ---------------------------------------------------------------- PPT

// 每个 # / ## 标题开一页（或者用 --- 分页）；标题下面的列表和段落是这一页的内容
function slidesFrom(md) {
  const slides = [];
  let cur = null;
  const open = (title) => { cur = { title: title || '', lines: [] }; slides.push(cur); };
  for (const b of mdBlocks(md)) {
    if (b.type === 'hr') { cur = null; continue; }
    if (b.type === 'h' && b.level <= 2) { open(plain(b.text)); continue; }
    if (!cur) open('');
    if (b.type === 'h') cur.lines.push({ text: b.text, level: 0, bold: true });
    else if (b.type === 'li' || b.type === 'ol') cur.lines.push({ text: b.text, level: b.level, bullet: true });
    else if (b.type === 'table') for (const r of b.rows) cur.lines.push({ text: r.join('  |  '), level: 0 });
    else cur.lines.push({ text: b.text, level: 0 });
  }
  return slides.filter((s) => s.title || s.lines.length);
}

function pRuns(text, size, extra) {
  return inlineRuns(text).map((r) => `<a:r><a:rPr lang="zh-CN" sz="${size}"${r.b || extra === 'b' ? ' b="1"' : ''}${r.i ? ' i="1"' : ''} dirty="0"><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>${x(r.text)}</a:t></a:r>`).join('') || `<a:endParaRPr lang="zh-CN" sz="${size}"/>`;
}
function spBox(id, name, x0, y0, cx, cy, paras) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x0}" y="${y0}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}
const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Hola"><a:themeElements>` +
  `<a:clrScheme name="Hola"><a:dk1><a:srgbClr val="1F2233"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B2F4A"/></a:dk2><a:lt2><a:srgbClr val="F4F4F8"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="6B5CFF"/></a:accent1><a:accent2><a:srgbClr val="FF6FB5"/></a:accent2><a:accent3><a:srgbClr val="22D39A"/></a:accent3><a:accent4><a:srgbClr val="F5A524"/></a:accent4><a:accent5><a:srgbClr val="2EC4D6"/></a:accent5><a:accent6><a:srgbClr val="FF5A4E"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="3D7BFF"/></a:hlink><a:folHlink><a:srgbClr val="7C8CFF"/></a:folHlink></a:clrScheme>` +
  `<a:fontScheme name="Hola"><a:majorFont><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  `<a:fmtScheme name="Hola"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst>` +
  `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`).join('')}</a:lnStyleLst>` +
  `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
  `<a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

function writePptx(md) {
  const slides = slidesFrom(md);
  if (!slides.length) slides.push({ title: '', lines: [] });
  const W = 12192000, H = 6858000;
  const files = {};
  slides.forEach((s, i) => {
    const n = s.lines.length, chars = s.lines.reduce((a, l) => a + l.text.length, 0);
    const size = n <= 5 && chars < 220 ? 2400 : n <= 9 && chars < 420 ? 2000 : n <= 14 ? 1600 : 1400;
    const titleOnly = !n;
    const title = s.title ? spBox(2, 'Title', 685800, titleOnly ? 2400000 : 457200, W - 1371600, titleOnly ? 1600000 : 1000000,
      `<a:p>${titleOnly ? '<a:pPr algn="ctr"/>' : ''}${pRuns(s.title, titleOnly ? 4400 : 3200, 'b')}</a:p>`) : '';
    const body = n ? spBox(3, 'Content', 685800, s.title ? 1600000 : 685800, W - 1371600, H - (s.title ? 2200000 : 1300000),
      s.lines.map((l) => `<a:p><a:pPr${l.bullet ? ` marL="${342900 + l.level * 342900}" indent="-342900"` : ''}><a:spcBef><a:spcPts val="600"/></a:spcBef>${l.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : '<a:buNone/>'}</a:pPr>${pRuns(l.text, size, l.bold ? 'b' : '')}</a:p>`).join('')) : '';
    files[`ppt/slides/slide${i + 1}.xml`] = `${XML}<p:sld ${NS_P}><p:cSld><p:spTree>${GRP}${title}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  });
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const CT = 'application/vnd.openxmlformats-officedocument.presentationml.';
  Object.assign(files, {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="${CT}presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="${CT}presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${CT}viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="${CT}tableStyles+xml"/>` +
      slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}slide+xml"/>`).join('') + `</Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `${XML}<p:presentation ${NS_P} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>` +
      slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('') +
      `</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="${REL}presProps" Target="presProps.xml"/><Relationship Id="rId4" Type="${REL}viewProps" Target="viewProps.xml"/><Relationship Id="rId5" Type="${REL}tableStyles" Target="tableStyles.xml"/>` +
      slides.map((_, i) => `<Relationship Id="rId${10 + i}" Type="${REL}slide" Target="slides/slide${i + 1}.xml"/>`).join('') + `</Relationships>`,
    'ppt/presProps.xml': `${XML}<p:presentationPr ${NS_P}/>`,
    'ppt/viewProps.xml': `${XML}<p:viewPr ${NS_P}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>`,
    'ppt/tableStyles.xml': `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    'ppt/theme/theme1.xml': THEME,
    'ppt/slideMasters/slideMaster1.xml': `${XML}<p:sldMaster ${NS_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}theme" Target="../theme/theme1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `${XML}<p:sldLayout ${NS_P} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  });
  return makeZip(files);
}

// 按扩展名生成：.docx / .pptx 用 Markdown；.xlsx 用 Markdown 表格或 CSV
function writeOffice(ext, content) {
  ext = String(ext).toLowerCase().replace(/^\./, '');
  if (ext === 'docx') return writeDocx(content);
  if (ext === 'xlsx') return writeXlsx(sheetsFrom(content));
  if (ext === 'pptx') return writePptx(content);
  throw new Error('unsupported: ' + ext);
}

module.exports = { crc32, makeZip, mdBlocks, writeDocx, writeXlsx, writePptx, writeOffice, sheetsFrom, parseCsv };
