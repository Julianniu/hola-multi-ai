// 文档好不好看：两份文件各渲染成图片，请一个独立的模型（Claude 命令行，只允许读这些图片）盲比。
// 只说"文件甲 / 文件乙"，不说谁做的；同一对比两次、左右对调，两次都选同一份才算赢，否则算平。
// 用法：node evals/doc-judge.js <文件A> <文件B> [最多几页] [任务说明]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { render } = require('./render');

const DIMS = { hierarchy: '层次（标题、重点一眼看出来）', readability: '易读（字号、行距、留白、不拥挤不溢出）', consistency: '统一（配色、字体、对齐前后一致）', polish: '精致（像专业人士做的，不是默认模板）' };

function ask(prompt, dir, timeoutMs = 6 * 60000) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--allowedTools', 'Read', '--add-dir', dir,
      '--disallowedTools', 'Bash,Edit,Write,Glob,Grep,WebSearch,WebFetch,NotebookEdit,Task,TodoWrite'];
    const child = spawn('claude', args, { cwd: dir, env, shell: process.platform === 'win32', windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      let text = out;
      try { text = JSON.parse(out).result || out; } catch (_) {}
      const m = String(text).match(/\{[\s\S]*\}/);
      try { resolve(m ? JSON.parse(m[0]) : null); } catch (_) { resolve(null); }
    });
    child.stdin.end(prompt, 'utf8');
  });
}

function promptFor(task, first, second) {
  const list = (tag, pages) => pages.map((p) => `- ${p}`).join('\n');
  return `你是一位严格的文档版式设计评审。下面有两份文件（${first.kind}），每份已经把前几页渲染成图片。请用 Read 工具逐张打开图片看清楚，再比较。

${task ? `【这份文件的用途】${task}\n\n` : ''}【文件甲的页面】
${list('甲', first.pages)}

【文件乙的页面】
${list('乙', second.pages)}

只比较"排版和视觉设计"，不比较内容写得好不好、数字对不对、页数多少：
${Object.entries(DIMS).map(([k, v]) => `- ${k}：${v}`).join('\n')}

只输出一个 JSON，不要别的文字：
{"winner": "甲" 或 "乙" 或 "平", "margin": 1～3（1 略好，3 明显好很多）, "dims": {${Object.keys(DIMS).map((k) => `"${k}": "甲/乙/平"`).join(', ')}}, "why": "一两句话说最关键的差别", "flaws_甲": ["甲最明显的版式毛病"], "flaws_乙": ["乙最明显的版式毛病"]}`;
}

// 渲染两份文件，比两次（对调），合并结论：winner = 'A' | 'B' | 'tie'
async function compareDocs(fileA, fileB, { maxPages = 5, task = '', workDir } = {}) {
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'hola-docjudge-'));
  const kind = path.extname(fileA).slice(1).toLowerCase();
  const pages = {};
  for (const [k, f] of [['A', fileA], ['B', fileB]]) {
    const out = path.join(dir, 'raw-' + k);
    fs.rmSync(out, { recursive: true, force: true });
    const r = render(f, out, maxPages);
    // 换成不带来源信息的名字：x1-p01.png / x2-p01.png
    pages[k] = r.pages.map((p, i) => { const to = path.join(dir, `${k === 'A' ? 'x1' : 'x2'}-p${String(i + 1).padStart(2, '0')}.png`); fs.copyFileSync(p, to); return to; });
  }
  const runs = [];
  for (const order of [['A', 'B'], ['B', 'A']]) {
    const v = await ask(promptFor(task, { kind, pages: pages[order[0]] }, { kind, pages: pages[order[1]] }), dir);
    const map = (w) => (w === '甲' ? order[0] : w === '乙' ? order[1] : 'tie');
    runs.push(v ? { winner: map(v.winner), margin: Number(v.margin) || 1, dims: Object.fromEntries(Object.entries(v.dims || {}).map(([k, w]) => [k, map(w)])), why: v.why || '',
      flaws: { [order[0]]: v['flaws_甲'] || [], [order[1]]: v['flaws_乙'] || [] } } : null);
  }
  const ok = runs.filter(Boolean);
  const winner = ok.length === 2 && ok[0].winner === ok[1].winner ? ok[0].winner : 'tie';
  const dims = Object.fromEntries(Object.keys(DIMS).map((k) => [k, ok.length === 2 && ok[0].dims[k] === ok[1].dims[k] ? ok[0].dims[k] : 'tie']));
  return { winner, margin: winner === 'tie' ? 0 : Math.min(...ok.map((r) => r.margin)), dims, runs, pages };
}

if (require.main === module) {
  const [a, b, mx, task] = process.argv.slice(2);
  compareDocs(a, b, { maxPages: Number(mx) || 5, task }).then((r) => console.log(JSON.stringify({ winner: r.winner, margin: r.margin, dims: r.dims, runs: r.runs }, null, 2)));
}
module.exports = { compareDocs, DIMS };
