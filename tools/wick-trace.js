#!/usr/bin/env node
// 回放 Wick 的步骤日志：node tools/wick-trace.js <对话文件夹> [消息id] [--full]
// 不给消息 id：列出这个对话里每一轮的概要（谁、多久、用量、发给了哪家）；给了：按时间顺序列出这一轮的每一步。
// --full：连完整提示词、工具结果一起打出来。
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const full = args.includes('--full');
const [dir, id] = args.filter((a) => a !== '--full');
if (!dir) { console.log('用法：node tools/wick-trace.js <对话文件夹> [消息id] [--full]'); process.exit(1); }
const tdir = path.join(dir, '.hola', 'trace');
const read = (f) => fs.readFileSync(path.join(tdir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const s = (ms) => (ms / 1000).toFixed(1) + 's';
const cut = (x, n) => { x = typeof x === 'string' ? x : JSON.stringify(x); return full || x.length <= n ? x : x.slice(0, n) + '…'; };

let files = [];
try { files = fs.readdirSync(tdir).filter((f) => f.endsWith('.jsonl')); } catch (_) { console.log('这个对话没有步骤日志：' + tdir); process.exit(1); }

if (!id) {
  const seq = (f) => Number((f.match(/m-(\d+)/) || [])[1]) || 0;
  for (const f of files.sort((a, b) => seq(a) - seq(b))) {
    const ev = read(f);
    const st = ev.find((e) => e.k === 'start') || {};
    const end = ev.find((e) => e.k === 'end') || {};
    const u = end.usage || {};
    const tools = ev.filter((e) => e.k === 'tool' || (e.k === 'step' && e.kind === 'tool')).length;
    console.log(`${f.replace('.jsonl', '').padEnd(6)} ${String(st.name || '').padEnd(10)} ${String(st.reason || '').padEnd(10)} ${end.ms ? s(end.ms) : '（没结束）'}  输入 ${u.input || 0} / 缓存 ${u.cached || 0} / 输出 ${u.output || 0}  工具 ${tools} 步  ${st.resumed ? '续接' : '新开'}  → ${st.provider || ''}`);
  }
  process.exit(0);
}

const f = files.find((x) => x === `${id}.jsonl`);
if (!f) { console.log('没有这条消息的日志：' + id); process.exit(1); }
for (const e of read(f)) {
  const t = s(e.t).padStart(7);
  if (e.k === 'start') console.log(`${t}  开始  ${e.name}（${e.reason}）模型 ${e.model || '默认'} → 发给 ${e.provider}；${e.resumed ? '续接会话' : '新会话'}；提示词 ${e.promptChars} 字${e.images && e.images.length ? '；图片 ' + e.images.join('、') : ''}\n${cut(e.prompt || '', 600).replace(/^/gm, '           │ ')}`);
  else if (e.k === 'cli') console.log(`${t}  启动  ${e.cmd} ${cut(e.args.join(' '), 300)}（提示词走 ${e.promptVia}）`);
  else if (e.k === 'request') console.log(`${t}  请求  第 ${e.step + 1} 步：${e.messages} 条消息、${e.chars} 字、${e.tools} 个工具${e.toolChoice ? '、不许再用工具' : ''}`);
  else if (e.k === 'response') console.log(`${t}  回复  HTTP ${e.status}；用量 ${JSON.stringify(e.usage || {})}${e.toolCalls.length ? '；要调用 ' + e.toolCalls.map((x) => x.name).join('、') : ''}${e.text ? '\n           │ ' + cut(e.text, 300) : ''}${e.err ? '\n           │ 出错：' + cut(e.err, 300) : ''}`);
  else if (e.k === 'tool') console.log(`${t}  工具  ${e.name} ${cut(e.args, 200)}\n           │ ${cut(e.result, 400).replace(/\n/g, '\n           │ ')}`);
  else if (e.k === 'step') console.log(`${t}  ${({ tool: '步骤', result: '结果', error: '出错', think: '思考', log: '日志' })[e.kind] || e.kind}  ${cut(e.text, 300).replace(/\n/g, ' ')}`);
  else if (e.k === 'end') console.log(`${t}  结束  ${e.status}，用时 ${e.ms ? s(e.ms) : '?'}，用量 ${JSON.stringify(e.usage || {})}${e.firstAt != null ? '，第一个字 ' + s(e.firstAt) : ''}\n${cut(e.text || '', 600).replace(/^/gm, '           │ ')}`);
}
