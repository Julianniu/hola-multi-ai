#!/usr/bin/env node
// 模拟三家命令行的输出格式（照真实输出的结构写的，去掉了个人信息），用来测：解析、用量、模型、权限参数。
// 用法：node fake-cli.js <claude-stream | codex-json | agy-json | fail> [这家命令行平时收到的参数…]
'use strict';
const fs = require('fs');
const mode = process.argv[2];
const args = process.argv.slice(3);
if (args[0] === '--version') { console.log('fake-cli 1.0.0'); process.exit(0); }
// 记下收到的参数，测试拿来核对模型、思考深度、权限有没有传对
try { fs.mkdirSync('.hola', { recursive: true }); fs.writeFileSync(`.hola/args-${mode}.json`, JSON.stringify(args)); } catch (_) {}

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => { useMcp().then(run, run); });
process.stdin.resume();

// 提示词里有"用外部工具"、参数里挂了 Hola 的外部工具转接服务时：像真的命令行一样启动它，列工具、调用两次，结果记到 .hola/mcp-result.json
function useMcp() {
  const prompt = input || (args.includes('-p') ? args[args.indexOf('-p') + 1] : '');
  if (!prompt.includes('用外部工具')) return Promise.resolve();
  const files = args.filter((a) => /mcp-[a-z]+-\d+\.json$/.test(a));
  if (!files.length) return Promise.resolve();
  const cfg = JSON.parse(fs.readFileSync(files[0], 'utf8')).mcpServers['hola-mcp'];
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const ch = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env } });
    let o = '';
    ch.stdout.on('data', (d) => { o += d; });
    const msgs = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }];
    const lines = () => o.trim().split('\n').filter(Boolean);
    ch.stdin.write(msgs.map((m) => JSON.stringify(m) + '\n').join(''));
    const wait = (n) => new Promise((r) => { const t = setInterval(() => { if (lines().length >= n) { clearInterval(t); r(); } }, 50); });
    wait(2).then(() => {
      const tools = JSON.parse(lines()[1]).result.tools.map((t) => t.name);
      const call = (id, name, a) => ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: a } }) + '\n');
      call(3, tools.find((t) => t.endsWith('__list_users')), {});
      call(4, tools.find((t) => t.endsWith('__send_message')), { text: '你好' });
      return wait(4).then(() => {
        fs.writeFileSync('.hola/mcp-result.json', JSON.stringify({ tools, replies: lines().slice(2).map((l) => JSON.parse(l)) }));
        ch.stdin.end();
        resolve();
      });
    });
  });
}

function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
// 被请去"看图写说明"时，回一段像样的描述（提示词可能从标准输入来，也可能在 -p 参数里）
const DESCRIBE = '画面：一张测试图片，中间是三个彩色圆圈，图上没有文字，深蓝色背景。';
// Antigravity 的标准输入模式：一行 {"event":"user","message":{"content":"…"}}（照 2026-10-23 实测的 agy 1.4.6 写的）
const agyStream = mode === 'agy-json' && args.includes('--input-format');
function run() {
  let prompt = input || (args.includes('-p') ? args[args.indexOf('-p') + 1] : '');
  if (agyStream) {
    try { prompt = JSON.parse(input.split(/\n/)[0]).message.content; } catch (_) { prompt = ''; }
    fs.writeFileSync('.hola/agy-stdin.txt', prompt);
  }
  try { fs.writeFileSync(`.hola/prompt-${mode}.txt`, prompt); fs.appendFileSync('.hola/prompts-seen.log', `<<<<<${mode}\n${prompt}\n`); } catch (_) {}
  // 测"续接失败"：有 .hola/fail-resume 时，带 --resume 的启动直接报错（像会话丢了一样）
  if (args.includes('--resume') && fs.existsSync('.hola/fail-resume')) { process.stderr.write('No conversation found with session ID\n'); process.exit(1); }
  const describing = prompt.includes('看不到图片的队友');
  if (describing) fs.appendFileSync('.hola/described.log', mode + '\n');
  if (mode === 'claude-stream') {
    const after = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : '');
    const sid = after('--session-id') || after('--resume') || 's0';
    out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', session_id: sid, tools: ['Read', 'Write'] });
    // --include-partial-messages：一小段一小段的字（照 2026-10-23 实测的格式）
    if (args.includes('--include-partial-messages')) {
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null, session_id: sid });
      for (const piece of ['在', '线']) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, parent_tool_use_id: null, session_id: sid });
    }
    // 先说一段、再调用工具（"中间的分析"），最后才给答案
    if (prompt.includes('先看看再回答')) {
      out({ type: 'assistant', message: { content: [{ type: 'text', text: '我先看一下附件里的价格表。' }, { type: 'tool_use', name: 'Read', input: { file_path: '附件/价格表.csv' } }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', content: '商品,价格' }] } });
    }
    out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '先想一想' }, { type: 'text', text: describing ? DESCRIBE : '在线' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: describing ? DESCRIBE : '在线',
      usage: { input_tokens: 2, cache_creation_input_tokens: 11606, cache_read_input_tokens: 27545, output_tokens: 4 } });
  } else if (mode === 'codex-json') {
    out({ type: 'thread.started', thread_id: 't1' });
    out({ type: 'turn.started' });
    out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '在线' } });
    out({ type: 'turn.completed', usage: { input_tokens: 15518, cached_input_tokens: 12032, output_tokens: 5, reasoning_output_tokens: 0 } });
    const o = args.indexOf('-o');
    if (o >= 0) fs.writeFileSync(args[o + 1], describing ? DESCRIBE : '在线（来自 -o 文件）');
  } else if (agyStream) {
    const cid = 'c1';
    const text = describing ? DESCRIBE : '在线\n';
    const usage = { input_tokens: 11713, output_tokens: 75, thinking_tokens: 74, cache_read_tokens: 1000, total_tokens: 11788 };
    out({ event: 'init', conversation_id: cid, init: { cwd: process.cwd(), tools: ['view_file', 'write_to_file'], permission_mode: 'request-review' } });
    out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 0, state: 'DONE', step_type: 'user_input' } });
    out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'DONE', step_type: 'view_file' } });
    out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: text.slice(0, 1) } });
    out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: text.slice(1), usage } });
    out({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: text, duration_seconds: 2.9, num_turns: 1, usage } });
  } else if (mode === 'agy-json') {
    out({ conversation_id: 'c1', status: 'SUCCESS', response: describing ? DESCRIBE : '在线\n', duration_seconds: 2.9, num_turns: 1,
      usage: { input_tokens: 11713, output_tokens: 75, thinking_tokens: 74, cache_read_tokens: 1000 } });
  } else {
    process.stderr.write('Error: not logged in\n');
    process.exit(1);
  }
}
