// Wick 第 3 阶段：任务板、开工确认（老板只确认一次方案）、中途插话、改派 / 取消、额度用完自动顶替、重启后接着做
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHola } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HELPER = { autoMemory: false, memberPrefs: { codex: { role: 'helper' } } };
const said = (c) => c.messages.filter((m) => m.from !== 'boss' && m.from !== 'system').map((m) => `${m.from}:${m.reason}`);
async function until(h, id, fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) { const c = await h.conv(id); if (fn(c)) return c; if (Date.now() - t0 > ms) throw new Error('等不到：' + JSON.stringify(said(c))); await sleep(60); }
}

describe('任务板和开工确认', () => {
  const hs = [];
  after(async () => { for (const h of hs) { try { await h.stop(); } catch (_) {} } });
  const start = async (settings = HELPER, env = {}) => { const h = await startHola({ settings, env }); hs.push(h); return h; };

  it('主脑要派活：先出开工确认卡，不派；点开工后接力、验收都自动走完；任务板记下每一步', async () => {
    const h = await start(HELPER, { HOLA_DEMO_DUMP: '1' });
    const id = await h.newConv();
    let { conv } = await h.ask(id, '帮我把推广要点做成表格');
    assert.deepEqual(said(conv), ['claude:main'], '还没开工，帮手不动');
    const card = conv.messages.find((m) => m.plan);
    assert.equal(card.plan.status, 'proposed');
    assert.deepEqual(card.plan.steps, [{ member: 'codex', task: '把这三条要点做成表格。' }]);
    assert.equal(conv.board.plan.status, 'proposed');
    assert.deepEqual(conv.board.items.map((x) => `${x.member}:${x.reason}:${x.status}`), ['claude:main:done']);
    conv = await h.go(id);
    assert.deepEqual(said(conv), ['claude:main', 'codex:handoff', 'claude:review']);
    assert.equal(conv.messages.find((m) => m.plan).plan.status, 'approved');
    assert.deepEqual(conv.board.items.map((x) => `${x.member}:${x.reason}:${x.status}`), ['claude:main:done', 'codex:handoff:done', 'claude:review:done']);
    assert.equal(conv.board.items[1].title, '把这三条要点做成表格。');
    assert.ok(conv.board.items.every((x) => x.msg), '每一项都对应一条消息');
    assert.equal(conv.board.task, '帮我把推广要点做成表格');
    // 帮手的回合要写交付单
    const ps = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Codex.txt'), 'utf8');
    assert.match(ps, /【交付单】/);
    // 再开一件新事：任务板清空重来
    ({ conv } = await h.ask(id, '你好'));
    assert.deepEqual(conv.board.items.map((x) => x.reason), ['main']);
    assert.equal(conv.board.plan, null);
  });

  it('方案不开工：点"先不做"就停；回一句修改意见，主脑按意见改，再出一张新卡', async () => {
    const h = await start({ ...HELPER, autoMemory: false }, { HOLA_DEMO_DUMP: '1' });
    let id = await h.newConv();
    let { conv } = await h.ask(id, '帮我把推广要点做成表格');
    let card = conv.messages.find((m) => m.plan);
    assert.equal((await h.post('plan', { conv: id, msg: card.id, action: 'cancel' })).status, 200);
    conv = await h.waitIdle(id);
    assert.equal(conv.messages.find((m) => m.plan).plan.status, 'cancelled');
    assert.ok(!said(conv).includes('codex:handoff'));
    assert.equal((await h.post('plan', { conv: id, msg: card.id, action: 'go' })).status, 400, '处理过的方案不能再开工');

    id = await h.newConv();
    await h.ask(id, '帮我把推广要点做成表格');
    ({ conv } = await h.ask(id, '表格里再加一列预算'));
    const reasons = said(conv);
    assert.deepEqual(reasons, ['claude:main', 'claude:replan'], '老板的回复当作修改意见，交给写方案的主脑');
    assert.equal(conv.messages.find((m) => m.plan).plan.status, 'changed');
    assert.equal(conv.messages.filter((m) => m.from === 'boss').pop().reason, 'planchange');
    assert.match(fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Claude.txt'), 'utf8'), /老板还没开工，回复了修改意见/);
  });

  it('老板拍板就等于确认过方案：按决定分工直接接力，不再出卡；关掉开工确认就全自动', async () => {
    let h = await start({ autoMemory: false }); // 演示剧本里 Codex 是大脑时才会有分歧
    let id = await h.newConv();
    const { conv: c1 } = await h.ask(id, '新品耳机首发怎么推广，有分歧就让我拍板', { mode: 'discuss' });
    const concl = c1.messages.find((m) => m.awaitDecision);
    await h.post('decide', { conv: id, msg: concl.id, option: 'A' });
    const c2 = await h.waitIdle(id);
    assert.ok(!c2.messages.some((m) => m.plan && m.plan.status === 'proposed'), '拍板后不再出开工卡');
    assert.equal(c2.board.plan.status, 'approved');

    h = await start({ ...HELPER, planConfirm: false });
    id = await h.newConv();
    const { conv } = await h.ask(id, '帮我把推广要点做成表格');
    assert.deepEqual(said(conv), ['claude:main', 'codex:handoff', 'claude:review'], '全自动：不出卡');
    assert.ok(!conv.messages.some((m) => m.plan));
  });

  it('干活时老板插话：没开始的验收先撤下，主脑按新要求调整', async () => {
    const h = await start(HELPER, { HOLA_DEMO_SLOW_WORK: '1500' });
    const id = await h.newConv();
    await h.ask(id, '帮我把推广要点做成表格');
    const card = (await h.conv(id)).messages.find((m) => m.plan);
    await h.post('plan', { conv: id, msg: card.id, action: 'go' });
    await until(h, id, (c) => c.board.items.some((x) => x.reason === 'handoff' && x.status === 'running'));
    await h.post('send', { conv: id, text: '表格改成按渠道分' });
    const c = await h.waitIdle(id, 30000);
    assert.equal(c.messages.filter((m) => m.from === 'boss').pop().reason, 'insert');
    assert.deepEqual(said(c), ['claude:main', 'codex:handoff', 'claude:replan'], '帮手做完手上这步，原定的验收撤下，主脑按新要求调整');
  });

  it('改派还没开始的一项、取消正在做的一项', async () => {
    const h = await start({ autoMemory: false }, { HOLA_DEMO_SLOW_WORK: '2000' });
    const id = await h.newConv();
    await h.post('send', { conv: id, text: '@Codex 先做 @Gemini 再做' });
    let c = await until(h, id, (x) => (x.board || { items: [] }).items.some((i) => i.member === 'codex' && i.status === 'running'));
    const gem = c.board.items.find((i) => i.member === 'gemini');
    assert.equal(gem.status, 'queued');
    assert.equal((await h.post('board/reassign', { conv: id, item: gem.id, member: 'claude' })).status, 200);
    const run = c.board.items.find((i) => i.member === 'codex');
    assert.equal((await h.post('board/reassign', { conv: id, item: run.id, member: 'claude' })).status, 400, '已经开始的不能改派');
    assert.equal((await h.post('board/cancel', { conv: id, item: run.id })).status, 200);
    c = await h.waitIdle(id, 30000);
    const cx = c.messages.find((m) => m.from === 'codex');
    assert.equal(cx.status, 'stopped');
    assert.ok(c.messages.some((m) => m.from === 'claude' && m.reason === 'mention'), '改派给 Claude 的那一项照常做');
    assert.ok(!c.messages.some((m) => m.from === 'gemini'));
    assert.deepEqual(c.board.items.map((i) => `${i.member}:${i.status}`), ['codex:cancelled', 'claude:done']);
    assert.ok(c.messages.some((m) => m.from === 'system' && /改派给 Claude/.test(m.text)));
  });

  it('额度用完：这一项自动换人顶上，群里说一声；其他错误不顶替', async () => {
    const h = await start({ autoMemory: false }, { HOLA_DEMO_QUOTA: 'Codex', HOLA_DEMO_DUMP: '1' });
    const id = await h.newConv();
    const { conv } = await h.ask(id, '@Codex 做一份推广表');
    assert.deepEqual(said(conv).slice(0, 2), ['codex:mention', 'claude:mention']);
    assert.ok(conv.messages.some((m) => m.from === 'system' && /Codex 额度用完或登录失效了，老板点名给 Ta 的活改由 Claude 顶上/.test(m.text)));
    assert.match(fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Claude.txt'), 'utf8'), /这一项原本是 Codex 的/);
    // 普通的程序出错（不是额度、登录、掉线）：不换人——哪怕给老板的说明里写着"登录过期或额度用完"这类常见原因
    const h2 = await start({ autoMemory: false }, { HOLA_DEMO_CRASH: 'Codex' });
    const id2 = await h2.newConv();
    const { conv: c2 } = await h2.ask(id2, '@Codex 做一份推广表');
    assert.deepEqual(said(c2), ['codex:mention']);
    assert.equal(c2.messages.find((m) => m.from === 'codex').status, 'error');
    assert.ok(!c2.messages.some((m) => m.from === 'system' && /顶上/.test(m.text)));
  });

  it('Hola 重启：没做完的活接着做（被打断的那一项说明情况后重做），然后照常验收', async () => {
    const h = await start(HELPER, { HOLA_DEMO_SLOW_WORK: '6000', HOLA_DEMO_DUMP: '1' });
    const id = await h.newConv();
    await h.ask(id, '帮我把推广要点做成表格');
    const card = (await h.conv(id)).messages.find((m) => m.plan);
    await h.post('plan', { conv: id, msg: card.id, action: 'go' });
    await until(h, id, (c) => c.board.items.some((x) => x.reason === 'handoff' && x.status === 'running'));
    // 等任务板存到硬盘上（存盘最多合并 2 秒），再模拟断电式关掉
    const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(h.workspace, id, '.hola', 'chat.json'), 'utf8')).board.items.some((x) => x.reason === 'handoff' && x.status === 'running'); } catch (_) { return false; } };
    for (let i = 0; i < 60 && !saved(); i++) await sleep(100);
    assert.ok(saved(), '任务板及时存了盘');
    await h.kill();
    const h2 = await startHola({ settings: HELPER, env: { HOLA_DATA_DIR: h.dataDir, HOLA_WORKSPACE: h.workspace, HOLA_DEMO_DUMP: '1' } });
    hs.unshift(h2); // 先关它：它占着第一个 Hola 的数据文件夹
    await until(h2, id, (c) => c.messages.some((m) => m.from === 'system' && /重启前还有 1 项活没做完/.test(m.text)));
    const c = await h2.waitIdle(id, 30000);
    assert.deepEqual(said(c), ['claude:main', 'codex:handoff', 'codex:handoff', 'claude:review']);
    assert.equal(c.messages.filter((m) => m.reason === 'handoff')[0].status, 'stopped', '被打断的那次');
    assert.match(fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Codex.txt'), 'utf8'), /Hola 上次重启打断了这一项/);
    assert.deepEqual(c.board.items.map((x) => `${x.reason}:${x.status}`), ['main:done', 'handoff:done', 'review:done']);
  });
});
