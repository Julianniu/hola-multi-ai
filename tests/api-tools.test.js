// API 队友能动手：用模拟的 OpenAI 兼容接口按剧本回复"调用工具"，检查 Hola 真的去读写文件、把结果送回去、
// 用量逐次累加；接口不支持工具时自动改成只动脑；"完全权限"才能运行命令；越界路径和本机网址要拦下。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const office = require('../office');
const { startHola, freePort, makeDocx } = require('./helpers');

describe('API 队友能动手', () => {
  let h, srv, base, queue = [], seen = [];
  const sse = (res, list) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const o of list) res.write('data: ' + JSON.stringify(o) + '\n\n');
    res.end('data: [DONE]\n\n');
  };
  const jsonRes = (res, o, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const say = (text, usage) => (res) => sse(res, [{ choices: [{ delta: { content: text } }] }, ...(usage ? [{ choices: [], usage }] : [])]);
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
  const addMember = async (name, extra = {}) => {
    const r = await h.post('members/save', { member: { name, type: 'api', baseUrl: base, model: 'm-' + name, apiKey: 'sk-t', strengths: '写作', ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r));
    for (let i = 0; i < 50; i++) { const m = (await h.init()).members.find((x) => x.id === r.id); if (m && m.online) break; await new Promise((ok) => setTimeout(ok, 100)); }
    return r.id;
  };
  const toolMsgs = (req) => req.messages.filter((m) => m.role === 'tool');

  before(async () => {
    h = await startHola({ settings: { autoMemory: false } });
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

  it('读附件、写 Word、一次调两个工具、参数分好几段到、思考原样送回、用量每次都算上', async () => {
    const id = await addMember('DT');
    const conv = await h.newConv();
    await h.upload(conv, 'brief.docx', makeDocx(['耳机新品：主打降噪，预算 8000 元']));
    queue.push(
      (res) => sse(res, [
        { choices: [{ delta: { reasoning_content: '先读附件' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"附件/brief.docx"}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]),
      (res) => jsonRes(res, { choices: [{ message: { content: null, tool_calls: [
        call('c2', 'write_file', { path: '产出/方案.docx', content: '# 降噪耳机推广方案\n\n- 预算 8000 元\n- 主打降噪' }),
        call('c3', 'read_file', { path: '.hola/chat.json' }),
        call('c4', 'fetch_url', { url: 'http://127.0.0.1:1/' }),
      ] } }], usage: { prompt_tokens: 20, completion_tokens: 3 } }),
      (res) => sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c5', function: { name: 'write_file', arguments: '{bad' } }] } }] }]),
      say('做好了：产出/方案.docx', { prompt_tokens: 30, completion_tokens: 4 }),
    );
    const n0 = seen.length;
    await h.post('send', { conv, text: '@DT 根据附件写个推广方案', attachments: [{ path: '附件/brief.docx' }] });
    const c = await h.waitIdle(conv);
    const m = c.messages.find((x) => x.from === id);
    assert.equal(m.status, 'done', m.text);
    assert.equal(m.text, '做好了：产出/方案.docx');
    assert.deepEqual(m.usage, { input: 60, cached: 0, output: 9 }, '每次请求的用量都要算上');
    assert.ok((m.files || []).some((f) => f.path === '产出/方案.docx'), '做出来的文件挂在消息下面');
    const doc = office.readOffice(path.join(h.workspace, conv, '产出', '方案.docx'));
    assert.deepEqual(doc.blocks.map((b) => b.text), ['降噪耳机推广方案', '预算 8000 元', '主打降噪']);

    const reqs = seen.slice(n0);
    assert.equal(reqs.length, 4);
    const names = reqs[0].tools.map((t) => t.function.name);
    assert.ok(names.includes('write_file') && names.includes('web_search'));
    assert.ok(!names.includes('run_command'), '没开完全权限就没有运行命令');
    assert.ok(!names.some((n) => n.startsWith('browser_')), '不是桌面版就没有内置浏览器');
    assert.match(reqs[0].messages[0].content, /用 Hola 提供的工具干活/);
    assert.match(reqs[0].messages[0].content, /通过 API 接入：能读写对话文件夹里的文件/);
    // 第二次请求：带着上一步的思考和读到的附件内容
    const a1 = reqs[1].messages.find((x) => x.role === 'assistant');
    assert.equal(a1.reasoning_content, '先读附件');
    assert.equal(a1.tool_calls[0].function.arguments, '{"path":"附件/brief.docx"}');
    assert.match(toolMsgs(reqs[1])[0].content, /预算 8000 元/);
    const t2 = toolMsgs(reqs[2]);
    assert.match(t2.find((x) => x.tool_call_id === 'c2').content, /已保存：产出\/方案\.docx/);
    assert.match(t2.find((x) => x.tool_call_id === 'c3').content, /不能读/, '.hola 里有聊天记录和通行证，不给读');
    assert.match(t2.find((x) => x.tool_call_id === 'c4').content, /不能打开/, '不读本机网址');
    assert.match(toolMsgs(reqs[3]).find((x) => x.tool_call_id === 'c5').content, /不是合法的 JSON/);
    // 进度里写着它干了什么（界面的趣味状态靠这个）
    assert.ok(m.process.some((p) => p.t === '读取：附件/brief.docx'));
    assert.ok(m.process.some((p) => p.t === '写入：产出/方案.docx'));
  });

  it('Excel 和 PPT：写成 .xlsx / .pptx 就是正式文件', async () => {
    const id = (await h.init()).members.find((x) => x.name === 'DT').id;
    const conv = await h.newConv();
    queue.push(
      (res) => jsonRes(res, { choices: [{ message: { tool_calls: [
        call('x1', 'write_file', { path: '预算.xlsx', content: '## 渠道预算\n| 渠道 | 预算 |\n|---|---|\n| 抖音 | 5000 |' }),
        call('x2', 'write_file', { path: '发布会.pptx', content: '# 新品发布\n\n## 卖点\n- 降噪\n- 续航' }),
      ] } }] }),
      say('好了'),
    );
    await h.post('send', { conv, text: '@DT 做表格和 PPT' });
    await h.waitIdle(conv);
    const x = office.readOffice(path.join(h.workspace, conv, '预算.xlsx'));
    assert.equal(x.sheets[0].name, '渠道预算');
    assert.deepEqual(x.sheets[0].rows, [['渠道', '预算'], ['抖音', '5000']]);
    const p = office.readOffice(path.join(h.workspace, conv, '发布会.pptx'));
    assert.deepEqual(p.slides.map((s) => s.title), ['新品发布', '卖点']);
    assert.deepEqual(p.slides[1].paras, ['卖点', '降噪', '续航']);
    assert.ok(id);
  });

  it('讨论阶段写文件会被挡住（等有了结论再动手）', async () => {
    const id = (await h.init()).members.find((x) => x.name === 'DT').id;
    const conv = await h.newConv();
    await h.post('conv/active', { conv, active: [id, 'claude'] });
    queue.push(
      (res) => jsonRes(res, { choices: [{ message: { tool_calls: [call('d1', 'write_file', { path: '草稿.md', content: '草稿' })] } }] }),
      say('我的看法：先定预算。\n\n【需要讨论】否'),
    );
    const n0 = seen.length;
    await h.post('send', { conv, text: '新品耳机怎么推广', mode: 'discuss' });
    await h.waitIdle(conv);
    assert.match(toolMsgs(seen[n0 + 1]).find((x) => x.tool_call_id === 'd1').content, /讨论阶段/);
    assert.ok(!fs.existsSync(path.join(h.workspace, conv, '草稿.md')));
  });

  it('完全权限：多一个"运行命令"，真的能跑', async () => {
    const id = await addMember('DF', { access: 'full' });
    assert.equal((await h.init()).members.find((x) => x.id === id).access, 'full');
    const conv = await h.newConv();
    queue.push(
      (res) => jsonRes(res, { choices: [{ message: { tool_calls: [call('r1', 'run_command', { command: 'echo hola-ok' })] } }] }),
      say('跑完了'),
    );
    const n0 = seen.length;
    await h.post('send', { conv, text: '@DF 跑个命令' });
    await h.waitIdle(conv);
    assert.ok(seen[n0].tools.some((t) => t.function.name === 'run_command'));
    assert.match(toolMsgs(seen[n0 + 1])[0].content, /hola-ok/);
    assert.match(seen[n0].messages[0].content, /run_command 运行命令/);
  });

  it('接口不支持工具：自动改成只动脑、记下来，提示词也跟着改；"保存并测试"能提前试出来', async () => {
    const id = await addMember('DN');
    queue.push(
      (res) => jsonRes(res, { error: { message: 'tools is not supported for this model' } }, 400),
      say('只能动脑'),
    );
    const conv = await h.newConv();
    const n0 = seen.length;
    await h.post('send', { conv, text: '@DN 你好' });
    const c = await h.waitIdle(conv);
    assert.equal(c.messages.find((x) => x.from === id).text, '只能动脑');
    assert.ok(seen[n0].tools && !seen[n0 + 1].tools);
    assert.match(seen[n0 + 1].messages[0].content, /不能读写文件、不能联网/, '重拼的提示词说清楚它不能动手');
    assert.equal((await h.init()).members.find((x) => x.id === id).edit.toolsOk, false);
    // 下次直接不给工具
    queue.push(say('还是只动脑'));
    await h.post('send', { conv, text: '@DN 再来' });
    await h.waitIdle(conv);
    assert.ok(!seen[seen.length - 1].tools);

    // 保存并测试：先发一句话，再试工具
    const id2 = await addMember('DP');
    queue.push(say('OK'), (res) => jsonRes(res, { choices: [{ message: { tool_calls: [call('p1', 'ping', {})] } }] }));
    const t = await h.post('members/test', { id: id2 });
    assert.equal(t.ok, true);
    assert.equal(t.hands, true);
    assert.equal((await h.init()).members.find((x) => x.id === id2).edit.toolsOk, true);
  });

  it('关掉"能动手"：不给工具，提示词说它只动脑', async () => {
    const id = await addMember('DQ', { hands: false });
    const conv = await h.newConv();
    queue.push(say('好'));
    await h.post('send', { conv, text: '@DQ 你好' });
    await h.waitIdle(conv);
    const last = seen[seen.length - 1];
    assert.ok(!last.tools);
    assert.match(last.messages[0].content, /你是通过 API 接入的，不能读写文件/);
    assert.equal((await h.init()).members.find((x) => x.id === id).edit.hands, false);
  });
});
