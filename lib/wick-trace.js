// Wick · 步骤日志：每位队友每一轮，一份完整的流水账（wick trace），出了问题能回放：
// 收到了什么提示词、每一步做了什么、调了什么工具、得到什么结果、用了多少 token、花了多久，
// 以及把哪些内容发给了哪一家（数据去向）。
// 写在对话文件夹的 .hola/trace/<消息id>.jsonl（一行一个事件），对话删了它也跟着删；每个对话最多留最近 300 份。
// 看的时候：node tools/wick-trace.js <对话文件夹> [消息id]
'use strict';
const fs = require('fs');
const path = require('path');
const { wick } = require('./core');
const { convDir, setProcHook } = require('./convs');

const KEEP = 300;
const dirOf = (c) => path.join(convDir(c), '.hola', 'trace');
const fileOf = (c, msg) => path.join(dirOf(c), `${msg.id}.jsonl`);
const started = new WeakMap(); // msg → 开始时间

function trace(c, msg, k, data) {
  if (!c || !msg || !wick('trace')) return;
  const t0 = started.get(msg);
  if (t0 == null) return;
  try { fs.appendFileSync(fileOf(c, msg), JSON.stringify({ t: Date.now() - t0, k, ...data }) + '\n'); } catch (_) {}
}

// 一轮开始：谁、用什么、发给哪一家、完整提示词
function traceStart(c, msg, m, info = {}) {
  if (!c || !msg || !wick('trace')) return;
  started.set(msg, Date.now());
  try {
    fs.mkdirSync(dirOf(c), { recursive: true });
    fs.writeFileSync(fileOf(c, msg), '');
    prune(c);
  } catch (_) {}
  trace(c, msg, 'start', { at: new Date().toISOString(), member: m.id, name: m.name, type: m.type, reason: msg.reason, model: m.model || (m.api || {}).model || '', provider: providerOf(m), ...info });
}
function traceEnd(c, msg, data = {}) {
  trace(c, msg, 'end', { status: msg.status, usage: msg.usage || null, firstAt: msg.firstAt ? msg.firstAt - msg.startedAt : null, ...data });
  started.delete(msg);
}

// 数据发到了哪里：API 队友是接口地址的域名；命令行队友是它背后的厂商
function providerOf(m) {
  if (m.type === 'api') { try { return new URL((m.api || {}).baseUrl).host; } catch (_) { return (m.api || {}).baseUrl || 'api'; } }
  return { 'claude-stream': 'Anthropic（Claude Code）', 'codex-json': 'OpenAI（Codex）', 'agy-json': 'Google（Antigravity）' }[m.parser] || m.cmd || 'cli';
}

function prune(c) {
  let list = [];
  try { list = fs.readdirSync(dirOf(c)).filter((f) => f.endsWith('.jsonl')); } catch (_) { return; }
  if (list.length <= KEEP) return;
  const byAge = list.map((f) => ({ f, at: fs.statSync(path.join(dirOf(c), f)).mtimeMs })).sort((a, b) => a.at - b.at);
  for (const { f } of byAge.slice(0, list.length - KEEP)) { try { fs.unlinkSync(path.join(dirOf(c), f)); } catch (_) {} }
}

// 后台过程里的每一步（读文件、运行命令、工具结果、出错……）也记一份
setProcHook((c, msg, item) => trace(c, msg, 'step', { kind: item.k, text: item.t }));

module.exports = { trace, traceStart, traceEnd, providerOf };
