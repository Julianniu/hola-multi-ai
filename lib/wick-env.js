// Wick · 环境卡片：启动时查一遍这台电脑上有什么（Python 和常用包、Node、PowerShell、ffmpeg），
// 写成一句话放进给队友的说明里（wick envCard）。
// 为什么：基线里这台电脑没装 Python，Claude 几乎每题都先试 python、撞上应用商店的假入口、再换办法——
// 每轮从零开始，记不住。装上 Python 后同样的题总耗时 −29%、token −28%。别人的电脑也常常没有 Python。
'use strict';
const { spawn } = require('child_process');
const { IS_WIN, T, wick } = require('./core');

let card = '';
let probedAt = 0;
let hasNode = false;

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, shell: false }); } catch (_) { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(null); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim() : null); });
  });
}

const PY_PKGS = [['openpyxl', 'openpyxl'], ['docx', 'python-docx'], ['pptx', 'python-pptx'], ['pandas', 'pandas'], ['matplotlib', 'matplotlib'], ['PIL', 'Pillow']];

async function probe() {
  const parts = [];
  // Python：Windows 上没装时，python 是应用商店的假入口（会失败），所以要真的跑一下
  let py = null;
  for (const cmd of IS_WIN ? ['python', 'py'] : ['python3', 'python']) {
    const code = `import sys,importlib.util as u;print(sys.version.split()[0]);print(','.join(n for n in ${JSON.stringify(PY_PKGS.map((p) => p[0]))} if u.find_spec(n)))`;
    const out = await run(cmd, ['-c', code]);
    if (out && /^\d+\.\d+/.test(out)) { py = { cmd, ver: out.split(/\r?\n/)[0], pkgs: (out.split(/\r?\n/)[1] || '').split(',').filter(Boolean) }; break; }
  }
  if (py) {
    const names = PY_PKGS.filter((p) => py.pkgs.includes(p[0])).map((p) => p[1]);
    parts.push(T(`Python ${py.ver}（命令 ${py.cmd}${names.length ? '，已装 ' + names.join('、') : '，没装办公文件相关的包'}）`, `Python ${py.ver} (command ${py.cmd}${names.length ? ', with ' + names.join(', ') : ', no office-file packages'})`));
  } else {
    parts.push(T('没有 Python（不要用 python 命令；处理文件用 Node 或 PowerShell）', 'no Python (do not call python; use Node or PowerShell for files)'));
  }
  const node = await run(IS_WIN ? 'node.exe' : 'node', ['--version']);
  hasNode = !!node;
  parts.push(node ? `Node ${node}` : T('没有 Node 命令', 'no node command'));
  if (IS_WIN) {
    const pwsh = await run('pwsh.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    parts.push(pwsh ? `PowerShell ${pwsh}` : 'Windows PowerShell 5');
  }
  const ff = await run(IS_WIN ? 'ffmpeg.exe' : 'ffmpeg', ['-version']);
  parts.push(ff ? T('有 ffmpeg', 'ffmpeg available') : T('没有 ffmpeg', 'no ffmpeg'));
  card = [IS_WIN ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', ...parts].join(T('；', '; '));
  probedAt = Date.now();
  return card;
}

// 启动时查一次，之后每 6 小时再查一次（老板可能装了新东西）
function startEnvProbe() {
  probe().catch(() => {});
  setInterval(() => probe().catch(() => {}), 6 * 3600e3).unref();
}

// 放进说明里的那一段（还没查完、或者关掉了，就是空的）
function envText() {
  if (!wick('envCard') || !card) return '';
  return T(`【本机环境】${card}。按这个选工具，不要先试本机没有的。\n\n`, `[This computer] ${card}. Pick tools accordingly; don't try what isn't installed.\n\n`);
}

// ---------------------------------------------------------------- 本机经验（wick envNotes，第 4 阶段·自动沉淀）
// 队友干活时撞上的"这台电脑的坑"（命令不存在、Python 包没装、PowerShell 不让跑脚本、中文输出报 GBK……），
// 同一个坑碰到两次就成为候选；老板在设置里点"加入"后，以后每个干活的回合都会先告诉队友（开会的提示词不加）。
// 存在 data/wick-envnotes.json：{ 签名: { text, count, status: new | on | off, at } }
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./core');
const NOTES_FILE = path.join(DATA_DIR, 'wick-envnotes.json');
let notes = {};
try { notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch (_) {}
const saveNotes = () => { try { fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 1)); } catch (_) {} };
const PITFALLS = [
  [/'([\w.+-]+)' is not recognized as an internal or external command|'([\w.+-]+)' 不是内部或外部命令|\b([\w.+-]+): command not found|The term '([\w.+-]+)' is not recognized/i,
    (n) => [`cmd:${n}`, T(`这台电脑上没有 ${n} 命令（队友试过报错），换别的办法`, `There is no ${n} command on this computer (a teammate hit this); use something else`)]],
  [/No module named ['"]?([\w.]+)/, (n) => [`py:${n.split('.')[0]}`, T(`这台电脑的 Python 没装 ${n.split('.')[0]} 包：要用就先 pip install，或者换别的办法`, `Python on this computer lacks the ${n.split('.')[0]} package: pip install it first, or use something else`)]],
  [/Cannot find module '([^'./][^']*)'/, (n) => [`node:${n}`, T(`这台电脑的 Node 没装 ${n} 模块`, `Node on this computer lacks the ${n} module`)]],
  [/running scripts is disabled|禁止运行脚本/i, () => ['ps:policy', T('这台电脑的 PowerShell 不让直接运行 .ps1 脚本：用 powershell -ExecutionPolicy Bypass -File 运行', "PowerShell here won't run .ps1 scripts directly: use powershell -ExecutionPolicy Bypass -File")]],
  [/'gbk' codec can't (en|de)code|UnicodeEncodeError/i, () => ['py:gbk', T('这台电脑上 Python 打印中文会报 GBK 编码错误：运行前设置 PYTHONIOENCODING=utf-8', 'Python here fails on Chinese output with a GBK error: set PYTHONIOENCODING=utf-8 first')]],
];
// 一回合结束：看看出错的步骤里有没有撞上已知类型的坑
function learnFromTurn(msg) {
  if (!wick('envNotes') || !msg) return;
  const seen = new Set();
  for (const p of msg.process || []) {
    if (p.k !== 'error' && p.k !== 'result') continue;
    for (const [re, mk] of PITFALLS) {
      const m = String(p.t || '').match(re);
      if (!m) continue;
      const [sig, text] = mk(m.slice(1).find(Boolean) || '');
      if (seen.has(sig)) continue;
      seen.add(sig);
      const n = notes[sig] || (notes[sig] = { text, count: 0, status: 'new' });
      n.count++;
      n.at = Date.now();
    }
  }
  if (seen.size) saveNotes();
}
const envNotes = () => Object.entries(notes).map(([sig, n]) => ({ sig, ...n })).filter((n) => n.status === 'on' || (n.status === 'new' && n.count >= 2));
function setEnvNote(sig, status) { if (!notes[sig] || !['on', 'off'].includes(status)) return false; notes[sig].status = status; saveNotes(); return true; }
// 干活的回合：老板确认过的本机经验
function envNotesText() {
  if (!wick('envNotes')) return '';
  const on = Object.values(notes).filter((n) => n.status === 'on');
  return on.length ? T(`\n\n【本机经验（以前在这台电脑上踩过的坑）】\n${on.map((n) => '- ' + n.text).join('\n')}`, `\n\n[Lessons from this computer]\n${on.map((n) => '- ' + n.text).join('\n')}`) : '';
}

module.exports = { startEnvProbe, probe, envText, learnFromTurn, envNotes, setEnvNote, envNotesText, get card() { return card; }, get probedAt() { return probedAt; }, get hasNode() { return hasNode; } };
