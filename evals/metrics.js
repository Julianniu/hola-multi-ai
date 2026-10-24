// 从一次运行的消息里算用量、耗时、工具步数等。跑分时实时算一次；判分规则或统计口径改了以后，
// 也能从 runs/ 里保存的对话重新算：node evals/metrics.js <结果文件夹>（会改写 results.json 和 report.md）
'use strict';
const fs = require('fs');
const path = require('path');

// 命令行自己打印的提醒（比如 Codex 说配置里有一行它不认识），不算工具出错
const NOISE = /ignoring \d+ unrecognized configuration|is ignored\.?$|deprecated/i;

function toolErrorsOf(msg) {
  let seenTool = false, n = 0;
  for (const p of msg.process || []) {
    if (p.k === 'tool') seenTool = true;
    else if (p.k === 'error' && seenTool && !NOISE.test(p.t || '')) n++;
  }
  return n;
}

// 队友这次运行里真正干活的消息：有开始时间的（预先放好的聊天记录没有）
function metricsOf(msgs) {
  const team = msgs.filter((x) => x.from !== 'boss' && x.from !== 'system' && x.startedAt);
  const work = team.filter((x) => !['memory', 'describe', 'skill'].includes(x.reason));
  const sum = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0);
  const u = (list, k) => sum(list, (x) => (x.usage || {})[k]);
  return {
    turns: work.length,
    sideTurns: team.length - work.length,
    errors: work.filter((x) => x.status === 'error').length,
    stopped: work.filter((x) => x.status === 'stopped').length,
    turnMs: sum(work, (x) => (x.endedAt && x.startedAt ? x.endedAt - x.startedAt : 0)),
    // 首字时间：老板多久看到第一个字（边写边显示时是第一个字出现；没有时要等整段写完）
    firstMs: work.length ? Math.round(sum(work, (x) => ((x.firstAt || x.endedAt || x.startedAt) - x.startedAt)) / work.length) : 0,
    input: u(work, 'input'), cached: u(work, 'cached'), output: u(work, 'output'),
    sideInput: u(team, 'input') - u(work, 'input'), sideOutput: u(team, 'output') - u(work, 'output'),
    tools: sum(work, (x) => (x.process || []).filter((p) => p.k === 'tool').length),
    toolErrors: sum(work, toolErrorsOf),
    maxPromptChars: Math.max(0, ...work.map((x) => x.promptChars || 0)),
    tags: work.filter((x) => ['initial', 'discuss', 'review'].includes(x.reason) || (x.reason === 'conclusion' && !x.consensus))
      .map((x) => ({ reason: x.reason, from: x.from, missing: x.tagMissing || null })),
    models: [...new Set(work.map((x) => x.model).filter(Boolean))],
  };
}

// 一次运行保存下来的所有消息（runs/<名字>/workspace/<对话>/.hola/chat.json）
function savedMessages(runDir) {
  const ws = path.join(runDir, 'workspace');
  const out = [];
  try {
    for (const c of fs.readdirSync(ws)) {
      try { out.push(...JSON.parse(fs.readFileSync(path.join(ws, c, '.hola', 'chat.json'), 'utf8')).messages); } catch (_) {}
    }
  } catch (_) {}
  return out;
}
const runName = (r, many) => `${r.task}_${String(r.member).replace(/\+/g, '_')}${many ? '_' + r.rep : ''}`;

function recompute(dir) {
  const file = path.join(dir, 'results.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const many = (data.meta.gate || data.meta.repeat) > 1;
  let n = 0;
  for (const r of data.results) {
    const run = path.join(dir, 'runs', r.dir || runName(r, many));
    const msgs = savedMessages(run);
    if (msgs.length) { r.metrics = metricsOf(msgs); n++; }
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  require('./report').writeReport(dir);
  return n;
}

if (require.main === module) console.log(`重新统计了 ${recompute(path.resolve(process.argv[2]))} 次运行`);
module.exports = { metricsOf, toolErrorsOf, savedMessages, recompute, runName };
