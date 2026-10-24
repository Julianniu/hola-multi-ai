// 判分规则改了以后，拿保存下来的产出文件重新判分（不用重跑模型）：node evals/recheck.js <结果文件夹> S02,S09,S10,T06
// 只重判任务里 verify() 那部分（只看文件的检查项），其他检查项保持原样。
'use strict';
const fs = require('fs');
const path = require('path');
const { runName, recompute } = require('./metrics');

const dir = path.resolve(process.argv[2]);
const ids = String(process.argv[3] || '').split(',').filter(Boolean);
const TASKS = [...require('./tasks/single'), ...require('./tasks/team')];
const file = path.join(dir, 'results.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const many = (data.meta.gate || data.meta.repeat) > 1;
let n = 0;
for (const r of data.results) {
  const task = TASKS.find((t) => t.id === r.task);
  if (!task || !task.verify || (ids.length && !ids.includes(r.task)) || ['error', 'infra', 'na'].includes(r.status)) continue;
  const ws = path.join(dir, 'runs', r.dir || runName(r, many), 'workspace');
  const conv = fs.existsSync(ws) && fs.readdirSync(ws).find((c) => fs.existsSync(path.join(ws, c, '.hola', 'chat.json')));
  if (!conv) continue;
  const fresh = [];
  // 单人任务：这位队友最后的回答（有的检查只看回答）
  let answer = '';
  try {
    const msgs = JSON.parse(fs.readFileSync(path.join(ws, conv, '.hola', 'chat.json'), 'utf8')).messages;
    const last = msgs.filter((x) => x.from === r.member && x.startedAt && !['memory', 'describe', 'skill'].includes(x.reason)).pop();
    answer = last ? last.text || '' : '';
  } catch (_) {}
  task.verify({ dir: path.join(ws, conv), answer, check: (name, pass, detail, o = {}) => fresh.push({ name, pass: !!pass, detail: detail || '', soft: !!o.soft }), note: (k, v) => { r.notes[k] = v; } });
  const names = new Set(fresh.map((c) => c.name));
  const before = r.status;
  r.checks = [...r.checks.filter((c) => !names.has(c.name) && !/^排品表\.xlsx 至少/.test(c.name)), ...fresh];
  const hard = r.checks.filter((c) => !c.soft);
  r.status = hard.length && hard.every((c) => c.pass) ? 'pass' : 'fail';
  if (before !== r.status) r.notes['重新判分'] = `${before} → ${r.status}`;
  console.log(`${r.task}·${r.member}·${r.rep}：${before} → ${r.status}`);
  n++;
}
fs.writeFileSync(file, JSON.stringify(data, null, 2));
recompute(dir);
console.log(`重新判了 ${n} 次运行`);
