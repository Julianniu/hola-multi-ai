// 调用 AI 这一层：三家命令行的输出解析、用量换算、模型 / 思考深度 / 权限开关、API 队友、出错提示
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
    claude: { name: 'Claude', strengths: '写作', cmd: 'node', parser: 'claude-stream',
      args: [FAKE, 'claude-stream', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write'] },
    codex: { name: 'Codex', strengths: '代码', cmd: 'node', parser: 'codex-json',
      args: [FAKE, 'codex-json', 'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-o', '{OUTFILE}', '-'] },
    gemini: { name: 'Gemini', strengths: '检索', cmd: 'node', parser: 'agy-json', readOnly: true,
      args: [FAKE, 'agy-json', '-p', '{PROMPT}', '--output-format', 'json'] },
  },
};

describe('调用 AI', () => {
  let h, id;
  const member = async (mid) => (await h.init()).members.find((m) => m.id === mid);
  const argsOf = (mode) => JSON.parse(fs.readFileSync(path.join(h.workspace, id, '.hola', `args-${mode}.json`), 'utf8'));
  const lastFrom = async (text, from) => { const { added } = await h.ask(id, text); return added.find((m) => m.from === from && m.reason === 'mention'); };

  before(async () => {
    h = await startHola({ config: CONFIG, settings: { autoMemory: false }, env: { CODEX_HOME: path.join(__dirname, 'fixtures', 'codex-home') } });
    id = await h.newConv();
  });
  after(async () => { await h.stop(); });

  it('Claude：读出回复、实际模型，用量把缓存算进输入', async () => {
    const m = await lastFrom('@Claude 你好', 'claude');
    assert.equal(m.status, 'done');
    assert.equal(m.text, '在线');
    assert.equal(m.model, 'claude-sonnet-5-5');
    assert.deepEqual(m.usage, { input: 2 + 11606 + 27545, cached: 27545, output: 4 });
    assert.ok(m.process.some((p) => p.k === 'think'), '思考过程记进后台过程');
  });

  it('Codex：以 -o 文件为准，用量来自 turn.completed，模型取它自己的默认设置', async () => {
    const m = await lastFrom('@Codex 你好', 'codex');
    assert.equal(m.text, '在线（来自 -o 文件）');
    assert.deepEqual(m.usage, { input: 15518, cached: 12032, output: 5 });
    assert.equal(m.model, 'gpt-test-luna');
    assert.equal(m.effort, 'medium');
  });

  it('Gemini（Antigravity）：从 JSON 里读回复和用量', async () => {
    const m = await lastFrom('@Gemini 你好', 'gemini');
    assert.equal(m.text, '在线');
    assert.deepEqual(m.usage, { input: 11713, cached: 0, output: 75 });
    const a = argsOf('agy-json');
    assert.match(a[a.indexOf('-p') + 1], /现在轮到你（Gemini）/, '提示词通过 -p 传进去');
  });

  it('Claude：完全权限 + 选模型 + 思考深度，都写进启动参数', async () => {
    assert.equal((await member('claude')).access, 'safe');
    const r = await h.post('members/save', { member: { id: 'claude', name: 'Claude', access: 'full', cliModel: 'sonnet', cliEffort: 'high' } });
    assert.equal(r.status, 200);
    const m = await member('claude');
    assert.deepEqual([m.access, m.model, m.effort], ['full', 'sonnet', 'high']);
    const msg = await lastFrom('@Claude 你好', 'claude');
    const a = argsOf('claude-stream');
    assert.ok(a.includes('--dangerously-skip-permissions'));
    assert.ok(!a.includes('--permission-mode') && !a.includes('--allowedTools'), '安全模式的参数要去掉');
    assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
    assert.equal(a[a.indexOf('--effort') + 1], 'high');
    assert.equal(a.filter((x) => x === '--model').length, 1, '不能重复');
    assert.equal(msg.effort, 'high');
  });

  it('Codex：参数插在 exec 后面，完全权限去掉沙盒', async () => {
    await h.post('members/save', { member: { id: 'codex', name: 'Codex', access: 'full', cliModel: 'gpt-test-sol', cliEffort: 'ultra' } });
    await lastFrom('@Codex 你好', 'codex');
    const a = argsOf('codex-json');
    assert.equal(a[0], 'exec');
    assert.ok(a.indexOf('-m') > 0 && a[a.indexOf('-m') + 1] === 'gpt-test-sol');
    assert.ok(a.includes('model_reasoning_effort=ultra'));
    assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox') && !a.includes('--sandbox'));
    // 改回默认：模型和思考深度的参数都要拿掉
    await h.post('members/save', { member: { id: 'codex', name: 'Codex', access: 'safe', cliModel: '', cliEffort: '' } });
    await lastFrom('@Codex 你好', 'codex');
    const b = argsOf('codex-json');
    assert.ok(!b.includes('-m') && !b.some((x) => /model_reasoning_effort/.test(x)));
    assert.equal(b[b.indexOf('--sandbox') + 1], 'workspace-write');
  });

  it('Gemini：完全权限才能写文件，关掉后变回只读', async () => {
    await h.post('members/save', { member: { id: 'gemini', name: 'Gemini', access: 'full' } });
    assert.equal((await member('gemini')).readOnly, false);
    await lastFrom('@Gemini 你好', 'gemini');
    assert.ok(argsOf('agy-json').includes('--dangerously-skip-permissions'));
    await h.post('members/save', { member: { id: 'gemini', name: 'Gemini', access: 'safe' } });
    assert.equal((await member('gemini')).readOnly, true);
  });

  it('不安全的模型名、不认识的思考深度都要拒绝（模型名会拼进命令行）', async () => {
    for (const bad of ['a&calc', 'x"y', 'a b', 'm|n']) {
      assert.equal((await h.post('members/save', { member: { id: 'claude', name: 'Claude', cliModel: bad } })).status, 400, bad);
    }
    assert.equal((await h.post('members/save', { member: { id: 'claude', name: 'Claude', cliEffort: 'turbo' } })).status, 400);
  });

  it('模型下拉：Claude 用别名；Codex 只列可见的模型，思考深度按模型给', async () => {
    const c = await h.post('models', { id: 'claude' });
    assert.deepEqual(c.choices.map((x) => x.id), ['fable', 'opus', 'sonnet']);
    const x = await h.post('models', { id: 'codex' });
    assert.deepEqual(x.choices.map((m) => m.id), ['gpt-test-sol', 'gpt-test-luna']);
    assert.equal(x.defaultHint, 'gpt-test-luna');
    assert.ok(x.efforts['gpt-test-sol'].includes('ultra') && !x.efforts['gpt-test-luna'].includes('ultra'));
    assert.deepEqual(x.efforts[''], x.efforts['gpt-test-luna'], '"默认"用的是 config.toml 里那个模型的档位');
  });

  it('自己加的命令行队友出错：显示报错原文，并提示登录 / 额度问题', async () => {
    const r = await h.post('members/save', { member: { name: 'Broken', type: 'cli', cmd: 'node', argsText: `"${FAKE}" fail`, parser: 'plain', strengths: 'x' } });
    assert.equal(r.status, 200);
    for (let i = 0; i < 50 && !(await member(r.id)).online; i++) await new Promise((ok) => setTimeout(ok, 100));
    const m = await lastFrom('@Broken 你好', r.id);
    assert.equal(m.status, 'error');
    assert.match(m.text, /not logged in/);
    assert.match(m.text, /登录过期/);
    await h.post('members/delete', { id: r.id });
  });

  describe('API 队友（OpenAI 兼容）', () => {
    let api, reqs = [], rejectOptions = false;
    before(async () => {
      const port = await freePort();
      api = http.createServer((req, res) => {
        let b = '';
        req.on('data', (d) => { b += d; });
        req.on('end', () => {
          const body = JSON.parse(b);
          reqs.push({ url: req.url, auth: req.headers.authorization, body });
          if (rejectOptions && body.stream_options) { res.writeHead(400); return res.end('{"error":{"message":"Unrecognized request argument: stream_options"}}'); }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
          send({ choices: [{ delta: { reasoning_content: '想想' } }] });
          send({ choices: [{ delta: { content: '你' } }], usage: null });
          send({ choices: [{ delta: { content: '好' } }] });
          if (body.stream_options) send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 } } });
          res.end('data: [DONE]\n\n');
        });
      }).listen(port, '127.0.0.1');
      const r = await h.post('members/save', { member: { name: 'DS', type: 'api', baseUrl: `http://127.0.0.1:${port}/v1/`, model: 'ds-test', apiKey: 'sk-test', strengths: '写作' } });
      assert.equal(r.status, 200);
      api.memberId = r.id;
    });
    after(() => api.close());

    it('流式回复拼起来，用量和模型都记下，Key 放在请求头里', async () => {
      const m = await lastFrom('@DS 你好', api.memberId);
      assert.equal(m.text, '你好');
      assert.equal(m.model, 'ds-test');
      assert.deepEqual(m.usage, { input: 100, cached: 20, output: 7 });
      const q = reqs[reqs.length - 1];
      assert.equal(q.url, '/v1/chat/completions');
      assert.equal(q.auth, 'Bearer sk-test');
      assert.equal(q.body.model, 'ds-test');
      assert.match(q.body.messages[0].content, /现在轮到你（DS）/);
    });

    it('服务商不认 stream_options 时，自动去掉再试一次', async () => {
      rejectOptions = true;
      const n = reqs.length;
      const m = await lastFrom('@DS 你好', api.memberId);
      assert.equal(m.status, 'done');
      assert.equal(m.text, '你好');
      assert.equal(reqs.length - n, 2);
      assert.ok(!reqs[reqs.length - 1].body.stream_options);
      rejectOptions = false;
    });

    it('API 队友的 Key 不会出现在页面数据里', async () => {
      const m = await member(api.memberId);
      assert.ok(!JSON.stringify(m).includes('sk-test'));
      assert.equal(m.edit.keyHint, '已填写');
    });
  });
});
