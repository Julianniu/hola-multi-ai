// 开会的提示词（独立作答 / 内部讨论 / 团队结论 / 拍板后执行）整段原文一字不许变——包括拼进去的花名册、规则、分工说明。
// prompts-golden.test.js 只锁了阶段说明那几段源码；这里用演示模式真的开几次会，把队友收到的整段提示词和存好的原文比。
// 老板明确同意改开会的提示词时，才用 HOLA_UPDATE_MEETING=1 node --test tests/prompts-meeting.test.js 重新生成原文。
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHola } = require('./helpers');

const FIXTURE = path.join(__dirname, 'fixtures', 'meeting-prompts.json');
const PHASE = [['initial', /同时、独立作答/], ['discuss', /现在是团队内部讨论第/], ['conclusion', /团队讨论结束/], ['decided', /团队讨论没谈拢，老板已经拍板/]];
// 和机器有关的部分去掉：本机环境卡片
// 和机器有关的部分去掉：本机环境卡片；拍板后执行（干活的回合）里那条检查命令带着 Hola 装在哪个文件夹，本机有没有 node 也会影响它出不出现
const norm = (t) => t.replace(/【本机环境】[^\n]*\n\n/, '').replace(/\r\n/g, '\n').replace(/\n- 交付前可以用这条命令再查一遍[^\n]*/g, '');

function meetingPrompts(h, id, scenario) {
  const log = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompts.log'), 'utf8');
  const out = [];
  for (const part of log.split('\n<<<<<PROMPT ').slice(1)) {
    const who = part.slice(0, part.indexOf('>>>>>'));
    const text = norm(part.slice(part.indexOf('>>>>>\n') + 6));
    const tail = text.slice(text.lastIndexOf('现在轮到你'));
    const ph = PHASE.find(([, re]) => re.test(tail));
    if (ph) out.push({ scenario, phase: ph[0], who, text });
  }
  return out;
}

describe('开会的提示词整段不变', () => {
  const hs = [];
  after(async () => { for (const h of hs) await h.stop(); });

  it('四种开会场景，队友收到的提示词和存好的原文一字不差', async () => {
    const all = [];
    const env = { HOLA_DEMO_DUMP: 'all' };
    // 1) 普通开会，达成共识
    let h = await startHola({ settings: { autoMemory: false }, env });
    hs.push(h);
    let id = await h.newConv();
    await h.ask(id, '@大家 新品耳机怎么推广');
    all.push(...meetingPrompts(h, id, '共识'));
    // 2) 有分歧，老板点方案拍板
    id = await h.newConv();
    await h.ask(id, '@大家 这个要老板拍板：定价 199 还是 299');
    const c = await h.conv(id);
    const concl = c.messages.find((m) => m.reason === 'conclusion' && m.awaitDecision);
    assert.ok(concl, '有等拍板的结论');
    await h.post('decide', { conv: id, msg: concl.id, option: concl.options[0].key });
    await h.waitIdle(id);
    all.push(...meetingPrompts(h, id, '拍板'));
    // 3) 主脑直接回答后，老板点"让大家讨论一下"
    id = await h.newConv();
    const { added } = await h.ask(id, '新品耳机定价多少合适');
    const main = added.find((m) => m.reason === 'main');
    await h.post('discuss', { conv: id, msg: main.id });
    await h.waitIdle(id);
    all.push(...meetingPrompts(h, id, '升级开会'));
    // 4) 有帮手时开会（结论里会多一段分工说明）
    h = await startHola({ settings: { autoMemory: false, memberPrefs: { codex: { role: 'helper' } } }, env });
    hs.push(h);
    id = await h.newConv();
    await h.ask(id, '@大家 新品耳机怎么推广');
    all.push(...meetingPrompts(h, id, '有帮手'));

    const key = (p) => `${p.scenario}|${p.phase}|${p.who}|${p.text.length}`;
    // 用最普通的比较排序：localeCompare 跟着系统语言走，中文和英文系统排出来的顺序不一样（GitHub 的机器是英文）
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    all.sort((a, b) => cmp(key(a), key(b)) || cmp(a.text, b.text));
    for (const s of ['共识', '拍板', '升级开会', '有帮手']) for (const ph of s === '拍板' ? ['initial', 'conclusion', 'decided'] : ['initial', 'conclusion']) assert.ok(all.some((p) => p.scenario === s && p.phase === ph), `${s} 里有 ${ph}`);
    if (process.env.HOLA_UPDATE_MEETING) { fs.writeFileSync(FIXTURE, JSON.stringify(all, null, 1)); return; }
    const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    assert.equal(all.length, want.length, '开会的提示词条数变了');
    for (let i = 0; i < want.length; i++) {
      const a = all[i], b = want[i];
      if (a.text === b.text) continue;
      let k = 0;
      while (k < a.text.length && a.text[k] === b.text[k]) k++;
      assert.fail(`${b.scenario} · ${b.phase} · ${b.who} 的提示词变了，从这里开始不同：\n原来：${JSON.stringify(b.text.slice(Math.max(0, k - 60), k + 120))}\n现在：${JSON.stringify(a.text.slice(Math.max(0, k - 60), k + 120))}`);
    }
  });
});
