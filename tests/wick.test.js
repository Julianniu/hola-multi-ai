// Wick 的改进（演示模式，假队友秒回）：规矩墙、开关可以单独关掉。
// 调用命令行 / API 的部分在 members.test.js、api-tools.test.js 里测。
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHola } = require('./helpers');

// 聊够 60 条（30 问 30 答），其中第 3 问是老板定的规矩；然后看第 31 问时队友收到的提示词
async function longChat(h) {
  const id = await h.newConv();
  for (let i = 1; i <= 30; i++) await h.ask(id, i === 3 ? '跟你说下我们家文案的习惯：价格前面放 ¥ 符号，结尾落一句"喜欢就带走"。' : `第 ${i} 个问题：灯光怎么打？`);
  await h.ask(id, '写一段文案');
  return fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Claude.txt'), 'utf8');
}

describe('Wick', () => {
  const hs = [];
  after(async () => { for (const h of hs) await h.stop(); });

  it('规矩墙：聊久了，老板较早说的话不在最近 50 条里，也原样放进提示词', async () => {
    const h = await startHola({ settings: { autoMemory: false }, env: { HOLA_DEMO_DUMP: '1' } });
    hs.push(h);
    const p = await longChat(h);
    const wall = p.indexOf('【老板较早说过的话');
    assert.ok(wall > 0, '有这一栏');
    assert.match(p.slice(wall), /\[第 5 条\] 跟你说下我们家文案的习惯/);
    assert.ok(wall < p.indexOf('===== 群聊记录 ====='), '放在群聊记录前面');
    assert.equal(p.split('跟你说下我们家文案的习惯').length - 1, 1, '只出现一次（不在最近 50 条里）');
  });

  // ---------------------------------------------------------------- 长会话（用模拟的三家命令行）
  describe('长会话 + 只送新消息', () => {
    const FAKE = path.join(__dirname, 'fixtures', 'fake-cli.js');
    const CONFIG = {
      workspace: 'workspace', timeoutMinutes: 2,
      members: {
        claude: { name: 'Claude', strengths: '写作', cmd: 'node', parser: 'claude-stream', args: [FAKE, 'claude-stream', '-p', '--output-format', 'stream-json', '--verbose'] },
        codex: { name: 'Codex', strengths: '代码', cmd: 'node', parser: 'codex-json', args: [FAKE, 'codex-json', 'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-o', '{OUTFILE}', '-'] },
        gemini: { name: 'Gemini', strengths: '检索', cmd: 'node', parser: 'agy-json', args: [FAKE, 'agy-json', '-p', '{PROMPT}', '--output-format', 'json'] },
      },
    };
    let h, id;
    const dir = () => path.join(h.workspace, id);
    const argsOf = (mode) => JSON.parse(fs.readFileSync(path.join(dir(), '.hola', `args-${mode}.json`), 'utf8'));
    const promptOf = (mode) => fs.readFileSync(path.join(dir(), '.hola', `prompt-${mode}.txt`), 'utf8');
    const after = (a, f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);

    it('第一轮送完整提示词并开新会话；第二轮续接，只送新消息', async () => {
      h = await startHola({ config: CONFIG, settings: { autoMemory: false, wick: { sessions: true, teamMcp: false } }, env: { CODEX_HOME: path.join(__dirname, 'fixtures', 'codex-home') } });
      hs.push(h);
      id = await h.newConv();
      await h.ask(id, '@Claude 第一句：记住暗号蓝鲸');
      const a1 = argsOf('claude-stream');
      const sid = after(a1, '--session-id');
      assert.match(sid || '', /^[0-9a-f-]{36}$/, '新会话由 Hola 指定编号');
      assert.match(promptOf('claude-stream'), /===== 群聊记录 =====/);
      const { added } = await h.ask(id, '@Claude 第二句：暗号是什么');
      const a2 = argsOf('claude-stream');
      assert.equal(after(a2, '--resume'), sid, '续接同一个会话');
      const p2 = promptOf('claude-stream');
      assert.match(p2, /^（接着上次的对话/);
      assert.match(p2, /第二句：暗号是什么/);
      assert.ok(!p2.includes('第一句：记住暗号蓝鲸'), '已经送过的不再送');
      assert.ok(!p2.includes('你是 Hola 团队里的'), '团队说明没变就不重送');
      assert.equal(added.find((m) => m.from === 'claude').resumed, true);
    });

    it('Codex 续接用 exec resume <编号>，沙盒改成 -c 写法；Gemini 用 --conversation', async () => {
      await h.ask(id, '@Codex 你好');
      await h.ask(id, '@Codex 再来');
      const a = argsOf('codex-json');
      assert.deepEqual(a.slice(0, 2), ['exec', 'resume']);
      assert.ok(!a.includes('--sandbox'));
      assert.ok(a.includes('sandbox_mode="workspace-write"'));
      assert.equal(a[a.length - 2], 't1', '编号放在最后的 - 前面');
      assert.match(promptOf('codex-json'), /^（接着上次的对话/);
      await h.ask(id, '@Gemini 你好');
      await h.ask(id, '@Gemini 再来');
      assert.equal(after(argsOf('agy-json'), '--conversation'), 'c1');
    });

    it('续接失败（会话丢了）：丢掉旧会话，送完整提示词重来一次，照样完成', async () => {
      fs.writeFileSync(path.join(dir(), '.hola', 'fail-resume'), '1');
      const { added } = await h.ask(id, '@Claude 第三句');
      fs.unlinkSync(path.join(dir(), '.hola', 'fail-resume'));
      const m = added.find((x) => x.from === 'claude');
      assert.equal(m.status, 'done', m.text);
      assert.equal(m.resumed, false);
      assert.ok(argsOf('claude-stream').includes('--session-id'), '重来时开了新会话');
      assert.match(promptOf('claude-stream'), /===== 群聊记录 =====/, '重来时是完整提示词');
    });

    it('换了模型：旧会话不能接着用，开新会话', async () => {
      await h.post('members/save', { member: { id: 'claude', name: 'Claude', cliModel: 'opus' } });
      await h.ask(id, '@Claude 第四句');
      assert.ok(argsOf('claude-stream').includes('--session-id'));
    });

    it('开会的三个阶段不用长会话（照旧送完整提示词）；第一轮看不到主脑那一版，讨论轮才看到；会后干活续接时补上讨论内容', async () => {
      await h.ask(id, '@Codex 先热身');
      const { added } = await h.ask(id, '6 月到 7 月环比增长多少？');
      const main = added.find((m) => m.from === 'claude' && m.reason === 'main');
      assert.ok(main, '主脑直接回答');
      const r = await h.post('discuss', { conv: id, msg: main.id });
      assert.equal(r.status, 200, JSON.stringify(r));
      // 等第一轮 Codex 拿到的提示词
      const t0 = Date.now();
      let initial = '';
      while (Date.now() - t0 < 20000) {
        const c = await h.conv(id);
        if (c.messages.some((m) => m.from === 'codex' && m.reason === 'initial' && m.status === 'done')) break;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      initial = fs.readFileSync(path.join(dir(), '.hola', 'prompts-seen.log'), 'utf8').split('<<<<<').filter((x) => x.startsWith('codex-json') && /独立作答|同时、独立作答/.test(x)).pop() || '';
      assert.ok(initial, '记下了 Codex 第一轮的提示词');
      assert.ok(!initial.includes('主脑直接回答'), '第一轮看不到主脑那一版');
      await h.waitIdle(id);
      const later = fs.readFileSync(path.join(dir(), '.hola', 'prompts-seen.log'), 'utf8').split('<<<<<').filter((x) => x.startsWith('codex-json') && /内部讨论第 1 轮/.test(x)).pop() || '';
      assert.ok(later.includes('主脑直接回答'), '讨论轮补上了主脑那一版');
      assert.match(initial, /===== 群聊记录 =====/, '开会时送的是完整提示词');
      assert.ok(!initial.includes('（接着上次的对话'), '开会时不续接会话');
      // 会后干活：续接 Codex 的会话，开会的内容作为新消息补上
      await h.ask(id, '@Codex 按结论做');
      const p = promptOf('codex-json');
      assert.match(p, /^（接着上次的对话/);
      assert.match(p, /内部讨论|讨论第1轮|团队结论/);
    });
  });

  it('长会话（API 队友）：第二轮带着上一轮的完整来往（含思考内容）接着发，只追加新消息', async () => {
    const http = require('http');
    const { freePort } = require('./helpers');
    const seen = [];
    const port = await freePort();
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        seen.push(JSON.parse(b));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `第 ${seen.length} 次回答`, reasoning_content: `想法 ${seen.length}` } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
      });
    }).listen(port, '127.0.0.1');
    const h = await startHola({ settings: { autoMemory: false, wick: { sessions: true } } });
    hs.push(h);
    try {
      const r = await h.post('members/save', { member: { name: 'DS', type: 'api', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'k', strengths: '写作' } });
      for (let i = 0; i < 50; i++) { if ((await h.init()).members.find((x) => x.id === r.id).online) break; await new Promise((ok) => setTimeout(ok, 100)); }
      const conv = await h.newConv();
      await h.ask(conv, '@DS 第一句');
      await h.ask(conv, '@DS 第二句');
      const [a, b] = seen.slice(-2);
      assert.deepEqual(a.messages.map((x) => x.role), ['system', 'user'], '第一轮：固定说明作为系统消息 + 其余内容');
      assert.deepEqual(b.messages.map((x) => x.role), ['system', 'user', 'assistant', 'user'], '上一轮的来往 + 这一轮');
      assert.deepEqual(b.messages[2], { role: 'assistant', content: '第 1 次回答', reasoning_content: '想法 1' });
      assert.match(b.messages[3].content, /^（接着上次的对话/);
      assert.match(b.messages[3].content, /第二句/);
      assert.ok(!b.messages[3].content.includes('第一句'));
    } finally { srv.close(); }
  });

  it('边写边显示：队友正在写的字陆续推给页面，记下第一个字出现的时间；草稿不存进聊天记录', async () => {
    const http = require('http');
    const { freePort } = require('./helpers');
    const port = await freePort();
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', async () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const piece of ['第一段，', '第二段，', '写完了。']) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
          await new Promise((ok) => setTimeout(ok, 400));
        }
        res.end('data: [DONE]\n\n');
      });
    }).listen(port, '127.0.0.1');
    const h = await startHola({ settings: { autoMemory: false } });
    hs.push(h);
    try {
      const r = await h.post('members/save', { member: { name: 'DW', type: 'api', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'k', strengths: '写作', hands: false } });
      for (let i = 0; i < 50; i++) { if ((await h.init()).members.find((x) => x.id === r.id).online) break; await new Promise((ok) => setTimeout(ok, 100)); }
      const conv = await h.newConv();
      // 一边听页面收到的推送，一边发消息
      const ctrl = new AbortController();
      const got = [];
      const listen = (async () => {
        const res = await fetch(h.base + '/api/events', { signal: ctrl.signal });
        const reader = res.body.getReader();
        let buf = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += Buffer.from(value).toString('utf8');
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const line = buf.slice(0, i).replace(/^data: /, '');
              buf = buf.slice(i + 2);
              try { const ev = JSON.parse(line); if (ev.type === 'draft') got.push(ev.text); } catch (_) {}
            }
          }
        } catch (_) {}
      })();
      await h.ask(conv, '@DW 写点什么');
      ctrl.abort();
      await listen;
      assert.ok(got.length >= 2, '陆续收到好几次：' + JSON.stringify(got));
      assert.equal(got[0], '第一段，');
      const m = (await h.conv(conv)).messages.find((x) => x.from === r.id);
      assert.equal(m.text, '第一段，第二段，写完了。');
      assert.ok(m.firstAt >= m.startedAt && m.firstAt < m.endedAt, '记下了第一个字出现的时间');
      assert.ok(!('draft' in m), '草稿写完就清掉');
      const saved = JSON.parse(fs.readFileSync(path.join(h.workspace, conv, '.hola', 'chat.json'), 'utf8')).messages.find((x) => x.id === m.id);
      assert.ok(!('draft' in saved));
    } finally { srv.close(); }
  });

  it('长对话压缩（API 队友）：会话记录太长时，较早的部分请模型压成要点，保留开头和最近几轮', async () => {
    const http = require('http');
    const { freePort } = require('./helpers');
    const seen = [];
    const port = await freePort();
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const body = JSON.parse(b);
        seen.push(body);
        const ask = body.messages.length === 1 && /压缩成要点/.test(body.messages[0].content);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ask ? '要点：已经读过 报价.md，暗号是蓝鲸-4721' : `回答 ${seen.length}` } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
      });
    }).listen(port, '127.0.0.1');
    const h = await startHola({ settings: { autoMemory: false, wick: { sessions: true } } });
    hs.push(h);
    try {
      const r = await h.post('members/save', { member: { name: 'DC', type: 'api', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'k', strengths: '写作' } });
      for (let i = 0; i < 50; i++) { if ((await h.init()).members.find((x) => x.id === r.id).online) break; await new Promise((ok) => setTimeout(ok, 100)); }
      const conv = await h.newConv();
      await h.ask(conv, '@DC 第一句');
      // 人为把会话记录撑大：中间塞几轮很长的来往
      const f = path.join(h.workspace, conv, '.hola', `wick-api-${r.id}.json`);
      const hist = JSON.parse(fs.readFileSync(f, 'utf8'));
      const big = '很长的工具结果。'.repeat(30000);
      for (let k = 1; k <= 4; k++) hist.push({ role: 'user', content: `第 ${k} 轮的问题` }, { role: 'assistant', content: k === 1 ? big : `第 ${k} 轮的回答` });
      fs.writeFileSync(f, JSON.stringify(hist));
      const n0 = seen.length;
      await h.ask(conv, '@DC 最新的问题');
      const reqs = seen.slice(n0);
      assert.equal(reqs.length, 2, '先压缩一次，再正式回答');
      assert.match(reqs[0].messages[0].content, /压缩成要点/);
      const main = reqs[1].messages;
      const all = JSON.stringify(main);
      assert.ok(!all.includes(big.slice(0, 2000)), '很长的旧内容不再整段发');
      assert.match(all, /之前的工作要点[\s\S]*暗号是蓝鲸-4721/);
      assert.equal(main[0].role, 'system', '开头的团队说明保留');
      assert.match(all, /第 4 轮的回答/, '最近几轮完整保留');
      assert.match(main[main.length - 1].content, /最新的问题/);
      const m = (await h.conv(conv)).messages.filter((x) => x.from === r.id).pop();
      assert.equal(m.status, 'done');
    } finally { srv.close(); }
  });

  it('花费：按用量和单价算出每条消息、这个对话、今天花了多少；到了上限就停，不再发请求', async () => {
    const http = require('http');
    const { freePort } = require('./helpers');
    let calls = 0;
    const port = await freePort();
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // 100 万输入（其中 40 万命中缓存）+ 10 万输出
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的' } }], usage: { prompt_tokens: 1000000, prompt_cache_hit_tokens: 400000, completion_tokens: 100000 } }));
      });
    }).listen(port, '127.0.0.1');
    const h = await startHola({ settings: { autoMemory: false } });
    hs.push(h);
    try {
      const r = await h.post('members/save', { member: { name: 'DF', type: 'api', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: 'k', strengths: '写作', hands: false, price: { input: 1, cached: 0.1, output: 2 } } });
      for (let i = 0; i < 50; i++) { if ((await h.init()).members.find((x) => x.id === r.id).online) break; await new Promise((ok) => setTimeout(ok, 100)); }
      const conv = await h.newConv();
      await h.ask(conv, '@DF 你好');
      const m = (await h.conv(conv)).messages.find((x) => x.from === r.id);
      // 60 万 × 1 + 40 万 × 0.1 + 10 万 × 2，单位元 / 百万 → 0.6 + 0.04 + 0.2 = 0.84
      assert.ok(Math.abs(m.cost - 0.84) < 1e-6, String(m.cost));
      const sp = await (await fetch(`${h.base}/api/spend?conv=${conv}`)).json();
      assert.ok(Math.abs(sp.conv - 0.84) < 1e-6 && sp.today >= 0.84 - 1e-6, JSON.stringify(sp));
      // 上限：每个对话 0.5 元 → 已经超了，下一条不再发请求
      await h.post('settings', { budget: { perConv: 0.5 } });
      const before = calls;
      const { added } = await h.ask(conv, '@DF 再来');
      const m2 = added.find((x) => x.from === r.id);
      assert.equal(calls, before, '到了上限就不再发请求');
      assert.equal(m2.status, 'error');
      assert.match(m2.text, /上限/);
    } finally { srv.close(); }
  });

  it('步骤日志：每一轮一份流水账（开始、完整提示词、每一步、结束），回放工具能读', async () => {
    const h = await startHola({ settings: { autoMemory: false } });
    hs.push(h);
    const id = await h.newConv();
    const { added } = await h.ask(id, '@Claude 你好');
    const m = added.find((x) => x.from === 'claude');
    const f = path.join(h.workspace, id, '.hola', 'trace', `${m.id}.jsonl`);
    const ev = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const start = ev.find((e) => e.k === 'start');
    assert.equal(start.member, 'claude');
    assert.match(start.prompt, /现在轮到你（Claude）/);
    assert.ok(start.provider);
    assert.ok(ev.some((e) => e.k === 'cli'), '记下了启动命令');
    const end = ev.find((e) => e.k === 'end');
    assert.equal(end.status, 'done');
    assert.equal(end.text, m.text);
    const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'wick-trace.js'), path.join(h.workspace, id), m.id], { encoding: 'utf8' });
    assert.match(out, /开始.*Claude/);
    assert.match(out, /结束  done/);
  });

  it('环境卡片：启动时查一遍本机有什么，写进给队友的说明', async () => {
    const h = await startHola({ settings: { autoMemory: false }, env: { HOLA_DEMO_DUMP: '1' } });
    hs.push(h);
    const id = await h.newConv();
    let p = '';
    for (let i = 0; i < 20 && !p.includes('【本机环境】'); i++) {
      await h.ask(id, '你好');
      p = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Claude.txt'), 'utf8');
      if (!p.includes('【本机环境】')) await new Promise((ok) => setTimeout(ok, 500));
    }
    assert.match(p, /【本机环境】(Windows|macOS|Linux)；.*(Python|没有 Python).*Node v\d+/);
    assert.ok(p.indexOf('【本机环境】') < p.indexOf('===== 群聊记录 ====='));
  });

  it('规矩墙：老板亲手整理的规矩每一轮都原样告诉队友（开会时也一样）', async () => {
    const h = await startHola({ settings: { autoMemory: false }, env: { HOLA_DEMO_DUMP: '1' } });
    hs.push(h);
    const id = await h.newConv();
    const r = await h.post('rules', { conv: id, rules: ['价格一律写成 ¥ 加数字', '  ', '结尾加一句"喜欢就带走"'] });
    assert.deepEqual(r.rules.map((x) => x.text), ['价格一律写成 ¥ 加数字', '结尾加一句"喜欢就带走"'], '空行去掉');
    assert.deepEqual((await h.conv(id)).rules.map((x) => x.text), r.rules.map((x) => x.text));
    await h.ask(id, '写段文案');
    const p = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Claude.txt'), 'utf8');
    assert.match(p, /【老板定下的规矩（老板亲自整理的，每一条都要遵守）】\n- 价格一律写成 ¥ 加数字\n- 结尾加一句"喜欢就带走"/);
    await h.ask(id, '开会讨论一下', { mode: 'discuss' });
    const all = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-Codex.txt'), 'utf8');
    assert.match(all, /价格一律写成 ¥ 加数字/, '开会时也带上');
  });

  it('开关：settings.wick.rulesWall = false 时退回旧做法', async () => {
    const h = await startHola({ settings: { autoMemory: false, wick: { rulesWall: false } }, env: { HOLA_DEMO_DUMP: '1' } });
    hs.push(h);
    const p = await longChat(h);
    assert.ok(!p.includes('【老板较早说过的话'));
    assert.ok(!p.includes('跟你说下我们家文案的习惯'), '旧做法：第 5 条已经被挤出去了');
  });
});
