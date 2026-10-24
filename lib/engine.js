// Hola · 讨论引擎：点名与调度、独立作答 → 讨论 → 结论 → 拍板、接力、自动记忆、整理技能
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ATTACH_DIR, EN, MEMORY_NAME, T, broadcast, settings, wick } = require('./core');
const { enabledIds, isHelper, killTree, members } = require('./members');
const { TEXT_DIR, activeIds, addProc, clearDraft, broadcastConvList, broadcastState, clip, convDir, convertOffice, convs, fileInfo, listFiles, memTemplate, nameOf, newMsg, readMemory, rt, saveConv, sys, update, imageNoteRel, textVersionRel } = require('./convs');
const { revokeConv, setPlanAllow } = require('./browser');
const { recordTurn, recordKind, recordReview, recordCheck } = require('./wick-cards');
const { learnFromTurn } = require('./wick-env');
const { setTeamHandler, revokeTeamConv } = require('./wick-team');
const { cardLine } = require('./wick-cards');
const { board, boardReset, boardAdd, boardItem, boardSet, boardLog, openItems } = require('./wick-board');
const { runMember } = require('./run');
const { broadcastSkills, listSkills, noteSkillUse, parseSkill, syncSkillsTo, writeSkill } = require('./skills');
const { TAG_NEED, TAG_STANCE, TAG_REVIEW, agentPrompt, extractOptions, fullPromptMeta, loginHint, msgLine, promptParts, sessionPrompt, transcript, describePrompt } = require('./prompts');
const wickSession = require('./wick-session');
const { traceStart, traceEnd } = require('./wick-trace');
const { checkDelivery } = require('./wick-verify');
const { canAct } = require('./tools');
const { overBudget } = require('./wick-api');

// ---------------------------------------------------------------- 点名与调度

const ALL_WORDS = ['全员', '所有人', '大家', 'all'];
function mentionsIn(text, selfId) {
  const found = [];
  let all = false;
  const re = /@\s*([A-Za-z0-9\u4e00-\u9fa5._-]+)/g;
  let mt;
  while ((mt = re.exec(text || ''))) {
    const w = mt[1].toLowerCase();
    if (ALL_WORDS.some((a) => w.startsWith(a))) { all = true; continue; }
    const id = enabledIds().sort((a, b) => members[b].name.length - members[a].name.length)
      .find((k) => w.startsWith(members[k].name.toLowerCase().replace(/\s+/g, '')) || w === k);
    if (id && id !== selfId && !found.includes(id)) found.push(id);
  }
  return { ids: found, all };
}

// 参与这次对话、在线的大脑（帮手不开会）
function brainIds(c) { return activeIds(c).filter((id) => !isHelper(id)); }
function mainBrain(c) {
  const pref = settings.conclusionBy;
  const brains = brainIds(c);
  return (brains.includes(pref) && pref) || brains[0] || activeIds(c)[0] || null;
}

// ---------------------------------------------------------------- 排活（wick board：每一项都上任务板）

// 一项活排进队列：先记到任务板上（干什么、谁来做），front = 插到最前面（返工、顶替）
function enqueue(c, job, front) {
  const r = rt(c);
  if (job.type !== 'skill') { if (!job.title) job.title = titleOf(c, job); boardAdd(c, job); }
  if (front) r.jobs.unshift(job); else r.jobs.push(job);
  return job;
}
// 交活那条消息里写给这位队友的那一行（"@Codex 把三条要点做成表格" → "把三条要点做成表格"）
function taskFor(text, id) {
  const name = members[id] ? members[id].name : id;
  const line = String(text || '').split('\n').find((l) => new RegExp('@\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(l));
  return line ? clip(line.replace(/[*#>`]/g, '').replace(/@\s*[A-Za-z0-9一-龥._-]+/g, '').replace(/^[\s\-、，,：:]+/, '').replace(/\s+/g, ' ').trim(), 60) : '';
}
function titleOf(c, job) {
  const boss = [...c.messages].reverse().find((x) => x.from === 'boss');
  const ask = boss ? clip(String(boss.text || '').replace(/@\S+/g, '').replace(/\s+/g, ' ').trim(), 40) : '';
  switch (job.type === 'discuss' ? 'discuss' : job.reason) {
    case 'discuss': return T('开会讨论', 'Team meeting');
    case 'main': case 'mention': return ask;
    case 'handoff': return job.task || taskFor((c.messages.filter((x) => x.from === job.by).pop() || {}).text, job.member) || T('接手队友交的活', 'Take over the handed-off work');
    case 'review': return T('验收交付', 'Review the delivery');
    case 'fix': return T('按检查结果返工', 'Fix what the check found');
    case 'decided': return T('按老板的拍板分工执行', 'Carry out your decision');
    case 'replan': return T('按老板的新要求调整', 'Adjust to your new request');
  }
  return '';
}

// mode：'discuss' = 老板点了"开会讨论"；不点名、也没开会时，由主脑一个人直接回答
function onBossMessage(c, text, attachments, mode) {
  const pending = pendingDecision(c);
  const plan = pendingPlan(c);
  const { ids, all } = mentionsIn(text, null);
  // 有一条结论在等老板拍板时，没 @ 人的回复就当作拍板
  const isDecision = !!(pending && text && !ids.length && !all);
  // 有一份分工方案在等老板开工时，没 @ 人的回复就当作"方案要改"
  const isPlanChange = !!(!isDecision && plan && text && !ids.length && !all && mode !== 'discuss');
  const r = rt(c);
  // 大家正在按方案干活，老板插话（没 @ 人）：当作要求变了，主脑调整分工
  const working = r.running && !['initial', 'discuss', 'conclusion'].includes(r.phase) && openItems(c).some((x) => x.status === 'running' && x.reason !== 'discuss');
  const isInsert = !!(!isDecision && !isPlanChange && working && text && !ids.length && !all && mode !== 'discuss' && wick('replan'));
  newMsg(c, 'boss', text, { attachments, ...(isDecision ? { reason: 'decision' } : isPlanChange ? { reason: 'planchange' } : isInsert ? { reason: 'insert' } : {}) });
  if ((c.title === '新对话' || c.title === 'New chat') && text) {
    c.title = text.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, EN() ? 40 : 20) || T('新对话', 'New chat');
    saveConv(c);
  }
  broadcastConvList();
  if (isDecision) { decide(c, pending); return; }
  if (pending) { pending.decided = 'other'; update(c, pending); }
  if (plan) { plan.plan.status = isPlanChange ? 'changed' : 'dropped'; update(c, plan); setPlan(c, null); }
  if (!ids.length && !activeIds(c).length) { sys(c, T('这次没有可以干活的队友：要么都没勾选参与，要么不在线。在输入框下方的"参与"里选几位，或者点右上角的光点看原因。', 'No teammate can take this: none are selected, or none are online. Pick some under "Working" below the input box, or click the lights at the top right to see why.')); return; }

  r.redos = 0;
  if (isPlanChange) {
    // 方案还没开工，老板说要改：写方案的那位按老板的意见改（改完要再派活，会再出一张开工确认）
    const writer = activeIds(c).includes(plan.from) && members[plan.from] && members[plan.from].online ? plan.from : mainBrain(c);
    if (writer) enqueue(c, { type: 'turn', member: writer, reason: 'replan', of: plan.id });
  } else if (isInsert) {
    // 正在干活时老板插话：还没开始的接力先撤下，当前这一步做完后主脑按新要求调整（新的分工要再确认一次）
    for (const q of r.jobs.filter((q) => q.type === 'turn' && ['handoff', 'review'].includes(q.reason))) boardSet(c, q.id, { status: 'cancelled', note: T('老板插话，先撤下', 'Withdrawn: you changed the request') });
    r.jobs = r.jobs.filter((q) => !(q.type === 'turn' && ['handoff', 'review'].includes(q.reason)));
    setPlan(c, null);
    const main = mainBrain(c);
    if (main) enqueue(c, { type: 'turn', member: main, reason: 'replan' }, true);
  } else if (ids.length && !all) {
    // 点了名：按 @ 的先后顺序依次来
    if (!openItems(c).length) boardReset(c, text);
    ids.forEach((id, i) => enqueue(c, { type: 'turn', member: id, reason: 'mention', after: ids.slice(0, i) }));
    r.hops = 0;
  } else if (r.running && r.phase === 'discuss') {
    sys(c, T('大家会在下一轮讨论里看到老板这条消息。', 'The team will see this message in the next discussion round.'));
    return;
  } else if (all || mode === 'discuss') {
    // 老板发起开会（"开会讨论"按钮，或者写了 @大家 / @全员）
    if (!openItems(c).length) boardReset(c, text);
    enqueue(c, { type: 'discuss' });
    r.hops = 0;
  } else {
    if (!openItems(c).length) boardReset(c, text);
    enqueue(c, { type: 'turn', member: mainBrain(c), reason: 'main' });
    r.hops = 0;
  }
  if (!r.running) pump(c); else broadcastState(c);
}

// ---------------------------------------------------------------- 开工确认（甩手掌柜：老板只在开工前确认一次方案）
// 主脑或团队结论要 @ 队友分头干活时，先停下来出一张"分工方案 + 开工"卡（msg.plan）；老板点开工，之后全自动：
// 接力、验收退回、返工、浏览器点击都不再问。老板拍板（选了方案）就等于确认过；老板自己按顺序 @ 的是老板自己的安排。
// 方案到老板下一次开新的事为止；老板插话改了要求、或者调整后又要派新的活，算方案变了，再确认一次。
// settings.planConfirm === false：全自动，不出卡。
function planOf(c) { return (c.board && c.board.plan) || null; }
function setPlan(c, plan) { board(c).plan = plan; saveConv(c); broadcast({ type: 'board', conv: c.id, board: c.board }); }
const planApproved = (c) => { const p = planOf(c); return !!(p && p.status === 'approved'); };
// 在等老板开工的那条方案（之后老板还没说过话）
function pendingPlan(c) {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.from === 'boss') return null;
    if (m.plan) return m.plan.status === 'proposed' ? m : null;
  }
  return null;
}
// 老板点了开工 / 不做了
function answerPlan(c, msgId, go) {
  const m = c.messages.find((x) => x.id === msgId);
  if (!m || !m.plan || m !== pendingPlan(c)) return T('这份方案已经处理过了', 'This plan has already been handled');
  m.plan.status = go ? 'approved' : 'cancelled';
  m.plan.at = Date.now();
  update(c, m);
  if (!go) { setPlan(c, null); sys(c, T('老板没有开工，这份分工先放着。', "You didn't start this plan; it's on hold.")); return null; }
  setPlan(c, { status: 'approved', msg: m.id, at: Date.now() });
  const r = rt(c);
  for (const s of m.plan.steps) enqueue(c, { type: 'turn', member: s.member, reason: 'handoff', by: m.from, task: s.task });
  r.hops = m.plan.steps.length;
  if (!r.running) pump(c); else broadcastState(c);
  return null;
}
// 方案确认之后：这个对话里队友的浏览器点击、输入不再逐个问老板（每一次都记在任务板上）
setPlanAllow((convId, who, detail) => {
  const c = convs.get(convId);
  if (!c || !planApproved(c) || !rt(c).running) return false;
  boardLog(c, T(`方案已确认，自动允许：${who.name} ${detail || ''}`, `Plan approved, allowed automatically: ${who.name} ${detail || ''}`).trim());
  return true;
});

// ---------------------------------------------------------------- Hola 团队工具（wick teamMcp）：看任务板、看队友、交活
// 交活不马上派：记在这条消息上（msg.assign），这一回合结束时和回复里的 @ 一起走 queueHandoffs（开工确认、接力上限都照旧）
setTeamHandler(async (p, tool, args) => {
  const c = convs.get(p.conv);
  if (!c) return T('找不到这个对话。', 'Conversation not found.');
  if (tool === 'board') {
    const b = c.board || { items: [] };
    if (!b.items.length) return T('任务板是空的。', 'The task board is empty.');
    const st = { queued: '排队', running: '进行中', done: '完成', error: '出错', cancelled: '已取消', skipped: '跳过', stopped: '中断' };
    return `${T('这件事', 'Task')}：${b.task || ''}\n${T('方案', 'Plan')}：${b.plan ? ({ proposed: '等老板开工', approved: '已确认' }[b.plan.status] || b.plan.status) : '—'}\n` +
      b.items.map((x) => `- ${x.reason === 'discuss' ? '大家' : nameOf(x.member)}｜${x.title || x.reason}｜${st[x.status] || x.status}${x.note ? '（' + x.note + '）' : ''}`).join('\n');
  }
  if (tool === 'members') {
    return activeIds(c).map((id) => { const mm = members[id]; const card = cardLine(id); return `- ${mm.name}：${isHelper(id) ? '帮手' : '大脑'}${id === mainBrain(c) ? '（主脑）' : ''}，${mm.online ? '在线' : '不在线'}。擅长：${mm.strengths || ''}${card ? '。实际表现：' + card : ''}`; }).join('\n');
  }
  if (tool === 'assign') {
    const msg = c.messages.find((x) => x.id === p.msg);
    const { ids } = mentionsIn('@' + String(args.member || '').replace(/^@/, ''), p.member);
    const to = ids[0];
    if (!to) return T(`找不到队友"${args.member}"，用 members 看看有谁。`, `No teammate called "${args.member}". Use members to see who's here.`);
    if (!activeIds(c).includes(to)) return T(`${nameOf(to)} 这次没有参与或者不在线。`, `${nameOf(to)} isn't working on this or is offline.`);
    if (!msg || msg.status !== 'running') return T('这一回合已经结束了。', 'This turn has already ended.');
    msg.assign = [...(msg.assign || []).filter((x) => x.member !== to), { member: to, task: clip(String(args.task || '').trim(), 300) }];
    return T(`记下了：你这一回合结束后交给 ${nameOf(to)}${planApproved(c) ? '' : '（还没确认方案，会先请老板开工）'}。`, `Noted: this goes to ${nameOf(to)} when your turn ends${planApproved(c) ? '' : ' (after the boss approves the plan)'}.`);
  }
  return T('不认识这个工具。', 'Unknown tool.');
});

// ---------------------------------------------------------------- 自动顶替（wick substitute）
// 额度用完、登录失效、掉线：这一项换一位同角色（大脑换大脑、帮手换帮手）在线的队友顶上，每项最多换一次，群里说一声。
// 老板点名的活也会顶替，但会写明"原本点的是谁"。内容出错（答错、工具报错）不顶替。
const OUT_OF_SERVICE = /usage limit|rate.?limit(ed)?\b|quota|insufficient (balance|credit|funds|quota)|余额不足|额度(用完|不足|已用尽)|credit balance|billing|limit (reached|exceeded)|\b(401|402|403|429)\b|unauthori[sz]ed|not logged in|please (run )?\/?log ?in|login required|log in again|登录(已)?(过期|失效)|请(重新)?登录|token (has )?expired|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|没找到 .* 命令|Can't find the .* command/i;
function substitute(c, m, job, why) {
  if (!wick('substitute') || job.subFor || job.type !== 'turn' || ['initial', 'discuss', 'conclusion'].includes(job.reason)) return null;
  const tried = [m.id, ...(job.tried || [])];
  const ok = activeIds(c).filter((id) => !tried.includes(id) && members[id] && members[id].online && (members[id].type !== 'api' || canAct(members[id]) || !['handoff', 'fix'].includes(job.reason)));
  const same = ok.filter((id) => isHelper(id) === isHelper(m.id));
  const pick = (same.length ? same : ok)[0];
  if (!pick) return null;
  sys(c, T(`${m.name} ${why === 'offline' ? '现在不在线' : '额度用完或登录失效了'}，${job.reason === 'mention' ? '老板点名给 Ta 的' : '这一项'}活改由 ${nameOf(pick)} 顶上。`,
    `${m.name} ${why === 'offline' ? 'is offline' : 'is out of quota or logged out'}; ${nameOf(pick)} takes over ${job.reason === 'mention' ? 'the work you assigned to them' : 'this step'}.`));
  const { id: _id, ...rest } = job;
  return { ...rest, member: pick, subFor: m.id, tried };
}

async function pump(c) {
  const r = rt(c);
  if (r.running) return;
  const myGen = r.gen;
  r.running = true;
  broadcastState(c);
  broadcastConvList();
  while (myGen === r.gen) {
    while (r.jobs.length && myGen === r.gen) {
      const job = r.jobs.shift();
      const item = job.id ? boardItem(c, job.id) : null;
      if (item && item.status === 'cancelled') continue;
      if (job.type === 'discuss') {
        boardSet(c, job.id, { status: 'running', start: Date.now() });
        await runDiscussion(c, myGen, job);
        boardSet(c, job.id, { status: myGen === r.gen ? 'done' : 'stopped', end: Date.now() });
        continue;
      }
      if (job.type === 'skill') { await distillSkill(c, myGen, job); continue; }
      const m = members[job.member];
      if (!m || !m.online) {
        const sub = m && substitute(c, m, job, 'offline');
        boardSet(c, job.id, { status: 'skipped', end: Date.now(), note: sub ? T(`换 ${nameOf(sub.member)} 顶上`, `${nameOf(sub.member)} takes over`) : '' });
        if (sub) { enqueue(c, sub, true); continue; }
        sys(c, T(`${m ? m.name : job.member} 不在线，跳过。`, `${m ? m.name : job.member} is offline, skipped.`));
        continue;
      }
      r.phase = job.reason;
      boardSet(c, job.id, { status: 'running', start: Date.now() });
      const before = listFiles(c);
      const msg = await agentTurn(c, m, job, myGen);
      if (!msg) { boardSet(c, job.id, { status: 'stopped', end: Date.now() }); continue; }
      const cancelled = item && boardItem(c, job.id).status === 'cancelled';
      if (cancelled) { msg.status = 'stopped'; if (!msg.text) msg.text = T('（老板取消了这一项）', '(You cancelled this step)'); update(c, msg); }
      else boardSet(c, job.id, { status: msg.status === 'done' ? 'done' : 'error', msg: msg.id, end: Date.now() });
      attachFiles(c, before, [msg]);
      if (cancelled) continue;
      if (WORK_TURNS.has(job.reason)) recordKind(m, msg);
      // 额度用完 / 登录失效：换人顶上，这一项重新做
      if (msg.status === 'error' && OUT_OF_SERVICE.test(msg.errRaw || '')) {
        const sub = substitute(c, m, job, 'quota');
        if (sub) { boardSet(c, job.id, { note: T(`换 ${nameOf(sub.member)} 顶上`, `${nameOf(sub.member)} takes over`) }); enqueue(c, sub, true); continue; }
      }
      const fix = verifyTurn(c, m, msg, job);
      afterReview(c, msg);
      queueHandoffs(c, m, msg, job);
      // 交的文件有硬伤：先让本人返工一次，返工完再交给主脑验收（验收时两条都算交付）
      if (fix) { enqueue(c, fix, true); continue; }
      noteDelivery(c, m, msg, job.orig || job, job.orig ? job.of : null);
    }
    if (myGen !== r.gen) return;
    if (settings.autoMemory !== false && needsMemory(c)) await updateMemory(c, myGen);
    if (!r.jobs.length) break;
  }
  if (myGen !== r.gen) return;
  r.running = false;
  r.phase = '';
  broadcastState(c);
  broadcastConvList();
}

async function parallelRound(c, ids, turnFor, myGen) {
  const before = listFiles(c);
  const msgs = (await Promise.all(ids.map((id) => agentTurn(c, members[id], turnFor(id), myGen)))).filter(Boolean);
  if (myGen === rt(c).gen) attachFiles(c, before, msgs);
  return msgs;
}

async function runDiscussion(c, myGen, job = {}) {
  const r = rt(c);
  let ids = brainIds(c);
  const base = job.escalate ? c.messages.find((m) => m.id === job.escalate && m.status === 'done') : null;
  if (base) ids = ids.filter((id) => id !== base.from);
  if (!ids.length || ids.length + (base ? 1 : 0) < 2) {
    sys(c, T(`这次只有 ${(base ? [base.from] : ids).map(nameOf).join('、') || '0'} 位大脑在线，开不成会。在输入框下方的"参与"里多选几位大脑，或者到"队友"里把帮手改成大脑。`,
      `Only ${(base ? [base.from] : ids).map(nameOf).join(', ') || 'no'} brain is available, so there's no meeting. Pick more brains under "Working" below the input box, or turn a helper into a brain under Teammates.`));
    return;
  }
  const flow = crypto.randomBytes(3).toString('hex');

  r.phase = 'initial';
  broadcastState(c);
  const first = await parallelRound(c, ids, () => ({ reason: 'initial', flow, round: 0, hide: base ? [base.id] : [] }), myGen);
  if (myGen !== r.gen) return;
  const ok = (base ? [base] : []).concat(first.filter((m) => m.status === 'done'));
  if (ok.length < 2) return; // 只有一个人能答，就不讨论了

  ids = ok.map((m) => m.from);
  // 老板发起的会，至少讨论一轮（不再由队友自己决定开不开）
  const maxRounds = Math.max(1, Math.min(6, Number(settings.maxDiscussRounds) || 3));
  let consensus = false;
  let rounds = 0;
  for (let k = 1; k <= maxRounds; k++) {
    sys(c, k === 1 ? T('有值得讨论的地方，进入内部讨论 · 第 1 轮', 'Worth discussing: internal discussion · round 1') : T(`还有分歧，继续讨论 · 第 ${k} 轮`, `Still disagreeing: discussion · round ${k}`), { divider: true });
    r.phase = 'discuss';
    broadcastState(c);
    const msgs = await parallelRound(c, ids, () => ({ reason: 'discuss', flow, round: k }), myGen);
    if (myGen !== r.gen) return;
    rounds = k;
    const done = msgs.filter((m) => m.status === 'done');
    if (!done.length) return;
    if (done.every((m) => m.stance !== 'object')) { consensus = true; break; }
  }

  const pref = settings.conclusionBy;
  const writer = (ids.includes(pref) && pref) || ids[0];
  sys(c, consensus ? T(`达成共识，由 ${nameOf(writer)} 整理团队结论`, `Consensus reached, ${nameOf(writer)} writes the team conclusion`) : T(`讨论 ${rounds} 轮仍有分歧，由 ${nameOf(writer)} 整理结论并写明分歧`, `Still split after ${rounds} rounds, ${nameOf(writer)} writes the conclusion and notes the disagreement`), { divider: true });
  r.phase = 'conclusion';
  broadcastState(c);
  const before = listFiles(c);
  const msg = await agentTurn(c, members[writer], { reason: 'conclusion', flow, consensus, rounds }, myGen);
  if (!msg || myGen !== r.gen) return;
  attachFiles(c, before, [msg]);
  if (consensus) { queueHandoffs(c, members[writer], msg); return; }
  // 没谈拢：先停下等老板拍板，哪怕结论里 @ 了人也不派活
  if (msg.status !== 'done') return;
  msg.awaitDecision = true;
  update(c, msg);
}

// 等老板拍板的那条结论（之后老板还没说过话）
function pendingDecision(c) {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.from === 'boss') return null;
    if (m.reason === 'conclusion') return m.awaitDecision && !m.decided ? m : null;
  }
  return null;
}

// 老板拍板：记下决定，交给写结论的那位按决定分工
function decide(c, concl, key) {
  concl.decided = key || 'custom';
  update(c, concl);
  const writer = members[concl.from] && members[concl.from].online && activeIds(c).includes(concl.from) ? concl.from : activeIds(c)[0];
  if (!writer) { sys(c, T('现在没有在线的队友可以执行。', 'No teammate is online to carry this out.')); return; }
  const r = rt(c);
  setPlan(c, { status: 'approved', msg: concl.id, at: Date.now(), decided: true }); // 老板拍板 = 确认了方案
  enqueue(c, { type: 'turn', member: writer, reason: 'decided' });
  r.hops = 0;
  if (!r.running) pump(c); else broadcastState(c);
}

// 老板在主脑的回答下面点"让大家讨论一下"：其他大脑先独立作答（看不到主脑那一版），再一起讨论
function escalate(c, msgId) {
  const r = rt(c);
  const base = c.messages.find((m) => m.id === msgId);
  if (!base || base.reason !== 'main' || base.status !== 'done') return T('只能把主脑的回答拿去讨论', "Only the main brain's answer can be taken to a meeting");
  // 正在开会时不再开第二个；只是在整理记忆、干活、验收时，排在后面，做完自动开始
  if (r.running && ['initial', 'discuss', 'conclusion'].includes(r.phase)) return T('等这一轮讨论结束再开会', 'Wait until the current discussion ends');
  if (r.jobs.some((q) => q.type === 'discuss')) return T('已经排好队，马上开会', 'A meeting is already queued');
  if (base.escalated) return T('这条回答已经讨论过了', 'This answer has already been discussed');
  base.escalated = true;
  // 这条回答下面还挂着没开工的分工方案：改成开会了，方案作废
  if (base.plan && base.plan.status === 'proposed') { base.plan.status = 'dropped'; if (planOf(c) && planOf(c).msg === base.id) setPlan(c, null); }
  update(c, base);
  sys(c, T(`老板请大家讨论一下 ${nameOf(base.from)} 的回答`, `You asked the team to discuss ${nameOf(base.from)}'s answer`), { divider: true });
  enqueue(c, { type: 'discuss', escalate: base.id });
  r.hops = 0;
  r.redos = 0;
  pump(c);
  return null;
}

// 队友交给别人的活做完了：记下来，这一批都做完后由主脑统一验收
function noteDelivery(c, m, msg, job, prev) {
  const r = rt(c);
  if (job.reason !== 'handoff' || msg.status !== 'done') return;
  const main = mainBrain(c);
  if (!main || m.id === main) return;
  // 交付的人顺手 @ 了主脑（"请验收"）：不当普通接力，统一走下面的验收
  const folded = r.jobs.filter((q) => q.type === 'turn' && q.reason === 'handoff' && q.member === main && q.by === m.id);
  r.jobs = r.jobs.filter((q) => !folded.includes(q));
  // 任务板上也去掉这一项（并进下面的验收了）
  if (folded.length && c.board) { c.board.items = c.board.items.filter((x) => !folded.some((q) => q.id === x.id)); saveConv(c); broadcast({ type: 'board', conv: c.id, board: c.board }); }
  // 老板中途插话、主脑正要按新要求调整：这份交付由主脑调整时一起看，不再单独验收
  if (r.jobs.some((q) => q.reason === 'replan')) { r.toReview = []; return; }
  (r.toReview = r.toReview || []).push(...(prev ? [prev] : []), msg.id);
  if (r.jobs.some((q) => q.type === 'turn' && q.reason === 'handoff')) return;
  const of = r.toReview.splice(0);
  if (settings.conclusionBy !== main) sys(c, T(`主脑 ${nameOf(settings.conclusionBy)} 这次不在，由 ${nameOf(main)} 代为验收。`, `The main brain ${nameOf(settings.conclusionBy)} isn't available, so ${nameOf(main)} reviews this time.`));
  enqueue(c, { type: 'turn', member: main, reason: 'review', of });
}
// 验收结果：退回超过 2 次就先停下，请老板看一眼（免得来回返工没完没了）
const MAX_REDOS = 2;
function afterReview(c, msg) {
  const r = rt(c);
  if (msg.reason !== 'review') return;
  const delivered = c.messages.filter((x) => (msg.reviewOf || []).includes(x.id));
  recordReview(msg, delivered);
  // 技能候选（第 4 阶段·自动沉淀）：做出了文件、验收通过的活，在验收消息下面给一个"存为技能"
  if (wick('skillHints') && ['pass', 'fixed'].includes(msg.review) && delivered.some((d) => (d.files || []).length)) { msg.skillHint = true; update(c, msg); }
  if (msg.review !== 'redo') { r.redos = 0; return; }
  r.redos = (r.redos || 0) + 1;
  if (r.redos > MAX_REDOS) {
    msg.reviewStop = true;
    update(c, msg);
    sys(c, T(`已经退回重做 ${MAX_REDOS} 次了，先停一下，请老板看看怎么处理。`, `Work has been sent back ${MAX_REDOS} times. Pausing so you can decide what to do.`));
  }
}

// 交付前检查（wick verify）：干活的回合交了文件，Hola 先打开看一遍（lib/wick-verify.js）。
// 结果记在 msg.check（主脑验收时能看到）；有硬伤（打不开、没写完、PPT 溢出、说做好了却没有文件……）就让本人马上返工一次。
// 返工和验收退回共用一个次数上限，花费超了预算就不返工。
const WORK_TURNS = new Set(['main', 'mention', 'handoff', 'decided', 'review', 'fix', 'replan']);
function verifyTurn(c, m, msg, job) {
  if (!wick('verify') || msg.status !== 'done' || !WORK_TURNS.has(job.reason)) return null;
  let problems;
  const boss = [...c.messages].reverse().find((x) => x.from === 'boss');
  try { problems = checkDelivery(convDir(c), (msg.files || []).map((f) => f.path), msg.text, [...listFiles(c).keys()], boss ? boss.text : ''); } catch (_) { return null; }
  if (!problems.length) return null;
  msg.check = problems;
  update(c, msg);
  const errors = problems.filter((p) => p.level === 'error');
  recordCheck(m, errors.length > 0);
  // API 队友的 readOnly 另有用处（记忆行），能不能写文件看 canAct
  if (!errors.length || job.reason === 'fix' || (m.type === 'api' ? !canAct(m) : m.readOnly) || overBudget(c)) return null;
  const r = rt(c);
  if ((r.redos || 0) >= MAX_REDOS) return null;
  r.redos = (r.redos || 0) + 1;
  addProc(c, msg, 'log', T(`交付前检查发现问题，请 ${m.name} 返工一次：`, `The delivery check found problems; ${m.name} will fix them once: `) + errors.map((p) => p.msg).join('；'));
  return { type: 'turn', member: m.id, reason: 'fix', problems: errors, of: msg.id, orig: job, by: job.by };
}

function attachFiles(c, before, msgs) {
  const changed = [...listFiles(c).entries()]
    .filter(([f, sig]) => before.get(f) !== sig && f !== MEMORY_NAME && !f.startsWith(ATTACH_DIR + '/') && !f.startsWith(TEXT_DIR + '/'))
    .map(([f]) => f);
  for (const f of changed) convertOffice(c, f);
  if (!changed.length || !msgs.length) return;
  const left = new Set(changed);
  for (const msg of msgs) {
    const mine = msgs.length === 1 ? changed : changed.filter((f) => (msg.captured || []).includes(f) || (msg.text || '').includes(path.basename(f)));
    if (!mine.length) continue;
    msg.files = mine.map((f) => fileInfo(c, f)).slice(0, 30);
    mine.forEach((f) => left.delete(f));
    update(c, msg);
  }
  if (left.size) sys(c, T(`这一轮新增或修改了：${[...left].slice(0, 12).join('、')}`, `Added or changed this round: ${[...left].slice(0, 12).join(', ')}`));
}

function queueHandoffs(c, m, msg) {
  const r = rt(c);
  if (msg.status !== 'done' || msg.reviewStop) return;
  const { ids: said } = mentionsIn(msg.text, m.id);
  // 回复里的 @，加上用团队工具交出去的活（msg.assign）
  const assigned = (msg.assign || []).filter((a) => a.member !== m.id);
  const ids = [...new Set([...said, ...assigned.map((a) => a.member)])];
  const taskOf = (id) => ((assigned.find((a) => a.member === id) || {}).task) || taskFor(msg.text, id);
  const act = activeIds(c);
  const go = [];
  for (const id of ids) {
    if (r.jobs.some((q) => q.type === 'turn' && q.member === id)) continue;
    if (!act.includes(id)) { sys(c, T(`${nameOf(id)} 这次没有参与（或不在线），${nameOf(m.id)} 交给 Ta 的活没有派出去。需要的话，老板可以直接 @ Ta。`, `${nameOf(id)} isn't working on this (or is offline), so ${nameOf(m.id)}'s hand-off wasn't sent. @ them directly if you want them in.`)); continue; }
    go.push(id);
  }
  if (!go.length) return;
  // 还没确认过方案：先出开工确认卡，老板点开工再派（answerPlan）
  if (settings.planConfirm !== false && !planApproved(c)) {
    msg.plan = { status: 'proposed', steps: go.map((id) => ({ member: id, task: taskOf(id) })) };
    update(c, msg);
    setPlan(c, { status: 'proposed', msg: msg.id, at: Date.now() });
    return;
  }
  for (const id of go) {
    if (r.hops >= settings.maxAutoTurns) {
      sys(c, T(`队友之间已经自动接力 ${settings.maxAutoTurns} 次了，先停一下，等老板看一眼再继续。`, `Teammates have handed off ${settings.maxAutoTurns} times in a row. Pausing here so you can take a look.`));
      for (const q of r.jobs.filter((q) => q.reason === 'handoff')) boardSet(c, q.id, { status: 'cancelled', note: T('接力次数到上限', 'Hand-off limit reached') });
      r.jobs = r.jobs.filter((q) => q.reason !== 'handoff');
      break;
    }
    r.hops++;
    enqueue(c, { type: 'turn', member: id, reason: 'handoff', by: m.id, task: taskOf(id) });
  }
}

// ---------------------------------------------------------------- 任务板上的操作：改派、取消（老板点的）

// 还没开始的一项换人做
function reassign(c, itemId, to) {
  const r = rt(c);
  const job = r.jobs.find((q) => q.id === itemId);
  if (!job || job.type !== 'turn') return T('只能改派还没开始的活', 'Only steps that haven\'t started can be reassigned');
  if (!activeIds(c).includes(to) || !members[to] || !members[to].online) return T('这位队友这次没有参与或者不在线', 'That teammate isn\'t working on this or is offline');
  if (to === job.member) return null;
  sys(c, T(`老板把"${clip(job.title || '', 30)}"从 ${nameOf(job.member)} 改派给 ${nameOf(to)}`, `You reassigned "${clip(job.title || '', 30)}" from ${nameOf(job.member)} to ${nameOf(to)}`));
  job.reassigned = job.member;
  job.member = to;
  boardSet(c, itemId, { member: to, note: T(`原本是 ${nameOf(job.reassigned)}`, `Was ${nameOf(job.reassigned)}`) });
  return null;
}
// 取消一项：没开始的直接撤下；正在做的，结束这位队友的这次运行（其他人照常）
function cancelItem(c, itemId) {
  const r = rt(c);
  const it = boardItem(c, itemId);
  if (!it || !['queued', 'running'].includes(it.status)) return T('这一项已经结束了', 'This step has already finished');
  const wasRunning = it.status === 'running';
  if (wasRunning && it.reason === 'discuss') { stopConv(c, T('老板取消了这次开会。', 'You cancelled the meeting.')); return null; }
  boardSet(c, itemId, { status: 'cancelled', end: Date.now() });
  r.jobs = r.jobs.filter((q) => q.id !== itemId);
  if (wasRunning) for (const ch of r.children) if (ch.holaMember === it.member) { if (ch.abort) ch.abort(); else killTree(ch); }
  return null;
}

// ---------------------------------------------------------------- 自动记忆

function seqOf(m) { return Number(String(m.id).split('-')[1]) || 0; }

function newSinceMemory(c) {
  const mark = c.memMark || 0;
  return c.messages.filter((m) => seqOf(m) > mark && m.reason !== 'memory' && m.reason !== 'skill' && m.reason !== 'describe' && m.status !== 'running' &&
    (m.from === 'boss' || (members[m.from] && m.status === 'done'))).slice(-60);
}

function needsMemory(c) {
  const fresh = newSinceMemory(c);
  return fresh.some((m) => m.from !== 'boss') && activeIds(c).length > 0;
}

function memoryPrompt(c, fresh) {
  const lines = fresh.map((m) => {
    const files = [...(m.attachments || []), ...(m.files || [])].map((f) => f.path);
    return msgLine(m) + (files.length && !msgLine(m).includes('（') ? `\n（文件：${files.join('，')}）` : '');
  }).join('\n\n');
  return `你是 Hola 团队的"记忆整理员"。Hola 里每个对话都有一份独立的记忆，队友每次发言前都会先读它；聊天记录太长时，较早的内容只能靠这份记忆延续。
你的任务：把下面"新增对话"里值得长期记住的内容，合并进"当前记忆"，输出更新后的完整记忆。

只记长期有用的东西：
- 目标与背景：这个对话在做什么项目、给谁、为什么。
- 老板的偏好与要求：老板明确说过的要求、口味、禁忌、格式偏好（只记老板说过的，不要替他推断）。
- 已经定下的结论：团队结论、老板拍板的决定（写结论本身，不写讨论过程）。
- 进度与待办：做到哪一步、还有什么没做、谁负责。
- 重要文件：交付文件和关键附件的文件名，以及一句话说明是什么。

规则：
- 合并、去重、压缩：新信息推翻旧信息时，直接改成新的，不要留着矛盾的两条。总长度尽量控制在 3000 字以内。
- 寒暄、过程性讨论、没有结论的发散，都不要记。
- 老板的个人资料和长期偏好另有地方保存，不用重复记；只记跟这个对话有关的。
- 不要修改任何文件、不要运行命令，只输出文字。
- 如果新增对话里没有任何值得记的内容，只输出一行：【无需更新】
- ${EN() ? '记忆内容和【本次变化】那句话都用英文写，五个小标题沿用当前记忆里的英文标题。' : '记忆内容用中文写。'}

输出格式（严格遵守）：
第一行：【本次变化】用一句话说明这次记了什么
然后输出完整记忆，放在 <<<记忆 和 记忆>>> 之间，使用这个结构：
<<<记忆
# 对话记忆

## 目标与背景
……
## 老板的偏好与要求
……
## 已经定下的结论
……
## 进度与待办
……
## 重要文件
……
记忆>>>
${wick('ruleHints') ? `
如果新增对话里老板明确定下了以后都要照做的规矩（比如"以后价格都写成 ¥ 加数字""表格一律做成 Excel"），在 记忆>>> 后面另起一段：
【规矩候选】
- 一条一行，尽量用老板的原话
没有就不写这一段。只写老板明确要求以后都这样做的；一次性的要求、你自己的推断都不要写。
` : ''}
【当前记忆】
${readMemory(c) || memTemplate()}

【新增对话】
${lines}`;
}

// 规矩候选（wick ruleHints，第 4 阶段·自动沉淀）：记忆整理员发现老板定下了长期规矩，先放进候选，老板点"加入"才进规矩墙
const normRule = (s) => String(s || '').replace(/[\s，。,.！!"“”'‘’]/g, '').toLowerCase();
function noteRuleHints(c, out) {
  if (!wick('ruleHints')) return;
  const sec = String(out || '').match(/【规矩候选】\s*\n((?:[ \t]*[-•*][^\n]*\n?)+)/);
  if (!sec) return;
  const have = new Set([...(c.rules || []), ...(c.ruleHints || []), ...(c.ruleNo || [])].map((r) => normRule(r.text || r)));
  const add = sec[1].split('\n').map((l) => l.replace(/^[ \t]*[-•*]\s*/, '').trim()).filter((t) => t.length >= 4 && t.length <= 200 && !have.has(normRule(t)));
  if (!add.length) return;
  c.ruleHints = [...(c.ruleHints || []), ...add.map((text) => ({ text, at: Date.now() }))].slice(-8);
  saveConv(c);
  broadcast({ type: 'hints', conv: c.id, hints: c.ruleHints });
}
// 老板对一条候选的回答：add = 加进规矩墙，否则 = 不用（记下来，以后不再提）
function answerRuleHint(c, text, add) {
  const i = (c.ruleHints || []).findIndex((h) => h.text === text);
  if (i < 0) return T('这条建议已经处理过了', 'This suggestion has already been handled');
  const [h] = c.ruleHints.splice(i, 1);
  if (add) c.rules = [...(c.rules || []), { text: h.text }].slice(0, 50);
  else c.ruleNo = [...(c.ruleNo || []), { text: h.text }].slice(-30);
  saveConv(c);
  broadcast({ type: 'hints', conv: c.id, hints: c.ruleHints });
  return null;
}

async function updateMemory(c, myGen) {
  const r = rt(c);
  const fresh = newSinceMemory(c);
  const lastSeq = Math.max(...c.messages.map(seqOf));
  const pref = settings.conclusionBy;
  const act = activeIds(c);
  const keeperId = (act.includes(pref) && pref) || act[0];
  if (!keeperId) return;
  const m = members[keeperId];
  r.phase = 'memory';
  const msg = newMsg(c, m.id, '', { status: 'running', startedAt: Date.now(), reason: 'memory' });
  r.working.add(m.id);
  broadcastState(c);
  const res = await runMember(c, m, memoryPrompt(c, fresh), msg, []);
  r.working.delete(m.id);
  if (myGen !== r.gen) return;
  msg.endedAt = Date.now();
  const out = res.text || '';
  const body = out.match(/<<<\s*记忆\s*\n([\s\S]*?)\n?\s*记忆\s*>>>/);
  const change = (out.match(/【本次变化】\s*(.+)/) || [])[1];
  if (/【无需更新】/.test(out) && !body) {
    msg.text = T('这一轮没有需要长期记住的新内容。', 'Nothing new worth remembering this round.');
    msg.status = 'done';
    msg.memoryChanged = false;
  } else if (body && body[1].trim().length > 20) {
    const file = path.join(convDir(c), MEMORY_NAME);
    try {
      const hist = path.join(convDir(c), '.hola', 'memory-history');
      fs.mkdirSync(hist, { recursive: true });
      const old = readMemory(c);
      if (old) fs.writeFileSync(path.join(hist, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`), old);
      fs.writeFileSync(file, body[1].trim() + '\n');
      msg.text = change ? change.trim() : T('已更新对话记忆。', 'Conversation memory updated.');
      msg.status = 'done';
      msg.memoryChanged = true;
    } catch (e) {
      msg.text = T('写入对话记忆失败：', 'Failed to write memory: ') + e.message;
      msg.status = 'error';
    }
  } else {
    msg.text = T('整理记忆没成功，下一轮会再试。', "Couldn't update memory, will retry next round.") + (res.err ? '\n' + clip(res.err, 300) : '');
    msg.status = 'error';
  }
  if (msg.status !== 'error') c.memMark = lastSeq;
  noteRuleHints(c, out);
  update(c, msg);
  if (msg.memoryChanged) broadcast({ type: 'memory', conv: c.id, memory: readMemory(c) });
  broadcastState(c);
}

function distillPrompt(c, fromMsg) {
  const existing = listSkills().map((s) => `- ${s.name}：${s.description}`).join('\n') || '（还没有）';
  const focus = fromMsg ? `\n【老板想沉淀的这条结论】\n[${nameOf(fromMsg.from)}] ${clip(fromMsg.text, 6000)}\n` : '';
  return `你是 Hola 团队的"技能整理员"。Hola 有一个所有对话、所有队友共用的技能库：每个技能是一份可以反复使用的做事方法，下次遇到同类任务，队友会先读它再动手。
老板希望把这个对话里的做法沉淀成一个技能。请从下面的对话记忆和群聊记录里提炼：

- 这是哪一类任务（写清楚什么时候该用这个技能，方便队友判断）；
- 做这类任务的步骤和分工（谁擅长哪一步）；
- 质量标准、老板明确提过的偏好和禁忌；
- 这次踩过的坑、讨论中得出的关键判断；
- 需要的话，给出输出模板或检查清单。

规则：
- 写成通用的方法，不要写成这一次的流水账；这次特有的具体数字、名字只作为例子出现。
- 只写老板说过的偏好，不要替他推断。
- 如果技能库里已经有同一类技能，就用完全相同的名称，把新经验合并进去，输出合并后的完整版本。
- 不要修改任何文件、不要运行命令，只输出文字。${EN() ? '\n- 技能内容用英文写。' : '\n- 技能内容用中文写。'}

输出格式（严格遵守）：
第一行：【本次变化】用一句话说明这个技能是什么
然后：
<<<技能
name: 技能名称（简短，10 个字以内）
description: 一句话说明什么时候用它
---
# 技能名称
（具体做法，Markdown）
技能>>>

【技能库里已有的技能】
${existing}
${focus}
【本对话记忆】
${clip(readMemory(c), 6000) || '（空）'}

【群聊记录】
${transcript(c)}`;
}

async function distillSkill(c, myGen, job) {
  const r = rt(c);
  const act = activeIds(c);
  const pref = settings.conclusionBy;
  const keeperId = (act.includes(pref) && pref) || act[0];
  if (!keeperId) { sys(c, T('没有在线的队友，没法整理技能。', 'No teammate is online to write the skill.')); return; }
  const m = members[keeperId];
  const fromMsg = job.fromMsg ? c.messages.find((x) => x.id === job.fromMsg) : null;
  r.phase = 'skill';
  const msg = newMsg(c, m.id, '', { status: 'running', startedAt: Date.now(), reason: 'skill' });
  r.working.add(m.id);
  broadcastState(c);
  const res = await runMember(c, m, distillPrompt(c, fromMsg), msg, []);
  r.working.delete(m.id);
  if (myGen !== r.gen) return;
  msg.endedAt = Date.now();
  const out = res.text || '';
  const block = out.match(/<<<\s*技能\s*\n([\s\S]*?)\n?\s*技能\s*>>>/);
  const change = (out.match(/【本次变化】\s*(.+)/) || [])[1];
  if (block) {
    const raw = block[1].trim();
    const sk = parseSkill(raw.startsWith('---') ? raw : '---\n' + raw.replace(/\n---\n/, '\n---\n'));
    try {
      const existed = listSkills().find((x) => x.name.toLowerCase() === (sk.name || '').toLowerCase());
      const id = writeSkill(sk, { source: 'conversation', fromConv: c.title });
      msg.skillId = id;
      msg.skillName = sk.name;
      msg.skillUpdated = !!existed;
      msg.text = change ? change.trim() : sk.description;
      msg.status = 'done';
      broadcastSkills();
    } catch (e) { msg.text = T('保存技能失败：', 'Failed to save the skill: ') + e.message; msg.status = 'error'; }
  } else {
    msg.text = T('整理技能没成功，可以再试一次。', "Couldn't write the skill, please try again.") + (res.err ? '\n' + clip(res.err, 300) : '');
    msg.status = 'error';
  }
  update(c, msg);
  broadcastState(c);
}

function extractTags(text) {
  let need = null, stance = null;
  const n = text.match(TAG_NEED);
  if (n) { need = n[1] === '是'; text = text.replace(TAG_NEED, ''); }
  const st = text.match(TAG_STANCE);
  if (st) { stance = st[1] === '同意' ? 'agree' : 'object'; text = text.replace(TAG_STANCE, ''); }
  return { text: text.trim(), need, stance };
}

// ---------------------------------------------------------------- 图片说明（给看不到图片的队友）
// 能不能看图：三家命令行都能看；API 队友要在设置里打开"能看图片"
const canSeeImages = (m) => (m.type === 'api' ? !!(m.api || {}).vision : ['claude-stream', 'codex-json', 'agy-json'].includes(m.parser));
// 谁来看图写说明：优先 Gemini，其次 Claude、Codex，再其次任何能看图、在线的队友
function imageDescriber() {
  const ok = (id) => members[id] && members[id].enabled && members[id].online && canSeeImages(members[id]);
  return ['gemini', 'claude', 'codex'].find(ok) || enabledIds().find(ok) || null;
}
// 同一张图只写一次：好几个看不到图的队友同时要，就等同一份
async function ensureImageNotes(c, rels, myGen) {
  const r = rt(c);
  if (!r.describing) r.describing = new Map();
  for (const rel of rels.slice(0, 4)) {
    if (textVersionRel(c, rel)) continue;
    if (!r.describing.has(rel)) r.describing.set(rel, describeImage(c, rel, myGen).finally(() => r.describing.delete(rel)));
    await r.describing.get(rel);
    if (myGen !== r.gen) return;
  }
}
async function describeImage(c, rel, myGen) {
  const id = imageDescriber();
  if (!id) return; // 没有能看图的队友在线：就照旧告诉 API 队友"看不到"
  const m = members[id];
  const r = rt(c);
  const msg = newMsg(c, m.id, '', { status: 'running', startedAt: Date.now(), reason: 'describe', file: rel });
  r.working.add(m.id);
  broadcastState(c);
  const res = await runMember(c, m, describePrompt(rel), msg, [path.join(convDir(c), rel)]);
  r.working.delete(m.id);
  if (myGen !== r.gen) return;
  msg.endedAt = Date.now();
  const text = String(res.text || '').trim();
  if (res.code === 0 && text.length > 10) {
    fs.mkdirSync(path.join(convDir(c), TEXT_DIR), { recursive: true });
    fs.writeFileSync(path.join(convDir(c), imageNoteRel(rel)), `# 图片说明：${path.basename(rel)}\n\n（${m.name} 看图后写的，给看不到图片的队友参考）\n\n${text}\n`);
    msg.text = path.basename(rel);
    msg.status = 'done';
  } else {
    msg.text = T('没能写出图片说明', "Couldn't describe the image") + (res.err ? '\n' + clip(res.err, 300) : '');
    msg.status = 'error';
  }
  update(c, msg);
  broadcastState(c);
}

async function agentTurn(c, m, turn, myGen) {
  const r = rt(c);
  // 看不到图片的 API 队友：先请能看图的队友把老板这次发的图片写成说明
  if (m.type === 'api' && !canSeeImages(m)) {
    const lb = [...c.messages].reverse().find((x) => x.from === 'boss');
    const rels = ((lb && lb.attachments) || []).filter((a) => a.image).map((a) => a.path);
    if (rels.length) { await ensureImageNotes(c, rels, myGen); if (myGen !== r.gen) return null; }
  }
  const msg = newMsg(c, m.id, '', { status: 'running', startedAt: Date.now(), reason: turn.reason, by: turn.by || null, round: turn.round, flow: turn.flow || null, consensus: turn.consensus, ...(turn.escalated ? { escalated: true } : {}) });
  if (turn.id) boardSet(c, turn.id, { msg: msg.id });
  r.working.add(m.id);
  broadcastState(c);
  const lastBoss = [...c.messages].reverse().find((x) => x.from === 'boss');
  const images = (lastBoss && lastBoss.attachments || []).filter((a) => a.image).map((a) => path.join(convDir(c), a.path));
  if (m.type !== 'api') syncSkillsTo(c);
  // 长会话（wick sessions）：能续接就只送新消息；不能就送完整提示词并开一个新会话。
  // 开会的三个阶段（独立作答、内部讨论、团队结论）不用长会话，照旧每次送完整提示词：
  // A/B（2026-10-23，全 API 团队）里开会用长会话讨论轮数变多、评审分下降，老板定过讨论质量不能拿来换速度。
  // 没送过的讨论消息，下一次干活续接时会作为"新消息"补上。
  const discussing = ['initial', 'discuss', 'conclusion'].includes(turn.reason);
  let sess = discussing ? null : wickSession.current(c, m);
  let pr = sess ? sessionPrompt(c, m, turn, sess) : null;
  if (!pr) { sess = discussing ? null : wickSession.fresh(c, m); pr = sess ? { text: agentPrompt(c, m, turn), ...fullPromptMeta(c, m, turn) } : { text: agentPrompt(c, m, turn) }; }
  msg.promptChars = pr.text.length; // 记下提示词有多长（评测和排查用）
  if (sess) msg.resumed = !sess.fresh;
  traceStart(c, msg, m, { resumed: !!msg.resumed, promptChars: pr.text.length, prompt: pr.text, images: images.map((p) => path.basename(p)) });
  // 最后一个参数：API 队友的接口不支持工具时，用它重新拼一份"只动脑"的提示词
  // API 队友干活时：固定说明单独作为系统消息发（开会的三个阶段照旧，一个字不动）
  const sysHead = m.type === 'api' && !discussing && wick('apiSystem') ? promptParts(c, m, turn).header : '';
  let res = await runMember(c, m, pr.text, msg, images, () => agentPrompt(c, m, turn), sess, sysHead);
  // 续接失败（会话丢了、命令行不认）：丢掉这个会话，送完整提示词重来一次
  if (sess && !sess.fresh && !res.text && myGen === r.gen) {
    addProc(c, msg, 'log', T('接着上次的会话没成功，换成完整的提示词重来一次。', "Couldn't resume the previous session; starting over with the full prompt."));
    wickSession.drop(c, m);
    sess = wickSession.fresh(c, m);
    pr = { text: agentPrompt(c, m, turn), ...fullPromptMeta(c, m, turn) };
    msg.promptChars = pr.text.length;
    msg.resumed = false;
    res = await runMember(c, m, pr.text, msg, images, () => agentPrompt(c, m, turn), sess, sysHead);
  }
  r.working.delete(m.id);
  clearDraft(msg);
  if (myGen !== r.gen) { if (sess) wickSession.drop(c, m); return null; }
  if (sess) { if (res.text) wickSession.commit(c, m, sess, { sid: res.sessionId, sent: [...(pr.sent || []), msg.id], hashes: pr.hashes }); else wickSession.drop(c, m); }
  msg.endedAt = Date.now();
  if (res.text) {
    const tags = extractTags(res.text);
    let text = noteSkillUse(tags.text, msg);
    // 漏写了该写的标签：只记下来（评测统计用），处理方式不变
    const missing = (tag) => { msg.tagMissing = tag; };
    if (turn.reason === 'initial') { msg.needDiscuss = tags.need === true; if (tags.need === null) missing('need'); }
    if (turn.reason === 'discuss') { msg.stance = tags.stance || 'agree'; if (!tags.stance) missing('stance'); }
    if (turn.reason === 'review') {
      const rv = text.match(TAG_REVIEW);
      msg.review = rv ? { 通过: 'pass', 已修改: 'fixed', 退回: 'redo' }[rv[1]] : 'pass';
      msg.reviewOf = turn.of || [];
      if (rv) text = text.replace(TAG_REVIEW, '').replace(/^[\s，,。:：]+/, '') || text;
      else missing('review');
    }
    if (turn.reason === 'conclusion' && !turn.consensus) { const o = extractOptions(text); text = o.text || text; msg.options = o.options; if (o.options.length < 2) missing('options'); }
    if (m.readOnly) {
      const mem = text.match(/(^|\n)\s*记忆[:：]\s*(.+)\s*$/);
      if (mem) {
        try { fs.appendFileSync(path.join(convDir(c), MEMORY_NAME), `- ${mem[2].trim()}（${m.name}）\n`); } catch (_) {}
        addProc(c, msg, 'tool', '记入对话记忆：' + mem[2].trim());
        text = text.slice(0, mem.index).trim() || text;
      }
    }
    msg.text = text;
    msg.status = res.code === 0 ? 'done' : 'error';
  } else {
    msg.status = 'error';
    msg.text = T('没能完成，出错了。', "Couldn't finish, something went wrong.") + (res.err ? T('\n\n错误信息：\n', '\n\nError:\n') + clip(res.err, 800) : '') +
      loginHint(m);
  }
  // 程序自己报的原始错误（自动顶替只看这个：给老板的说明里有"登录过期、额度用完"这类提示，不能拿来判断）
  if (msg.status === 'error') msg.errRaw = clip(res.err || '', 600);
  recordTurn(m, msg);
  learnFromTurn(msg);
  traceEnd(c, msg, { text: msg.text, err: res.err || '', sessionId: res.sessionId || '', ms: msg.endedAt - msg.startedAt });
  update(c, msg);
  broadcastState(c);
  return msg;
}

function stopConv(c, note) {
  const r = rt(c);
  r.gen++;
  r.jobs = [];
  for (const ch of r.children) { if (ch.abort) ch.abort(); else killTree(ch); }
  r.children.clear();
  revokeConv(c.id);
  revokeTeamConv(c.id);
  r.working.clear();
  r.running = false;
  r.phase = '';
  for (const m of c.messages) if (m.status === 'running') { m.status = 'stopped'; if (!m.text) m.text = '（被老板叫停）'; clearDraft(m); update(c, m); }
  if (note) sys(c, note);
  broadcastState(c);
  broadcastConvList();
}

// ---------------------------------------------------------------- 崩溃续做（wick resume）
// Hola 或电脑重启后：任务板上排着队的活接着排；做到一半被打断的那一项重新做（提示词里说明被打断过，先看看已经做了什么）。
// 开会被打断不续（讨论要几位同时作答，接不上），在群里说一声。要等队友在线检查做完再调用（http 启动时）。
function resumeWork(c) {
  if (!wick('resume') || !c.board) return false;
  const r = rt(c);
  if (r.running || r.jobs.length) return false;
  const todo = c.board.items.filter((x) => x.status === 'queued' || x.status === 'running');
  if (!todo.length) return false;
  let n = 0;
  for (const it of todo) {
    if (it.reason === 'discuss' || !it.job || it.job.type !== 'turn') {
      boardSet(c, it.id, { status: 'stopped', note: T('重启打断', 'Interrupted by a restart') });
      if (it.reason === 'discuss') sys(c, T('Hola 重启打断了开会。需要的话，点"开会讨论"重新开。', 'A restart interrupted the meeting. Start it again with "Meeting" if you still need it.'));
      continue;
    }
    const job = { ...it.job, id: it.id, ...(it.status === 'running' ? { resumed: true } : {}) };
    boardSet(c, it.id, { status: 'queued', note: it.status === 'running' ? T('重启后接着做', 'Resumed after a restart') : '' });
    r.jobs.push(job);
    n++;
  }
  if (!n) return false;
  sys(c, T(`Hola 重启前还有 ${n} 项活没做完，接着做。`, `${n} unfinished step(s) from before the restart: carrying on.`));
  pump(c);
  return true;
}

function anyRunning() { return [...convs.values()].some((c) => c.rt && c.rt.running); }

module.exports = { answerRuleHint, enqueue, answerPlan, pendingPlan, reassign, cancelItem, resumeWork, ALL_WORDS, mentionsIn, brainIds, mainBrain, escalate, onBossMessage, pump, parallelRound, runDiscussion, pendingDecision, decide, attachFiles, queueHandoffs, seqOf, newSinceMemory, needsMemory, memoryPrompt, updateMemory, distillPrompt, distillSkill, extractTags, agentTurn, stopConv, anyRunning };
