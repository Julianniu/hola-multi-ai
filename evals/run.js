// Hola / Wick 评测：node evals/run.js [--suite smoke|standard|full] [--members claude,codex,gemini,deepseek] [--tasks S01,T01] [--repeat 3] [--label 说明] [--root 程序文件夹] [--fake]
// --root：用另一份 Hola 程序跑（比如冻结的基线副本 .wick-baseline/2.0.1），同一天先后跑基线和新版本，结果才能直接比。
// 跑真模型会用订阅额度和 API 余额。--fake = 用演示的假队友，只检查评测工具本身能不能跑通（分数没有意义）。
// 结果在 evals/results/<时间>-<说明>/：report.md（给人看）、results.json（给程序看）、runs/（每次运行的对话文件夹，可以回看）。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startEval, FIX, sleep, ROOT } = require('./harness');
const { writeReport } = require('./report');
const { metricsOf } = require('./metrics');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);
const SUITE = arg('suite', 'smoke');
const FAKE = flag('fake');
const REPEAT = Math.max(1, Number(arg('repeat', SUITE === 'full' ? 3 : 1)) || 1);
// 门槛任务（gate: true，Wick 每一步要证明不变差的那几个）在标准档至少跑 3 次
const GATE = Math.max(REPEAT, Number(arg('gate-repeat', SUITE === 'smoke' ? 1 : 3)) || 1);
const ONLY = arg('tasks', '') ? arg('tasks').split(',') : null;
const PROG = arg('root', '') ? path.resolve(arg('root')) : ROOT;
// --team：讨论任务换一支队伍（第一位是主脑），比如 --team deepseekpro,deepseek = 全 API 团队；点名了具体队友的任务（fixedTeam）不换
const TEAM = arg('team', '') ? arg('team').split(',') : null;
// --wick apiTools=0,apiGuard=0：在同一份代码里关掉 / 打开 Wick 的某几项（A/B 对比用）
// --set planConfirm=0：改一项普通设置（比如关掉开工确认），值是 0 / 1 / 数字 / 文字
const SET = Object.fromEntries((arg('set', '') || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, v === '0' || v === 'false' ? false : v === '1' || v === 'true' ? true : isNaN(Number(v)) ? v : Number(v)]; }));
const WICK = Object.fromEntries((arg('wick', '') || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, v !== '0' && v !== 'false']; }));
if (FAKE) process.env.HOLA_EVAL_NO_JUDGE = '1';

// API 队友（DeepSeek 等）的接口资料放在 evals/local.json（不上传）：{ "deepseek": { "name", "baseUrl", "model", "apiKey", "vision", "strengths" } }
let LOCAL = {};
try { LOCAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'local.json'), 'utf8')); } catch (_) {}
const BUILTIN = ['claude', 'codex', 'gemini'];
const API_IDS = Object.keys(LOCAL);
const infoOf = (m) => ({ type: BUILTIN.includes(m) ? 'cli' : API_IDS.includes(m) ? 'api' : 'other' });
function apiMember(id, access, patch) {
  const a = LOCAL[id];
  return { id, name: a.name || id, color: a.color || '#4d6bfe', strengths: a.strengths || '写作、推理、数据整理', type: 'api',
    api: { baseUrl: a.baseUrl, model: a.model, apiKey: a.apiKey || '', temperature: '', vision: !!a.vision, hands: true, full: access === 'full', effort: a.effort || '', ...(patch || {}) } };
}

const MEMBERS = arg('members', '') ? arg('members').split(',') : SUITE === 'smoke' ? ['claude'] : [...BUILTIN, ...API_IDS];
for (const m of [...MEMBERS, ...(TEAM || [])]) if (infoOf(m).type === 'other') { console.error(`不认识的队友：${m}（API 队友要先写进 evals/local.json）`); process.exit(2); }

const TASKS = [...require('./tasks/single'), ...require('./tasks/team')]
  .filter((t) => (ONLY ? ONLY.includes(t.id) : t.suites.includes(SUITE)));

const p2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
const OUT = path.join(__dirname, 'results', `${stamp}-${arg('label', SUITE)}${FAKE ? '-fake' : ''}`);
fs.mkdirSync(path.join(OUT, 'runs'), { recursive: true });

// 把设置合并起来（memberPrefs 按队友逐个合并）
function mergeOpts(a, b) {
  const out = { ...a, ...b };
  out.settings = { ...(a.settings || {}), ...(b.settings || {}) };
  out.settings.memberPrefs = { ...((a.settings || {}).memberPrefs || {}) };
  for (const [k, v] of Object.entries((b.settings || {}).memberPrefs || {})) out.settings.memberPrefs[k] = { ...(out.settings.memberPrefs[k] || {}), ...v };
  out.custom = [...(a.custom || []), ...(b.custom || [])];
  return out;
}

// 讨论任务这次用的队伍
function teamOf(task) {
  if (!task.team) return null;
  if (!TEAM || task.fixedTeam) return task.team;
  return task.team.length === 1 ? [TEAM[0]] : TEAM;
}
const nameOf = (id) => (API_IDS.includes(id) ? LOCAL[id].name || id : id[0].toUpperCase() + id.slice(1));

// 这一次运行用什么队友、什么设置启动 Hola
function plan(task, m, res) {
  const access = task.access || 'full';
  const info = m ? infoOf(m) : { type: 'team' };
  const team = teamOf(task);
  const extra = task.opts ? task.opts(m, res, info, { team, nameOf }) : {};
  let o = { fake: FAKE, root: PROG, settings: { ...(task.settings || {}), ...SET, ...(Object.keys(WICK).length ? { wick: WICK } : {}) } };
  let active;
  if (team) {
    const cli = team.filter((x) => BUILTIN.includes(x));
    const prefs = Object.fromEntries(cli.map((x) => [x, { access }]));
    // helperLast：队伍里最后一位当帮手（不开会、只接活）
    if (task.helperLast) prefs[team[team.length - 1]] = { ...(prefs[team[team.length - 1]] || {}), role: 'helper' };
    o = mergeOpts(o, { members: cli, custom: team.filter((x) => API_IDS.includes(x)).map((x) => apiMember(x, access)),
      settings: { conclusionBy: team[0], memberPrefs: prefs } });
    active = [...team, ...((extra.custom || []).map((c) => c.id))];
  } else if (task.kind === 'harness') {
    active = [task.member];
  } else if (info.type === 'cli') {
    o = mergeOpts(o, { members: [m], settings: { conclusionBy: m, memberPrefs: { [m]: { access } } } });
    active = [m];
  } else {
    o = mergeOpts(o, { members: [], custom: [apiMember(m, access, extra.apiPatch)], settings: { conclusionBy: m } });
    active = [m];
  }
  const { apiPatch: _p, ...rest } = extra;
  o = mergeOpts(o, rest);
  if (FAKE) o.members = (o.members || []).length ? o.members : BUILTIN.slice(0, 1);
  return { opts: o, active, team };
}

// 不是任务本身的问题：额度用完、限流、登录过期、网络断了。这种算"环境问题"，自动重跑一次，不计入完成率
const INFRA = /rate.?limit|usage limit|hit your limit|quota|额度|429|overloaded|529|unauthori[sz]ed|401|not logged in|please log ?in|credit balance|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i;
function infraOf(msgs) {
  for (const x of msgs || []) {
    if (x.status !== 'error' || x.from === 'boss') continue;
    const detail = String(x.text || '').split(/错误信息：|Error:/)[1] || '';
    const body = detail.split(/常见原因|Common causes/)[0];
    if (INFRA.test(body)) return body.trim().slice(0, 300);
  }
  return '';
}

async function runOne(task, m, rep, retried) {
  const who = m || (task.team ? teamOf(task).join('+') : task.member);
  const tag = `${task.id}·${who}${GATE > 1 ? '·' + rep : ''}`;
  const rec = { task: task.id, title: task.title, kind: task.team ? 'team' : task.kind || 'single', member: who, rep, status: 'error', checks: [], notes: {}, score: null, safety: 0, error: '', ms: 0, metrics: null };
  const t0 = Date.now();
  let res = {}, h = null, conv = null, seedLen = 0;
  try {
    res = task.prepare ? await task.prepare() : {};
    const { opts, active, team } = plan(task, m, res);
    const seed = task.seed ? { id: 'eval-' + task.id, ...task.seed(m || (team ? team[0] : 'claude'), team) } : null;
    if (seed) opts.seeds = [seed];
    console.log(`▶ ${tag} 开始`);
    h = await startEval(opts);
    conv = seed ? seed.id : await h.newConv();
    seedLen = seed ? seed.messages.length : 0;
    await h.setActive(conv, active);
    let na = null;
    const ctx = {
      m: m || task.member || null, team, h, conv, dir: h.convDir(conv), fix: FIX, sleep,
      say: (text, extra) => h.say(conv, text, extra),
      attach: (name, as) => h.attach(conv, name, as),
      put: (rel, data) => { const p = path.join(h.convDir(conv), rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); },
      check: (name, pass, detail, o = {}) => rec.checks.push({ name, pass: !!pass, detail: detail || '', soft: !!o.soft }),
      note: (k, v) => { rec.notes[k] = v; },
      score: (s) => { rec.score = s; },
      safety: (n) => { rec.safety += n || 0; },
      na: (why) => { na = why; },
      track: () => {},
    };
    await task.run(ctx, res, task);
    const c = await h.conv(conv);
    rec.metrics = metricsOf(c.messages.slice(seedLen));
    rec.infra = infraOf(c.messages.slice(seedLen));
    const hard = rec.checks.filter((x) => !x.soft);
    rec.status = na ? 'na' : hard.length && hard.every((x) => x.pass) ? 'pass' : 'fail';
    if (na) rec.notes['没测到'] = na;
  } catch (e) {
    rec.error = String((e && e.stack) || e).slice(0, 2000);
    // 评测用的 Hola 没起来：算环境问题，下面会自动重跑一次
    if (/Hola 没能启动/.test(rec.error)) rec.infra = 'Hola 没能启动（电脑太忙或端口被占）';
    try { if (h && conv) { const c = await h.conv(conv); if (c) rec.metrics = metricsOf(c.messages.slice(seedLen)); } } catch (_) {}
  }
  rec.ms = Date.now() - t0;
  rec.dir = tag.replace(/[·+]/g, '_');
  const keep = path.join(OUT, 'runs', rec.dir);
  if (h) await h.close(keep).catch(() => {});
  if (task.cleanup) await Promise.resolve(task.cleanup(res)).catch(() => {});
  // 测接口出错本身的任务（假接口）不算环境问题
  if (rec.status !== 'pass' && rec.status !== 'na' && rec.infra && task.kind !== 'harness') {
    rec.status = 'infra';
    if (!retried) {
      console.log(`… ${tag} 遇到环境问题（${rec.infra.split(/\n/)[0]}），1 分钟后重跑`);
      await sleep(60000);
      const again = await runOne(task, m, rep, true);
      again.notes['重跑过'] = rec.infra;
      return again;
    }
  }
  const mark = { pass: '✅', fail: '❌', na: '➖', error: '⚠️', infra: '🔌' }[rec.status];
  console.log(`${mark} ${tag}  ${Math.round(rec.ms / 1000)} 秒${rec.error ? '  出错：' + rec.error.split('\n')[0] : ''}`);
  return rec;
}

// 这次用的命令行版本（它们会自己更新，分数变化可能来自这里）
const CLI = {};
for (const c of FAKE ? [] : BUILTIN) {
  const cmd = { claude: 'claude', codex: 'codex', gemini: 'agy' }[c];
  try { CLI[c] = execFileSync(cmd, ['--version'], { encoding: 'utf8', shell: true, windowsHide: true, timeout: 30000 }).trim().split(/\n/)[0]; } catch (_) { CLI[c] = '?'; }
}

(async () => {
  const lanes = new Map(); // 同一位队友的任务排成一队依次跑；不同队友之间同时跑
  const team = [];
  const lane = (k) => lanes.get(k) || (lanes.set(k, []), lanes.get(k));
  for (let rep = 1; rep <= GATE; rep++) {
    for (const t of TASKS) {
      if (rep > (t.gate ? GATE : REPEAT)) continue;
      if (t.needs && !t.needs.every((x) => API_IDS.includes(x))) continue;
      if (t.team) { if (TEAM && t.fixedTeam) continue; if (!FAKE || teamOf(t).every((x) => BUILTIN.includes(x))) team.push([t, null, rep]); continue; }
      if (t.kind === 'harness') { lane('harness').push([t, null, rep]); continue; }
      for (const m of MEMBERS) if (!t.applies || t.applies(m, infoOf(m))) lane(m).push([t, m, rep]);
    }
  }
  const total = [...lanes.values()].reduce((s, l) => s + l.length, 0) + team.length;
  console.log(`评测：档位 ${SUITE}，队友 ${MEMBERS.join('、')}，共 ${total} 次运行${FAKE ? '（假队友，只测评测工具）' : ''}\n结果：${OUT}\n`);
  const started = Date.now();
  const results = [];
  const save = () => {
    const meta = { suite: SUITE, members: MEMBERS, repeat: REPEAT, gate: GATE, fake: FAKE, label: arg('label', ''), wick: WICK, set: SET, started, ended: Date.now(), program: PROG, version: require(path.join(PROG, 'package.json')).version, cli: CLI };
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, results }, null, 2));
    writeReport(OUT);
  };
  await Promise.all([...lanes.values()].map(async (list) => { for (const [t, m, rep] of list) { results.push(await runOne(t, m, rep)); save(); } }));
  for (const [t, m, rep] of team) { results.push(await runOne(t, m, rep)); save(); }
  save();
  console.log(`\n完成，用时 ${Math.round((Date.now() - started) / 60000)} 分钟。报告：${path.join(OUT, 'report.md')}`);
})();
