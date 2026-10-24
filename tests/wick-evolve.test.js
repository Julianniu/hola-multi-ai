// Wick 第 4 阶段 · 越用越好：规矩候选（老板点了才进规矩墙）、本机经验（同一个坑碰到两次成为候选）、验收通过后提示存为技能
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHola } = require('./helpers');

describe('越用越好', () => {
  const hs = [];
  after(async () => { for (const h of hs) { try { await h.stop(); } catch (_) {} } });

  it('规矩候选：老板说"以后……"，记忆整理员提出来；点加入才进规矩墙，点不用以后不再提', async () => {
    const h = await startHola({ env: { HOLA_DEMO_DUMP: 'all' } });
    hs.push(h);
    const id = await h.newConv();
    await h.ask(id, '以后价格都写成 ¥ 加数字');
    let c = await h.conv(id);
    assert.deepEqual(c.ruleHints.map((x) => x.text), ['以后价格都写成 ¥ 加数字']);
    assert.deepEqual(c.rules || [], [], '还没进规矩墙');
    const r = await h.post('rules/hint', { conv: id, text: '以后价格都写成 ¥ 加数字', add: true });
    assert.deepEqual(r.rules.map((x) => x.text), ['以后价格都写成 ¥ 加数字']);
    assert.deepEqual(r.hints, []);
    // 同样的话再说一次：已经在规矩墙上了，不再提
    await h.ask(id, '以后价格都写成 ¥ 加数字');
    c = await h.conv(id);
    assert.deepEqual(c.ruleHints, []);
    // 记忆整理员的提示词里有这一段，开会的提示词不受影响（prompts-meeting.test 锁着）
    assert.match(fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompts.log'), 'utf8'), /【规矩候选】/);
    // 点"不用"：以后同样的话不再提
    const id2 = await h.newConv();
    await h.ask(id2, '以后表格一律做成 Excel');
    await h.post('rules/hint', { conv: id2, text: '以后表格一律做成 Excel', add: false });
    await h.ask(id2, '以后表格一律做成 Excel');
    assert.deepEqual((await h.conv(id2)).ruleHints, []);
  });

  it('验收通过、做出了文件：验收消息下面提示"存为技能"', async () => {
    const h = await startHola({ settings: { autoMemory: false, memberPrefs: { codex: { role: 'helper' } } } });
    hs.push(h);
    const id = await h.newConv();
    const { added } = await h.ask(id, '帮我把推广要点做成表格', { go: true });
    const rv = added.find((m) => m.reason === 'review');
    assert.equal(rv.review, 'pass');
    assert.equal(rv.skillHint, true);
  });
});

describe('本机经验（单独测，用临时数据文件夹）', () => {
  it('同一个坑碰到两次成为候选；老板加入后，干活的提示词里会写上；开会不写', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-envnotes-'));
    process.env.HOLA_DATA_DIR = path.join(dir, 'data');
    process.env.HOLA_WORKSPACE = path.join(dir, 'ws');
    const env = require('../lib/wick-env');
    const turn = (t) => ({ process: [{ k: 'error', t }] });
    env.learnFromTurn(turn("ModuleNotFoundError: No module named 'docx'"));
    assert.deepEqual(env.envNotes(), [], '一次不算');
    env.learnFromTurn(turn("Traceback ... No module named 'docx'"));
    env.learnFromTurn(turn("'ffmpeg' is not recognized as an internal or external command,"));
    const ns = env.envNotes();
    assert.deepEqual(ns.map((n) => n.sig), ['py:docx']);
    assert.match(ns[0].text, /没装 docx 包/);
    assert.equal(env.envNotesText(), '', '没加入之前不写进提示词');
    assert.equal(env.setEnvNote('py:docx', 'on'), true);
    assert.match(env.envNotesText(), /【本机经验（以前在这台电脑上踩过的坑）】\n- 这台电脑的 Python 没装 docx 包/);
    assert.ok(fs.existsSync(path.join(dir, 'data', 'wick-envnotes.json')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
