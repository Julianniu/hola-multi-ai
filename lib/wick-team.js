// Wick · Hola 团队工具（wick teamMcp，第 4 阶段的"Hola MCP"最小版）：干活的队友能看任务板、看队友、交活。
// 命令行队友（Claude / Codex）通过 tools/hola-team-mcp.js 调用，API 队友在 Hola 里直接调用（tools.js）。
// 这里只管通行证和怎么把工具服务挂到命令行上；工具具体做什么由 engine 注册（setTeamHandler），
// 交活和写"@名字"走同一条路：开工确认、接力上限、花费上限都照旧管着。Gemini（agy）还没接 MCP。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PORT, ROOT, wick } = require('./core');
const { convDir } = require('./convs');

const passes = new Map(); // token → { conv, member, msg }
let handler = null;
function setTeamHandler(fn) { handler = fn; }
function issueTeamPass(c, m, msg) { const token = crypto.randomBytes(24).toString('hex'); passes.set(token, { conv: c.id, member: m.id, msg: msg.id }); return token; }
function revokeTeamPass(token) { passes.delete(token); }
function revokeTeamConv(convId) { for (const [t, p] of passes) if (p.conv === convId) passes.delete(t); }

// MCP 调用（命令行队友）：凭通行证找到是哪个对话、哪位队友、哪条消息
async function callTeamTool(token, tool, args) {
  const p = passes.get(token);
  const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  if (!p || !handler) return text('通行证无效或已过期（这一回合已经结束）。', true);
  try { return text(await handler(p, tool, args || {})); } catch (e) { return text(String(e.message || e), true); }
}
// API 队友在 Hola 里直接调用（不用通行证）
async function callTeamDirect(c, m, msg, tool, args) {
  if (!handler) return '团队工具还没准备好。';
  return handler({ conv: c.id, member: m.id, msg: msg.id }, tool, args || {});
}

// 给 Claude / Codex 的命令行挂上团队工具。返回新的参数、环境变量和运行结束时的 done()
const TIMEOUT_SEC = 60;
function withTeam(c, m, msg, args, work) {
  if (!wick('teamMcp') || !work || !['claude-stream', 'codex-json'].includes(m.parser)) return null;
  const exe = process.execPath, script = path.join(ROOT, 'tools', 'hola-team-mcp.js');
  const url = `http://127.0.0.1:${PORT}`;
  const token = issueTeamPass(c, m, msg);
  if (m.parser === 'codex-json') {
    // Codex 安全模式下调用 MCP 工具要人批准，后台运行（exec）批不了，挂上也用不了还拖慢启动：只在完全权限时挂（实测 2026-10-24）
    if (!args.includes('--dangerously-bypass-approvals-and-sandbox') || [exe, script].some((p) => p.includes("'"))) { revokeTeamPass(token); return null; }
    const k = 'mcp_servers.hola_team.';
    const cfg = ['-c', `${k}command='${exe}'`, '-c', `${k}args=['${script}']`, '-c', `${k}env={ELECTRON_RUN_AS_NODE='1',HOLA_URL='${url}',HOLA_TEAM_TOKEN='${token}'}`,
      '-c', `${k}startup_timeout_sec=30`, '-c', `${k}tool_timeout_sec=${TIMEOUT_SEC}`];
    // -c 要放在子命令 exec 前面（codex -c … exec …）
    const at = args.indexOf('exec');
    return {
      args: at >= 0 ? [...args.slice(0, at), ...cfg, ...args.slice(at)] : [...cfg, ...args],
      env: {},
      done() { revokeTeamPass(token); },
    };
  }
  const file = path.join(convDir(c), '.hola', `team-${m.id}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'hola-team': { command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: '1', HOLA_URL: url, HOLA_TEAM_TOKEN: token } } } }));
  const out = [...args];
  const i = out.findIndex((x) => x === '--allowedTools' || x === '--allowed-tools');
  if (i >= 0 && out[i + 1] && !/mcp__hola-team/.test(out[i + 1])) out[i + 1] += ',mcp__hola-team';
  const rel = path.relative(convDir(c), file);
  // --mcp-config 后面能跟好几个文件：浏览器那个已经在最后了就接在它后面，否则新加一个
  if (out[out.length - 2] === '--mcp-config') out.push(rel);
  else out.push('--mcp-config', rel);
  return { args: out, env: {}, done() { revokeTeamPass(token); try { fs.unlinkSync(file); } catch (_) {} } };
}

module.exports = { setTeamHandler, issueTeamPass, revokeTeamPass, revokeTeamConv, callTeamTool, callTeamDirect, withTeam };
