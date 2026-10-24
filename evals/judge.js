// 评审：讨论质量这种没法用规则判的，请一个独立的模型按打分表打分。
// 默认用 Claude 命令行（订阅，不带任何工具、不留会话记录）；每次评审都看不到队友的名字（用 队友A/B/C 代替）。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runClaude(prompt, timeoutMs = 5 * 60000) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-judge-'));
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebSearch,WebFetch,NotebookEdit,Task,TodoWrite'];
    const child = spawn('claude', args, { cwd, env, shell: process.platform === 'win32', windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      let text = out;
      try { text = JSON.parse(out).result || out; } catch (_) {}
      resolve(text);
    });
    child.stdin.end(prompt, 'utf8');
  });
}

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; }
}

// 讨论质量：question = 老板的问题，talk = [{who, round, text}]，conclusion = 团队结论
async function judgeDiscussion(question, talk, conclusion) {
  if (process.env.HOLA_EVAL_NO_JUDGE) return null;
  const names = [...new Set(talk.map((t) => t.who))];
  const alias = (w) => '队友' + 'ABCDEFG'[names.indexOf(w)];
  const lines = talk.map((t, i) => `【发言${i + 1}｜${alias(t.who)}｜${t.round ? '讨论第' + t.round + '轮' : '独立作答'}】\n${t.text}`).join('\n\n');
  const prompt = `你是一位严格、公正的评审，评估一个 AI 团队内部讨论的质量。只根据下面的材料打分，不要客气。

【老板的问题】
${question}

【讨论过程】
${lines}

【团队结论】
${conclusion}

请按 1～5 分（5 最好）给结论打分：
- clear：结论是否直接、明确地回答了问题（有明确的选择或答案）
- integrate：结论是否吸收了不同队友各自有价值的观点，而不只是一个人的意见
- reasoning：理由是否具体（有数字、算账、对比），而不是空话
- risk：是否指出了主要风险或前提条件
- concise：是否简洁、没有套话和重复

再逐条判断每个"讨论第 N 轮"的发言是否"有效"：提出了新观点、新论据、实质性的反驳或修正 = 有效；只是附和、复述别人或客套 = 无效。独立作答不用判断。

只输出一个 JSON，不要任何其他文字：
{"clear":n,"integrate":n,"reasoning":n,"risk":n,"concise":n,"effective":[发言编号…],"ineffective":[发言编号…],"comment":"一句话点评"}`;
  const j = parseJson(await runClaude(prompt));
  if (!j) return null;
  const keys = ['clear', 'integrate', 'reasoning', 'risk', 'concise'];
  const avg = keys.reduce((s, k) => s + (Number(j[k]) || 0), 0) / keys.length;
  const eff = (j.effective || []).length;
  const ineff = (j.ineffective || []).length;
  return { ...j, avg: Math.round(avg * 100) / 100, effectiveRatio: eff + ineff ? Math.round((eff / (eff + ineff)) * 100) / 100 : null };
}

module.exports = { runClaude, judgeDiscussion, parseJson };
