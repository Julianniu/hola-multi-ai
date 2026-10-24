// 把 results.json 写成给人看的 report.md。单独重写报告：node evals/report.js <结果文件夹>
'use strict';
const fs = require('fs');
const path = require('path');

const NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', deepseek: 'DeepSeek', apitest: '假接口' };
const nm = (m) => String(m).split('+').map((x) => NAME[x] || x).join(' + ');
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
const sec = (ms) => (ms ? Math.round(ms / 1000) + ' 秒' : '—');
const k = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : String(Math.round(n || 0)));
const MARK = { pass: '✅', fail: '❌', na: '➖', error: '⚠️', infra: '🔌' };

function writeReport(dir) {
  const { meta, results } = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
  const L = [];
  const when = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
  L.push(`# Hola 评测报告 · ${meta.label || meta.suite}${meta.fake ? '（假队友自测，分数无意义）' : ''}`, '');
  L.push(`- 档位：${meta.suite}；队友：${meta.members.map(nm).join('、')}；每个任务跑 ${meta.repeat} 次${meta.gate > meta.repeat ? `（门槛任务 S10–S13、T02、T03 跑 ${meta.gate} 次）` : ''}；Hola ${meta.version}`);
  L.push(`- 时间：${when(meta.started)} → ${when(meta.ended)}（${Math.round((meta.ended - meta.started) / 60000)} 分钟）；共 ${results.length} 次运行`);
  L.push(`- 程序：${meta.program || ''}；命令行版本：${Object.entries(meta.cli || {}).map(([a, b]) => nm(a) + ' ' + b).join('；') || '—'}`);
  L.push('- 记号：✅ 通过 ❌ 没通过 ⚠️ 运行出错（崩溃 / 超时） 🔌 环境问题（额度、限流、登录、网络，重跑后仍然这样，不计入完成率） ➖ 这次没测到', '');

  // ------------------------------------------------ 每位队友的单人任务
  const single = results.filter((r) => r.kind === 'single');
  const who = [...new Set(single.map((r) => r.member))];
  if (single.length) {
    L.push('## 一、单人任务总览', '');
    L.push('| 队友 | 跑了 | 通过 | 完成率 | 出错 | 平均每题耗时 | 首字时间 | 平均输入 token | 平均输出 token | 平均工具步数 | 工具出错率 | 越权 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const m of who) {
      const models = [...new Set(single.filter((r) => r.member === m).flatMap((r) => (r.metrics || {}).models || []))];
      const rs = single.filter((r) => r.member === m && r.status !== 'na' && r.status !== 'infra');
      const ms = rs.map((r) => r.metrics).filter(Boolean);
      const avg = (f) => (ms.length ? ms.reduce((s, x) => s + (f(x) || 0), 0) / ms.length : 0);
      const tools = ms.reduce((s, x) => s + x.tools, 0);
      const terr = ms.reduce((s, x) => s + x.toolErrors, 0);
      L.push(`| ${nm(m)}${models.length ? '（' + models.join('、') + '）' : ''} | ${rs.length} | ${rs.filter((r) => r.status === 'pass').length} | ${pct(rs.filter((r) => r.status === 'pass').length, rs.length)} | ${rs.filter((r) => r.status === 'error').length} | ${sec(avg((x) => x.turnMs))} | ${sec(avg((x) => x.firstMs))} | ${k(avg((x) => x.input))} | ${k(avg((x) => x.output))} | ${avg((x) => x.tools).toFixed(1)} | ${pct(terr, tools)} | ${rs.reduce((s, r) => s + (r.safety || 0), 0)} |`);
    }
    L.push('', '（耗时只算队友干活的时间；token 不含记忆整理等后台活，后台活另记在 results.json 的 sideInput / sideOutput。）', '');

    L.push('## 二、单人任务逐项', '');
    const ids = [...new Set(single.map((r) => r.task))];
    L.push(`| 任务 | ${who.map(nm).join(' | ')} |`);
    L.push(`| --- | ${who.map(() => '---').join(' | ')} |`);
    for (const id of ids) {
      const title = single.find((r) => r.task === id).title;
      const cells = who.map((m) => {
        const rs = single.filter((r) => r.task === id && r.member === m);
        return rs.length ? rs.map((r) => MARK[r.status]).join('') + (rs[0].metrics ? ` ${sec(rs[0].metrics.turnMs)}` : '') : '—';
      });
      L.push(`| ${id} ${title} | ${cells.join(' | ')} |`);
    }
    L.push('');
  }

  // ------------------------------------------------ 评测工具自己的任务（假接口）
  const harness = results.filter((r) => r.kind === 'harness');
  if (harness.length) {
    L.push('## 三、API 队友的"手脚"（假接口，不花钱）', '');
    for (const r of harness) L.push(`- ${MARK[r.status]} ${r.task} ${r.title}：${Object.entries(r.notes).map(([a, b]) => `${a} ${JSON.stringify(b)}`).join('；')}`);
    L.push('');
  }

  // ------------------------------------------------ 讨论任务
  const team = results.filter((r) => r.kind === 'team');
  if (team.length) {
    L.push('## 四、多 AI 讨论任务', '');
    L.push('| 任务 | 队伍 | 结果 | 轮数 | 共识 | 评审分（满分 5） | 有效发言比 | 总耗时 | 输入 token | 输出 token |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of team) {
      const j = r.notes['评审打分'];
      const m = r.metrics || {};
      L.push(`| ${r.task} ${r.title} | ${nm(r.member)} | ${MARK[r.status]} | ${r.notes['讨论轮数'] ?? '—'} | ${r.notes['达成共识'] == null ? '—' : r.notes['达成共识'] ? '是' : '否'} | ${j ? j.avg : '—'} | ${j && j.effectiveRatio != null ? j.effectiveRatio : '—'} | ${sec(r.ms)} | ${k(m.input)} | ${k(m.output)} |`);
    }
    L.push('');
    // T09：标签遵守率
    const tags = team.flatMap((r) => (r.metrics || {}).tags || []);
    if (tags.length) {
      const miss = tags.filter((t) => t.missing);
      L.push(`**T09 标签遵守**：该写标签的发言 ${tags.length} 条，漏写 ${miss.length} 条（${pct(miss.length, tags.length)}）。` +
        (miss.length ? '漏写的：' + miss.map((t) => `${nm(t.from)} 的${{ initial: '【需要讨论】', discuss: '【立场】', review: '【验收】', conclusion: '【方案】' }[t.reason]}`).join('、') + '。漏写【立场】会被当成"同意"，漏写【验收】会被当成"通过"。' : ''), '');
    }
  }

  // ------------------------------------------------ 没通过的细节
  const bad = results.filter((r) => ['fail', 'error', 'infra'].includes(r.status) || r.checks.some((c) => !c.pass && c.soft));
  if (bad.length) {
    L.push('## 五、没通过的地方（细节）', '');
    for (const r of bad) {
      L.push(`**${r.task} · ${nm(r.member)}${(meta.gate || meta.repeat) > 1 ? ' · 第' + r.rep + '次' : ''}** ${MARK[r.status]}`);
      for (const c of r.checks.filter((x) => !x.pass)) L.push(`- ${c.soft ? '（参考项）' : ''}${c.name}${c.detail ? '：' + String(c.detail).replace(/\n/g, ' ').slice(0, 200) : ''}`);
      if (r.error) L.push('- 运行出错：' + r.error.split('\n')[0].slice(0, 300));
      if (r.infra) L.push('- 环境问题：' + r.infra.split('\n')[0].slice(0, 300));
      const notes = Object.entries(r.notes).filter(([a]) => a !== '评审打分');
      if (notes.length) L.push('- 备注：' + notes.map(([a, b]) => `${a} ${JSON.stringify(b)}`).join('；'));
      L.push('');
    }
  }

  // ------------------------------------------------ 其他记录
  const long = results.filter((r) => r.notes['提示词长度（字）']);
  if (long.length) {
    L.push('## 六、其他记录', '');
    for (const r of long) L.push(`- ${r.task} ${nm(r.member)}：提示词 ${r.notes['提示词长度（字）']} 字`);
    L.push('');
  }
  L.push('每次运行的完整对话（聊天记录、产出文件、Hola 日志）在本文件夹的 runs/ 里。');
  fs.writeFileSync(path.join(dir, 'report.md'), L.join('\n') + '\n');
}

if (require.main === module) writeReport(path.resolve(process.argv[2]));
module.exports = { writeReport };
