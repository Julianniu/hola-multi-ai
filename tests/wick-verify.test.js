// Wick · 交付前检查：检查器本身（各种坏文件能不能查出来、Hola 自己排的文件必须一次通过），
// 以及在群聊里的效果（有硬伤让本人返工一次，返工完验收看得到检查结果；开关关掉就不返工）。
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkFile, checkDelivery, missingClaims, pagesAsked } = require('../lib/wick-verify');
const { writeOffice, makeZip } = require('../lib/office-write');
const { readZip } = require('../office');
const { startHola } = require('./helpers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-verify-'));
const put = (name, data) => { const f = path.join(dir, name); fs.writeFileSync(f, data); return f; };
const errors = (f) => checkFile(f).problems.filter((p) => p.level === 'error').map((p) => p.msg).join(' / ');
// 把 Hola 生成的文件里某个部件改一下（造坏文件用）
function tamper(buf, part, fn) {
  const zip = readZip(buf);
  const files = {};
  for (const n of zip.names()) files[n] = n === part ? fn(zip.text(n)) : zip.bytes(n);
  return makeZip(files);
}

const DECK = '# 云感枕 PRO\n主播培训\n\n## 三个卖点\n- **软**：慢回弹\n- **托**：分区护颈\n- **透**：开孔透气\n\n## 价格\n| 规格 | 价格 |\n|---|---|\n| 单只 | 229 |\n\n## 话术\n- 促单节奏：痛点 → 演示 → 价格\n- 异议：\n  - 会塌吗？→ 不会\n\n※ 参数以品牌方为准';

describe('交付前检查', () => {
  it('Hola 自己排版的 Word / PPT / Excel 一次通过', () => {
    for (const [ext, md] of [['docx', '# 方案\n\n## 一、目标\n\n说明：数字为建议值。\n\n| 指标 | 目标 |\n|---|---|\n| GMV | 300 万 |'], ['pptx', DECK], ['xlsx', '| 商品 | 价格 |\n|---|---|\n| 枕头 | 229 |']]) {
      const r = checkFile(put('ok.' + ext, writeOffice(ext, md)));
      assert.deepEqual(r.problems, [], ext);
    }
  });

  it('PPT：字放不下文本框、空白页能查出来', () => {
    const deck = writeOffice('pptx', DECK);
    // 把第 2 页的字号改成 66 磅：卡片里放不下
    const big = tamper(deck, 'ppt/slides/slide2.xml', (x) => x.replace(/sz="\d+"/g, 'sz="6600"'));
    assert.match(errors(put('big.pptx', big)), /第 2 页的文字放不下/);
    // 把第 3 页的东西全删掉：空白页
    const blank = tamper(deck, 'ppt/slides/slide3.xml', (x) => x.replace(/<p:sp>[\s\S]*<\/p:sp>|<p:graphicFrame>[\s\S]*<\/p:graphicFrame>/g, ''));
    assert.match(errors(put('blank.pptx', blank)), /第 3 页是空白页/);
    // 表格格子的边距写成了 8 英寸（真实案例：单位弄错），字会被挤成竖排、表格冲出页面
    const squeezed = tamper(deck, 'ppt/slides/slide3.xml', (x) => x.replace(/marL="91440" marR="91440"/g, 'marL="7315200" marR="7315200"'));
    assert.match(errors(put('squeezed.pptx', squeezed)), /第 3 页的表格有格子太窄/);
  });

  it('Excel：错误值是问题，只有公式没有结果是提醒', () => {
    const x = writeOffice('xlsx', '| 商品 | 价格 |\n|---|---|\n| 枕头 | 229 |');
    const bad = tamper(x, 'xl/worksheets/sheet1.xml', (s) => s.replace('</row></sheetData>', '<c r="C2" t="e"><f>B2/0</f><v>#DIV/0!</v></c><c r="D2"><f>B2*2</f></c></row></sheetData>'));
    const r = checkFile(put('bad.xlsx', bad));
    assert.match(r.problems.find((p) => p.level === 'error').msg, /错误值（C2）/);
    assert.match(r.problems.find((p) => p.level === 'warn').msg, /1 个公式没有算好的结果（D2）/);
  });

  it('打不开、空文件、没写完的占位', () => {
    assert.match(errors(put('broken.docx', 'not a zip')), /打不开/);
    assert.match(errors(put('empty.md', '')), /空文件/);
    assert.match(errors(put('todo.md', '# 方案\n\n预算：TODO')), /没写完的占位"TODO"/);
    assert.match(errors(put('fill.docx', writeOffice('docx', '# 方案\n\n负责人：[在此填写姓名]'))), /没写完的占位/);
    // "待确认 / 待填"是故意留给老板的，不算
    assert.equal(errors(put('ok.md', '# 方案\n\n负责人：（待填）\n价格：待确认')), '');
  });

  it('回复说保存了某个文件，文件夹里却没有', () => {
    assert.deepEqual(missingClaims('已保存：报价表.xlsx，老板直接看。', ['方案.docx']), ['报价表.xlsx']);
    assert.deepEqual(missingClaims('已保存：方案.docx', ['产出/方案.docx']), []);
    assert.deepEqual(missingClaims('你可以把它另存为 报价表.xlsx', []), [], '没说做好了就不算');
    assert.deepEqual(missingClaims('已整理完成，来源 https://x.com/a/report.pdf', []), [], '网址不算');
    assert.deepEqual(missingClaims('已更新 资料库/价格表.xlsx 的分析', []), [], '资料库里的文件不在对话文件夹，不算');
    assert.deepEqual(missingClaims('没有找到 价格表.xlsx。已保存分析结果：分析.md', ['分析.md']), [], '提到老板说错的文件名不算');
    assert.deepEqual(missingClaims('**报价表.csv** 已保存好了', []), ['报价表.csv'], '文件名在前、"已保存"在后也算');
    // 2026-10-24 门槛评测里的两次误报
    assert.deepEqual(missingClaims('已做好：**云感枕 PRO 双11直播活动方案.docx**', ['云感枕 PRO 双11直播活动方案.docx']), [], '文件名带空格');
    assert.deepEqual(missingClaims('我没法直接写文件，把内容给你，复制保存成 `待办.md` 就行', []), [], '建议老板保存，不是说自己做好了');
    const out = checkDelivery(dir, ['.build/draft.pptx'], '', []);
    assert.ok(out.some((p) => /隐藏文件夹/.test(p.msg)), '只放在隐藏文件夹里');
  });

  it('老板说了几页 PPT，页数对不上', () => {
    assert.equal(pagesAsked('做一份 5 页的 PPT'), 5);
    assert.equal(pagesAsked('做个十二页的演示'), 12);
    assert.equal(pagesAsked('PPT 十页左右就行'), 0);
    assert.equal(pagesAsked('写 3 页的 Word'), 0);
    assert.equal(pagesAsked('PPT 第 3 页的标题改一下'), 0, '说的是某一页');
    assert.equal(pagesAsked('每页放 2 张图的 PPT'), 0);
    assert.equal(pagesAsked('PPT 改成 6 页，第 2 页加个表'), 6);
    put('deck4.pptx', writeOffice('pptx', DECK));
    assert.match(checkDelivery(dir, ['deck4.pptx'], '', [], '做一份 5 页的 PPT').map((p) => p.msg).join(), /老板要 5 页，做出来是 4 页/);
    assert.deepEqual(checkDelivery(dir, ['deck4.pptx'], '', [], '做一份 4 页的 PPT'), []);
  });

  it('命令行队友用的 hola-doc.js：生成 + 检查', () => {
    const md = put('deck.md', DECK);
    const out = path.join(dir, 'deck.pptx');
    const tool = path.join(__dirname, '..', 'tools', 'hola-doc.js');
    assert.match(execFileSync(process.execPath, [tool, md, out], { encoding: 'utf8' }), /检查通过/);
    assert.throws(() => execFileSync(process.execPath, [tool, 'check', put('t.md', 'TODO')], { encoding: 'utf8' }), (e) => /问题：.*TODO/.test(e.stdout));
  });

  // ---------------------------------------------------------------- 群聊里
  const hs = [];
  after(async () => { for (const h of hs) await h.stop(); });

  it('交了半成品：本人马上返工一次，文件改好', async () => {
    const h = await startHola({ settings: { autoMemory: false } });
    hs.push(h);
    const id = await h.newConv();
    await h.ask(id, '@Claude 交一份半成品方案');
    const msgs = (await h.conv(id)).messages.filter((m) => m.from === 'claude');
    assert.deepEqual(msgs.map((m) => m.reason), ['mention', 'fix']);
    assert.match(msgs[0].check.map((p) => p.msg).join(), /TODO/);
    assert.ok(!msgs[1].check, '返工后的文件没问题');
    assert.doesNotMatch(fs.readFileSync(path.join(h.workspace, id, '活动方案.md'), 'utf8'), /TODO/);
    // 同一个对话里再来两次：返工次数按老板的每条消息算，不是整个对话一共两次
    await h.ask(id, '@Claude 再交一份半成品方案');
    await h.ask(id, '@Claude 第三份半成品方案');
    const all = (await h.conv(id)).messages.filter((m) => m.from === 'claude').map((m) => m.reason);
    assert.deepEqual(all, ['mention', 'fix', 'mention', 'fix', 'mention', 'fix']);
  });

  it('Hola 文档标准：要做文件的回合才加，开会和闲聊不加', async () => {
    const h = await startHola({ settings: { autoMemory: false }, env: { HOLA_DEMO_DUMP: 'all' } });
    hs.push(h);
    const id = await h.newConv();
    const prompts = () => fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompts.log'), 'utf8').split('<<<<<PROMPT ').slice(1);
    await h.ask(id, '@Claude 做一份 5 页的 PPT');
    assert.match(prompts().pop(), /【Hola 文档标准（最低要求）】/);
    await h.ask(id, '@Claude 你好');
    await h.ask(id, '@Claude 今天天气怎么样');
    assert.doesNotMatch(prompts().pop(), /Hola 文档标准/);
    await h.ask(id, '@大家 这份 PPT 用什么配色');
    const meeting = prompts().filter((p) => /同时、独立作答|团队内部讨论第|由你代表团队|团队讨论结束/.test(p));
    assert.ok(meeting.length >= 3, '开了会');
    assert.ok(meeting.every((p) => !/Hola 文档标准/.test(p)), '开会的阶段不加');
  });

  it('预览：新版式的 PPT / Word 在分屏预览里照样能显示', () => {
    const office = require('../office');
    for (const [ext, md] of [['pptx', DECK], ['docx', '# 方案\n\n注意：数字是建议值。\n\n| 指标 | 目标 |\n|---|---|\n| GMV | 300 万 |']]) {
      const f = put('pv.' + ext, writeOffice(ext, md));
      const html = office.toHtml(office.readOffice(f, { visual: true }), 'pv.' + ext);
      assert.match(html, /300 万|分区护颈/, ext);
    }
  });

  it('说做好了其实没有文件：返工；开关关掉就不管', async () => {
    const h = await startHola({ settings: { autoMemory: false } });
    hs.push(h);
    let id = await h.newConv();
    await h.ask(id, '@Codex 假装做好报价表');
    let msgs = (await h.conv(id)).messages.filter((m) => m.from === 'codex');
    assert.deepEqual(msgs.map((m) => m.reason), ['mention', 'fix']);
    assert.ok(fs.existsSync(path.join(h.workspace, id, '报价表.csv')));

    const off = await startHola({ settings: { autoMemory: false, wick: { verify: false } } });
    hs.push(off);
    id = await off.newConv();
    await off.ask(id, '@Codex 假装做好报价表');
    msgs = (await off.conv(id)).messages.filter((m) => m.from === 'codex');
    assert.deepEqual(msgs.map((m) => m.reason), ['mention']);
    assert.ok(!msgs[0].check);
  });
});
