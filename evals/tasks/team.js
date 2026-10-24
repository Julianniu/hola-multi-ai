// 多 AI 讨论任务：team = 这次开着的队友（第一位是主脑；跑分时可以用 --team 整支换掉），helperLast = 最后一位当帮手（不开会、只接活）。
// 点名了具体队友的任务标 fixedTeam，换队伍时跳过。ctx.team = 这次实际的队伍。
// T09（标签遵守率）不单独跑：报告里从所有讨论任务的消息里统计。
'use strict';
const path = require('path');
const D = require('../fixtures/data');
const C = require('../check');
const { judgeDiscussion } = require('../judge');

const BRAINS = ['claude', 'codex', 'gemini'];
const of = (msgs, reason) => msgs.filter((m) => m.reason === reason);
const talkOf = (msgs) => msgs.filter((m) => ['initial', 'discuss'].includes(m.reason) && m.status === 'done').map((m) => ({ who: m.from, round: m.round || 0, text: m.text }));
// 只看会议本身：结论一写完就叫停（共识结论会自动派活、验收，那部分由 T06 / T07 测，这里不等）
async function meetOnly(ctx, text) {
  const before = (await ctx.h.conv(ctx.conv)).messages.length;
  await ctx.h.post('send', { conv: ctx.conv, text, mode: 'discuss' });
  const t0 = Date.now();
  for (;;) {
    await ctx.sleep(2000);
    const c = await ctx.h.conv(ctx.conv);
    const added = c.messages.slice(before);
    const concl = added.find((m) => m.reason === 'conclusion' && m.status !== 'running');
    if (concl || !c.running || Date.now() - t0 > 30 * 60000) {
      if (c.running) await ctx.h.post('stop', { conv: ctx.conv });
      await ctx.sleep(1500);
      return { added: (await ctx.h.conv(ctx.conv)).messages.slice(before) };
    }
  }
}
const rounds = (msgs) => Math.max(0, ...of(msgs, 'discuss').map((m) => m.round || 0));

// 讨论题的通用记录：几轮、有没有共识、谁在哪一轮
function noteMeeting(ctx, msgs) {
  const concl = of(msgs, 'conclusion')[0];
  ctx.note('讨论轮数', rounds(msgs));
  ctx.note('达成共识', concl ? !!concl.consensus : null);
  return concl;
}

module.exports = [
  {
    id: 'T01', title: '简单算术题开会：很快收敛且算对', suites: ['smoke', 'standard', 'full'], team: BRAINS,
    async run(ctx) {
      const r = await ctx.say('开会讨论：一件 320 元的商品，"满 300 减 40"和"打 87 折"哪个更划算？便宜多少钱？', { mode: 'discuss' });
      const concl = noteMeeting(ctx, r.added);
      const t = (concl || {}).text || '';
      ctx.check('写出了团队结论', !!concl && concl.status === 'done');
      ctx.check('算对：87 折 278.4，便宜 1.6 元', C.has(t, '278.4') && C.has(t, '1.6'));
      ctx.check('达成共识', !!concl && !!concl.consensus);
      ctx.check('1 轮内收敛', rounds(r.added) <= 1, `${rounds(r.added)} 轮`, { soft: true });
    },
  },
  {
    id: 'T02', gate: true, title: '有取舍的定价问题：讨论质量（评审打分）', suites: ['standard', 'full'], team: BRAINS,
    question: '开会讨论：我们是 5 个人的直播电商小团队，新品云感枕 PRO 成本 45 元（含包装和运费），竞品同类枕头直播价大多在 99～159 元。首场直播定价 99、129、159 选哪个？给出结论和理由。',
    async run(ctx, res, task) {
      const r = await meetOnly(ctx, task.question);
      const concl = noteMeeting(ctx, r.added);
      ctx.check('写出了团队结论', !!concl && concl.status === 'done');
      if (!concl) return;
      const j = await judgeDiscussion(task.question.replace(/^开会讨论：/, ''), talkOf(r.added), concl.text);
      ctx.note('评审打分', j);
      ctx.score(j ? j.avg / 5 : null);
      ctx.check('评审平均分 ≥ 3.5（满分 5）', !!j && j.avg >= 3.5, j ? `${j.avg} 分；有效发言比 ${j.effectiveRatio}；${j.comment || ''}` : '评审没给出结果');
    },
  },
  {
    // T03 纠错 + T04 独立性：同一场会。主脑（Claude）的回答里故意算错，并带一个只有它才写的"方案代号"
    id: 'T03', gate: true, title: '纠错 + 独立性：把算错的主脑回答拿去开会', suites: ['standard', 'full'], team: BRAINS,
    seed: (main) => ({
      title: '环比增长',
      memory: '',
      messages: [
        { id: 'm-1', from: 'boss', text: '我们 6 月 GMV 是 120 万，7 月是 150 万，环比增长了多少？8 月目标定多少合适？', ts: Date.now() - 60000, status: 'done', process: [] },
        { id: 'm-2', from: main, reason: 'main', text: '环比增长 20%（150 − 120 = 30，30 ÷ 150 = 20%）。按这个增速，8 月目标建议定 180 万。方案代号：青柠-73。', ts: Date.now() - 30000, status: 'done', process: [] },
      ],
    }),
    async run(ctx) {
      const before = (await ctx.h.conv(ctx.conv)).messages.length;
      const d = await ctx.h.post('discuss', { conv: ctx.conv, msg: 'm-2' });
      if (d.status !== 200) throw new Error('开会失败：' + JSON.stringify(d));
      await ctx.sleep(500);
      const c = await ctx.h.waitIdle(ctx.conv);
      const added = c.messages.slice(before);
      ctx.track(added);
      const concl = noteMeeting(ctx, added);
      const t = (concl || {}).text || '';
      ctx.check('结论改正为 25%', /25\s*%/.test(t));
      const init = of(added, 'initial').filter((m) => m.from !== ctx.team[0]);
      ctx.note('第一轮独立算对的队友', init.filter((m) => /25\s*%/.test(m.text)).map((m) => m.from));
      const leak = init.filter((m) => C.has(m.text, '青柠'));
      ctx.check('T04 独立性：其他队友第一轮看不到主脑那一版', init.length > 0 && leak.length === 0, leak.map((m) => m.from).join('、'));
    },
  },
  {
    id: 'T05', title: '真分歧：给出方案 A/B、不派活，拍板后再执行', suites: ['full'], team: BRAINS, fixedTeam: true, settings: { maxDiscussRounds: 2 },
    async run(ctx) {
      const r = await ctx.say('开会讨论：首场直播主推哪个商品？请各自坚持自己的角度，不要轻易让步——Claude 只看利润，Codex 只看销量，Gemini 只看品牌调性。商品：云感枕 PRO（成本 45，售价 129.9）、乳胶枕（成本 30，售价 89）、蚕丝被（成本 210，售价 399）。', { mode: 'discuss' });
      const concl = noteMeeting(ctx, r.added);
      if (!concl) { ctx.check('写出了团队结论', false); return; }
      if (concl.consensus) { ctx.na('这次大家达成了共识，没形成分歧，测不到拍板流程'); return; }
      ctx.check('结论里有 2 个以上可选方案', (concl.options || []).length >= 2, (concl.options || []).map((o) => o.key).join('/'));
      ctx.check('等老板拍板', !!concl.awaitDecision);
      ctx.check('拍板前没有派活', !r.added.some((m) => m.reason === 'handoff'));
      if (!(concl.options || []).length) return;
      const before = (await ctx.h.conv(ctx.conv)).messages.length;
      await ctx.h.post('decide', { conv: ctx.conv, msg: concl.id, option: concl.options[0].key });
      await ctx.sleep(500);
      const c = await ctx.h.waitIdle(ctx.conv);
      const added = c.messages.slice(before);
      ctx.track(added);
      ctx.check('拍板后按决定执行', of(added, 'decided').some((m) => m.status === 'done'));
    },
  },
  {
    id: 'T06', title: '主脑分派给帮手，帮手交付，主脑验收', suites: ['standard', 'full'], team: ['claude', 'codex'], helperLast: true,
    settings: { policy: 'saving' },
    async run(ctx, res, task) {
      const r = await ctx.say('做一份云感枕 PRO 首场直播的排品表 Excel，文件名 排品表.xlsx：至少 8 个商品，每行有上架顺序、商品、价格、讲解时长。');
      const helper = ctx.team[ctx.team.length - 1];
      const hand = r.added.filter((m) => m.from === helper && m.reason === 'handoff');
      ctx.check('主脑把活派给了帮手', hand.length > 0);
      task.verify(ctx);
      const rv = r.added.filter((m) => m.reason === 'review');
      ctx.check('主脑做了验收', rv.length > 0 && rv.every((m) => m.from === ctx.team[0]));
      ctx.note('验收结果', rv.map((m) => m.review));
    },
    verify(ctx) {
      const rows = C.sheetRows(path.join(ctx.dir, '排品表.xlsx')).filter((r) => r.some((c) => /[0-9]/.test(String(c))) && r.filter((c) => String(c).trim()).length >= 3);
      ctx.check('排品表.xlsx 至少 8 个商品', rows.length >= 8, `${rows.length} 行`);
    },
  },
  {
    id: 'T07', title: '验收把关：帮手交了错的表，不能直接"通过"', suites: ['standard', 'full'], team: ['claude'],
    opts: (m, res, info, { team, nameOf }) => ({
      custom: [{ id: 'xiaozhu', name: '小助', color: '#999999', strengths: '整理表格', type: 'cli', cmd: process.execPath, args: [path.join(__dirname, '..', 'fake-helper.js'), nameOf(team[0])], parser: 'plain', versionCheck: false }],
      settings: { memberPrefs: { xiaozhu: { role: 'helper' } } },
    }),
    async run(ctx) {
      const a = await ctx.attach('6月直播销售.xlsx');
      const r = await ctx.say('让小助根据附件的销售表做一张各主播的 GMV 汇总表（汇总.xlsx），做完你来验收。', { attachments: [a] });
      ctx.check('活交给了小助', r.added.some((m) => m.from === 'xiaozhu' && m.reason === 'handoff'));
      const rv = r.added.filter((m) => m.reason === 'review');
      ctx.note('验收结果', rv.map((m) => m.review));
      ctx.check('发现了错误（退回或自己改正，不是"通过"）', rv.length > 0 && rv[0].review !== 'pass', rv.length ? rv[0].review : '没有验收');
      const rows = C.sheetRows(path.join(ctx.dir, '汇总.xlsx'));
      const fixed = D.HOSTS.every((h) => rows.some((row) => row.some((c) => String(c).includes(h)) && C.rowHas(row, D.gmvByHost[h], 1)));
      ctx.check('最后的 汇总.xlsx 数字是对的', fixed, '', { soft: true });
    },
  },
  {
    id: 'T08', title: '@ 顺序：Gemini 先查，Claude 接着写', suites: ['standard', 'full'], team: ['claude', 'gemini'], fixedTeam: true,
    async run(ctx) {
      const a = await ctx.attach('价格表-最终版.csv');
      const r = await ctx.say('@Gemini 先读一下附件的价格表，找出价格最高的三个商品；@Claude 再根据 Gemini 找出的三个商品，各写一句推荐语。', { attachments: [a] });
      const g = r.added.findIndex((m) => m.from === 'gemini' && m.reason === 'mention');
      const c = r.added.findIndex((m) => m.from === 'claude' && m.reason === 'mention');
      ctx.check('顺序对：Gemini 在前，Claude 在后', g >= 0 && c > g);
      const top = (i) => (i >= 0 ? D.top3.filter((n) => C.has(r.added[i].text, n.split('·')[1] || n)).length : 0);
      ctx.check('Gemini 找对了三个商品', top(g) === 3, `${top(g)}/3`);
      ctx.check('Claude 用上了 Gemini 的结果', top(c) === 3, `${top(c)}/3`);
    },
  },
  {
    id: 'T10', title: '混合队：Claude（命令行）+ DeepSeek（API）讨论定价', suites: ['full'], team: ['claude', 'deepseek'], fixedTeam: true, needs: ['deepseek'],
    question: '开会讨论：我们是 5 个人的直播电商小团队，新品云感枕 PRO 成本 45 元（含包装和运费），竞品同类枕头直播价大多在 99～159 元。首场直播定价 99、129、159 选哪个？给出结论和理由。',
    async run(ctx, res, task) {
      const r = await meetOnly(ctx, task.question);
      const concl = noteMeeting(ctx, r.added);
      ctx.check('写出了团队结论', !!concl && concl.status === 'done');
      ctx.check('DeepSeek 参与了讨论', r.added.some((m) => m.from === 'deepseek' && m.status === 'done'));
      if (!concl) return;
      const j = await judgeDiscussion(task.question.replace(/^开会讨论：/, ''), talkOf(r.added), concl.text);
      ctx.note('评审打分', j);
      ctx.score(j ? j.avg / 5 : null);
    },
  },
];
