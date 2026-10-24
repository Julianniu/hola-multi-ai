// 两次跑分逐题对比（A = 之前，B = 之后）：node evals/compare.js <A 结果文件夹> <B 结果文件夹>
// 只比两边都跑过的"任务 × 队友"；同一题跑了几次就取平均。结果打印出来，并写进 B 文件夹的 compare.md。
'use strict';
const fs = require('fs');
const path = require('path');

const load = (d) => JSON.parse(fs.readFileSync(path.join(path.resolve(d), 'results.json'), 'utf8'));
const NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', deepseek: 'DeepSeek' };
const nm = (m) => String(m).split('+').map((x) => NAME[x] || x).join(' + ');

function group(data) {
  const g = new Map();
  for (const r of data.results) {
    if (['infra', 'na'].includes(r.status)) continue;
    const k = r.task + '|' + r.member;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const out = new Map();
  for (const [k, rs] of g) {
    const ms = rs.map((r) => r.metrics || {});
    const avg = (f) => ms.reduce((s, x) => s + (f(x) || 0), 0) / ms.length;
    out.set(k, { task: rs[0].task, title: rs[0].title, member: rs[0].member, n: rs.length,
      pass: rs.filter((r) => r.status === 'pass').length, sec: avg((x) => x.turnMs) / 1000, first: avg((x) => x.firstMs) / 1000, input: avg((x) => x.input), tools: avg((x) => x.tools), toolErrors: avg((x) => x.toolErrors) });
  }
  return out;
}

const fmtK = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : String(Math.round(n)));
const change = (a, b, f = (x) => Math.round(x)) => {
  if (!a && !b) return '0';
  const p = a ? Math.round(((b - a) / a) * 100) : null;
  return `${f(a)} → ${f(b)}${p == null ? '' : `（${p > 0 ? '+' : ''}${p}%）`}`;
};

const [A, B] = process.argv.slice(2);
const a = group(load(A));
const b = group(load(B));
const keys = [...b.keys()].filter((k) => a.has(k));
const L = [`# 逐题对比`, '', `- 之前：${path.basename(path.resolve(A))}`, `- 之后：${path.basename(path.resolve(B))}`, '',
  '| 任务 | 队友 | 通过 | 耗时（秒） | 首字（秒） | 输入 token | 工具步数 | 工具出错 |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
const tot = { a: { sec: 0, input: 0, tools: 0, err: 0, pass: 0, n: 0 }, b: { sec: 0, input: 0, tools: 0, err: 0, pass: 0, n: 0 } };
for (const k of keys.sort()) {
  const x = a.get(k), y = b.get(k);
  L.push(`| ${y.task} ${y.title} | ${nm(y.member)} | ${x.pass}/${x.n} → ${y.pass}/${y.n} | ${change(x.sec, y.sec)} | ${change(x.first, y.first)} | ${change(x.input, y.input, fmtK)} | ${change(x.tools, y.tools, (v) => v.toFixed(1))} | ${change(x.toolErrors, y.toolErrors, (v) => v.toFixed(1))} |`);
  for (const [t, v] of [[tot.a, x], [tot.b, y]]) { t.sec += v.sec; t.input += v.input; t.tools += v.tools; t.err += v.toolErrors; t.pass += v.pass / v.n; t.n++; }
}
L.push('', `**合计（${keys.length} 组）**：通过 ${tot.a.pass.toFixed(1)} → ${tot.b.pass.toFixed(1)}；耗时 ${change(tot.a.sec, tot.b.sec)} 秒；输入 token ${change(tot.a.input, tot.b.input, fmtK)}；工具步数 ${change(tot.a.tools, tot.b.tools)}；工具出错 ${change(tot.a.err, tot.b.err)}`);
L.push('', '（模型每次表现有随机性，单次运行的差别要谨慎看待；同一天先后跑两边最可比。）');
const text = L.join('\n') + '\n';
fs.writeFileSync(path.join(path.resolve(B), 'compare.md'), text);
console.log(text);
