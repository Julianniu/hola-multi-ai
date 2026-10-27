// Wick 第 5 阶段 · 对标 DeepSeek 的 dsh：API 队友的计划清单（交卷前还有没做完的提醒一次）、
// 改文件前自动快照（undo_file 退回）、命令超时转后台（command_job 看进展）。用模拟的 OpenAI 兼容接口按剧本走。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startHola, freePort } = require('./helpers');

describe('Wick · 学 dsh 的几样', () => {
  let h, srv, base, queue = [], seen = [];
  const sse = (res, list) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const o of list) res.write('data: ' + JSON.stringify(o) + '\n\n');
    res.end('data: [DONE]\n\n');
  };
  const say = (text) => (res) => sse(res, [{ choices: [{ delta: { content: text } }] }]);
  const calls = (...list) => (res) => sse(res, [{ choices: [{ delta: { tool_calls: list.map(([name, args], index) => ({ index, id: 'c' + index + name, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] }]);
  const addMember = async (name, extra = {}) => {
    const r = await h.post('members/save', { member: { name, type: 'api', baseUrl: base, model: 'm-' + name, apiKey: 'sk-t', strengths: '写作', ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r));
    for (let i = 0; i < 50; i++) { const m = (await h.init()).members.find((x) => x.id === r.id); if (m && m.online) break; await new Promise((ok) => setTimeout(ok, 100)); }
    return r.id;
  };
  const lastTool = (req) => req.messages.filter((m) => m.role === 'tool').pop().content;

  before(async () => {
    h = await startHola({ settings: { autoMemory: false, planConfirm: false }, env: { HOLA_WICK_KEEP: '300', HOLA_WICK_CLOCK_MS: '1' } });
    const port = await freePort();
    base = `http://127.0.0.1:${port}/v1`;
    srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const body = JSON.parse(b);
        seen.push(body);
        const step = queue.shift();
        if (!step) return say('（剧本用完了）')(res);
        step(res, body);
      });
    }).listen(port, '127.0.0.1');
  });
  after(async () => { srv.close(); await h.stop(); });

  it('计划清单：同时只能一步在做；交卷时还有没做完的，Hola 提醒一次', async () => {
    const id = await addMember('DP');
    const conv = await h.newConv();
    const n0 = seen.length;
    queue.push(
      calls(['update_plan', { items: [{ step: '查资料', status: 'in_progress' }, { step: '写方案', status: 'in_progress' }] }]),
      calls(['update_plan', { items: [{ step: '查资料', status: 'done' }, { step: '写方案', status: 'pending' }] }]),
      say('做完了'),
      calls(['update_plan', { items: [{ step: '查资料', status: 'done' }, { step: '写方案', status: 'done' }] }]),
      say('方案写好了'),
    );
    const { added } = await h.ask(conv, '@DP 做个方案');
    assert.match(lastTool(seen[n0 + 1]), /只能有一步在做/);
    assert.ok(seen[n0].tools.some((t) => t.function.name === 'update_plan'));
    const nudge = seen[n0 + 3].messages.find((m) => m.role === 'user' && /计划里还有没做完的：写方案/.test(m.content));
    assert.ok(nudge, '交卷前提醒还有没做完的步骤');
    assert.equal(added.find((x) => x.from === id).text, '方案写好了');
    assert.equal(seen.length, n0 + 5, '只提醒一次');
  });

  it('改文件前自动留底：undo_file 退回上一个版本', async () => {
    await addMember('DU');
    const conv = await h.newConv();
    queue.push(
      calls(['write_file', { path: 'a.md', content: '第一版' }]),
      calls(['write_file', { path: 'a.md', content: '第二版' }]),
      calls(['edit_file', { path: 'a.md', old_string: '第二版', new_string: '第三版' }]),
      calls(['undo_file', { path: 'a.md' }]),
      say('退回去了'),
    );
    await h.ask(conv, '@DU 写个文件');
    assert.equal(fs.readFileSync(path.join(h.workspace, conv, 'a.md'), 'utf8'), '第二版');
    assert.match(lastTool(seen[seen.length - 1]), /还能再退 1 次/);
  });

  it('命令转后台：放到后台跑，command_job 等它跑完拿到输出；没有完全权限就没有这几个工具', async () => {
    await addMember('DB', { access: 'full' });
    const conv = await h.newConv();
    const n0 = seen.length;
    const cmd = `node -e "setTimeout(()=>console.log('bg-done'),1500)"`;
    queue.push(
      calls(['run_command', { command: cmd, background: true }]),
      calls(['command_job', { id: 1, wait: 20 }]),
      say('跑完了'),
    );
    await h.ask(conv, '@DB 跑一下');
    assert.match(lastTool(seen[n0 + 1]), /已放到后台运行，编号 1/);
    assert.match(lastTool(seen[n0 + 2]), /已经结束，退出码 0[\s\S]*bg-done/);
    assert.ok(seen[n0].tools.some((t) => t.function.name === 'command_job'));
    await addMember('DN');
    const c2 = await h.newConv();
    const n1 = seen.length;
    queue.push(say('好'));
    await h.ask(c2, '@DN 你好');
    assert.ok(!seen[n1].tools.some((t) => /command/.test(t.function.name)), '安全模式没有运行命令的工具');
  });
  it('学 dsh（二）：后台命令跑完主动通知；没读过的文件先读再改；快满时中途压缩成检查点（命中缓存的做法）', async () => {
    await addMember('DX', { access: 'full' });
    const conv = await h.newConv();
    fs.writeFileSync(path.join(h.workspace, conv, '旧.md'), '老板写的\n');
    const n0 = seen.length;
    const usage = (n) => (res, body) => sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'u' + n, type: 'function', function: { name: 'search_files', arguments: JSON.stringify({ query: 'q' + n }) } }] } }] }, { choices: [], usage: { prompt_tokens: n === 3 ? 150000 : 1000, completion_tokens: 5 } }]);
    queue.push(
      calls(['run_command', { command: `node -e "setTimeout(()=>console.log('job-ok'),200)"`, background: true }], ['write_file', { path: '旧.md', content: '盖掉' }]),
      calls(['run_command', { command: `node -e "setTimeout(()=>{},1500)"` }]),
      usage(1), usage(2), usage(3),
      say('## 老板的要求和意图\n查资料'),
      say('做完了'),
    );
    const { added } = await h.ask(conv, '@DX 干活');
    const r = seen.slice(n0);
    assert.match(r[1].messages.filter((m) => m.role === 'tool').pop().content, /已经存在，你这一轮还没读过/, '不盖掉没读过的文件');
    assert.equal(fs.readFileSync(path.join(h.workspace, conv, '旧.md'), 'utf8'), '老板写的\n');
    assert.ok(r[2].messages.some((m) => m.role === 'user' && /后台命令 1[\s\S]*已经结束，退出码 0[\s\S]*job-ok/.test(m.content)), '跑完主动告诉它');
    const ask = r[5];
    assert.match(ask.messages[ask.messages.length - 1].content, /上下文快满了/);
    assert.equal(ask.tool_choice, 'none', '压缩请求带同样的工具清单（命中缓存），但不许调用');
    assert.ok(r[6].messages.some((m) => /<compacted-summary>[\s\S]*老板的要求和意图/.test(m.content || '')), '较早的一段换成了检查点');
    assert.ok(!r[6].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c0run_command'), '被换掉的工具结果不在了');
    assert.equal(added.find((x) => x.from && x.text === '做完了').text, '做完了');
  });
  it('学 dsh（三）：长会话里只有某块资料变了就只补发那一块；告诉它现在几点、这一轮做了多久', async () => {
    const id = await addMember('DS2');
    const conv = await h.newConv();
    queue.push(calls(['list_files', {}]), say('好'));
    let n0 = seen.length;
    await h.ask(conv, '@DS2 看看文件');
    const first = seen[n0];
    assert.match(JSON.stringify(first.messages), /现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（星期/, '干活时知道今天几号几点');
    assert.ok(seen[n0 + 1].messages.some((m) => m.role === 'user' && /这一轮已经做了 \d+ 分钟/.test(m.content)), '干久了提醒时间');
    const sk = await h.post('skills/save', { skill: { name: '直播复盘', description: '写直播复盘时用', body: '# 复盘\n\n先看数据。' } });
    assert.equal(sk.status, 200, JSON.stringify(sk));
    queue.push(say('收到'));
    n0 = seen.length;
    await h.ask(conv, '@DS2 再看看');
    const last = seen[n0].messages.filter((m) => m.role === 'user').pop().content;
    assert.match(last, /接着上次的对话/, '是续接（只送变化）');
    assert.match(last, /【Hola 技能库（有更新，以这份为准，之前的作废）】[\s\S]*直播复盘/, '只补发技能库那一块');
    assert.ok(!/【团队说明（有更新）】/.test(last), '团队说明没整份重发');
  });
});
