// 中转站：内置的 Claude / Codex / Gemini 改走公司的 API 中转站；读取可用模型；思考深度；模型不在分组里时说清楚；
// Key 只存在 data/relays.json，不会出现在页面数据里。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startHola, freePort } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli.js');
const CONFIG = {
  workspace: 'workspace', timeoutMinutes: 2,
  members: {
    claude: { name: 'Claude', strengths: '写作', cmd: 'node', parser: 'claude-stream', args: [FAKE, 'claude-stream', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write'] },
    codex: { name: 'Codex', strengths: '代码', cmd: 'node', parser: 'codex-json', args: [FAKE, 'codex-json', 'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-o', '{OUTFILE}', '-'] },
  },
};

describe('中转站 / API 接入', () => {
  let h, srv, root, seen = [], mode = {};
  const KEY = 'sk-relay-secret-123';
  before(async () => {
    h = await startHola({ config: CONFIG, settings: { autoMemory: false }, env: { CODEX_HOME: path.join(__dirname, 'fixtures', 'codex-home') } });
    const port = await freePort();
    root = `http://127.0.0.1:${port}`;
    srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const body = b ? JSON.parse(b) : null;
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        const j = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.headers.authorization !== 'Bearer ' + KEY) return j(401, { error: { message: 'API key is required' } });
        // 像 sub2api 一样：模型列表只在 /v1/models
        if (req.method === 'GET') return req.url === '/v1/models' ? j(200, { data: [{ id: 'gemini-x' }, { id: 'claude-y' }, { id: 'gpt-z' }] }) : j(404, { error: 'not found' });
        if (req.url === '/v1/messages') return j(mode.messagesOk ? 200 : 404, {});
        if (req.url === '/v1/responses') return j(404, {});
        if (mode.chat500) return j(500, { error: { message: 'upstream error' } });
        if (!['claude-y', 'gpt-z', 'gemini-x'].includes(body.model)) return j(404, { error: { message: `Model "${body.model}" is not supported by any configured account in this group` } });
        if (body.reasoning_effort && mode.rejectEffort) return j(400, { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } });
        if (body.tools && body.messages.length === 1 && /ping/.test(JSON.stringify(body.messages))) return j(200, { choices: [{ message: { tool_calls: [{ id: 'p', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: `来自中转站的 ${body.model}` } }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
      });
    }).listen(port, '127.0.0.1');
  });
  after(async () => { srv.close(); await h.stop(); });
  const member = async (id) => (await h.init()).members.find((m) => m.id === id);
  const waitOnline = async (id) => { for (let i = 0; i < 50 && !(await member(id)).online; i++) await new Promise((r) => setTimeout(r, 100)); return member(id); };

  it('读取可用模型：地址没写 /v1 也能读到，并告诉页面该用 /v1；Key 不对时说清楚', async () => {
    const r = await h.post('members/remote-models', { baseUrl: root, apiKey: KEY });
    assert.deepEqual(r.models, ['claude-y', 'gemini-x', 'gpt-z']);
    assert.equal(r.base, root + '/v1');
    const bad = await h.post('members/remote-models', { baseUrl: root, apiKey: 'wrong' });
    assert.match(bad.error, /401/);
  });

  it('内置 Claude 改走中转站：变成 API 队友、用中转站的模型回答；Key 不出现在页面数据里', async () => {
    const r = await h.post('members/save', { member: { id: 'claude', name: 'Claude', via: 'relay', baseUrl: root + '/v1', model: 'claude-y', apiKey: KEY, hands: true, apiEffort: 'high' } });
    assert.equal(r.status, 200, JSON.stringify(r));
    const m = await waitOnline('claude');
    assert.equal(m.type, 'api');
    assert.equal(m.via, 'relay');
    assert.equal(m.model, 'claude-y');
    assert.ok(m.edit.keyHint && !m.edit.keyHint.includes('secret'), '页面上只显示 Key 的开头结尾');
    const init = await h.init();
    assert.ok(!JSON.stringify(init).includes(KEY), 'Key 不能出现在页面数据里');
    assert.ok(!fs.readFileSync(path.join(h.dataDir, 'settings.json'), 'utf8').includes(KEY), 'Key 不放在设置里');
    assert.ok(fs.readFileSync(path.join(h.dataDir, 'relays.json'), 'utf8').includes(KEY));

    // 读取可用模型：Key 留空时用已保存的（地址没换）
    assert.deepEqual((await h.post('members/remote-models', { id: 'claude', baseUrl: root + '/v1' })).models.length, 3);
    // 换了网址就不给已保存的 Key
    assert.match((await h.post('members/remote-models', { id: 'claude', baseUrl: 'http://localhost:1/v1' })).error || '', /./);

    const id = await h.newConv();
    const { added } = await h.ask(id, '@Claude 你好');
    const reply = added.find((x) => x.from === 'claude');
    assert.equal(reply.text, '来自中转站的 claude-y');
    const q = seen.filter((x) => x.url === '/v1/chat/completions').pop();
    assert.equal(q.body.reasoning_effort, 'high', '思考深度传给接口');
    assert.ok(q.body.tools, '中转站的 Claude 也能动手');
    assert.match(q.body.messages[0].content, /通过 API 接入：能读写对话文件夹里的文件/);
  });

  it('接口不认思考深度：去掉再试一次', async () => {
    mode.rejectEffort = true;
    const id = await h.newConv();
    const n = seen.length;
    const { added } = await h.ask(id, '@Claude 再说一句');
    assert.equal(added.find((x) => x.from === 'claude').status, 'done');
    const chats = seen.slice(n).filter((x) => x.url === '/v1/chat/completions');
    assert.equal(chats.length, 2);
    assert.ok(chats[0].body.reasoning_effort && !chats[1].body.reasoning_effort);
    mode.rejectEffort = false;
  });

  it('模型不在 Key 的分组里：提示去"读取可用模型"；连不通时自动试别的格式并写进报错', async () => {
    await h.post('members/save', { member: { id: 'claude', name: 'Claude', via: 'relay', baseUrl: root + '/v1', model: '6.1sol', hands: true } });
    let t = await h.post('members/test', { id: 'claude' });
    assert.equal(t.ok, false);
    assert.match(t.error, /读取可用模型/);
    assert.match(t.error, /not supported by any configured account/);
    mode.chat500 = true; mode.messagesOk = true;
    await h.post('members/save', { member: { id: 'claude', name: 'Claude', via: 'relay', baseUrl: root + '/v1', model: 'claude-y', hands: true } });
    t = await h.post('members/test', { id: 'claude' });
    assert.match(t.error, /诊断：这个模型用 Claude 原生格式/);
    mode.chat500 = false; mode.messagesOk = false;
  });

  it('切回订阅登录：又是命令行队友，提示词和以前一样；中转站资料留着，下次切回来不用重填', async () => {
    await h.post('members/save', { member: { id: 'claude', name: 'Claude', via: 'sub' } });
    const m = await waitOnline('claude');
    assert.equal(m.type, 'cli');
    assert.equal(m.via, 'sub');
    assert.equal(m.relay.baseUrl, root + '/v1', '中转站的地址还记着');
    const id = await h.newConv();
    const { added } = await h.ask(id, '@Claude 你好');
    assert.equal(added.find((x) => x.from === 'claude').text, '在线', '用回命令行');
  });

  it('自己加的 API 队友也能设思考深度；保存并测试会试出能不能动手', async () => {
    const r = await h.post('members/save', { member: { name: 'GPT', type: 'api', baseUrl: root + '/v1', model: 'gpt-z', apiKey: KEY, apiEffort: 'low' } });
    const t = await h.post('members/test', { id: r.id });
    assert.equal(t.ok, true, JSON.stringify(t));
    assert.equal(t.hands, true);
    const m = await member(r.id);
    assert.equal(m.edit.effort, 'low');
    assert.equal(m.edit.toolsOk, true);
  });
});
