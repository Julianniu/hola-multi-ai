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

// 显示宽度：中文算 2，英文数字算 1（Excel 列宽、Word 表格列宽用）
const textWidth = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

// Markdown → [{ type: h|p|li|ol|table|hr, level, text, rows }]
function mdBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' '), lines: para }); para = []; } };
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

// ---------------------------------------------------------------- Hola 文档标准（版式）

// Word / Excel / PPT 共用一套：深蓝做主色，浅灰蓝做底和隔行，四个点缀色给卡片，全部微软雅黑
const HS = {
  font: '微软雅黑',
  ink: '1F2433', body: '2E3446', muted: '6B7285',
  primary: '2F5597', primaryDark: '1D2B57', tint: 'EEF2FA', band: 'F5F7FB', line: 'D5DCEA', page: 'F7F8FC',
  accents: ['5B6CFF', '18A982', 'F08A3C', 'E25A7A'],
};
// 看起来像数字的格子（表格里右对齐）
const isNum = (s) => /^[-+]?[¥$€]?\s?\d[\d,]*(\.\d+)?\s?(%|‰|万|亿|元|件|单|个|人|倍|台|次|天|小时|分钟|秒)?$/.test(plain(s).trim());

// ---------------------------------------------------------------- Word

const FONT = `<w:rFonts w:ascii="${HS.font}" w:hAnsi="${HS.font}" w:eastAsia="${HS.font}" w:cs="${HS.font}"/>`;
const CALLOUT = /^\s*(\*\*|__)?(注意|提示|说明|备注|注|重要|风险提示|Note|Tip|Warning)(\*\*|__)?\s*[：:]|^\s*※/i;
const PAGE_W = 9026; // A4 宽减去左右各 2.54 厘米（单位：1/20 磅）

// o = { b, color }；rPr 里的顺序按 Word 的要求排（顺序错了 Word 会说文件损坏）
function wRuns(text, o = {}) {
  return inlineRuns(text).map((r) => {
    const pr = (r.code || o.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '') + (r.b || o.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') +
      (o.color ? `<w:color w:val="${o.color}"/>` : '') + (r.code ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '');
    return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`;
  }).join('');
}
function wPara(text, style, opts = {}) {
  const ppr = (style ? `<w:pStyle w:val="${style}"/>` : '') + (opts.num ? `<w:numPr><w:ilvl w:val="${opts.lvl || 0}"/><w:numId w:val="${opts.num}"/></w:numPr>` : '') + (opts.ppr || '');
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${wRuns(text, opts.run)}</w:p>`;
}
// 列宽按内容长短分；表头深蓝白字、隔行浅底、数字列右对齐、跨页时重复表头
function wTable(rows) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const want = Array.from({ length: cols }, (_, c) => Math.min(36, Math.max(4, ...rows.map((r) => textWidth(plain(r[c] || ''))))));
  const sum = want.reduce((a, b) => a + b, 0);
  const raw = want.map((v) => Math.max(900, PAGE_W * v / sum));
  const k = PAGE_W / raw.reduce((a, b) => a + b, 0);
  let widths = raw.map((v) => v * k);
  // 短的列（不超过 8 个汉字，比如"蓄水种草""日常价"）尽量一行放下，宽度从长的列里匀
  const longest = widths.map((_, c) => Math.max(1, ...rows.map((r) => textWidth(plain(r[c] || '')))));
  const fit = longest.map((v) => (v <= 16 ? Math.ceil(v / 2) * 210 * 1.08 + 260 : 0));
  const short = widths.map((w, c) => fit[c] > w);
  const need = widths.reduce((a, w, c) => a + (short[c] ? fit[c] - w : 0), 0);
  const spare = widths.reduce((a, w, c) => a + (short[c] ? 0 : w), 0);
  if (need > 0 && spare - need > PAGE_W * 0.4) widths = widths.map((w, c) => (short[c] ? fit[c] : w * (spare - need) / spare));
  widths = widths.map(Math.floor);
  const head = rows.length > 1;
  const numCol = widths.map((_, c) => { const v = rows.slice(1).map((r) => r[c] || '').filter((s) => s.trim()); return v.length > 0 && v.filter(isNum).length / v.length >= 0.6; });
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="${HS.line}"/>`).join('');
  const trs = rows.map((r, ri) => {
    const isHead = head && ri === 0;
    const fill = isHead ? HS.primary : head && ri % 2 === 0 ? HS.band : '';
    return `<w:tr>${isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${widths.map((w, ci) =>
      `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>` +
      wPara(r[ci] || '', null, { ppr: `<w:spacing w:before="40" w:after="40" w:line="276" w:lineRule="auto"/><w:jc w:val="${numCol[ci] && !isHead ? 'right' : 'left'}"/>`, run: isHead ? { b: true, color: 'FFFFFF' } : ci === 0 && widths.length >= 3 && !numCol[0] ? { b: true, color: HS.ink } : {} }) + '</w:tc>').join('')}</w:tr>`; // 三列以上的表，第一列（项目名）加粗
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${PAGE_W}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${trs}</w:tbl><w:p><w:pPr><w:spacing w:after="60"/></w:pPr></w:p>`;
}

function writeDocx(md) {
  const blocks = mdBlocks(md);
  // 只有开头一个 # 标题：它当文档大标题（居中），## 当一级小标题
  const titled = blocks[0] && blocks[0].type === 'h' && blocks[0].level === 1 && blocks.filter((b) => b.type === 'h' && b.level === 1).length === 1;
  let body = '', nextNum = 3, curOl = null;
  const nums = []; // 每个编号列表单独从 1 开始
  blocks.forEach((b, bi) => {
    if (b.type !== 'ol') curOl = null;
    if (b.type === 'h') {
      const lvl = titled ? (bi === 0 ? 0 : b.level - 1) : b.level;
      body += wPara(b.text, lvl === 0 ? 'Title' : lvl === 1 ? 'Heading1' : lvl === 2 ? 'Heading2' : 'Heading3');
    } else if (b.type === 'li') body += wPara(b.text, 'ListParagraph', { num: 1, lvl: b.level });
    else if (b.type === 'ol') {
      if (!curOl) { curOl = nextNum++; nums.push(curOl); }
      body += wPara(b.text, 'ListParagraph', { num: curOl, lvl: b.level });
    } else if (b.type === 'table') body += wTable(b.rows);
    else if (b.type === 'hr') body += `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${HS.line}"/></w:pBdr></w:pPr></w:p>`;
    else if (b.code) body += wPara(b.text, null, { ppr: '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="260" w:lineRule="auto"/><w:jc w:val="left"/>', run: { mono: true } });
    else if (b.quote) body += wPara(b.text, null, { ppr: `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${HS.primary}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${HS.band}"/><w:ind w:left="240" w:right="120"/>`, run: { color: HS.muted } });
    // "注意：/ 说明：/ 提示：/ ※" 开头的段落：浅橙底提示框
    // 紧挨着表格或列表的一句短话（不以句号结尾）是这张表 / 这组要点的小标题：加粗，和下面的内容放在同一页
    else if ((blocks[bi + 1] || {}).type && ['table', 'li', 'ol'].includes(blocks[bi + 1].type) && plain(b.text).length <= 40 && !/[。.!！?？]$/.test(plain(b.text).trim()) && !CALLOUT.test(b.text))
      body += wPara(b.text, null, { ppr: '<w:keepNext/><w:spacing w:before="200" w:after="80"/>', run: { b: true, color: HS.ink } });
    else if (CALLOUT.test(b.text)) body += wPara(b.text, null, { ppr: `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${HS.accents[2]}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="FFF6EC"/><w:spacing w:before="120" w:after="200"/><w:ind w:left="240" w:right="120"/>` });
    else body += wPara(b.text);
  });
  const lvls = (fmt) => [0, 1, 2].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${fmt === 'bullet' ? ['•', '◦', '▪'][l] : `%${l + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${420 * (l + 1)}" w:hanging="420"/></w:pPr>${fmt === 'bullet' ? `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="${HS.primary}"/></w:rPr>` : ''}</w:lvl>`).join('');
  const numbering = `${XML}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet')}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    nums.map((n) => `<w:num w:numId="${n}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('') +
    `</w:numbering>`;
  // 一级小标题：主色加粗、下面一条细线；二级主色；三级深色
  const heading = (id, name, size, before, color, line) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/>` +
    (line ? `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="${HS.line}"/></w:pBdr>` : '') +
    `<w:spacing w:before="${before}" w:after="140" w:line="300" w:lineRule="auto"/><w:jc w:val="left"/><w:outlineLvl w:val="${id.slice(-1) - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  const styles = `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="both"/></w:pPr><w:rPr><w:color w:val="${HS.body}"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="360" w:line="300" w:lineRule="auto"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="${HS.ink}"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>` +
    heading('Heading1', 'heading 1', 32, 400, HS.primary, true) + heading('Heading2', 'heading 2', 26, 260, HS.primary) + heading('Heading3', 'heading 3', 23, 200, HS.ink) +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="${HS.muted}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +
    `</w:styles>`;
  // 页脚：居中"页码 / 总页数"
  const field = (instr) => `<w:fldSimple w:instr=" ${instr} "><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
  const footer = `${XML}<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>${field('PAGE')}<w:r><w:t xml:space="preserve"> / </w:t></w:r>${field('NUMPAGES')}</w:p></w:ftr>`;
  // 页眉：右上角小字写文档标题，下面一条细线（有大标题的文档才有）
  const header = `${XML}<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Footer"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="${HS.line}"/></w:pBdr><w:jc w:val="right"/></w:pPr>${titled ? wRuns(plain(blocks[0].text)) : ''}</w:p></w:hdr>`;
  const doc = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body || '<w:p/>'}` +
    `<w:sectPr>${titled ? '<w:headerReference w:type="default" r:id="rId4"/>' : ''}<w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="680" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  return makeZip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
      `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="${REL}footer" Target="footer1.xml"/><Relationship Id="rId4" Type="${REL}header" Target="header1.xml"/></Relationships>`,
    'word/document.xml': doc,
    'word/styles.xml': styles,
    'word/numbering.xml': numbering,
    'word/footer1.xml': footer,
    'word/header1.xml': header,
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
    const widths = Array.from({ length: cols }, (_, c) => Math.min(50, Math.max(8, ...sh.rows.map((r) => textWidth(r[c] ?? '') * 1.1 + 2))));
    // 编号、年份、电话这类列不加千分位
    const plainCol = (sh.rows[0] || []).map((h) => /年|编号|序号|ID|代码|号码|电话|邮编|code/i.test(String(h ?? '')));
    // 样式：1 表头（深蓝白字居中）、2 文字、3 大数字（千分位）、4 普通数字、5 长文字（自动换行）；正文都带细边框
    const rowsXml = sh.rows.map((r, ri) => `<row r="${ri + 1}"${ri === 0 ? ' ht="24" customHeight="1"' : ''}>${r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1);
      const s = String(v ?? '');
      if (s === '') return ri === 0 ? '' : `<c r="${ref}" s="2"/>`;
      // 纯数字存成数字（Excel 里能直接求和）；以 0 开头的编号、超长数字保持文字
      if (ri > 0 && /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(s.trim())) return `<c r="${ref}" s="${Math.abs(Number(s)) >= 1000 && !s.includes('.') && !plainCol[ci] ? 3 : 4}"><v>${s.trim()}</v></c>`;
      const st = ri === 0 ? 1 : textWidth(s) > 50 ? 5 : 2;
      return `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${x(s)}</t></is></c>`;
    }).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` +
      (sh.rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '') +
      '<sheetFormatPr defaultRowHeight="18"/>' +
      (cols ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.round(w)}" customWidth="1"/>`).join('')}</cols>` : '') +
      `<sheetData>${rowsXml}</sheetData>` +
      (sh.rows.length > 2 && cols ? `<autoFilter ref="A1:${colName(cols - 1)}${sh.rows.length}"/>` : '') +
      // 打印：宽表横向，所有列缩到一页宽
      `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${widths.reduce((a, b) => a + b, 0) > 95 ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/></worksheet>`;
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
      `<fonts count="2"><font><sz val="11"/><color rgb="FF${HS.body}"/><name val="${HS.font}"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="${HS.font}"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${HS.primary}"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
      `<border>${['left', 'right', 'top', 'bottom'].map((s) => `<${s} style="thin"><color rgb="FF${HS.line}"/></${s}>`).join('')}<diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
      `<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  });
  return makeZip(files);
}

// ---------------------------------------------------------------- PPT

// 每个 # / ## 标题开一页（或者用 --- 分页）；标题下面的列表、段落和表格是这一页的内容
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
    else if (b.type === 'table') cur.lines.push({ table: b.rows });
    else if (!slides.indexOf(cur) && b.lines && b.lines.length > 1) for (const t of b.lines) cur.lines.push({ text: t, level: 0 }); // 封面的副标题：一行是一行
    else cur.lines.push({ text: b.text, level: 0 });
  }
  return slides.filter((s) => s.title || s.lines.length);
}

// 版面：16:9，左右各留 0.75 英寸；字号按估算挑"放得下的最大一号"，不靠 PowerPoint 自动缩小（导出图片、手机预览时它不生效）
const IN = 914400, PT = 12700;
const SW = 12192000, SH = 6858000, SM = 0.75 * IN;
const em = (s) => [...plain(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 1 : 0.56), 0);
const solid = (c, alpha) => `<a:solidFill><a:srgbClr val="${c}">${alpha ? `<a:alpha val="${alpha}"/>` : ''}</a:srgbClr></a:solidFill>`;
const SHADOW = `<a:effectLst><a:outerShdw blurRad="190500" dist="38100" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="${HS.primaryDark}"><a:alpha val="10000"/></a:srgbClr></a:outerShdw></a:effectLst>`;
const R = Math.round;

// o = { size (磅), color, b, boldColor }
function pRuns(text, o) {
  const sz = R(o.size * 100);
  return inlineRuns(text).map((r) => `<a:r><a:rPr lang="zh-CN" sz="${sz}"${r.b || o.b ? ' b="1"' : ''}${r.i ? ' i="1"' : ''} dirty="0">${solid(r.b && o.boldColor ? o.boldColor : o.color || HS.body)}<a:latin typeface="${HS.font}"/><a:ea typeface="${HS.font}"/></a:rPr><a:t>${x(r.text)}</a:t></a:r>`).join('') ||
    `<a:endParaRPr lang="zh-CN" sz="${sz}"/>`;
}
const bulletInd = (level) => (0.3 + 0.32 * (level || 0)) * IN;
// 一段：o 另有 align, bullet, level, before (磅), line (行距倍数)
function aPara(text, o) {
  const ind = o.bullet ? ` marL="${R(bulletInd(o.level))}" indent="${-R(0.3 * IN)}"` : '';
  const bu = o.bullet ? `<a:buClr><a:srgbClr val="${o.level ? HS.muted : HS.primary}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${o.level ? '–' : '•'}"/>` : '<a:buNone/>';
  return `<a:p><a:pPr${o.align ? ` algn="${o.align}"` : ''}${ind}><a:lnSpc><a:spcPct val="${R((o.line || 1.15) * 100000)}"/></a:lnSpc><a:spcBef><a:spcPts val="${R((o.before || 0) * 100)}"/></a:spcBef>${bu}</a:pPr>${pRuns(text, o)}</a:p>`;
}
// 一个形状（可带文字）：o = { x, y, w, h, geom, adj, fill, alpha, shadow, paras, anchor, inset }
function sp(ctx, o) {
  const id = ctx.id++;
  const ins = o.inset != null ? o.inset : 0.1 * IN;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${o.name || 'Shape'} ${id}"/><p:cNvSpPr${o.fill ? '' : ' txBox="1"'}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${R(o.x)}" y="${R(o.y)}"/><a:ext cx="${R(o.w)}" cy="${R(o.h)}"/></a:xfrm><a:prstGeom prst="${o.geom || 'rect'}"><a:avLst>${o.adj != null ? `<a:gd name="adj" fmla="val ${o.adj}"/>` : ''}</a:avLst></a:prstGeom>` +
    `${o.fill ? solid(o.fill, o.alpha) : '<a:noFill/>'}<a:ln><a:noFill/></a:ln>${o.shadow ? SHADOW : ''}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="${R(ins)}" tIns="${R(ins / 2)}" rIns="${R(ins)}" bIns="${R(ins / 2)}" anchor="${o.anchor || 't'}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${o.paras || '<a:p><a:endParaRPr lang="zh-CN"/></a:p>'}</p:txBody></p:sp>`;
}

// 文字估高：items = [{ text, bullet, level, rel (相对字号), gap (段前，按字号的倍数) }]，w = 文本框宽
function textHeight(items, size, w) {
  return items.reduce((sum, it) => {
    const s = size * (it.rel || 1);
    const avail = (w - 0.2 * IN - (it.bullet ? bulletInd(it.level) : 0)) * 0.95;
    const lines = Math.max(1, Math.ceil(em(it.text) / Math.max(1, avail / (s * PT))));
    return sum + lines * s * PT * 1.2 * (it.line || 1.15) + (it.gap || 0) * size * PT;
  }, 0.1 * IN);
}
const fitSize = (items, w, h, sizes) => sizes.find((s) => textHeight(items, s, w) <= h) || sizes[sizes.length - 1];
const itemParas = (items, size) => items.map((it) => aPara(it.text, { size: size * (it.rel || 1), color: it.color || HS.body, boldColor: HS.ink, b: it.b, bullet: it.bullet, level: it.level, before: (it.gap || 0) * size, line: it.line, align: it.align })).join('');

// 真表格：表头深蓝白字、隔行浅底；字号按行数和放得下挑
function tableFrame(ctx, rows, x0, y0, w, hMax) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const longest = Array.from({ length: cols }, (_, c) => Math.max(1, ...rows.map((r) => em(r[c] || ''))));
  const want = longest.map((v) => Math.min(24, Math.max(3, v)));
  const sum = want.reduce((a, b) => a + b, 0);
  let gw = want.map((v) => w * v / sum);
  // 短的列（不超过 8 个字）尽量一行放下，多出来的宽度从长的列里匀
  const fit = longest.map((v) => (v <= 8 ? v * 20 * PT / 0.95 + 0.25 * IN : 0));
  const short = gw.map((g, c) => fit[c] > g);
  const need = gw.reduce((a, g, c) => a + (short[c] ? fit[c] - g : 0), 0);
  const spare = gw.reduce((a, g, c) => a + (short[c] ? 0 : g), 0);
  if (need > 0 && spare - need > w * 0.4) gw = gw.map((g, c) => (short[c] ? fit[c] : g * (spare - need) / spare));
  gw = gw.map(Math.floor);
  const head = rows.length > 1;
  const rowH = (r, s) => Math.max(...gw.map((cw, c) => Math.ceil(em(r[c] || '') / Math.max(1, (cw - 0.2 * IN) * 0.95 / (s * PT))))) * s * PT * 1.25 + 0.14 * IN;
  const tall = (s) => rows.reduce((a, r) => a + rowH(r, s), 0);
  let size = (rows.length <= 4 ? 20 : rows.length <= 6 ? 18 : rows.length <= 9 ? 16 : 14) - (cols > 5 ? 2 : 0);
  while (size > 10 && tall(size) > hMax) size--;
  // 行少的表格把行高拉开一些，别只占半页、下面一大片空白
  const pad = Math.max(0, Math.min(rows.length <= 4 ? 0.5 * IN : 0.32 * IN, (hMax * 0.72 - tall(size)) / rows.length));
  const numCol = gw.map((_, c) => { const v = rows.slice(1).map((r) => r[c] || '').filter((s) => s.trim()); return v.length > 0 && v.filter(isNum).length / v.length >= 0.6; });
  const bd = ['lnL', 'lnR', 'lnT', 'lnB'].map((t) => `<a:${t} w="6350" cap="flat" cmpd="sng" algn="ctr">${solid(HS.line)}<a:prstDash val="solid"/></a:${t}>`).join('');
  const trs = rows.map((r, ri) => {
    const isHead = head && ri === 0;
    const fill = isHead ? HS.primary : ri % 2 === 0 ? HS.tint : 'FFFFFF';
    return `<a:tr h="${R(rowH(r, size) + pad)}">${gw.map((_, c) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${aPara(r[c] || '', { size, color: isHead ? 'FFFFFF' : HS.body, boldColor: HS.ink, b: isHead, line: 1.05, align: numCol[c] && !isHead ? 'r' : undefined })}</a:txBody>` +
      `<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">${bd}${solid(fill)}</a:tcPr></a:tc>`).join('')}</a:tr>`;
  }).join('');
  const id = ctx.id++;
  const h = tall(size) + pad * rows.length;
  return {
    h,
    xml: `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${R(x0)}" y="${R(y0)}"/><a:ext cx="${gw.reduce((a, b) => a + b, 0)}" cy="${R(h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
      `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${gw.map((v) => `<a:gridCol w="${v}"/>`).join('')}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
  };
}

// 2～4 条"**小标题**：说明"（或 ### 小标题 + 几行）→ 并排卡片；不像就返回 null，按普通列表排
function cardItems(lines) {
  const items = [];
  let cur = null;
  for (const l of lines) {
    if (l.table) return null;
    const runs = inlineRuns(l.text);
    if (l.bold || (l.bullet && !l.level && runs[0] && runs[0].b)) {
      cur = { lead: (l.bold ? plain(l.text) : runs[0].text).replace(/[：:]\s*$/, ''), head: !!l.bold, body: [] };
      const rest = l.bold ? '' : plain(l.text).slice(runs[0].text.length).replace(/^[\s：:—–-]+/, '');
      if (rest) cur.body.push(rest);
      items.push(cur);
    } else if (cur && (l.level || cur.head)) cur.body.push(l.text);
    else return null;
  }
  if (items.length < 2 || items.length > 4) return null;
  if (items.some((it) => em(it.lead) > 14 || it.body.reduce((n, t) => n + em(t), 0) > 120)) return null;
  return items;
}

function cardsXml(ctx, items, top, bottom) {
  const k = items.length, gap = 0.3 * IN, pad = 0.32 * IN;
  const w = (SW - 2 * SM - gap * (k - 1)) / k;
  // 卡片小标题尽量一行放下：最长的那个放不下就缩小一号（最小 18 磅）
  const longLead = Math.max(...items.map((it) => em(it.lead)));
  const lead = [26, 24, 22, 20, 18].filter((z) => z <= [0, 0, 26, 24, 20][k]).find((z) => longLead * z * PT <= (w - 2 * pad) * 0.97) || 18;
  const leadLines = Math.max(...items.map((it) => Math.ceil(em(it.lead) * lead * PT / (w - 2 * pad))));
  const leadH = leadLines * lead * PT * 1.3;
  const fixed = pad + 0.6 * IN + 0.22 * IN + leadH + 0.2 * IN + pad;
  const bodyW = w - 2 * pad + 0.2 * IN;
  const bodies = items.map((it) => it.body.map((t, j) => ({ text: t, gap: j ? 0.4 : 0 })));
  const sizes = [20, 18, 17, 16, 15, 14, 13, 12].filter((s) => s <= lead - 4); // 正文比卡片小标题小一档
  const size = Math.min(...bodies.map((b) => (b.length ? fitSize(b, bodyW, bottom - top - fixed, sizes) : sizes[0])));
  const bodyH = Math.max(0, ...bodies.map((b) => (b.length ? textHeight(b, size, bodyW) : 0)));
  const cardH = Math.min(bottom - top, Math.max(2.6 * IN, fixed + bodyH));
  const y = top + (bottom - top - cardH) * 0.35;
  return items.map((it, i) => {
    const cx = SM + i * (w + gap);
    const color = HS.primary; // 编号圆点统一用主色（盲评：四种颜色像随手配的）
    return sp(ctx, { x: cx, y, w, h: cardH, geom: 'roundRect', adj: 6000, fill: 'FFFFFF', shadow: true, name: 'Card' }) +
      sp(ctx, { x: cx + pad, y: y + pad, w: 0.6 * IN, h: 0.6 * IN, geom: 'ellipse', fill: color, inset: 0, anchor: 'ctr', name: 'Badge', paras: aPara(String(i + 1), { size: 18, color: 'FFFFFF', b: true, align: 'ctr', line: 1 }) }) +
      sp(ctx, { x: cx + pad - 0.1 * IN, y: y + pad + 0.82 * IN, w: bodyW, h: leadH + 0.1 * IN, paras: aPara(it.lead, { size: lead, color: HS.ink, b: true, line: 1.1 }), name: 'Lead' }) +
      (bodies[i].length ? sp(ctx, { x: cx + pad - 0.1 * IN, y: y + fixed - pad, w: bodyW, h: cardH - fixed + pad, paras: itemParas(bodies[i], size), name: 'Text' }) : '');
  }).join('');
}

// 同样的 2～4 条要点，换一种排法：一条一行的横条（左边编号和小标题，右边说明）。
// 连着几页都是卡片时轮流用，说明长的直接用横条（盲评：连续几页同一种卡片像套模板）
function rowsXml(ctx, items, top, bottom) {
  const k = items.length, gap = 0.2 * IN;
  const rowH = Math.min(1.45 * IN, (bottom - top - gap * (k - 1)) / k);
  const y0 = top + (bottom - top - rowH * k - gap * (k - 1)) * 0.35;
  const longLead = Math.max(...items.map((it) => em(it.lead)));
  const lead = [22, 20, 18].find((z) => longLead * z * PT <= 2.9 * IN * 0.97) || 18;
  const leadW = Math.max(1.8 * IN, Math.min(3.1 * IN, longLead * lead * PT / 0.97 + 0.45 * IN)); // 小标题这一栏跟着最长的小标题走
  const bodyX = SM + 1.15 * IN + leadW, bodyW = SW - SM - 0.25 * IN - bodyX;
  const bodies = items.map((it) => it.body.map((t, j) => ({ text: t, gap: j ? 0.3 : 0 })));
  const size = Math.min(...bodies.map((b) => (b.length ? fitSize(b, bodyW, rowH - 0.15 * IN, [20, 18, 17, 16, 15, 14, 13, 12]) : 20)));
  return items.map((it, i) => {
    const y = y0 + i * (rowH + gap);
    return sp(ctx, { x: SM, y, w: SW - 2 * SM, h: rowH, geom: 'roundRect', adj: 9000, fill: 'FFFFFF', shadow: true, name: 'Row' }) +
      sp(ctx, { x: SM + 0.35 * IN, y: y + (rowH - 0.55 * IN) / 2, w: 0.55 * IN, h: 0.55 * IN, geom: 'ellipse', fill: HS.primary, inset: 0, anchor: 'ctr', name: 'Badge', paras: aPara(String(i + 1), { size: 16, color: 'FFFFFF', b: true, align: 'ctr', line: 1 }) }) +
      sp(ctx, { x: SM + 1.15 * IN, y, w: leadW, h: rowH, anchor: 'ctr', paras: aPara(it.lead, { size: lead, color: HS.ink, b: true, line: 1.1 }), name: 'Lead' }) +
      (bodies[i].length ? sp(ctx, { x: bodyX, y, w: bodyW, h: rowH, anchor: 'ctr', paras: itemParas(bodies[i], size), name: 'Text' }) : '');
  }).join('');
}

const FOOT = /^\s*(※|注[:：]|备注[:：]|\*\s|说明[:：])/;

// 一页的形状：封面（第一页，标题加不超过三行）、过渡页（只有标题）、卡片、表格、普通列表
function slideShapes(s, i, total, deck = {}) {
  const ctx = { id: 2 };
  const n = s.lines.length;
  const chars = s.lines.reduce((a, l) => a + (l.table ? 99 : em(l.text)), 0);
  if (i === 0 && total > 1 && s.title && n <= 3 && chars <= 140 && !s.lines.some((l) => l.table)) {
    // 标题尽量一行放下；放不下就两行，并把框收窄让两行差不多长（不让一两个字单独掉到第二行）
    const tw = 8.6 * IN, t = em(s.title);
    const size = [44, 40, 36].find((z) => t * z * PT <= tw) || [36, 32, 28].find((z) => t * z * PT <= tw * 1.9) || 28;
    const lines = Math.ceil(t * size * PT / tw);
    const boxW = lines > 1 ? Math.min(tw, Math.ceil(t / lines + 1) * size * PT) + 0.2 * IN : 8.8 * IN;
    const titleH = lines * size * PT * 1.25 + 0.1 * IN;
    const subs = s.lines.map((l, j) => ({ text: l.text, gap: j ? 0.4 : 0, color: 'C9D2EE' }));
    return {
      bg: HS.primaryDark,
      xml: sp(ctx, { x: SW - 4.6 * IN, y: -1.6 * IN, w: 6.4 * IN, h: 6.4 * IN, geom: 'ellipse', fill: 'FFFFFF', alpha: 6000, name: 'Deco' }) +
        sp(ctx, { x: SW - 2.9 * IN, y: 3.9 * IN, w: 4.2 * IN, h: 4.2 * IN, geom: 'ellipse', fill: HS.accents[0], alpha: 30000, name: 'Deco' }) +
        sp(ctx, { x: SM, y: 2.2 * IN, w: 0.9 * IN, h: 0.08 * IN, fill: HS.accents[2], name: 'Bar' }) +
        sp(ctx, { x: SM - 0.1 * IN, y: 2.45 * IN, w: boxW, h: titleH, paras: aPara(s.title, { size, color: 'FFFFFF', b: true, line: 1.05 }), name: 'Title' }) +
        (subs.length ? sp(ctx, { x: SM - 0.1 * IN, y: 2.55 * IN + titleH, w: 8.8 * IN, h: 2 * IN, paras: itemParas(subs, 18), name: 'Subtitle' }) : ''),
    };
  }
  const pageNo = sp(ctx, { x: SW - SM - 1 * IN, y: SH - 0.52 * IN, w: 1 * IN, h: 0.32 * IN, inset: 0, name: 'Page',
    paras: `<a:p><a:pPr algn="r"/><a:fld id="{4B6A3C1E-2F8D-4E5A-9B7C-1D2E3F4A5B6C}" type="slidenum"><a:rPr lang="zh-CN" sz="1100" dirty="0">${solid(HS.muted)}<a:latin typeface="${HS.font}"/><a:ea typeface="${HS.font}"/></a:rPr><a:t>${i + 1}</a:t></a:fld></a:p>` });
  if (!n) { // 过渡页
    const size = em(s.title) > 20 ? 32 : 40;
    return {
      bg: HS.page,
      xml: sp(ctx, { x: SM, y: 2.6 * IN, w: SW - 2 * SM, h: 1.4 * IN, anchor: 'b', paras: aPara(s.title, { size, color: HS.ink, b: true, align: 'ctr', line: 1.05 }), name: 'Title' }) +
        sp(ctx, { x: (SW - 0.9 * IN) / 2, y: 4.2 * IN, w: 0.9 * IN, h: 0.07 * IN, fill: HS.primary, name: 'Bar' }) + pageNo,
    };
  }
  // 标题：一行放得下就 28 磅，放不下缩到 24 / 20
  let xml = '', top = 0.6 * IN;
  if (s.title) {
    const tw = SW - 2 * SM - 0.2 * IN;
    const size = [28, 24, 20].find((z) => em(s.title) * z * PT <= tw) || 20;
    xml += sp(ctx, { x: SM - 0.1 * IN, y: 0.4 * IN, w: SW - 2 * SM + 0.2 * IN, h: 0.9 * IN, anchor: 'b', paras: aPara(s.title, { size, color: HS.ink, b: true, line: 1.05 }), name: 'Title' }) +
      sp(ctx, { x: SM, y: 1.38 * IN, w: 0.75 * IN, h: 0.06 * IN, fill: HS.primary, name: 'Bar' });
    top = 1.7 * IN;
  }
  // 结尾的"※ / 注："小字放到页脚
  const lines = s.lines.slice();
  const foot = [];
  while (lines.length > 1 && !lines[lines.length - 1].table && !lines[lines.length - 1].bullet && FOOT.test(lines[lines.length - 1].text)) foot.unshift(lines.pop());
  let bottom = SH - 0.62 * IN;
  if (foot.length) {
    const fh = textHeight(foot.map((l) => ({ text: l.text })), 12, SW - 2 * SM - 1.2 * IN);
    xml += sp(ctx, { x: SM - 0.1 * IN, y: SH - 0.5 * IN - fh, w: SW - 2 * SM - 1 * IN, h: fh, anchor: 'b', paras: itemParas(foot.map((l) => ({ text: l.text, color: HS.muted })), 12), name: 'Note' });
    bottom = SH - 0.62 * IN - fh;
  }
  const cards = cardItems(lines);
  if (cards) {
    deck.cards = (deck.cards || 0) + 1;
    // 说明长、或者小标题在卡片里一行放不下（最小 18 磅），就用横条：横条的小标题那一栏更宽
    const cardW = (SW - 2 * SM - 0.3 * IN * (cards.length - 1)) / cards.length - 0.64 * IN;
    const long = cards.some((it) => it.body.reduce((n, t) => n + em(t), 0) > 45 || em(it.lead) * 18 * PT > cardW * 0.97);
    const rows = long || deck.cards % 2 === 0;
    return { bg: HS.page, xml: xml + (rows ? rowsXml : cardsXml)(ctx, cards, top + 0.1 * IN, bottom) + pageNo };
  }
  // 普通内容：表格前后的文字各占一块，表格用真表格
  // 带子项的一级要点当小标题（主色加粗、不带圆点），子项升一级当要点：层次一眼能看出来
  const toItems = (ls) => ls.map((l, j) => {
    const parent = l.bullet && !l.level && ls[j + 1] && ls[j + 1].bullet && ls[j + 1].level > 0;
    if (l.bold || parent) return { text: l.text.replace(/[：:]\s*$/, ''), b: true, color: HS.primary, gap: j ? 0.9 : 0 };
    const under = l.bullet && l.level > 0 && ls.slice(0, j).reverse().find((p) => p.bullet && !p.level);
    return { text: l.text, bullet: !!l.bullet, level: under ? l.level - 1 : l.level || 0, gap: j ? (l.level ? 0.3 : 0.6) : 0 };
  });
  const ti = lines.findIndex((l) => l.table);
  const before = toItems(ti < 0 ? lines : lines.slice(0, ti));
  // 一页只排一张真表格，再有的按行写成文字（一页两张表本来也放不下）
  const after = ti < 0 ? [] : toItems(lines.slice(ti + 1).flatMap((l) => (l.table ? l.table.map((r) => ({ text: r.join('  |  '), level: 0 })) : [l])));
  const bw = SW - 2 * SM + 0.2 * IN;
  const sizes = before.length <= 3 && !after.length && ti < 0 ? [26, 24, 22, 20, 18, 16, 14] : [22, 20, 18, 17, 16, 15, 14, 13, 12];
  if (ti < 0) {
    // 普通列表放在一张白色圆角卡片上（左边一条主色竖线），卡片高度跟着内容走
    const inW = bw - 0.5 * IN, inH = bottom - top - 0.1 * IN - 0.5 * IN;
    const size = fitSize(before, inW, inH, sizes);
    const h = Math.min(bottom - top - 0.1 * IN, textHeight(before, size, inW) + 0.5 * IN);
    return {
      bg: HS.page,
      xml: xml + sp(ctx, { x: SM, y: top + 0.1 * IN, w: SW - 2 * SM, h, geom: 'roundRect', adj: 4000, fill: 'FFFFFF', shadow: true, name: 'Panel' }) +
        sp(ctx, { x: SM, y: top + 0.1 * IN + 0.25 * IN, w: 0.06 * IN, h: h - 0.5 * IN, fill: HS.primary, name: 'Bar' }) +
        sp(ctx, { x: SM + 0.25 * IN - 0.1 * IN, y: top + 0.1 * IN + 0.25 * IN, w: inW, h: h - 0.5 * IN, paras: itemParas(before, size), name: 'Content' }) + pageNo,
    };
  }
  const room = bottom - top;
  const size = fitSize([...before, ...after], bw, room * 0.45, sizes);
  const hb = before.length ? textHeight(before, size, bw) : 0;
  const ha = after.length ? textHeight(after, size, bw) : 0;
  if (before.length) xml += sp(ctx, { x: SM - 0.1 * IN, y: top, w: bw, h: hb, paras: itemParas(before, size), name: 'Content' });
  const t = tableFrame(ctx, lines[ti].table, SM, top + hb + (hb ? 0.1 * IN : 0), SW - 2 * SM, room - hb - ha - 0.25 * IN);
  xml += t.xml;
  if (after.length) xml += sp(ctx, { x: SM - 0.1 * IN, y: top + hb + t.h + 0.25 * IN, w: bw, h: ha, paras: itemParas(after, size), name: 'Content' });
  return { bg: HS.page, xml: xml + pageNo };
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
  const W = SW, H = SH;
  const files = {};
  const deck = {}; // 整份 PPT 共用的状态（第几个卡片页）
  slides.forEach((s, i) => {
    const { bg, xml } = slideShapes(s, i, slides.length, deck);
    files[`ppt/slides/slide${i + 1}.xml`] = `${XML}<p:sld ${NS_P}><p:cSld><p:bg><p:bgPr>${solid(bg)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GRP}${xml}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
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
