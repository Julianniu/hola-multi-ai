// Wick · 交付前检查（wick verify）：队友交了文件，Hola 先自己打开看一遍——
// 打不打得开、有没有内容、有没有"TODO / 此处填写"这种没写完的地方、PPT 字有没有溢出框、Excel 有没有 #REF! 和没算出来的公式、
// 回复里说"已保存"的文件到底在不在。有硬伤就让本人马上返工一次（engine 里排一个 fix 回合），小毛病交给主脑验收时参考。
// 全部用 JS 读文件本身（office.js），不依赖 Office / Python：Mac、CI、没装 Office 的电脑都一样能查。
'use strict';
const fs = require('fs');
const path = require('path');
const office = require('../office');
// 不依赖 core：命令行队友用的 tools/hola-doc.js 也直接引用这个文件（core 一加载就会建数据文件夹）
const T = (zh, en) => (office.lang === 'en' ? en : zh);

const OFFICE = /\.(docx|xlsx|pptx)$/i;
const TEXTY = /\.(md|txt|csv|html?)$/i;
// 明显没写完的占位（"待确认 / 待填"是故意留给老板的，不算）
const PLACEHOLDER = /\bTODO\b|\bTBD\b|\bFIXME\b|lorem ipsum|此处(填写|插入|补充|添加)|在此(填写|插入|输入)|\{\{[^}]{0,40}\}\}|\[(在此|插入|填写)[^\]]{0,30}\]|【(在此|插入|填写)[^】]{0,30}】/i;

const em = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 1 : 0.56), 0);
const attr = (tag, name) => { const m = String(tag).match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : ''; };
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const unprefix = (xml) => xml.replace(/<(\/?)[a-zA-Z]+:(?=[a-zA-Z])/g, (m, s) => (/^<\/?(a|p|r|w|mc|v|o):/.test(m) ? m : `<${s}`));

// PPT：每个带文字的框估一下字有多高，明显超出框的、字太小的、跑出页面的记下来
function pptxLayout(zip, problems) {
  const pres = zip.text('ppt/presentation.xml');
  const sz = pres.match(/<p:sldSz\b[^>]*>/);
  const SW = sz ? Number(attr(sz[0], 'cx')) : 12192000, SH = sz ? Number(attr(sz[0], 'cy')) : 6858000;
  const slides = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  const over = [], tiny = [], out = [], narrow = [], tall = [];
  slides.forEach((name, i) => {
    const xml = zip.text(name);
    const boxes = []; // 这一页的形状：{ x, y, w, h, need, anchor, fill, text }
    for (const s of xml.match(/<p:sp>[\s\S]*?<\/p:sp>|<p:sp\b[\s\S]*?<\/p:sp>/g) || []) {
      // 位置和大小只认 <a:xfrm> 里的（扩展数据里也有叫 <a:ext> 的标签）
      const xfrm = (s.match(/<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/) || [''])[0];
      const off = xfrm.match(/<a:off\b[^>]*>/), ext = xfrm.match(/<a:ext\b[^>]*>/);
      if (!off || !ext) continue; // 占位符的位置写在版式里，估不了
      const x = Number(attr(off[0], 'x')), y = Number(attr(off[0], 'y')), w = Number(attr(ext[0], 'cx')), h = Number(attr(ext[0], 'cy'));
      const spPr = ((s.match(/<p:spPr\b[\s\S]*?<\/p:spPr>/) || [''])[0]).replace(/<a:ln\b[\s\S]*?<\/a:ln>/g, '');
      const fill = /<a:(solidFill|gradFill|blipFill)\b/.test(spPr);
      const body = (s.match(/<a:bodyPr\b[^>]*(\/>|>[\s\S]*?<\/a:bodyPr>)/) || [''])[0];
      const box = { x, y, w, h, need: 0, anchor: attr(body, 'anchor') || 't', fill, text: false };
      boxes.push(box);
      if (/spAutoFit/.test(body)) continue; // 框跟着字长高
      const scale = (Number(attr((body.match(/<a:normAutofit\b[^>]*>/) || [''])[0], 'fontScale')) || 100000) / 100000;
      const ins = (k, d) => { const v = attr(body, k); return v === '' ? d : Number(v); };
      const avail = Math.max(1, w - ins('lIns', 91440) - ins('rIns', 91440));
      let need = ins('tIns', 45720) + ins('bIns', 45720), chars = 0, total = 0;
      for (const p of s.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\b[\s\S]*?<\/a:p>/g) || []) {
        const segs = p.split(/<a:br\b[^>]*\/>|<a:br\b[^>]*>[\s\S]*?<\/a:br>/).map((g) => decode((g.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join('')));
        const text = segs.join('');
        const size = (Number(attr((p.match(/<a:(rPr|endParaRPr|defRPr)\b[^>]*\bsz="\d+"[^>]*>/) || [''])[0], 'sz')) || 1800) / 100 * scale;
        const lnPct = Number(attr((p.match(/<a:lnSpc>\s*<a:spcPct\b[^>]*>/) || [''])[0].replace(/^<a:lnSpc>\s*/, ''), 'val')) || 100000;
        // 手动换行（<a:br/>）分开的每一段各自折行
        const lines = segs.reduce((n, g) => n + Math.max(1, Math.ceil(em(g) * size * 12700 / (avail * 0.97))), 0);
        need += lines * size * 12700 * 1.2 * lnPct / 100000;
        if (text.trim()) total += lines;
        if (text.trim().length > 2) chars += text.length; // 一两个字的（编号、箭头）不会真的折行，不算
        if (text && size < 10 && text.length > 12) tiny.push(i + 1);
      }
      if (!chars) continue;
      box.text = true;
      box.need = total >= 1 ? need : 0;
      if (x + w > SW * 1.02 || y + h > SH * 1.02 || x < -SW * 0.02 || y < -SH * 0.02) out.push(i + 1);
    }
    // 字比框高不一定看得出来（框没底色、下面是空的）。只有看得见的才算溢出：
    // 冲出页面、压到别的文字、带底色的框（或放在卡片里）字跑到框外
    for (const b of boxes) {
      if (!b.text || !(b.need > b.h * 1.25 && b.need - b.h > 0.3 * 914400)) continue;
      const extra = b.need - b.h;
      const top = b.anchor === 'b' ? b.y - extra : b.anchor === 'ctr' ? b.y - extra / 2 : b.y;
      const bottom = top + b.need;
      const xOver = (o) => o.x < b.x + b.w && o.x + o.w > b.x;
      const hitsText = boxes.some((o) => o !== b && o.text && xOver(o) && o.y < bottom && o.y + o.h > top && !(o.y >= b.y && o.y + o.h <= b.y + b.h));
      const card = boxes.find((o) => o !== b && o.fill && !o.text && o.x <= b.x + 1 && o.y <= b.y + 1 && o.x + o.w >= b.x + b.w * 0.5 && o.y + o.h >= b.y + b.h * 0.5);
      const spills = (b.fill && (bottom > b.y + b.h + 0.1 * 914400 || top < b.y - 0.1 * 914400)) || (card && (bottom > card.y + card.h + 0.05 * 914400 || top < card.y - 0.05 * 914400));
      if (bottom > SH * 1.01 || top < -SH * 0.01 || hitsText || spills) over.push(i + 1);
    }
    // 表格：格子里能放字的宽度（列宽减左右边距）连两个字都放不下 → 字会竖着排；估出来的表格高度超出页面底边
    for (const g of xml.match(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g) || []) {
      const tbl = g.match(/<a:tbl>[\s\S]*<\/a:tbl>/);
      if (!tbl) continue;
      const xfrm = (g.match(/<p:xfrm\b[^>]*>[\s\S]*?<\/p:xfrm>/) || [''])[0];
      const y = Number(attr((xfrm.match(/<a:off\b[^>]*>/) || [''])[0], 'y')) || 0;
      const cols = (tbl[0].match(/<a:gridCol\b[^>]*>/g) || []).map((c) => Number(attr(c, 'w')) || 0);
      let height = 0;
      for (const tr of tbl[0].match(/<a:tr\b[\s\S]*?<\/a:tr>/g) || []) {
        let ci = 0, rowNeed = Number(attr(tr, 'h')) || 0;
        for (const tc of tr.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) || []) {
          const span = Number(attr(tc, 'gridSpan')) || 1;
          const cw = cols.slice(ci, ci + span).reduce((a, b) => a + b, 0);
          ci += span;
          if (/\bhMerge="1"|\bvMerge="1"/.test(tc.match(/<a:tc\b[^>]*>/)[0])) continue;
          const pr = (tc.match(/<a:tcPr\b[^>]*>/) || [''])[0];
          const m = (k) => { const v = attr(pr, k); return v === '' ? (k === 'marL' || k === 'marR' ? 91440 : 45720) : Number(v); };
          const text = decode((tc.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join(''));
          const size = (Number(attr((tc.match(/<a:(rPr|endParaRPr)\b[^>]*\bsz="\d+"[^>]*>/) || [''])[0], 'sz')) || 1800) / 100;
          const avail = cw - m('marL') - m('marR');
          if (text.trim().length > 1 && avail < size * 12700 * 2) narrow.push(i + 1);
          const lines = Math.max(1, Math.ceil(em(text) * size * 12700 / Math.max(size * 12700, avail * 0.95)));
          rowNeed = Math.max(rowNeed, lines * size * 12700 * 1.2 + m('marT') + m('marB'));
        }
        height += rowNeed;
      }
      if (y + height > SH * 1.03) tall.push(i + 1);
    }
  });
  const pages = (a) => [...new Set(a)].join('、');
  if (narrow.length) problems.push({ level: 'error', msg: T(`第 ${pages(narrow)} 页的表格有格子太窄（列宽减去格子边距后连两个字都放不下），字会被挤成竖排：检查列宽和单元格边距（margin 的单位）`, `A table on slide ${pages(narrow)} has cells too narrow for two characters (column width minus cell margins), so text will stack vertically: check column widths and cell margins (and their units)`) });
  if (tall.length) problems.push({ level: 'error', msg: T(`第 ${pages(tall)} 页的表格太高，超出了页面底边：删减行、拆成两页或调小字号`, `The table on slide ${pages(tall)} runs past the bottom of the slide: cut rows, split the slide or use a smaller font`) });
  if (over.length) problems.push({ level: 'error', msg: T(`第 ${pages(over)} 页的文字放不下，超出了文本框（字太多或字号太大）：删减文字、拆成两页或调小字号`, `Text overflows its box on slide ${pages(over)}: cut text, split the slide or use a smaller font`) });
  if (tiny.length) problems.push({ level: 'warn', msg: T(`第 ${pages(tiny)} 页有小于 10 磅的字，投影时看不清`, `Slide ${pages(tiny)} has text under 10 pt, too small to read when projected`) });
  if (out.length) problems.push({ level: 'warn', msg: T(`第 ${pages(out)} 页有文字框超出了页面边缘`, `A text box runs off the edge of slide ${pages(out)}`) });
}

// Excel：错误值、只写了公式没有结果（预览和读取都看不到数）
function xlsxCells(zip, problems) {
  const errs = [], noValue = [];
  for (const n of zip.names().filter((x) => /^xl\/worksheets\/[^/]+\.xml$/.test(x))) {
    const xml = unprefix(zip.text(n));
    for (const c of xml.match(/<c\b[^>]*?(\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref = attr(c, 'r');
      const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (attr(c, 't') === 'e' || /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/.test(v || '')) errs.push(ref);
      else if (/<f\b/.test(c) && (v === undefined || v === '')) noValue.push(ref);
    }
  }
  const list = (a) => a.slice(0, 6).join('、') + (a.length > 6 ? T(` 等 ${a.length} 处`, ` and ${a.length - 6} more`) : '');
  if (errs.length) problems.push({ level: 'error', msg: T(`表格里有错误值（${list(errs)}），公式引用错了或者除以 0`, `The sheet has error values (${list(errs)}): a broken reference or division by zero`) });
  if (noValue.length) problems.push({ level: 'warn', msg: T(`有 ${noValue.length} 个公式没有算好的结果（${list(noValue)}）：Excel 打开会重算，但预览、手机和其他程序看到的是空白。最好存成算好的数值，或者用 Excel / LibreOffice 重算后再保存`, `${noValue.length} formulas have no cached result (${list(noValue)}): Excel recalculates on open, but previews, phones and other programs show blanks. Save calculated values, or recalculate in Excel / LibreOffice before saving`) });
}

// 查一个文件：{ ok, problems: [{ level: 'error'|'warn', msg }] }
function checkFile(abs) {
  const problems = [];
  const name = path.basename(abs);
  let st;
  try { st = fs.statSync(abs); } catch (_) { return { ok: false, problems: [{ level: 'error', msg: T(`找不到文件 ${name}`, `File not found: ${name}`) }] }; }
  if (!st.size) return { ok: false, problems: [{ level: 'error', msg: T(`${name} 是空文件`, `${name} is empty`) }] };
  let text = '';
  if (OFFICE.test(abs)) {
    let zip, doc;
    try { zip = office.readZip(fs.readFileSync(abs)); } catch (_) { return { ok: false, problems: [{ level: 'error', msg: T(`${name} 打不开（不是有效的 Office 文件，可能没写完或格式错了）`, `${name} won't open (not a valid Office file; maybe unfinished or the wrong format)`) }] }; }
    try { doc = office.readOffice(abs); } catch (e) { return { ok: false, problems: [{ level: 'error', msg: T(`${name} 读不出内容：${e.message}`, `Couldn't read ${name}: ${e.message}`) }] }; }
    if (doc.kind === 'docx') {
      text = doc.blocks.map((b) => b.text || (b.rows || []).map((r) => r.join(' ')).join(' ')).join('\n');
      if (text.replace(/\s/g, '').length > 1500 && !doc.blocks.some((b) => b.type === 'h')) problems.push({ level: 'warn', msg: T(`${name} 很长但没有用标题样式，Word 里没有导航、层次不清`, `${name} is long but uses no heading styles: no navigation pane and no clear structure`) });
    } else if (doc.kind === 'pptx') {
      text = doc.slides.map((s) => s.paras.join('\n')).join('\n');
      const empty = doc.slides.filter((s) => !s.paras.length && !/<p:pic\b|<a:blip\b/.test(zip.text(`ppt/slides/slide${s.n}.xml`))).map((s) => s.n);
      if (empty.length) problems.push({ level: 'error', msg: T(`第 ${empty.join('、')} 页是空白页`, `Slide ${empty.join(', ')} is blank`) });
      try { pptxLayout(zip, problems); } catch (_) {}
    } else if (doc.kind === 'xlsx') {
      text = doc.sheets.map((s) => s.rows.map((r) => r.join(' ')).join('\n')).join('\n');
      try { xlsxCells(zip, problems); } catch (_) {}
    }
    if (!text.trim() && !(doc.kind === 'pptx' && doc.slides.length)) problems.push({ level: 'error', msg: T(`${name} 里没有内容`, `${name} has no content`) });
  } else if (TEXTY.test(abs)) {
    try { text = fs.readFileSync(abs, 'utf8'); } catch (_) {}
    if (!text.trim()) problems.push({ level: 'error', msg: T(`${name} 里没有内容`, `${name} has no content`) });
  } else return { ok: true, problems };
  const ph = text.match(PLACEHOLDER);
  if (ph) problems.push({ level: 'error', msg: T(`${name} 里还有没写完的占位"${ph[0]}"`, `${name} still has an unfinished placeholder "${ph[0]}"`) });
  return { ok: !problems.some((p) => p.level === 'error'), problems };
}

// 回复里说"已保存 / 生成了 某某.xlsx"，文件夹里却没有：dir = 对话文件夹，files = 这个文件夹里现有的文件（相对路径）
// 只认"说自己把某个文件做好了"：文件名和"已保存 / 做好了……"在同一句里、离得很近；网址、资料库里的文件不算
// 只认已经做完的说法（"复制保存成 X 就行"是建议，不算）；同一句里说了"没法 / 不能"也不算
const CLAIM = /已(经)?(保存|生成|做好|写好|导出|输出|创建)|保存(好|在|到|为|成)了|做好了|写好了|生成了|存好了/;
const CANT = /没法|不能|无法|做不到|没有权限/;
function missingClaims(text, files) {
  const t = String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/(资料库|附件)\/\S+/g, ' ');
  if (!CLAIM.test(t)) return [];
  const have = files.map((f) => path.basename(f).toLowerCase());
  const named = new Set();
  for (const m of t.matchAll(/([^\s`'"“”‘’「」《》（）()【】\[\]<>|*:：，,；;、/\\]{1,80}\.(docx|xlsx|pptx|pdf|csv|md))(?![\w.])/gi)) {
    const near = t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).split(/[。！？\n]/).find((s) => s.includes(m[1])) || '';
    if (CLAIM.test(near) && !CANT.test(near)) named.add(m[1]);
  }
  // 文件名里有空格时只截到了后半段："双11方案.docx" 也算找到了 "云感枕 PRO 双11方案.docx"
  return [...named].filter((n) => { const b = path.basename(n).toLowerCase(); return !have.some((h) => h === b || h.endsWith(b)); });
}

// 老板说了要几页 PPT（"做一份 5 页的 PPT""十页左右"不算，要明确的数）
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function pagesAsked(ask) {
  // "第 3 页""每页 2 张"是在说某一页，不是总页数
  const m = String(ask || '').match(/(?<![第每]\s*)(?<![\d一二两三四五六七八九十])(\d{1,2}|[一二两三四五六七八九十]|十[一二三四五六七八九])\s*页(?!左右|以内|以上|上下|的标题|的内容)/);
  if (!m || !/ppt|幻灯|演示|slides?|deck/i.test(ask)) return 0;
  const s = m[1];
  return /^\d+$/.test(s) ? Number(s) : s.length === 2 ? 10 + CN_NUM[s[1]] : CN_NUM[s];
}

// 一回合交付的检查：files = 这回合新增或改过的文件（相对 dir），allFiles = 文件夹里所有文件，ask = 老板最后一条消息
function checkDelivery(dir, files, text, allFiles, ask) {
  const out = [];
  for (const f of files) {
    if (!OFFICE.test(f) && !TEXTY.test(f)) continue;
    const r = checkFile(path.join(dir, f));
    for (const p of r.problems) out.push({ ...p, file: f });
  }
  const want = pagesAsked(ask);
  const decks = files.filter((f) => /\.pptx$/i.test(f) && !f.split('/').some((seg) => seg.startsWith('.')));
  if (want && decks.length === 1) {
    let n = 0;
    try { n = office.readOffice(path.join(dir, decks[0])).slides.length; } catch (_) {}
    if (n && n !== want) out.push({ level: 'error', file: decks[0], msg: T(`老板要 ${want} 页，做出来是 ${n} 页`, `The boss asked for ${want} slides; the deck has ${n}`) });
  }
  const visible = files.filter((f) => !f.split('/').some((seg) => seg.startsWith('.')));
  if (files.length && !visible.length && files.some((f) => OFFICE.test(f))) out.push({ level: 'error', msg: T('做好的文件只放在隐藏文件夹里（名字以 . 开头），老板看不到：放到对话文件夹里', 'The finished file is only inside a hidden folder (name starts with "."), where the boss can\'t see it: put it in the conversation folder') });
  for (const n of missingClaims(text, allFiles)) out.push({ level: 'error', msg: T(`回复里说做好了 ${n}，但文件夹里没有这个文件`, `The reply says ${n} is done, but there is no such file in the folder`) });
  return out;
}

module.exports = { checkFile, checkDelivery, missingClaims, pagesAsked, PLACEHOLDER };
