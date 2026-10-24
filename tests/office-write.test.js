// 生成 Word / Excel / PPT：写出来再用 Hola 自己的读取器读回去，内容要对得上
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const office = require('../office');
const { writeOffice, parseCsv } = require('../lib/office-write');

describe('生成 Office 文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-office-'));
  const roundtrip = (ext, content) => {
    const f = path.join(dir, `t${Math.random().toString(36).slice(2)}.${ext}`);
    fs.writeFileSync(f, writeOffice(ext, content));
    return office.readOffice(f);
  };

  it('Word：标题、段落、加粗、列表、编号、表格、引用', () => {
    const d = roundtrip('docx', '# 方案\n\n第一段 **重点** 和 *强调*。\n\n## 步骤\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n| 渠道 | 预算 |\n|---|---|\n| 抖音 | 5000 |\n\n> 注意 <安全> & "引号"');
    assert.deepEqual(d.blocks.map((b) => [b.type, b.text || '']), [['h', '方案'], ['p', '第一段 重点 和 强调。'], ['h', '步骤'], ['li', '甲'], ['li', '乙'], ['li', '一'], ['li', '二'], ['table', ''], ['p', '注意 <安全> & "引号"']]);
    assert.deepEqual(d.blocks[7].rows, [['渠道', '预算'], ['抖音', '5000']]);
  });

  it('Excel：表格前的标题当工作表名，重名自动改；纯数字存成数字，0 开头的编号保持原样', () => {
    const x = roundtrip('xlsx', '## 预算\n| 渠道 | 预算 | 编号 |\n|---|---|---|\n| 抖音 | 5000 | 007 |\n\n## 预算\n| a |\n|---|\n| 1 |');
    assert.deepEqual(x.sheets.map((s) => s.name), ['预算', '预算(2)']);
    assert.deepEqual(x.sheets[0].rows, [['渠道', '预算', '编号'], ['抖音', '5000', '007']]);
  });

  it('Excel：也认 CSV（带引号和逗号的格子、Tab 分隔）', () => {
    assert.deepEqual(parseCsv('名字,数量\n"耳机, 黑色",3\n"说""好""的",1\n'), [['名字', '数量'], ['耳机, 黑色', '3'], ['说"好"的', '1']]);
    assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(roundtrip('xlsx', 'a,b\n1,2').sheets[0].rows, [['a', 'b'], ['1', '2']]);
  });

  it('PPT：每个标题一页，--- 也能分页，列表变成项目符号', () => {
    const p = roundtrip('pptx', '# 发布会\n\n## 卖点\n- 降噪\n- 续航\n\n---\n\n没有标题的一页');
    assert.deepEqual(p.slides.map((s) => s.paras), [['发布会'], ['卖点', '降噪', '续航'], ['没有标题的一页']]);
  });

  it('空内容也能生成能打开的文件', () => {
    for (const ext of ['docx', 'xlsx', 'pptx']) assert.ok(roundtrip(ext, ''));
  });

  it('标签带 x: 前缀的 Excel（Codex 用的 Open XML SDK 写法）也能读出内容', () => {
    // 把 Hola 自己生成的表格改写成 <x:row> 这种写法，再读回来
    const { readZip } = office;
    const { makeZip } = require('../lib/office-write');
    const zip = readZip(writeOffice('xlsx', '| 商品 | 销量 |\n| --- | --- |\n| 乳胶枕 | 392 |'));
    const files = {};
    for (const n of zip.names()) {
      const t = zip.text(n);
      files[n] = /^xl\/(workbook|worksheets\/|sharedStrings)/.test(n)
        ? t.replace(/<(\/?)([a-zA-Z])/g, (m, s, ch) => `<${s}x:${ch}`).replace(/<(\/?)x:\?xml/, '<$1?xml').replace(/xmlns=/, 'xmlns:x=')
        : zip.bytes(n);
    }
    const f = path.join(dir, 'prefixed.xlsx');
    fs.writeFileSync(f, makeZip(files));
    const sheet = readZip(fs.readFileSync(f)).names().find((n) => /^xl\/worksheets\/.+\.xml$/.test(n));
    assert.match(readZip(fs.readFileSync(f)).text(sheet), /<x:row/, '确实是带前缀的写法');
    const rows = office.readOffice(f).sheets[0].rows;
    assert.deepEqual(rows, [['商品', '销量'], ['乳胶枕', '392']]);
  });
});
