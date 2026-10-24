// Wick 第 3 阶段：队友能力卡（记下实际表现，派活时给主脑参考）、推荐团队配置、数据去向
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHola } = require('./helpers');

const HELPER = { autoMemory: false, memberPrefs: { codex: { role: 'helper' } } };

describe('能力卡、推荐配置、数据去向', () => {
  const hs = [];
  after(async () => { for (const h of hs) { try { await h.stop(); } catch (_) {} } });

  it('能力卡：帮手做了表、主脑验收通过，记到帮手头上；干过 3 次以上，主脑派活时能看到', async () => {
    const h = await startHola({ settings: HELPER, env: { HOLA_DEMO_DUMP: '1' } });
    hs.push(h);
    const id = await h.newConv();
    for (let i = 0; i < 3; i++) await h.ask(id, '帮我把推广要点做成表格', { go: true });
    const { cards } = await (await fetch(h.base + '/api/cards')).json();
    assert.match(cards.codex.line, /做表 3 次（验收：通过 3、改了再过 0、退回 0）/);
    assert.match(cards.codex.line, /订阅/);
    assert.match(cards.claude.line, /回答/);
    await h.ask(id, '帮我把推广要点做成表格');
    const p = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Claude.txt'), 'utf8');
    assert.match(p, /【队友能力卡（Hola 记下的实际表现，只供参考，交给谁由你决定）】\n- Codex：做表 3 次/);
    const file = path.join(h.dataDir, 'wick-cards.json');
    for (let i = 0; i < 30 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(file), '存在数据文件夹里（合并 0.5 秒后存盘）');
  });

  it('样本太少不给能力卡；开会的提示词里也不给', async () => {
    const h = await startHola({ settings: HELPER, env: { HOLA_DEMO_DUMP: 'all' } });
    hs.push(h);
    const id = await h.newConv();
    await h.ask(id, '帮我把推广要点做成表格', { go: true });
    await h.ask(id, '@大家 新品耳机怎么推广');
    const log = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompts.log'), 'utf8');
    assert.doesNotMatch(log, /队友能力卡/);
  });

  it('推荐团队配置：订阅命令行的当主脑，便宜的 API 模型当帮手；套用后设置跟着变', async () => {
    const h = await startHola({ settings: { autoMemory: false } });
    hs.push(h);
    const r = await h.post('members/save', { member: { name: 'Flash', type: 'api', baseUrl: 'http://127.0.0.1:9/v1', model: 'deepseek-flash', apiKey: 'sk-t', strengths: '写作' } });
    assert.equal(r.status, 200);
    const rec = await (await fetch(h.base + '/api/team/recommend')).json();
    assert.equal(rec.roles[r.id], 'helper', '便宜的 API 模型当帮手');
    const g = await h.post('members/save', { member: { name: 'GemPro', type: 'api', baseUrl: 'http://127.0.0.1:9/v1', model: 'gemini-3-pro', apiKey: 'sk-t', strengths: '检索' } });
    const rec2 = await (await fetch(h.base + '/api/team/recommend')).json();
    assert.equal(rec2.roles[g.id], 'brain', 'gemini 里的 mini 不能当成便宜模型');
    assert.equal(rec.roles.claude, 'brain');
    assert.ok(rec.lines.some((l) => /主脑：/.test(l)) && rec.lines.some((l) => /帮手（干粗活，不开会）：Flash/.test(l)));
    assert.equal((await h.post('team/apply', {})).status, 200);
    const init = await h.init();
    assert.equal(init.members.find((m) => m.id === r.id).role, 'helper');
    assert.equal(init.settings.conclusionBy, rec2.conclusionBy, '套用的是最新的推荐（演示里的命令行队友是普通脚本，强的 API 模型排前面）');
  });

  it('数据去向：对话里列出这次的内容发给过哪些服务商', async () => {
    const h = await startHola({ settings: HELPER });
    hs.push(h);
    const id = await h.newConv();
    await h.ask(id, '帮我把推广要点做成表格', { go: true });
    const c = await h.conv(id);
    assert.deepEqual(c.providers.map((p) => p.name).sort(), ['Claude', 'Codex']);
    assert.ok(c.providers.every((p) => p.provider && p.api === false));
  });
});
