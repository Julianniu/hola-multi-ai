// Wick · 能力卡（wick cards）：每位队友实际干活的记录——做过哪类活、几次、验收一次就过几次、被退回几次、交付前检查出过几次硬伤、
// 平均用时、平均花费，还有定期体检的结果。给主脑派活时参考、给老板看；只是参考，派给谁还是主脑通过 @ 决定（样本少时不下结论）。
// 存在 data/wick-cards.json（只存次数和用时，不存聊天内容）。
'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./core');
const { members } = require('./members');

const FILE = path.join(DATA_DIR, 'wick-cards.json');
let cards = {};
try { cards = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}
let timer = null;
function save() { clearTimeout(timer); timer = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(cards)); } catch (_) {} }, 500); }
const card = (id) => (cards[id] = cards[id] || { turns: 0, ok: 0, err: 0, ms: 0, yuan: 0, kinds: {}, checkErr: 0 });

// 这一回合是哪类活：看交了什么文件
const KIND = [['slides', /\.pptx?$/i], ['sheet', /\.(xlsx|xls|csv)$/i], ['doc', /\.(docx?|md|pdf|txt)$/i], ['code', /\.(js|ts|py|ps1|sh|bat|html|css|json)$/i], ['image', /\.(png|jpe?g|gif|webp|svg|mp4|mp3|wav)$/i]];
const KIND_NAME = { slides: ['PPT', 'decks'], sheet: ['做表', 'sheets'], doc: ['文档', 'documents'], code: ['代码', 'code'], image: ['图片音视频', 'media'], text: ['回答', 'answers'] };
function kindOf(msg) {
  for (const f of msg.files || []) for (const [k, re] of KIND) if (re.test(f.path)) return k;
  return 'text';
}

// 一回合结束：记用时和成败（是哪类活要等交付的文件挂到消息上以后再记，见 recordKind）
function recordTurn(m, msg) {
  if (!m || !msg) return;
  const c = card(m.id);
  c.turns++;
  if (msg.status === 'done') c.ok++; else c.err++;
  if (msg.endedAt && msg.startedAt) c.ms += msg.endedAt - msg.startedAt;
  if (msg.cost) c.yuan = Math.round((c.yuan + msg.cost) * 1e6) / 1e6;
  if (msg.status !== 'done') c.lastErr = { at: Date.now(), text: String(msg.text || '').slice(0, 160) };
  save();
}
// 干活的回合做完、交付的文件挂上以后：记一次这类活
function recordKind(m, msg) {
  if (!m || !msg || msg.status !== 'done') return;
  const c = card(m.id), k = kindOf(msg);
  (c.kinds[k] = c.kinds[k] || { n: 0, pass: 0, fixed: 0, redo: 0 }).n++;
  save();
}
// 主脑验收的结果，记到交付的人头上
function recordReview(review, delivered) {
  if (!review || !['pass', 'fixed', 'redo'].includes(review.review)) return;
  for (const d of delivered) {
    if (!d || d.from === review.from || !members[d.from]) continue;
    const k = (card(d.from).kinds[kindOf(d)] = card(d.from).kinds[kindOf(d)] || { n: 0, pass: 0, fixed: 0, redo: 0 });
    k[review.review]++;
  }
  save();
}
function recordCheck(m, hasError) { if (m && hasError) { card(m.id).checkErr++; save(); } }
// 定期体检的结果
function recordHealth(id, h) { card(id).health = { at: Date.now(), ...h }; save(); }

// 一句话的能力卡（中文给主脑；界面另有英文）
function cardLine(id, en) {
  const m = members[id], c = cards[id];
  if (!m || !c || !c.ok) return '';
  const kinds = Object.entries(c.kinds || {}).filter(([, k]) => k.n).sort((a, b) => b[1].n - a[1].n).slice(0, 4)
    .map(([k, v]) => { const seen = v.pass + v.fixed + v.redo; const nm = KIND_NAME[k][en ? 1 : 0];
      return en ? `${nm} ${v.n}×${seen ? ` (review: ${v.pass} passed, ${v.fixed} fixed, ${v.redo} sent back)` : ''}` : `${nm} ${v.n} 次${seen ? `（验收：通过 ${v.pass}、改了再过 ${v.fixed}、退回 ${v.redo}）` : ''}`; });
  const sec = Math.round(c.ms / Math.max(1, c.ok + c.err) / 1000);
  const money = m.type === 'api' ? (c.yuan ? (en ? `about ¥${(c.yuan / c.ok).toFixed(3)} per turn` : `平均每次约 ¥${(c.yuan / c.ok).toFixed(3)}`) : '') : (en ? 'subscription (no per-use charge)' : '订阅（不按次另外花钱）');
  const parts = [kinds.join(en ? ', ' : '、'), en ? `about ${sec}s per turn` : `平均 ${sec} 秒`, money, c.err ? (en ? `${c.err} failed turns` : `出错 ${c.err} 次`) : '', c.checkErr ? (en ? `${c.checkErr} hard problems found by the delivery check` : `交付检查发现硬伤 ${c.checkErr} 次`) : ''].filter(Boolean);
  return parts.join(en ? '; ' : '；');
}
// 给主脑派活时看的：至少有一位队友干过 3 次活才给（样本太少不如不给）
function cardsText(ids) {
  const lines = ids.map((id) => [id, cardLine(id)]).filter(([, l]) => l);
  if (!lines.some(([id]) => (cards[id].ok || 0) >= 3)) return '';
  return `\n\n【队友能力卡（Hola 记下的实际表现，只供参考，交给谁由你决定）】\n${lines.map(([id, l]) => `- ${members[id].name}：${l}`).join('\n')}`;
}
const allCards = () => cards;

// ---------------------------------------------------------------- 推荐团队配置
// 订阅命令行的队友能力最完整，优先当主脑（评测里 Claude 最稳，其次 Codex、Gemini）；API 队友看模型名：
// pro / max / opus / reasoner 这类强模型当大脑，flash / mini / lite / turbo 这类便宜快的当帮手（"聪明的想、便宜的干"）。
// 有实际验收记录的，验收一次就过的比例高的往前排。只是建议，老板点"套用"才生效。
// 按词匹配（前后是 - _ . / 空格或开头结尾），免得 gemini 里的 mini、minimax 被当成便宜模型
const STRONG = /(^|[-_./\s])(pro|max|opus|sonnet|plus|ultra|reasoner|r1|gpt-?5[\w.]*|o3|o4|k2|glm-?4\.[5-9]|qwen3-?(max|coder))(?=$|[-_./\s\d])/i;
const CHEAP = /(^|[-_./\s])(flash|mini|lite|turbo|haiku|nano|small|air|instant|8b|7b)(?=$|[-_./\s\d])/i;
function scoreOf(m) {
  let s = m.type === 'api' ? (CHEAP.test(m.version || (m.api || {}).model || m.name) ? 30 : STRONG.test(m.version || (m.api || {}).model || m.name) ? 70 : 50)
    : ({ 'claude-stream': 100, 'codex-json': 90, 'agy-json': 80 }[m.parser] || 60);
  const c = cards[m.id];
  if (c) {
    const k = Object.values(c.kinds || {}).reduce((a, v) => ({ pass: a.pass + v.pass, all: a.all + v.pass + v.fixed + v.redo }), { pass: 0, all: 0 });
    if (k.all >= 3) s += Math.round((k.pass / k.all - 0.5) * 20);
  }
  if (!m.online) s -= 200;
  return s;
}
function recommendTeam(en) {
  const list = Object.values(members).filter((m) => m.enabled).map((m) => ({ m, s: scoreOf(m) })).sort((a, b) => b.s - a.s);
  if (!list.length) return null;
  const roles = {};
  for (const { m, s } of list) roles[m.id] = s >= 60 ? 'brain' : 'helper';
  // 开会至少要两位大脑：不够就把最强的帮手升成大脑
  const brains = list.filter(({ m }) => roles[m.id] === 'brain' && m.online);
  if (brains.length < 2) { const up = list.find(({ m }) => roles[m.id] === 'helper' && m.online); if (up) roles[up.m.id] = 'brain'; }
  const main = list[0].m;
  const name = (id) => members[id].name;
  const helpers = list.filter(({ m }) => roles[m.id] === 'helper').map(({ m }) => name(m.id));
  const lines = en
    ? [`Main brain: ${main.name} (${main.type === 'api' ? 'the strongest model you added' : 'subscription command-line tool with its full toolset'})`,
      `Brains (join meetings): ${list.filter(({ m }) => roles[m.id] === 'brain').map(({ m }) => name(m.id)).join(', ')}`,
      helpers.length ? `Helpers (do the routine work, no meetings): ${helpers.join(', ')}` : 'No helpers: every teammate is strong enough to be a brain',
      'Work strategy: automatic (quality first with a subscription main brain, balanced with an API one)']
    : [`主脑：${main.name}（${main.type === 'api' ? '你加的模型里最强的' : '订阅的命令行工具，自带完整的工具，能力最全'}）`,
      `大脑（参加开会）：${list.filter(({ m }) => roles[m.id] === 'brain').map(({ m }) => name(m.id)).join('、')}`,
      helpers.length ? `帮手（干粗活，不开会）：${helpers.join('、')}` : '没有帮手：每位队友都够格当大脑',
      '干活策略：自动（主脑用订阅时质量优先，用 API 时均衡）'];
  return { conclusionBy: main.id, roles, policy: 'auto', lines };
}


// ---------------------------------------------------------------- 定期体检（wick health，第 4 阶段）
// 启动后和之后每 6 小时：命令行队友跑一次 --version（看装没装、能不能启动），API 队友请求一次模型列表（不花 token）。
// 只记结果和快慢（能力卡里给老板看），不改在线状态——有的中转站不支持模型列表。
async function runHealth() {
  const { spawnMember, killTree, cleanEnv } = require('./members');
  const { WORKSPACE } = require('./core');
  for (const m of Object.values(members)) {
    if (!m.enabled) continue;
    const t0 = Date.now();
    try {
      if (m.type === 'api') {
        const a = m.api || {};
        const base = String(a.baseUrl || '').replace(/\/+$/, '');
        const r = await fetch(base + '/models', { headers: a.apiKey ? { Authorization: 'Bearer ' + a.apiKey } : {}, signal: AbortSignal.timeout(10000) });
        recordHealth(m.id, { ok: r.ok, ms: Date.now() - t0, note: r.ok ? '' : 'HTTP ' + r.status });
      } else {
        // 只跑一次 --version 计时，不碰在线状态（checkMember 会先把人标成不在线）
        if (!m.resolved || m.versionCheck === false) continue;
        const code = await new Promise((resolve) => {
          let child;
          try { child = spawnMember(m, ['--version'], { cwd: WORKSPACE, env: cleanEnv() }); } catch (_) { return resolve(-1); }
          const timer = setTimeout(() => { killTree(child); resolve(-2); }, 30000);
          child.on('error', () => { clearTimeout(timer); resolve(-1); });
          child.on('close', (c) => { clearTimeout(timer); resolve(c); });
        });
        recordHealth(m.id, { ok: code === 0, ms: Date.now() - t0, note: code === 0 ? '' : code === -2 ? 'timeout' : 'exit ' + code });
      }
    } catch (e) { recordHealth(m.id, { ok: false, ms: Date.now() - t0, note: String(e.message || e).slice(0, 120) }); }
  }
}

module.exports = { runHealth, kindOf, recordTurn, recordKind, recordReview, recordCheck, recordHealth, cardLine, cardsText, allCards, recommendTeam };
