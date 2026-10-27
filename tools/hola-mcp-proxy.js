// Hola 外部工具转接服务（MCP，走标准输入输出）：老板在设置 → 连接里接上的 MCP 服务（钉钉等）由 Hola 自己连，
// Claude、Codex 这些命令行队友干活时通过这个小服务用它们——工具清单和每次调用都转回 Hola，
// 所以会改动外部数据的操作照样先问老板，也记在进度里。每次运行一张一次性通行证，运行结束就作废。
// 用 Hola 自己（桌面版是 Electron，加 ELECTRON_RUN_AS_NODE=1）或 Node 跑，不依赖任何其他文件。
'use strict';
const HOLA = process.env.HOLA_URL || '';
const TOKEN = process.env.HOLA_MCP_TOKEN || '';
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const post = (body) => fetch(HOLA + '/api/mcp/tool', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hola': '1' }, body: JSON.stringify({ token: TOKEN, ...body }) });
let cache = null;
async function listTools() {
  if (cache) return cache;
  try { const r = await post({ list: true }); cache = r.ok ? (await r.json()).tools || [] : []; } catch (_) { cache = []; }
  return cache;
}

async function callTool(name, args) {
  try {
    const r = await post({ tool: name, args: args || {} });
    if (!r.ok) return { content: [{ type: 'text', text: `Hola 后台拒绝了（HTTP ${r.status}）` }], isError: true };
    return await r.json();
  } catch (e) {
    return { content: [{ type: 'text', text: '连不上 Hola：' + (e && e.message || e) }], isError: true };
  }
}

async function handle(m) {
  if (!m || typeof m !== 'object' || m.id === undefined || m.id === null) return;
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion;
      return reply(m.id, { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'hola-mcp', version: '1.0.0' } });
    }
    case 'ping': return reply(m.id, {});
    case 'tools/list': return reply(m.id, { tools: await listTools() });
    case 'tools/call': {
      const p = m.params || {};
      return reply(m.id, await callTool(p.name, p.arguments));
    }
    default: return fail(m.id, -32601, 'method not found: ' + m.method);
  }
}

const pending = new Set();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch (_) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    const p = handle(m).catch((e) => fail(m.id, -32603, String(e && e.message || e)));
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
});
// 输入结束：等还在进行的调用回完话再退出
process.stdin.on('end', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
