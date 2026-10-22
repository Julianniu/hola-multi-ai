// Hola · 讨论引擎：点名与调度、独立作答 → 讨论 → 结论 → 拍板、接力、自动记忆、整理技能
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ATTACH_DIR, EN, MEMORY_NAME, T, broadcast, settings } = require('./core');
const { enabledIds, isHelper, killTree, members } = require('./members');
const { TEXT_DIR, activeIds, addProc, broadcastConvList, broadcastState, clip, convDir, convertOffice, convs, fileInfo, listFiles, memTemplate, nameOf, newMsg, readMemory, rt, saveConv, sys, update, imageNoteRel, textVersionRel } = require('./convs');
const { revokeConv } = require('./browser');
const { runMember } = require('./run');
const { broadcastSkills, listSkills, noteSkillUse, parseSkill, syncSkillsTo, writeSkill } = require('./skills');
const { TAG_NEED, TAG_STANCE, TAG_REVIEW, agentPrompt, extractOptions, loginHint, msgLine, transcript, describePrompt } = require('./prompts');

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

// mode：'discuss' = 老板点了"开会讨论"；不点名、也没开会时，由主脑一个人直接回答
function onBossMessage(c, text, attachments, mode) {
  const pending = pendingDecision(c);
  const { ids, all } = mentionsIn(text, null);
  // 有一条结论在等老板拍板时，没 @ 人的回复就当作拍板
  const isDecision = !!(pending && text && !ids.length && !all);
  newMsg(c, 'boss', text, { attachments, ...(isDecision ? { reason: 'decision' } : {}) });
  if ((c.title === '新对话' || c.title === 'New chat') && text) {
    c.title = text.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, EN() ? 40 : 20) || T('新对话', 'New chat');
    saveConv(c);
  }
  broadcastConvList();
  const r = rt(c);
  if (isDecision) { decide(c, pending); return; }
  if (pending) { pending.decided = 'other'; update(c, pending); }
  if (!ids.length && !activeIds(c).length) { sys(c, T('这次没有可以干活的队友：要么都没勾选参与，要么不在线。在输入框下方的"参与"里选几位，或者点右上角的光点看原因。', 'No teammate can take this: none are selected, or none are online. Pick some under "Working" below the input box, or click the lights at the top right to see why.')); return; }

  r.redos = 0;
  if (ids.length && !all) {
    // 点了名：按 @ 的先后顺序依次来
    ids.forEach((id, i) => r.jobs.push({ type: 'turn', member: id, reason: 'mention', after: ids.slice(0, i) }));
    r.hops = 0;
  } else if (r.running && r.phase === 'discuss') {
    sys(c, T('大家会在下一轮讨论里看到老板这条消息。', 'The team will see this message in the next discussion round.'));
    return;
  } else if (all || mode === 'discuss') {
    // 老板发起开会（"开会讨论"按钮，或者写了 @大家 / @全员）
    r.jobs.push({ type: 'discuss' });
    r.hops = 0;
  } else {
    r.jobs.push({ type: 'turn', member: mainBrain(c), reason: 'main' });
    r.hops = 0;
  }
  if (!r.running) pump(c); else broadcastState(c);
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
      if (job.type === 'discuss') { await runDiscussion(c, myGen, job); continue; }
      if (job.type === 'skill') { await distillSkill(c, myGen, job); continue; }
      const m = members[job.member];
      if (!m || !m.online) { sys(c, T(`${m ? m.name : job.member} 不在线，跳过。`, `${m ? m.name : job.member} is offline, skipped.`)); continue; }
      r.phase = job.reason;
      const before = listFiles(c);
      const msg = await agentTurn(c, m, job, myGen);
      if (!msg) continue;
      attachFiles(c, before, [msg]);
      afterReview(c, msg);
      queueHandoffs(c, m, msg);
      noteDelivery(c, m, msg, job);
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
  r.jobs.push({ type: 'turn', member: writer, reason: 'decided' });
  r.hops = 0;
  if (!r.running) pump(c); else broadcastState(c);
}

// 老板在主脑的回答下面点"让大家讨论一下"：其他大脑先独立作答（看不到主脑那一版），再一起讨论
function escalate(c, msgId) {
  const r = rt(c);
  const base = c.messages.find((m) => m.id === msgId);
  if (!base || base.reason !== 'main' || base.status !== 'done') return T('只能把主脑的回答拿去讨论', "Only the main brain's answer can be taken to a meeting");
  if (r.running) return T('等这一轮做完再开会', 'Wait until the current work finishes');
  if (base.escalated) return T('这条回答已经讨论过了', 'This answer has already been discussed');
  base.escalated = true;
  update(c, base);
  sys(c, T(`老板请大家讨论一下 ${nameOf(base.from)} 的回答`, `You asked the team to discuss ${nameOf(base.from)}'s answer`), { divider: true });
  r.jobs.push({ type: 'discuss', escalate: base.id });
  r.hops = 0;
  r.redos = 0;
  pump(c);
  return null;
}

// 队友交给别人的活做完了：记下来，这一批都做完后由主脑统一验收
function noteDelivery(c, m, msg, job) {
  const r = rt(c);
  if (job.reason !== 'handoff' || msg.status !== 'done') return;
  const main = mainBrain(c);
  if (!main || m.id === main) return;
  // 交付的人顺手 @ 了主脑（"请验收"）：不当普通接力，统一走下面的验收
  r.jobs = r.jobs.filter((q) => !(q.type === 'turn' && q.reason === 'handoff' && q.member === main && q.by === m.id));
  (r.toReview = r.toReview || []).push(msg.id);
  if (r.jobs.some((q) => q.type === 'turn' && q.reason === 'handoff')) return;
  const of = r.toReview.splice(0);
  if (settings.conclusionBy !== main) sys(c, T(`主脑 ${nameOf(settings.conclusionBy)} 这次不在，由 ${nameOf(main)} 代为验收。`, `The main brain ${nameOf(settings.conclusionBy)} isn't available, so ${nameOf(main)} reviews this time.`));
  r.jobs.push({ type: 'turn', member: main, reason: 'review', of });
}
// 验收结果：退回超过 2 次就先停下，请老板看一眼（免得来回返工没完没了）
const MAX_REDOS = 2;
function afterReview(c, msg) {
  const r = rt(c);
  if (msg.reason !== 'review') return;
  if (msg.review !== 'redo') { r.redos = 0; return; }
  r.redos = (r.redos || 0) + 1;
  if (r.redos > MAX_REDOS) {
    msg.reviewStop = true;
    update(c, msg);
    sys(c, T(`已经退回重做 ${MAX_REDOS} 次了，先停一下，请老板看看怎么处理。`, `Work has been sent back ${MAX_REDOS} times. Pausing so you can decide what to do.`));
  }
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
  const { ids } = mentionsIn(msg.text, m.id);
  const act = activeIds(c);
  for (const id of ids) {
    if (r.jobs.some((q) => q.type === 'turn' && q.member === id)) continue;
    if (!act.includes(id)) { sys(c, T(`${nameOf(id)} 这次没有参与（或不在线），${nameOf(m.id)} 交给 Ta 的活没有派出去。需要的话，老板可以直接 @ Ta。`, `${nameOf(id)} isn't working on this (or is offline), so ${nameOf(m.id)}'s hand-off wasn't sent. @ them directly if you want them in.`)); continue; }
    if (r.hops >= settings.maxAutoTurns) {
      sys(c, T(`队友之间已经自动接力 ${settings.maxAutoTurns} 次了，先停一下，等老板看一眼再继续。`, `Teammates have handed off ${settings.maxAutoTurns} times in a row. Pausing here so you can take a look.`));
      r.jobs = r.jobs.filter((q) => q.reason !== 'handoff');
      break;
    }
    r.hops++;
    r.jobs.push({ type: 'turn', member: id, reason: 'handoff', by: m.id });
  }
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
- 合并、去重、压缩：新信息推翻旧信息时，直接改成新的，不要留着矛盾的两条。总长度尽量控制在 1500 字以内。
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

【当前记忆】
${readMemory(c) || memTemplate()}

【新增对话】
${lines}`;
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
  r.working.add(m.id);
  broadcastState(c);
  const lastBoss = [...c.messages].reverse().find((x) => x.from === 'boss');
  const images = (lastBoss && lastBoss.attachments || []).filter((a) => a.image).map((a) => path.join(convDir(c), a.path));
  if (m.type !== 'api') syncSkillsTo(c);
  // 最后一个参数：API 队友的接口不支持工具时，用它重新拼一份"只动脑"的提示词
  const res = await runMember(c, m, agentPrompt(c, m, turn), msg, images, () => agentPrompt(c, m, turn));
  r.working.delete(m.id);
  if (myGen !== r.gen) return null;
  msg.endedAt = Date.now();
  if (res.text) {
    const tags = extractTags(res.text);
    let text = noteSkillUse(tags.text, msg);
    if (turn.reason === 'initial') msg.needDiscuss = tags.need === true;
    if (turn.reason === 'discuss') msg.stance = tags.stance || 'agree';
    if (turn.reason === 'review') {
      const rv = text.match(TAG_REVIEW);
      msg.review = rv ? { 通过: 'pass', 已修改: 'fixed', 退回: 'redo' }[rv[1]] : 'pass';
      msg.reviewOf = turn.of || [];
      if (rv) text = text.replace(TAG_REVIEW, '').replace(/^[\s，,。:：]+/, '') || text;
    }
    if (turn.reason === 'conclusion' && !turn.consensus) { const o = extractOptions(text); text = o.text || text; msg.options = o.options; }
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
  r.working.clear();
  r.running = false;
  r.phase = '';
  for (const m of c.messages) if (m.status === 'running') { m.status = 'stopped'; if (!m.text) m.text = '（被老板叫停）'; update(c, m); }
  if (note) sys(c, note);
  broadcastState(c);
  broadcastConvList();
}

function anyRunning() { return [...convs.values()].some((c) => c.rt && c.rt.running); }

module.exports = { ALL_WORDS, mentionsIn, brainIds, mainBrain, escalate, onBossMessage, pump, parallelRound, runDiscussion, pendingDecision, decide, attachFiles, queueHandoffs, seqOf, newSinceMemory, needsMemory, memoryPrompt, updateMemory, distillPrompt, distillSkill, extractTags, agentTurn, stopConv, anyRunning };
