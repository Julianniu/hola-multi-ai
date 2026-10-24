// 用保存下来的会议记录重新评审打分（不用重跑模型）：node evals/rejudge.js <结果文件夹> T02[,T10]
// 用在：评审当时没跑成（比如会后执行超时被叫停）、或者评审的打分表改了。
'use strict';
const fs = require('fs');
const path = require('path');
const { judgeDiscussion } = require('./judge');
const { savedMessages, runName, recompute } = require('./metrics');

(async () => {
  const dir = path.resolve(process.argv[2]);
  const ids = String(process.argv[3] || 'T02,T10').split(',');
  const file = path.join(dir, 'results.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const many = (data.meta.gate || data.meta.repeat) > 1;
  for (const r of data.results.filter((x) => ids.includes(x.task))) {
    const msgs = savedMessages(path.join(dir, 'runs', r.dir || runName(r, many)));
    const q = msgs.find((m) => m.from === 'boss');
    const concl = msgs.find((m) => m.reason === 'conclusion' && m.status === 'done');
    if (!q || !concl) { console.log(`${r.task}·${r.rep}：没有结论，跳过`); continue; }
    // 只看到结论为止（结论之后的派活、验收不属于会议）
    const upto = msgs.slice(0, msgs.indexOf(concl));
    const talk = upto.filter((m) => ['initial', 'discuss'].includes(m.reason) && m.status === 'done').map((m) => ({ who: m.from, round: m.round || 0, text: m.text }));
    const j = await judgeDiscussion(q.text.replace(/^开会讨论：/, ''), talk, concl.text);
    r.notes['评审打分'] = j;
    r.notes['讨论轮数'] = Math.max(0, ...upto.filter((m) => m.reason === 'discuss').map((m) => m.round || 0));
    r.notes['达成共识'] = !!concl.consensus;
    r.score = j ? j.avg / 5 : null;
    if (r.error) { r.notes['会后执行超时（结论已写出，按会议本身打分）'] = r.error.split('\n')[0]; r.error = ''; }
    r.checks = [{ name: '写出了团队结论', pass: true, detail: '', soft: false },
      ...(r.task === 'T02' ? [{ name: '评审平均分 ≥ 3.5（满分 5）', pass: !!j && j.avg >= 3.5, detail: j ? `${j.avg} 分；有效发言比 ${j.effectiveRatio}；${j.comment || ''}` : '评审没给出结果', soft: false }] : []),
      ...r.checks.filter((c) => !/结论|评审/.test(c.name))];
    r.status = r.checks.filter((c) => !c.soft).every((c) => c.pass) ? 'pass' : 'fail';
    console.log(`${r.task}·${r.rep}：${j ? j.avg : '—'} 分`);
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  recompute(dir);
})();
