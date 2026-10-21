// Hola · 提示词：拼给队友的提示词、各阶段的说明、回复里的标记
'use strict';
const { ATTACH_DIR, EN, IS_WIN, MEMORY_NAME, T, debateText, profile, profileText, settings } = require('./core');
const { enabledIds, members, strengthsOf } = require('./members');
const { TEXT_DIR, clip, listingText, nameOf, projectText, readMemory } = require('./convs');
const { skillsPromptText } = require('./skills');

// ---------------------------------------------------------------- 提示词

let curActive = null;
function rosterText(selfId) {
  return enabledIds().map((id) => members[id]).map((m) =>
    `- ${m.name}${m.id === selfId ? '（就是你）' : ''}：${strengthsOf(m)}` +
    (m.type === 'api' ? '。通过 API 接入：不能读写文件、不能联网，只能根据群聊内容思考和写作' : m.readOnly ? '。只读：能读文件、查资料，不能写文件' : '') +
    (!m.online ? '。【当前不在线】' : curActive && !curActive.includes(m.id) ? '。【这次没有参与】' : '')).join('\n');
}

function msgLine(m) {
  const files = (m.attachments || []).concat(m.files || []);
  const att = files.length ? `\n（${m.from === 'boss' ? '附件' : '产出文件'}：${files.map((f) => f.path + (f.textVersion ? `，文字版 ${f.textVersion}` : '')).join('；')}）` : '';
  const ph = m.reason === 'initial' ? ' · 独立作答' : m.reason === 'discuss' ? ` · 讨论第${m.round}轮${m.stance === 'object' ? ' · 有异议' : m.stance === 'agree' ? ' · 同意' : ''}` : m.reason === 'conclusion' ? (m.awaitDecision ? ' · 团队结论（有分歧，请老板拍板）' : ' · 团队结论') : m.reason === 'decided' ? ' · 按老板拍板执行' : m.reason === 'decision' ? ' · 拍板' : '';
  const opts = (m.options || []).length ? '\n' + m.options.map((o) => `【方案${o.key}】${o.text}`).join('\n') : '';
  return `[${nameOf(m.from)}${ph}] ${clip(m.text, 4000)}${opts}${att}`;
}

function transcript(c) {
  const msgs = c.messages.filter((m) => (m.text || (m.attachments || []).length) && m.status !== 'running' && m.reason !== 'memory' && m.reason !== 'skill');
  let pick = msgs.slice(-50);
  const firstBoss = msgs.find((m) => m.from === 'boss');
  if (firstBoss && !pick.includes(firstBoss)) pick = [firstBoss, { from: 'system', text: '（中间较早的记录已省略，要点见对话记忆）' }, ...pick];
  return pick.map(msgLine).join('\n\n');
}

const TAG_NEED = /^[ \t>*_]*【?\s*需要讨论\s*】?\s*[:：]?\s*(是|否)\s*[*_]*\s*$/m;
const TAG_STANCE = /^[ \t>*_]*【?\s*立场\s*】?\s*[:：]?\s*(同意|有异议)\s*[*_]*\s*$/m;
const TAG_OPTION = /^[ \t>*_#-]*(?:\d+[.、)）]\s*)?[ \t*_]*【\s*方案\s*([A-Da-dＡ-Ｄａ-ｄ1-4１-４])\s*】\s*[:：]?\s*(.+?)\s*[*_]*\s*$/gm;

// 没谈拢时，结论里的【方案A】… 行拆出来做成按钮
function extractOptions(text) {
  const options = [];
  const out = text.replace(TAG_OPTION, (_, k, t) => {
    let key = k.replace(/[Ａ-Ｚａ-ｚ１-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).toUpperCase();
    if (/\d/.test(key)) key = 'ABCD'[Number(key) - 1];
    if (!options.some((o) => o.key === key)) options.push({ key, text: t.replace(/^\*+|\*+$/g, '').trim().slice(0, 300) });
    return '';
  });
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), options };
}

function phaseGuide(c, m, turn) {
  const names = (ids) => ids.map(nameOf).join('、');
  switch (turn.reason) {
    case 'initial':
      return `老板发了新消息，没有点名，参与的队友同时、独立作答（这一轮你看不到其他队友的回答）。
请从你的长处出发，给出你自己的观点、答案或方案。
这是讨论阶段：可以读文件、查资料，但先不要生成正式的交付文件——等团队讨论出共识后再动手。
回复的最后单独一行必须是下面二选一：
【需要讨论】是　——问题有取舍、需要判断、大家很可能有不同看法
【需要讨论】否　——简单问候、事实性问题、或答案很明确`;
    case 'discuss':
      return `现在是团队内部讨论第 ${turn.round} 轮，老板不参与，靠你们自己的判断形成共识。
请认真读队友在前面几轮说的话：
- 指出你认同的有价值的部分（可以吸收进自己的方案）；
- 指出你不同意的地方，并给出理由；
- 补充大家都漏掉的关键点；必要时修正你自己的立场。
目标是得出一个最好的团队结论，不是礼貌附和：有实质分歧就说清楚，被说服了就直接说"我同意 X 的看法"。只谈有意义的点，简洁。${debateText() ? '\n' + debateText() : ''}
这一轮也不要生成正式交付文件。
回复的最后单独一行必须是下面二选一：
【立场】同意　——你认为团队已经可以形成一致结论（哪怕措辞细节不同）
【立场】有异议　——还有值得继续讨论的实质分歧`;
    case 'conclusion':
      if (!turn.consensus) return `团队讨论结束：讨论了 ${turn.rounds} 轮，仍有分歧。由你代表团队给老板写结论，请老板拍板。
- 开头用一两句话说清楚大家在哪些地方已经一致、卡在哪个分歧上，不要复述过程。
- 把可选的做法整理成 2～3 个方案，每个方案单独一行，严格用这个格式（标签保持中文，哪怕你用英文回复）：
【方案A】一句话说清这个方案（支持：名字、名字）
【方案B】……
- 方案行之后，简要写各方的理由，再写一句你建议老板选哪个、为什么。
- 老板拍板之前谁都不动手：这次不要 @ 任何人，也不要生成正式交付文件。`;
      return `团队讨论结束：大家已经达成共识。由你代表团队，给老板写最终结论。
- 开头直接给出答案、方案或决定，吸收讨论中有价值的部分，不要复述过程。
- 可以用一两句话点出讨论中最关键的取舍。
- 如果结论需要动手执行（做文件、写代码、出图等），在最后按分工写"@名字 + 具体任务"，队友会自动接手；你也可以自己做你那部分。`;
    case 'decided':
      return `团队讨论没谈拢，老板已经拍板（见群聊最后一条老板的消息）。不要再讨论，照老板的决定执行：
- 开头一句话复述老板的决定。
- 需要动手的部分按分工写"@名字 + 具体任务"，队友会自动接手；你也可以自己做你那部分。
- 如果老板这条消息其实还没做决定（只是追问、或者补充了要求），就直接回答他，这次不要 @ 任何人，也不要开始做交付文件。`;
    case 'mention':
      return turn.after && turn.after.length
        ? `老板按顺序点名，你排在 ${names(turn.after)} 之后：先看他们刚做完的部分，再接着做你的。`
        : `老板点名让你来做。`;
    case 'handoff':
      return `${nameOf(turn.by)} 在群里 @ 了你，请接着处理交给你的部分。`;
    default:
      return '';
  }
}

const LOGIN_BAT = IS_WIN
  ? { claude: 'Login-Claude.bat', codex: 'Login-Codex.bat', gemini: 'Login-Gemini.bat' }
  : { claude: 'mac/Login-Claude.command', codex: 'mac/Login-Codex.command', gemini: 'mac/Login-Gemini.command' };
function loginHint(m) {
  if (m.type === 'api') return T('\n\n常见原因：API Key 不对、余额不足，或模型名写错了。', '\n\nCommon causes: wrong API key, no balance left, or a wrong model name.');
  const how = LOGIN_BAT[m.id] ? T(`双击 Hola 文件夹里的 ${LOGIN_BAT[m.id]} 重新登录`, `double-click ${LOGIN_BAT[m.id]} in the Hola folder to sign in again`)
    : T(`在终端运行一次 ${m.cmd} 重新登录`, `run ${m.cmd} once in a terminal to sign in again`);
  const picked = (settings.memberPrefs[m.id] || {}).model;
  return T(`\n\n常见原因：登录过期（${how}），或订阅额度用完。`, `\n\nCommon causes: the sign-in expired (${how}), or the subscription quota ran out.`) +
    (picked ? T(`也可能是选的模型 ${picked} 这个订阅用不了：到"队友 → 编辑"把模型改回"默认"。`, ` Or the chosen model ${picked} isn't available on this subscription: set it back to "Default" under Teammates → Edit.`) : '');
}
function replyLangRule() {
  if (profile.language === 'en') return '用英文（English）回复。';
  if (profile.language === 'zh') return '用中文回复。';
  if (profile.language === 'follow') return '用老板最近一条消息所用的语言回复。';
  return EN() ? '老板使用英文界面：用英文（English）回复，除非老板用中文跟你说话。' : '用中文回复，除非老板用其他语言跟你说话。';
}

function agentPrompt(c, m, turn) {
  curActive = c.active || null;
  const discussing = turn.reason === 'initial' || turn.reason === 'discuss' || (turn.reason === 'conclusion' && !turn.consensus);
  return `你是 Hola 团队里的 ${m.name}。Hola 是几位 AI 平等协作的团队，老板（用户）是包工头：他用 @ 指定谁来做、按什么顺序做；没点名时，参与的队友先各自思考，再自己讨论出结论。

团队成员：
${rosterText(m.id)}

基本规则：
1. 大家地位平等，各自发挥长处：可以补充、质疑、接着往下做，不要重复队友已经说过的话。
2. ${discussing ? '讨论阶段提到队友时直接写名字就行，不要用 @（@ 表示正式交活）。' : '需要队友动手时，写"@名字 + 具体要做的事"，他会自动接手。只在真的需要对方动手时才 @，不要 @ 自己，也不要 @ 标着"这次没有参与"的队友。'}
3. ${m.type === 'api' ? '你是通过 API 接入的，不能读写文件、不能联网：只根据群聊内容和附在最后的附件文字来思考和写作；需要做文件或查资料时，请能做的队友来做。' : `当前目录是这个对话的专属文件夹。交付物放在这里，取清楚的文件名，并在回复里写明。生成的图片、视频、音频也一定要保存到当前目录（不要只留在你自己的界面或临时目录里），老板才能在群里直接看到和下载。老板发来的附件在"${ATTACH_DIR}"文件夹里。Word、Excel、PPT 文件都有系统自动转好的文字版（在"${TEXT_DIR}"文件夹，文件列表里有标注），读不了原文件时就读文字版。`}
4. "${MEMORY_NAME}"是本对话的记忆：系统会在每轮结束后自动整理，你不用改它，但要遵守里面记下的偏好和结论。
5. ${replyLangRule()}像在工作群里说话：先给结论，简洁具体。
6. 下面有【Hola 技能库】时：动手前看一眼，任务符合某个技能就照着做；用了的话，在回复第一行单独写"【技能】技能名"。

${profileText()}${projectText(c)}${skillsPromptText(c, m)}【本对话记忆（${MEMORY_NAME}）】
${clip(readMemory(c), 6000) || '（空）'}

【当前文件夹里的文件】
${listingText(c)}

===== 群聊记录 =====
${transcript(c)}
===== 记录结束 =====

现在轮到你（${m.name}）。${phaseGuide(c, m, turn)}`;
}

module.exports = { curActive, rosterText, msgLine, transcript, TAG_NEED, TAG_STANCE, TAG_OPTION, extractOptions, phaseGuide, LOGIN_BAT, loginHint, replyLangRule, agentPrompt };
