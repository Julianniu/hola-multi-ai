// Wick 第 4 阶段 · Hola 团队工具（最小版 MCP）：命令行队友干活时挂上（开会不挂）；MCP 服务能列工具、凭通行证调用；
// 交活和写 @ 一样，回合结束后才派，还没确认方案就先出开工卡。
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startHola } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli.js');
const CONFIG = {
  workspace: 'workspace', timeoutMinutes: 2,
  members: {
    claude: { name: 'Claude', strengths: '写作', cmd: 'node', parser: 'claude-stream', args: [FAKE, 'claude-stream', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write'] },
    codex: { name: 'Codex', strengths: '代码', cmd: 'node', parser: 'codex-json', args: [FAKE, 'codex-json', 'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-o', '{OUTFILE}', '-'] },
  },
};

// 跟 MCP 服务说几句话（一行一个 JSON）
function mcp(env, msgs) {
  return new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'hola-team-mcp.js')], { env: { ...process.env, ...env } });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('error', reject);
    ch.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    ch.stdin.end(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  });
}

describe('Hola 团队工具', () => {
  const hs = [];
  after(async () => { for (const h of hs) { try { await h.stop(); } catch (_) {} } });

  it('命令行队友：干活的回合挂上团队工具（安全模式白名单也放行），开会的回合不挂', async () => {
    const h = await startHola({ config: CONFIG, settings: { autoMemory: false }, env: { CODEX_HOME: path.join(__dirname, 'fixtures', 'codex-home') } });
    hs.push(h);
    const id = await h.newConv();
    const argsOf = (mode) => JSON.parse(fs.readFileSync(path.join(h.workspace, id, '.hola', `args-${mode}.json`), 'utf8'));
    await h.ask(id, '@Claude 你好');
    const a = argsOf('claude-stream');
    const i = a.indexOf('--mcp-config');
    assert.ok(i > 0 && /team-claude-\d+\.json$/.test(a[i + 1]), '带上团队工具的配置');
    assert.match(a[a.indexOf('--allowedTools') + 1], /mcp__hola-team/);
    assert.ok(!fs.existsSync(path.join(h.workspace, id, a[i + 1])), '运行结束配置文件删掉（里面有通行证）');
    await h.ask(id, '@Codex 你好');
    assert.ok(!argsOf('codex-json').some((x) => /hola_team/.test(x)), 'Codex 安全模式下调 MCP 工具要人批准、后台批不了，不挂');
    await h.post('members/save', { member: { id: 'codex', name: 'Codex', access: 'full' } });
    await h.ask(id, '@Codex 你好');
    const cx = argsOf('codex-json');
    assert.ok(cx.some((x) => /^mcp_servers\.hola_team\.command=/.test(x)), '完全权限时挂上');
    assert.ok(cx.indexOf('exec') > cx.findIndex((x) => /hola_team/.test(x)), '-c 放在 exec 前面');
    await h.ask(id, '@大家 新品怎么推广');
    assert.ok(!argsOf('claude-stream').includes('--mcp-config'), '开会不挂');
  });

  it('MCP 服务：能列出工具；通行证不对就拒绝', async () => {
    const h = await startHola({ settings: { autoMemory: false } });
    hs.push(h);
    const out = await mcp({ HOLA_URL: h.base, HOLA_TEAM_TOKEN: 'nope' }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'board', arguments: {} } },
    ]);
    assert.equal(out[0].result.serverInfo.name, 'hola-team');
    assert.deepEqual(out[1].result.tools.map((t) => t.name), ['board', 'members', 'assign']);
    assert.equal(out[2].result.isError, true);
    assert.match(out[2].result.content[0].text, /通行证无效/);
  });
});
