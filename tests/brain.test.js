// 主脑 + 大脑 / 帮手：直接发送由主脑回答；老板发起开会（至少讨论一轮）；把主脑的回答拿去开会时其他大脑先独立作答；
// 帮手不参与开会、只接活；交付后主脑验收（一批只验一次，退回太多次就停下）；干活策略写进主脑的提示词
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHola } = require('./helpers');

describe('主脑、大脑和帮手', () => {
  let h;
  before(async () => { h = await startHola({ settings: { autoMemory: false }, env: { HOLA_DEMO_DUMP: 'all' } }); });
  after(async () => { await h.stop(); });
  const prompts = (id) => fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompts.log'), 'utf8').split('<<<<<PROMPT ').slice(1);
  const meet = (id, text) => h.ask(id, text, { mode: 'discuss' });
  const role = (id, r) => h.post('members/save', { member: { id, name: { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[id], role: r } });

  it('老板发起的会至少讨论一轮（哪怕大家都觉得不用讨论）；@大家 也是开会', async () => {
    const id = await h.newConv();
    const { added } = await meet(id, '大家好');
    assert.equal(added.filter((m) => m.reason === 'initial').length, 3);
    assert.ok(added.every((m) => m.reason !== 'initial' || m.needDiscuss === false));
    assert.ok(added.some((m) => m.reason === 'discuss'), '至少讨论一轮');
    assert.ok(added.some((m) => m.reason === 'conclusion'));
    const id2 = await h.newConv();
    const r2 = await h.ask(id2, '@大家 新品耳机怎么推广');
    assert.ok(r2.added.some((m) => m.reason === 'initial') && r2.added.some((m) => m.reason === 'discuss'));
  });

  it('让大家讨论一下：其他大脑先独立作答，看不到主脑那一版；之后的讨论里大家都看得到', async () => {
    const id = await h.newConv();
    const { added } = await h.ask(id, '新品耳机首发该怎么推广');
    const main = added.find((m) => m.reason === 'main');
    assert.equal(main.from, 'claude');
    assert.equal((await h.post('discuss', { conv: id, msg: 'nope' })).status, 400);
    assert.equal((await h.post('discuss', { conv: id, msg: main.id })).status, 200);
    const c = await h.waitIdle(id);
    const after = c.messages.slice(c.messages.findIndex((m) => m.id === main.id) + 1);
    const initial = after.filter((m) => m.reason === 'initial');
    assert.deepEqual(initial.map((m) => m.from).sort(), ['codex', 'gemini'], '主脑不用再答一遍');
    assert.ok(after.some((m) => m.reason === 'discuss' && m.from === 'claude'), '主脑参加讨论');
    assert.ok(after.some((m) => m.reason === 'conclusion' && m.from === 'claude'));
    assert.equal(c.messages.find((m) => m.id === main.id).escalated, true);
    assert.equal((await h.post('discuss', { conv: id, msg: main.id })).status, 400, '同一条回答不重复开会');
    const ps = prompts(id);
    const snippet = main.text.slice(0, 20);
    const ini = ps.filter((p) => /同时、独立作答/.test(p) && /^(Codex|Gemini)>/.test(p));
    assert.equal(ini.length, 2);
    assert.ok(ini.every((p) => !p.includes(snippet)), '独立作答时看不到主脑的回答');
    assert.ok(ps.some((p) => /内部讨论第 1 轮/.test(p) && p.includes(snippet) && p.includes('主脑直接回答')), '讨论时大家都看得到');
  });

  it('帮手不参与开会；主脑把粗活交给帮手，交付后主脑验收一次', async () => {
    await role('codex', 'helper');
    assert.equal((await h.init()).members.find((m) => m.id === 'codex').role, 'helper');
    const id = await h.newConv();
    const m1 = await meet(id, '新品耳机首发该怎么推广');
    assert.deepEqual(m1.added.filter((m) => m.reason === 'initial').map((m) => m.from).sort(), ['claude', 'gemini'], '帮手不参加开会');
    const id2 = await h.newConv();
    const { added } = await h.ask(id2, '帮我把推广要点做成表格', { go: true });
    assert.deepEqual(added.filter((m) => m.from !== 'boss' && m.from !== 'system').map((m) => `${m.from}:${m.reason}`), ['claude:main', 'codex:handoff', 'claude:review']);
    const rv = added.find((m) => m.reason === 'review');
    assert.equal(rv.review, 'pass');
    assert.deepEqual(rv.reviewOf, [added.find((m) => m.reason === 'handoff').id]);
    const p = prompts(id2).find((x) => /由你（主脑）直接回答/.test(x));
    assert.match(p, /干活分工（质量优先）/, '主脑用订阅时，默认质量优先');
    assert.match(p, /Codex：.*帮手：不参与讨论，只接活/);
    assert.ok(prompts(id2).some((x) => /你是主脑，负责验收：Codex 刚交付/.test(x)));
  });

  it('交付的人顺手 @ 了主脑"请验收"：不当普通接力，只走一次正式验收', async () => {
    const id = await h.newConv();
    const { added, conv } = await h.ask(id, '把推广要点做成表格，做完请主脑验收', { go: true });
    assert.deepEqual(conv.board.items.map((x) => `${x.reason}:${x.status}`), ['main:done', 'handoff:done', 'review:done'], '并进验收的那次接力不留在任务板上');
    assert.deepEqual(added.filter((m) => m.from !== 'boss' && m.from !== 'system').map((m) => `${m.from}:${m.reason}`), ['claude:main', 'codex:handoff', 'claude:review']);
  });

  it('验收退回太多次：停下来请老板看', async () => {
    const id = await h.newConv();
    const { added } = await h.ask(id, '做表格，验收时退回', { go: true });
    const reviews = added.filter((m) => m.reason === 'review');
    assert.equal(reviews.length, 3, '退回 2 次后的第 3 次不再派活');
    assert.ok(reviews.every((m) => m.review === 'redo'));
    assert.ok(reviews.at(-1).reviewStop);
    assert.ok(added.some((m) => m.from === 'system' && /退回重做 2 次/.test(m.text)));
    assert.ok(!added.slice(added.indexOf(reviews.at(-1)) + 1).some((m) => m.reason === 'handoff'));
  });

  it('干活策略：改成省钱，主脑的提示词跟着变；没有帮手时不提分工，讨论的提示词不变', async () => {
    await h.post('settings', { policy: 'saving' });
    const id = await h.newConv();
    await h.ask(id, '帮我把推广要点做成表格');
    assert.match(prompts(id).find((x) => /由你（主脑）直接回答/.test(x)), /干活分工（省钱）/);
    await role('codex', 'brain');
    await h.post('settings', { policy: 'auto' });
    const id2 = await h.newConv();
    await meet(id2, '新品耳机首发该怎么推广');
    const ps = prompts(id2);
    assert.ok(ps.every((x) => !/干活分工|帮手：/.test(x)), '没有帮手时，提示词里不出现分工和帮手');
  });

  it('主脑刚答完、还在整理记忆时点"让大家讨论一下"：排队，整理完自动开会', async () => {
    const h2 = await startHola({ settings: { autoMemory: true }, env: { HOLA_DEMO_SLOW_MEMORY: '1500' } });
    try {
      const id = await h2.newConv();
      await h2.post('send', { conv: id, text: '新品耳机首发该怎么推广' });
      let main;
      for (let i = 0; i < 100 && !main; i++) { const c = await h2.conv(id); main = c.messages.find((m) => m.reason === 'main' && m.status === 'done'); if (!main) await new Promise((r) => setTimeout(r, 50)); }
      assert.equal((await h2.conv(id)).running, true, '这时还在整理记忆');
      assert.equal((await h2.post('discuss', { conv: id, msg: main.id })).status, 200);
      const c = await h2.waitIdle(id, 60000);
      assert.ok(c.messages.some((m) => m.reason === 'conclusion'), '整理完记忆后开了会');
    } finally { await h2.stop(); }
  });

  it('只有一位大脑能参加：说清楚开不成会', async () => {
    const id = await h.newConv();
    await h.post('conv/active', { conv: id, active: ['claude'] });
    const { added } = await meet(id, '新品耳机首发该怎么推广');
    assert.ok(added.some((m) => m.from === 'system' && /开不成会/.test(m.text)));
    assert.ok(!added.some((m) => m.reason === 'initial'));
  });
});
