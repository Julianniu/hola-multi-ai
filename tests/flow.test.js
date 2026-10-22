// 核心流程：用演示版的假队友把 Hola 的主要玩法走一遍（不调用任何真实 AI）
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHola, makeDocx } = require('./helpers');

const reasons = (msgs) => msgs.filter((m) => m.from !== 'system').map((m) => `${m.from}:${m.reason || ''}`);

describe('核心流程', () => {
  let h;
  before(async () => { h = await startHola({ env: { HOLA_TEST_DISOBEY: '1' } }); });
  after(async () => { await h.stop(); });

  it('页面和它的样式、脚本、翻译都能打开', async () => {
    for (const [p, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/app.css', 'text/css'], ['/i18n.js', 'javascript'], ['/logo.svg', 'svg']]) {
      const r = await fetch(h.base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), new RegExp(type), p);
      assert.equal(r.headers.get('cache-control'), 'no-store', p + ' 不能被缓存，否则更新后新旧文件会混用');
    }
  });

  it('启动后三位队友都在线', async () => {
    const init = await h.init();
    assert.deepEqual(init.members.map((m) => m.id), ['claude', 'codex', 'gemini']);
    assert.ok(init.members.every((m) => m.online), JSON.stringify(init.members.map((m) => m.problem)));
    assert.ok(['official', 'modified', 'unofficial', 'dev'].includes(init.build.status));
  });

  it('直接发送：主脑一个人回答，不开会', async () => {
    const id = await h.newConv();
    const { added } = await h.ask(id, '大家好');
    const replies = added.filter((m) => m.from !== 'boss' && m.reason !== 'memory');
    assert.deepEqual(replies.map((m) => `${m.from}:${m.reason}`), ['claude:main']);
    assert.match(replies[0].text, /在线/);
  });

  it('开会讨论：独立作答 → 讨论 → 达成共识 → 自动接力 → 主脑验收 → 整理记忆', async () => {
    const id = await h.newConv();
    const { conv, added } = await h.ask(id, '新品耳机首发该怎么推广', { mode: 'discuss' });
    const r = reasons(added);
    assert.equal(r.filter((x) => x.endsWith(':initial')).length, 3, r.join(' '));
    assert.ok(r.filter((x) => x.endsWith(':discuss')).length >= 3, r.join(' '));
    const concl = added.find((m) => m.reason === 'conclusion');
    assert.ok(concl && concl.consensus === true && !concl.awaitDecision);
    // 独立作答这一轮看不到彼此：三条回答都在讨论之前
    assert.ok(added.findIndex((m) => m.reason === 'discuss') > added.findLastIndex((m) => m.reason === 'initial'));
    const hand = added.find((m) => m.reason === 'handoff');
    assert.equal(hand && hand.from, 'codex', '结论里 @Codex 应该自动接手');
    assert.ok((hand.files || []).some((f) => f.path === '结论要点.csv'), '接手做出的文件要挂在消息上');
    assert.ok(fs.existsSync(path.join(h.workspace, id, '结论要点.csv')));
    const reviews = added.filter((m) => m.reason === 'review');
    assert.equal(reviews.length, 1, '队友交付后，主脑验收一次');
    assert.equal(reviews[0].from, 'claude');
    assert.equal(reviews[0].review, 'pass');
    assert.ok(!/【验收】/.test(reviews[0].text), '验收标签变成标记，不留在正文里');
    assert.ok(added.indexOf(reviews[0]) > added.indexOf(hand));
    assert.ok(added.some((m) => m.reason === 'memory' && m.memoryChanged), '每轮结束要整理记忆');
    assert.match(conv.memory, /已经定下的结论/);
    assert.equal(conv.running, false);
  });

  it('谈不拢：停下来等老板拍板，点按钮后按决定分工', async () => {
    const id = await h.newConv();
    const { added } = await h.ask(id, '新品耳机首发该怎么推广，有分歧就让我拍板', { mode: 'discuss' });
    const concl = added.find((m) => m.reason === 'conclusion');
    assert.ok(concl.awaitDecision && !concl.consensus);
    assert.deepEqual(concl.options.map((o) => o.key), ['A', 'B']);
    assert.ok(!/【方案/.test(concl.text), '方案行要拆成按钮，不留在正文里');
    assert.ok(!added.some((m) => m.reason === 'handoff'), '拍板之前谁都不许动手');
    assert.ok(!fs.existsSync(path.join(h.workspace, id, '结论要点.csv')));

    assert.equal((await h.post('decide', { conv: id, msg: concl.id, option: 'C' })).status, 400, '不存在的方案要拒绝');
    const r = await h.post('decide', { conv: id, msg: concl.id, option: 'B' });
    assert.equal(r.status, 200);
    const c = await h.waitIdle(id);
    const after = c.messages.slice(c.messages.findIndex((m) => m.id === concl.id) + 1);
    const boss = after.find((m) => m.from === 'boss');
    assert.equal(boss.reason, 'decision');
    assert.match(boss.text, /方案B/);
    assert.ok(!/支持/.test(boss.text), '老板的拍板消息里不重复"支持：…"');
    assert.ok(after.some((m) => m.reason === 'decided'));
    assert.ok(after.some((m) => m.reason === 'handoff' && m.from === 'codex'));
    assert.equal(c.messages.find((m) => m.id === concl.id).decided, 'B');
    assert.equal((await h.post('decide', { conv: id, msg: concl.id, option: 'A' })).status, 400, '拍过板不能再拍');
  });

  it('谈不拢：直接打字也算拍板，不会重新开一轮讨论', async () => {
    const id = await h.newConv();
    await h.ask(id, '新品耳机首发该怎么推广，有分歧就让我拍板', { mode: 'discuss' });
    const { conv, added } = await h.ask(id, '选A，但预算控制在5万以内');
    assert.equal(added[0].reason, 'decision');
    assert.ok(!added.some((m) => m.reason === 'initial' || m.reason === 'discuss'), reasons(added).join(' '));
    assert.ok(added.some((m) => m.reason === 'decided'));
    assert.equal(conv.messages.find((m) => m.reason === 'conclusion').decided, 'custom');
  });

  it('@ 点名：按 @ 的顺序依次做，没点到的不参与', async () => {
    const id = await h.newConv();
    const { added } = await h.ask(id, '@Gemini 先查一下竞品 @Claude 再写文案');
    const turns = added.filter((m) => m.reason === 'mention');
    assert.deepEqual(turns.map((m) => m.from), ['gemini', 'claude']);
    assert.ok(!added.some((m) => m.from === 'codex' && m.reason !== 'memory'));
  });

  it('叫停：正在干的活马上停下', async () => {
    const id = await h.newConv();
    await h.post('send', { conv: id, text: '新品耳机首发该怎么推广', mode: 'discuss' });
    assert.equal((await h.post('stop', { conv: id })).status, 200);
    const c = await h.waitIdle(id);
    assert.equal(c.running, false);
    assert.ok(c.messages.some((m) => m.status === 'stopped' || /叫停/.test(m.text || '')));
    assert.ok(!c.messages.some((m) => m.status === 'running'));
  });

  it('存为技能：把对话整理成技能库里的技能', async () => {
    const id = await h.newConv();
    await h.ask(id, '新品耳机首发该怎么推广');
    assert.equal((await h.post('skills/distill', { conv: id })).status, 200);
    const c = await h.waitIdle(id);
    const sk = c.messages.find((m) => m.reason === 'skill');
    assert.ok(sk && sk.status === 'done' && sk.skillId, JSON.stringify(sk));
    const md = fs.readFileSync(path.join(h.dataDir, 'skills', sk.skillId, 'SKILL.md'), 'utf8');
    assert.match(md, /^---\nname: 方案决策三步法/);
    assert.ok((await h.init()).skills.some((s) => s.id === sk.skillId));
  });

  it('项目：新建项目、任务归进项目，删除项目不删对话', async () => {
    const p = await h.post('projects/save', { project: { name: '双十一', brief: '预算 10 万' } });
    assert.ok(p.id);
    const id = await h.newConv(p.id);
    assert.equal((await h.conv(id)).project, p.id);
    assert.equal((await h.post('projects/save', { project: { name: '  ' } })).status, 400, '项目名不能为空');
    await h.post('projects/delete', { id: p.id });
    const c = await h.conv(id);
    assert.equal(c.project, null);
    assert.ok(c.messages, '对话还在');
  });

  it('改名、标记完成', async () => {
    const id = await h.newConv();
    await h.post('conv/rename', { conv: id, title: '新名字' });
    await h.post('conv/status', { conv: id, status: 'done' });
    const c = await h.conv(id);
    assert.equal(c.title, '新名字');
    assert.equal(c.status, 'done');
  });

  it('删除对话：文件夹真的删掉', async () => {
    const id = await h.newConv();
    await h.ask(id, '大家好');
    const dir = path.join(h.workspace, id);
    assert.ok(fs.existsSync(dir));
    assert.equal((await h.post('conv/delete', { conv: id })).status, 200);
    assert.ok(!fs.existsSync(dir));
    assert.equal((await h.conv(id)).status, 404);
  });

  it('附件：Word 自动转文字版，表格和 Word 都能预览', async () => {
    const id = await h.newConv();
    const csv = await h.upload(id, '报价.csv', Buffer.from('﻿产品,价格\n耳机,399\n'));
    assert.equal(csv.path, '附件/报价.csv');
    assert.equal(csv.preview, true);
    const pv = await (await fetch(`${h.base}/preview/${id}/${encodeURIComponent('附件')}/${encodeURIComponent('报价.csv')}`)).text();
    assert.match(pv, /<table[\s\S]*耳机[\s\S]*399/);

    const doc = await h.upload(id, '方案.docx', makeDocx(['第一段：目标人群', '第二段：预算 5 万']));
    assert.ok(doc.textVersion, '应该自动生成文字版');
    const tv = fs.readFileSync(path.join(h.workspace, id, doc.textVersion), 'utf8');
    assert.match(tv, /目标人群[\s\S]*预算 5 万/);
    const dp = await (await fetch(`${h.base}/preview/${id}/${doc.path.split('/').map(encodeURIComponent).join('/')}`)).text();
    assert.match(dp, /预算 5 万/);
  });

  it('同一份数据不能同时开两个 Hola（会把记录写乱）：第二个拒绝启动', async () => {
    const { spawn } = require('child_process');
    const { ROOT, freePort } = require('./helpers');
    const p = spawn(process.execPath, ['server.js', '--demo'], { cwd: ROOT, windowsHide: true,
      env: { ...process.env, PORT: String(await freePort()), NO_OPEN: '1', HOLA_DATA_DIR: h.dataDir, HOLA_WORKSPACE: h.workspace } });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => p.on('exit', r));
    assert.equal(code, 3);
    assert.match(err, /ANOTHER_INSTANCE/);
    assert.equal((await fetch(h.base + '/api/ping')).status, 200, '原来那个照常工作');
  });

  it('安全：不是 Hola 页面发来的请求、越界读取文件，都要拒绝', async () => {
    const id = await h.newConv();
    const noHeader = await fetch(`${h.base}/api/conv/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    assert.equal((await h.post('conv/new', {}, { Origin: 'https://evil.example' })).status, 403);
    for (const p of ['..%2F..%2Fdata%2Fsettings.json', '.hola%2Fchat.json']) {
      assert.equal((await fetch(`${h.base}/files/${id}/${p}`)).status, 404, p);
    }
  });
});
