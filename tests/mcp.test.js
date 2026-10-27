// 外部工具连接（MCP）：设置里接上一个服务 → 测试列出工具（只读 / 会改动）→ 密钥不发给页面 →
// 命令行队友干活时通过 Hola 的转接服务调用（会改动的先问老板）→ API 队友在 Hola 里直接调用 → 开会不挂 →
// 导入 Claude 桌面版格式的配置 → "你运行在 Hola 里"只出现在干活的回合。
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startHola } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli.js');
const FAKE_MCP = path.join(__dirname, 'fixtures', 'fake-mcp.js');
const CONFIG = {
  workspace: 'workspace', timeoutMinutes: 2,
  members: {
    claude: { name: 'Claude', strengths: '写作', cmd: 'node', parser: 'claude-stream', args: [FAKE, 'claude-stream', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write'] },
    codex: { name: 'Codex', strengths: '代码', cmd: 'node', parser: 'codex-json', args: [FAKE, 'codex-json', 'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-o', '{OUTFILE}', '-'] },
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (h, p) => (await fetch(h.base + p)).json();

describe('外部工具连接（MCP）', () => {
  const hs = [];
  after(async () => { for (const h of hs) { try { await h.stop(); } catch (_) {} } });

  it('接上服务、列出工具、密钥不外露；命令行队友干活时能用，会改动的先问老板；开会不挂', async () => {
    const h = await startHola({ config: CONFIG, settings: { autoMemory: false }, env: { CODEX_HOME: path.join(__dirname, 'fixtures', 'codex-home') } });
    hs.push(h);
    const log = path.join(h.dir, 'mcp-calls.log');
    const r = await h.post('mcp/save', { server: { name: '测试服务', kind: 'stdio', command: 'node', args: [FAKE_MCP], env: { FAKE_MCP_LOG: log, API_TOKEN: 'secret-1234' } } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.server.error, '', '连得上');
    assert.deepEqual(r.server.tools.map((t) => [t.name, t.write]), [['list_users', false], ['send_message', true]], '只读的认出来，其他算会改动');
    const pub = await getJson(h, '/api/mcp');
    const raw = JSON.stringify(pub);
    assert.ok(!raw.includes('secret-1234'), '密钥不发给页面');
    assert.deepEqual(pub.servers[0].env.API_TOKEN, { set: true, hint: '••••1234' });
    assert.ok(pub.presets.some((p) => p.key === 'dingtalk' && p.args.includes('dingtalk-mcp@latest')), '有钉钉模板');
    // 只改名字、密钥留空 → 原来的密钥保留
    await h.post('mcp/save', { server: { ...pub.servers[0], name: '测试服务' } });
    const id = await h.newConv();
    const sent = h.post('send', { conv: id, text: '@Claude 用外部工具查一下用户再发个消息' });
    // 发消息要老板点头：等审批卡片出来，点"这次允许"
    let ask;
    for (let i = 0; i < 100 && !ask; i++) { ask = ((await h.init()).browser.asks || [])[0]; if (!ask) await sleep(100); }
    assert.ok(ask, '会改动的工具先问老板');
    assert.match(ask.detail, /send_message/);
    await h.post('browser/answer', { id: ask.id, answer: 'once' });
    await sent;
    await h.waitIdle(id);
    const res = JSON.parse(fs.readFileSync(path.join(h.workspace, id, '.hola', 'mcp-result.json'), 'utf8'));
    assert.ok(res.tools.some((t) => /__list_users$/.test(t)) && res.tools.some((t) => /__send_message$/.test(t)), '转接服务列出了工具');
    assert.match(JSON.stringify(res.replies), /张三, 李四/);
    assert.match(JSON.stringify(res.replies), /已发送：你好/);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((x) => x.name).sort(), ['list_users', 'send_message']);
    assert.ok(calls.every((x) => x.token === 'secret-1234'), '改名后密钥还在，服务拿到了');
    const prompt = fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-claude-stream.txt'), 'utf8');
    assert.match(prompt, /【你所在的环境】/, '干活的回合告诉队友它在 Hola 里');
    assert.match(prompt, /外部工具（MCP）：测试服务/);
    // "这个对话都允许"：同一个对话里之后的外部工具不再问；但老板选了"每次都问我"就照样问
    const askOnce = async (text, answer) => {
      await h.post('send', { conv: id, text });
      // "每次都问我"时只读的工具也问：一直回答到这一轮做完
      let n = 0;
      for (let i = 0; i < 300; i++) {
        const a = ((await h.init()).browser.asks || [])[0];
        if (a) { assert.equal(a.kind, 'mcp', '卡片知道这是外部工具，不是浏览器'); await h.post('browser/answer', { id: a.id, answer }); n++; continue; }
        if (!(await h.conv(id)).running) break;
        await sleep(100);
      }
      await h.waitIdle(id);
      return n > 0;
    };
    assert.equal(await askOnce('@Claude 用外部工具再发一次', 'conv'), true);
    assert.equal(await askOnce('@Claude 用外部工具再发一次', 'once'), false, '这个对话都允许了，不再问');
    await h.post('mcp/toggle', { id: pub.servers[0].id, patch: { ask: 'always' } });
    assert.equal(await askOnce('@Claude 用外部工具再发一次', 'once'), true, '每次都问我：允许过也照样问');
    // 开会不挂，也不加环境说明
    await h.ask(id, '@大家 新品怎么推广');
    const args = JSON.parse(fs.readFileSync(path.join(h.workspace, id, '.hola', 'args-claude-stream.json'), 'utf8'));
    assert.ok(!args.some((a) => /mcp-claude-/.test(a)), '开会不挂外部工具');
    assert.ok(!fs.readFileSync(path.join(h.workspace, id, '.hola', 'prompt-claude-stream.txt'), 'utf8').includes('【你所在的环境】'));
    // 关掉这个服务：干活也不挂
    await h.post('mcp/toggle', { id: pub.servers[0].id, patch: { on: false } });
    await h.ask(id, '@Claude 你好');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(h.workspace, id, '.hola', 'args-claude-stream.json'), 'utf8')).some((a) => /mcp-claude-/.test(a)));
    // 删除
    await h.post('mcp/delete', { id: pub.servers[0].id });
    assert.equal((await getJson(h, '/api/mcp')).servers.length, 0);
  });

  it('API 队友在 Hola 里直接调用外部工具；导入 Claude 桌面版格式的配置', async () => {
    // 一个假的 OpenAI 兼容接口：第一次请求调用 MCP 工具，第二次回答
    const seen = [];
    const api = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const body = JSON.parse(b || '{}');
        seen.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const tool = (body.tools || []).map((t) => t.function.name).find((n) => /__list_users$/.test(n));
        const hasResult = (body.messages || []).some((m) => m.role === 'tool');
        const chunk = tool && !hasResult
          ? { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: tool, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
          : { choices: [{ index: 0, delta: { content: '查好了' }, finish_reason: 'stop' }] };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    const h = await startHola({ settings: { autoMemory: false, planConfirm: false } });
    hs.push(h);
    try {
      const r = await h.post('mcp/import', { text: JSON.stringify({ mcpServers: { 假服务: { command: 'node', args: [FAKE_MCP], env: { API_TOKEN: 'k-9999' } } } }) });
      assert.equal(r.added, 1);
      const s = (await getJson(h, '/api/mcp')).servers[0];
      await h.post('mcp/test', { id: s.id });
      const m = await h.post('members/save', { member: { name: 'DS', type: 'api', baseUrl: `http://127.0.0.1:${api.address().port}/v1`, model: 'fake', apiKey: 'sk-t', strengths: '写作' } });
      assert.equal(m.status, 200, JSON.stringify(m));
      const id = await h.newConv();
      const { added } = await h.ask(id, '@DS 查一下用户');
      const reply = added.find((x) => x.from === m.id);
      assert.match(reply.text, /查好了/);
      const toolMsg = seen.flatMap((b) => b.messages || []).find((x) => x.role === 'tool');
      assert.ok(toolMsg && /张三, 李四/.test(toolMsg.content), 'Hola 把调用转给了服务，结果交回模型');
    } finally { api.close(); }
  });
});
