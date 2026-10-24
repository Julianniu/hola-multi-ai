// 图片库 / 文件库：上传、列出、预览、发给队友、删对话后跟着消失、越界读取要拒绝
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHola, makeDocx } = require('./helpers');

// 一张 1×1 的 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('图片库 / 文件库', () => {
  let h;
  const libUpload = async (name, data) => (await fetch(`${h.base}/api/library/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Hola': '1' }, body: data })).json();
  const items = async () => (await (await fetch(h.base + '/api/library')).json()).items;
  before(async () => { h = await startHola({ env: { HOLA_DEMO_DUMP: 'all' } }); });
  after(async () => { await h.stop(); });

  it('上传到资料库：图片和文件都列出来，放在工作文件夹里看得见的"资料库"', async () => {
    const a = await libUpload('海报.png', PNG);
    const b = await libUpload('报价.docx', makeDocx(['耳机报价 399 元']));
    assert.ok(a.ok && b.ok);
    assert.ok(fs.existsSync(path.join(h.workspace, '资料库', '海报.png')));
    const list = await items();
    const img = list.find((x) => x.id === 'lib:海报.png'), doc = list.find((x) => x.id === 'lib:报价.docx');
    assert.ok(img && img.image && img.from === 'upload');
    assert.ok(doc && !doc.image && doc.preview);
    assert.equal((await fetch(h.base + img.url)).status, 200);
    assert.match(await (await fetch(h.base + doc.previewUrl)).text(), /耳机报价 399 元/);
  });

  it('资料库文件夹不会被当成一个对话', async () => {
    assert.ok(!(await h.init()).convs.some((c) => c.id === '资料库'));
  });

  it('对话里的附件和队友做出来的文件，自动出现在库里，标明来自哪个对话', async () => {
    const id = await h.newConv();
    await h.upload(id, '截图.png', PNG);
    await h.post('send', { conv: id, text: '新品耳机首发该怎么推广', attachments: [{ path: '附件/截图.png' }], mode: 'discuss' });
    await h.waitIdle(id);
    await h.go(id);
    const list = await items();
    const shot = list.find((x) => x.conv && x.conv.id === id && x.name === '截图.png');
    const made = list.find((x) => x.conv && x.conv.id === id && x.name === '结论要点.csv');
    assert.ok(shot && shot.image && shot.from === 'boss');
    assert.ok(made && made.from === 'codex', '队友做的文件');
    assert.equal((await fetch(h.base + made.previewUrl)).status, 200);
  });

  it('发给队友：复制进对话的附件，Word 自动转文字版，能看图的队友拿到图片', async () => {
    const id = await h.newConv();
    const doc = await h.post('library/attach', { conv: id, id: 'lib:报价.docx' });
    assert.equal(doc.path, '附件/报价.docx');
    assert.ok(doc.textVersion, '要走和上传一样的收尾，生成文字版');
    const img = await h.post('library/attach', { conv: id, id: 'lib:海报.png' });
    assert.equal(img.path, '附件/海报.png');
    assert.ok(img.image);
    await h.post('send', { conv: id, text: '@Claude 看看这张海报和报价', attachments: [{ path: doc.path }, { path: img.path }] });
    const c = await h.waitIdle(id);
    const boss = c.messages.find((m) => m.from === 'boss');
    assert.deepEqual(boss.attachments.map((a) => a.path), ['附件/报价.docx', '附件/海报.png']);
    const prompt = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompts.log'), 'utf8');
    assert.match(prompt, /附件\/海报\.png/, 'Claude 的提示词里要有图片的位置');
  });

  it('删掉对话：它的文件也从库里消失（说删就删）；资料库里自己上传的还在', async () => {
    const id = await h.newConv();
    await h.upload(id, '临时.png', PNG);
    await h.post('send', { conv: id, text: '大家好', attachments: [{ path: '附件/临时.png' }] });
    await h.waitIdle(id);
    assert.ok((await items()).some((x) => x.conv && x.conv.id === id));
    await h.post('conv/delete', { conv: id });
    const list = await items();
    assert.ok(!list.some((x) => x.conv && x.conv.id === id));
    assert.ok(list.some((x) => x.id === 'lib:海报.png'));
  });

  it('删除：只能删自己上传到资料库的，对话里的文件不在这里删', async () => {
    const conv = (await items()).find((x) => x.conv);
    assert.equal((await h.post('library/delete', { id: conv.id })).status, 400);
    await libUpload('不要了.txt', Buffer.from('x'));
    assert.equal((await h.post('library/delete', { id: 'lib:不要了.txt' })).status, 200);
    assert.ok(!fs.existsSync(path.join(h.workspace, '资料库', '不要了.txt')));
  });

  it('安全：越界读取、越界发送都要拒绝', async () => {
    for (const p of ['/library/..%2F..%2Fdata%2Fsettings.json', '/library/%2E%2E%2Fdata%2Fsettings.json', '/library-preview/..%2Fdata%2Fsettings.json', '/library/sub%2F..%2F..%2Fx']) {
      assert.equal((await fetch(h.base + p)).status, 404, p);
    }
    const id = await h.newConv();
    for (const bad of ['lib:../../data/settings.json', 'lib:..', 'conv:nope:x.png', `conv:${id}:../../data/settings.json`, `conv:${id}:.hola/chat.json`, 'whatever']) {
      assert.equal((await h.post('library/attach', { conv: id, id: bad })).status, 404, bad);
    }
    const noHeader = await fetch(`${h.base}/api/library/upload?name=x.txt`, { method: 'POST', body: 'x' });
    assert.equal(noHeader.status, 403);
  });

  it('常驻资料：设为常驻后所有队友每次都看到，取消后就没有；图片不能常驻；删掉文件自动取消', async () => {
    await libUpload('品牌调性.md', '# 品牌调性\n说话要年轻、不用"家人们"这类词。');
    await libUpload('合作伙伴.docx', makeDocx(['合作伙伴：某某音频']));
    const pin = (id, on) => h.post('library/pin', { id, on });
    assert.equal((await pin('lib:品牌调性.md', true)).ok, true);
    assert.equal((await pin('lib:合作伙伴.docx', true)).ok, true);
    assert.equal((await pin('lib:海报.png', true)).status, 400, '图片不能常驻');
    const it1 = (await items()).find((x) => x.id === 'lib:品牌调性.md');
    assert.ok(it1.pinned && it1.chars > 10);
    const prompts = async (text) => {
      const id = await h.newConv();
      await h.ask(id, text);
      return fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompts.log'), 'utf8');
    };
    const p1 = await prompts('@Claude 写一句开场白');
    assert.match(p1, /【团队常驻资料】[\s\S]*不用"家人们"这类词[\s\S]*合作伙伴：某某音频/);
    await pin('lib:品牌调性.md', false);
    await h.post('library/delete', { id: 'lib:合作伙伴.docx' });
    assert.ok(!(await items()).some((x) => x.pinned), '删掉的文件也不再常驻');
    const p2 = await prompts('@Claude 再写一句');
    assert.ok(!p2.includes('团队常驻资料'), '没有常驻资料时，提示词里没有这一段');
  });
});
