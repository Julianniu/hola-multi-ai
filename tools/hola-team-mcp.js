// Hola 团队工具服务（MCP，走标准输入输出；wick teamMcp）：Claude、Codex 这些命令行队友干活时能直接
// 看任务板、看队友（能力卡）、把一项活交给某位队友——交活和在回复里写"@名字 + 任务"完全一样：这一回合结束后才派出去，
// 照样要过开工确认、接力次数上限和花费上限。每次运行一张一次性通行证，运行结束就作废。
// 用 Hola 自己（桌面版是 Electron，加 ELECTRON_RUN_AS_NODE=1）或 Node 跑，不依赖任何其他文件。
'use strict';
const HOLA = process.env.HOLA_URL || '';
const TOKEN = process.env.HOLA_TEAM_TOKEN || '';

const obj = (props, required) => ({ type: 'object', properties: props || {}, ...(required ? { required } : {}) });
const TOOLS = [
  { name: 'board', description: '看这个对话的任务板：老板这件事拆成了哪几步、谁在做、做到哪、方案确认了没有。',
    inputSchema: obj() },
  { name: 'members', description: '看这次参与的队友：谁是大脑、谁是帮手、在不在线，以及 Hola 记下的实际表现（能力卡：做过哪类活、验收通过几次、平均用时和花费）。',
    inputSchema: obj() },
  { name: 'assign', description: '把一项活交给某位队友，和在回复里写"@名字 + 任务"一样：你这一回合结束后才派出去，还没确认方案时会先请老板开工。写清楚要做什么、做到什么标准。',
    inputSchema: obj({ member: { type: 'string', description: '队友的名字，比如 Codex' }, task: { type: 'string', description: '要做的事和标准' } }, ['member', 'task']) },
];
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(name, args) {
  try {
    const r = await fetch(HOLA + '/api/team/tool', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hola': '1' },
      body: JSON.stringify({ token: TOKEN, tool: name, args: args || {} }),
    });
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
      return reply(m.id, { protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'hola-team', version: '1.0.0' } });
    }
    case 'ping': return reply(m.id, {});
    case 'tools/list': return reply(m.id, { tools: TOOLS });
    case 'tools/call': {
      const p = m.params || {};
      if (!TOOLS.some((t) => t.name === p.name)) return fail(m.id, -32602, 'unknown tool: ' + p.name);
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
