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
process.stdin.on('end', run);
process.stdin.resume();

function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
// 被请去"看图写说明"时，回一段像样的描述（提示词可能从标准输入来，也可能在 -p 参数里）
const DESCRIBE = '画面：一张测试图片，中间是三个彩色圆圈，图上没有文字，深蓝色背景。';
function run() {
  const prompt = input || (args.includes('-p') ? args[args.indexOf('-p') + 1] : '');
  const describing = prompt.includes('看不到图片的队友');
  if (describing) fs.appendFileSync('.hola/described.log', mode + '\n');
  if (mode === 'claude-stream') {
    out({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: ['Read', 'Write'] });
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
  } else if (mode === 'agy-json') {
    out({ conversation_id: 'c1', status: 'SUCCESS', response: describing ? DESCRIBE : '在线\n', duration_seconds: 2.9, num_turns: 1,
      usage: { input_tokens: 11713, output_tokens: 75, thinking_tokens: 74, cache_read_tokens: 0 } });
  } else {
    process.stderr.write('Error: not logged in\n');
    process.exit(1);
  }
}
