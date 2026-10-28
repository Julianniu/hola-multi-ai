// Hola · 提示词：拼给队友的提示词、各阶段的说明、回复里的标记
'use strict';
const { ATTACH_DIR, EN, IS_WIN, MEMORY_NAME, ROOT, T, debateText, profile, profileText, settings, wick } = require('./core');
const fs = require('fs');
const path = require('path');
const { enabledIds, isHelper, members, strengthsOf } = require('./members');
const { TEXT_DIR, clip, convDir, listingText, nameOf, projectText, readMemory, textVersionRel } = require('./convs');
const { pinnedText } = require('./library');
const { apiFull, canAct } = require('./tools');
const { skillsPromptText } = require('./skills');
const { hash } = require('./wick-session');
const wickEnv = require('./wick-env');
const { envText } = wickEnv;
const { cardsText } = require('./wick-cards');
const { browserReady } = require('./browser');
const { mcpNames } = require('./mcp');

// ---------------------------------------------------------------- 提示词

let curActive = null;
function rosterText(selfId) {
  return enabledIds().map((id) => members[id]).map((m) =>
    `- ${m.name}${m.id === selfId ? '（就是你）' : ''}：${strengthsOf(m)}` +
    (m.type === 'api' ? (canAct(m) ? `。通过 API 接入：能读写对话文件夹里的文件、生成 Word / Excel / PPT、搜索和读网页${apiFull(m) ? '、运行命令' : ''}` : '。通过 API 接入：不能读写文件、不能联网，只能根据群聊内容思考和写作') : m.readOnly ? '。只读：能读文件、查资料，不能写文件' : '') +
    (isHelper(m.id) ? '。帮手：不参与讨论，只接活' : '') +
    (!m.online ? '。【当前不在线】' : curActive && !curActive.includes(m.id) ? '。【这次没有参与】' : '')).join('\n');
}

function msgLine(m) {
  const files = (m.attachments || []).concat(m.files || []);
  const att = files.length ? `\n（${m.from === 'boss' ? '附件' : '产出文件'}：${files.map((f) => f.path + (f.textVersion ? `，文字版 ${f.textVersion}` : '')).join('；')}）` : '';
  const ph = m.reason === 'main' ? ' · 主脑直接回答' : m.reason === 'review' ? ` · 主脑验收（${{ pass: '通过', fixed: '已修改', redo: '退回' }[m.review] || '通过'}）` : m.reason === 'initial' ? ' · 独立作答' : m.reason === 'discuss' ? ` · 讨论第${m.round}轮${m.stance === 'object' ? ' · 有异议' : m.stance === 'agree' ? ' · 同意' : ''}` : m.reason === 'conclusion' ? (m.awaitDecision ? ' · 团队结论（有分歧，请老板拍板）' : ' · 团队结论') : m.reason === 'decided' ? ' · 按老板拍板执行' : m.reason === 'decision' ? ' · 拍板' : m.reason === 'fix' ? ' · 交付前自查返工' : m.reason === 'replan' ? ' · 按老板的新要求调整' : '';
  const opts = (m.options || []).length ? '\n' + m.options.map((o) => `【方案${o.key}】${o.text}`).join('\n') : '';
  return `[${nameOf(m.from)}${ph}] ${clip(m.text, 4000)}${opts}${att}`;
}

// hide：这一轮不给看的消息（老板把主脑的回答拿去开会时，其他大脑先独立作答，看不到主脑那一版）
// 队友能看到的消息（不含整理记忆这类后台活、正在写的、这一轮要藏起来的）
const visible = (c, hide) => c.messages.filter((m) => (m.text || (m.attachments || []).length) && m.status !== 'running' && m.reason !== 'memory' && m.reason !== 'skill' && m.reason !== 'describe' && !(hide || []).includes(m.id));
function pickMsgs(c, hide) {
  const msgs = visible(c, hide);
  let pick = msgs.slice(-50);
  const firstBoss = msgs.find((m) => m.from === 'boss');
  if (firstBoss && !pick.includes(firstBoss)) pick = [firstBoss, { from: 'system', text: '（中间较早的记录已省略，要点见对话记忆）' }, ...pick];
  return pick;
}
function transcript(c, hide) {
  return pickMsgs(c, hide).map(msgLine).join('\n\n');
}

// 规矩墙（第一版，wick rulesWall）：群聊记录只放最近 50 条，更早的老板原话单独原样列出来——
// 老板定的规矩不能因为聊久了被挤出去（基线 S12：第 5 条定的规矩，到第 60 条四位队友全忘了）。
// 不靠关键词挑"像规矩的话"，老板较早的话全部列上（老板的话通常很短），超出篇幅时留最新的。
const WALL_MAX = 4000;
// 老板亲手整理的规矩（对话记忆抽屉里的"规矩墙"，c.rules）：每一轮都原样放进去，不压缩、不截掉
function pinnedRulesText(c) {
  const list = (Array.isArray(c.rules) ? c.rules : []).map((r) => String(r.text || r || '').trim()).filter(Boolean);
  return list.length ? `【老板定下的规矩（老板亲自整理的，每一条都要遵守）】\n${list.map((r) => '- ' + r).join('\n')}\n\n` : '';
}
function earlierBossText(c, hide) {
  if (!wick('rulesWall')) return '';
  const msgs = c.messages.filter((m) => (m.text || (m.attachments || []).length) && m.status !== 'running' && m.reason !== 'memory' && m.reason !== 'skill' && m.reason !== 'describe' && !(hide || []).includes(m.id));
  if (msgs.length <= 50) return '';
  const firstBoss = msgs.find((m) => m.from === 'boss');
  const older = msgs.slice(0, -50).filter((m) => m.from === 'boss' && m !== firstBoss && String(m.text || '').trim());
  const lines = [];
  let total = 0;
  for (let i = older.length - 1; i >= 0; i--) {
    const line = `- [第 ${Number(String(older[i].id).split('-')[1]) || '?'} 条] ${clip(older[i].text, 500)}`;
    if (total + line.length > WALL_MAX) { lines.unshift(`- （更早的 ${i + 1} 条已省略，要点见对话记忆）`); break; }
    lines.unshift(line);
    total += line.length;
  }
  return lines.length ? `【老板较早说过的话（原话，按时间先后；后说的覆盖先说的；里面的要求都要遵守）】\n${lines.join('\n')}\n\n` : '';
}

const TAG_NEED = /^[ \t>*_]*【?\s*需要讨论\s*】?\s*[:：]?\s*(是|否)\s*[*_]*\s*$/m;
const TAG_STANCE = /^[ \t>*_]*【?\s*立场\s*】?\s*[:：]?\s*(同意|有异议)\s*[*_]*\s*$/m;
const TAG_REVIEW = /^[ \t>*_#]*【\s*验收\s*】\s*[:：]?\s*[*_]*\s*(通过|已修改|退回)/m;
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

// 干活策略：主脑用订阅（命令行）时默认质量优先，用 API（按量付费）时默认均衡
function policyOf(m) {
  const p = settings.policy;
  return ['quality', 'balanced', 'saving'].includes(p) ? p : m.type === 'api' ? 'balanced' : 'quality';
}
// 这次能接活的帮手
function helpersNow() { return enabledIds().filter((id) => isHelper(id) && members[id].online && (!curActive || curActive.includes(id))); }
// 主脑（写结论 / 直接回答 / 拍板后执行的人）怎么分配活：没有帮手时什么都不加
function delegateText(m) {
  const hs = helpersNow().filter((id) => id !== m.id);
  if (!hs.length) return '';
  const who = hs.map(nameOf).join('、');
  return '\n' + {
    quality: `干活分工（质量优先）：能自己做的都自己做；只有你自己确实做不了的（比如你不能写文件、不能联网），才 @帮手（${who}）交给他们。`,
    balanced: `干活分工（均衡）：核心判断、创意方向、关键文案和最终结论你自己写；格式转换、做表、整理资料、搜索、批量改写、排版、翻译初稿这类粗活和长篇体力活，写清楚要求和标准后 @帮手（${who}）交给他们。`,
    saving: `干活分工（省钱）：你只出方案、定标准、做验收，自己尽量少写长文；能交出去的活都写清楚要求和标准，@帮手（${who}）去做。`,
  }[policyOf(m)] + '帮手交付后，由你负责验收。';
}
// 验收时附上交付文件的文字（给不能自己读文件的主脑看）
function deliveredText(c, ids) {
  const files = c.messages.filter((x) => (ids || []).includes(x.id)).flatMap((x) => x.files || []);
  return files.slice(0, 6).map((f) => {
    let t = '';
    try { const tv = textVersionRel(c, f.path); t = fs.readFileSync(path.join(convDir(c), tv || f.path), 'utf8'); } catch (_) {}
    return t ? `\n--- ${f.path} ---\n${clip(t, 8000)}` : `\n--- ${f.path}（不是文字文件，看不到内容）---`;
  }).join('');
}

// ---------------------------------------------------------------- Hola 文档标准（wick docGuide）

// 这次是不是要做 Word / PPT / Excel：看老板最后一条消息；接力、返工、验收时再看交活的那几条
const OFFICE_ASK = /word|ppt|excel|docx|pptx|xlsx|文档|演示|幻灯|表格|报告|方案|简报|汇报|海报|手册|清单/i;
function wantsOffice(c, turn) {
  const boss = [...c.messages].reverse().find((x) => x.from === 'boss');
  const relay = ['handoff', 'fix', 'review'].includes(turn.reason) ? c.messages.filter((x) => x.from !== 'system' && x.from !== 'boss').slice(-3) : [];
  return [boss, ...relay].some((x) => x && (OFFICE_ASK.test(x.text || '') || (x.files || []).some((f) => /\.(docx|pptx|xlsx)$/i.test(f.path))));
}
// 做文件的回合加一段"Hola 文档标准"：API 队友讲清楚 write_file 的 Markdown 怎么写能排出好版式；
// 命令行队友给最低要求（自己的设计更好就按自己的来）+ Hola 排版 / 检查工具的命令。开会的三个阶段不加。
function docStandardText(c, m, turn) {
  if (!wick('docGuide') || ['initial', 'discuss', 'conclusion'].includes(turn.reason) || !wantsOffice(c, turn)) return '';
  if (m.type === 'api' && !canAct(m)) return '';
  if (m.type === 'api') return `

【Hola 文档标准】write_file 生成 Word / PPT / Excel 时，Hola 会自动排版（深蓝主色、表头、页码），你只管把 Markdown 结构写对：
- Word：开头一个"# 文档标题"，"## 一、……"是一级小标题，"###"是二级；"注意：/ 说明：/ 提示："开头的段落会排成提示框；数据用 | 表格 |。
- PPT：第一个"# 标题"加不超过三行副标题 = 深色封面；之后每个"## 标题"一页，标题写结论（不要只写"卖点"两个字）。一页里 2～4 条"- **小标题**：一句说明"会排成并排卡片；对比或数据用一张 | 表格 |；页尾"※ ……"的一行会放进页脚小字。每页不超过 6～8 行，字多就拆成两页。
- Excel：每个 | 表格 | 一个工作表，表格前的"## 名字"是工作表名；数字只写数字（不带单位），单位写在表头里。
- 写完会自动检查，返回结果里有问题就改好再交。`;
  const tool = wickEnv.hasNode ? `node "${path.join(ROOT, 'tools', 'hola-doc.js')}"` : '';
  return `

【Hola 文档标准（最低要求）】做 Word / PPT / Excel 时：
- Word：一套配色和字体用到底（没有别的要求就用 Hola 配色：主色深蓝 #2F5597、深色 #1D2B57、浅底 #F5F7FB、细线 #D5DCEA，中文字体微软雅黑）；标题分层（用 Word 的标题样式），正文 10.5～11 磅、1.5 倍行距，表格有表头底色、数字右对齐，有页眉页码。
- PPT：版式和配色按你自己的设计来；硬性要求只有这几条——页数按老板说的，字号不小于 14 磅，文字不能超出框和页面，数据用真表格或图表（不要用竖线拼表格）。
- Excel：表头醒目、冻结首行、列宽合适；数字存成数字；用了公式就保存算好的结果（不然预览和手机上是空白）。
${tool ? `- 交付前可以用这条命令再查一遍（几秒钟，查打不开、没写完的占位、PPT 文字和表格溢出、Excel 错误值）：${tool} check 文件名` : ''}`;
  // 2026-10-24 A/B：给命令行队友"用 Hola 排版器一键生成"的捷径，Claude 就不自己设计了，PPT 盲评反而输给关掉时；
  // 叫它们"自己打开检查"，Gemini 反复渲染截图改了 20 分钟（关掉时 6 分钟）。所以只给最低要求和检查命令。
  // 第二轮：PPT 的配色、卡片这些样式要求也让 Claude、Codex 做得更像模板（盲评输给关掉时），PPT 只留硬性要求；Word 的样式要求四家都变好，保留。
  // 第三轮："不用反复截图对比"让 Claude 连自己习惯的那一次看图检查也省了（快了一倍，但有一份表格坏了没发现），改成中性的一句。
}

// 主脑派活时附上队友能力卡（wick cards）：只在主脑直接回答、按新要求调整这两种回合，而且有帮手时才给
function teamCards(c, m, turn) {
  if (!wick('cards') || !['main', 'replan'].includes(turn.reason) || !helpersNow().length) return '';
  return cardsText((c.active || enabledIds()).filter((id) => id !== m.id && members[id] && members[id].online));
}

// 这一项的来历：顶替别人的、老板改派的、Hola 重启打断后接着做的（开会的回合不会有这些）
// 干活的回合告诉队友"你运行在 Hola 里"：开会的几个阶段（独立作答 / 讨论 / 结论 / 拍板后执行）不加，那几段原文锁死了
const MEETING = ['initial', 'discuss', 'conclusion', 'decided'];
function holaContext(c, m, turn) {
  if (!wick('holaContext') || MEETING.includes(turn.reason)) return '';
  const api = m.type === 'api';
  const web = browserReady() && (api ? canAct(m) : ['claude-stream', 'codex-json'].includes(m.parser));
  const now = new Date();
  const lines = [
    ...(wick('clock') ? [`现在是 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}（星期${'日一二三四五六'[now.getDay()]}）。`] : []),
    '你运行在 Hola 里：这是老板电脑上的一个桌面应用，把几位 AI 拉进一个群里协作。Hola 每轮单独叫你一次，你最后的回复会直接发到群里；老板看不到你的思考过程和工具界面，只看得到回复和你存下的文件。',
    '这一轮中途不能停下来问老板：能自己做的直接做完；真的需要老板定的，写在回复里，等他下一条消息。' + (api ? '' : '不要让老板去终端运行命令，需要运行的你自己运行。'),
  ];
  if (!api || canAct(m)) lines.push('交付物存进当前对话的文件夹，群里会自动出现文件卡片，老板点一下就能预览和下载。');
  if (c.folder) lines.push(`这个对话用的是老板自己电脑上的文件夹（${c.folder}），里面原有的文件都是老板的：要改先读、看清楚，不要删除、移动或批量整理老板原有的文件，除非老板明确要求；新做的东西取清楚的文件名，别覆盖同名文件。`);
  if (web) lines.push('你可以用 Hola 的内置浏览器打开、阅读网页（老板能同时看到）；点按钮、填表之前 Hola 会先问老板。');
  if (mcpNames(m).length) lines.push(`老板给你接了这些外部工具（MCP）：${mcpNames(m).join('、')}。发消息、改数据这类操作 Hola 会先问老板。`);
  return '\n\n【你所在的环境】\n' + lines.join('\n');
}
function workNotes(turn) {
  const notes = [];
  if (turn.subFor) notes.push(`这一项原本是 ${nameOf(turn.subFor)} 的，Ta 额度用完、登录失效或者不在线，由你顶上。`);
  if (turn.reassigned) notes.push(`这一项原本交给 ${nameOf(turn.reassigned)}，老板改派给了你。`);
  if (turn.resumed) notes.push('Hola 上次重启打断了这一项：先看看群聊和文件夹里已经做了什么（可能有做了一半的文件、跑过的命令），接着做完，不要从头重复已经做好的部分。');
  return notes.length ? '\n' + notes.join('\n') : '';
}

// 验收时附上 Hola 交付前检查的结果（返工后还剩的问题、小毛病），只列最后一次的
function checkNotes(of) {
  const last = new Map();
  for (const x of of) for (const p of x.check || []) last.set(p.file || p.msg, p);
  const fixed = new Set(of.filter((x) => x.reason === 'fix').map((x) => x.id));
  const list = [...last.values()];
  if (!list.length) return fixed.size ? '\nHola 交付前检查：发现的问题已经让交付的人返工过一次。' : '';
  return `\nHola 交付前自动检查的结果（验收时重点看）：\n${list.map((p) => `- ${p.level === 'error' ? '问题' : '提醒'}：${p.file ? p.file + '：' : ''}${p.msg}`).join('\n')}`;
}

function phaseGuide(c, m, turn) {
  const names = (ids) => ids.map(nameOf).join('、');
  switch (turn.reason) {
    case 'main':
      return `老板这次没有点名，也没有发起开会：由你（主脑）直接回答。${delegateText(m)}`;
    case 'replan':
      return turn.of
        ? `你刚才给出的分工方案，老板还没开工，回复了修改意见（见群聊最后一条老板的消息）。按老板的意见调整：老板只是问问题就直接回答；要改分工就重新写"@名字 + 具体任务"（会再请老板确认开工）；不需要队友了就自己做。${delegateText(m)}`
        : `大家正在按方案干活，老板插话补充或者改了要求（见群聊最后一条老板的消息）。还没开始的接力已经先撤下了。你是主脑：先看看已经做了什么（群聊和文件），再按新要求调整——自己能改的直接改；需要队友动手就按新的分工写"@名字 + 具体任务"（会再请老板确认一次）；新要求不影响已经做好的部分，说明一句就行。${delegateText(m)}`;
    case 'fix':
      return `【交付前自动检查】你刚交的文件，Hola 打开检查后发现了下面的问题：
${(turn.problems || []).map((p) => `- ${p.file ? p.file + '：' : ''}${p.msg}`).join('\n')}
请直接把文件改好（覆盖原来的文件，不要另存一个新名字），改完自己再打开检查一遍。回复里用一两句话说改了什么就行，不用重复之前的内容。`;
    case 'review': {
      const of = c.messages.filter((x) => (turn.of || []).includes(x.id));
      const who = names([...new Set(of.map((x) => x.from))]);
      const canRead = !(m.type === 'api' && !canAct(m));
      return `你是主脑，负责验收：${who} 刚交付了交给他们的活（见群聊最后几条消息和产出文件）。
请对照老板的要求和之前定下的结论认真检查：内容对不对、有没有遗漏和错误、格式能不能直接用。${canRead ? '打开交付的文件逐项看，不要只看对方的说明。' : '你不能读文件，交付文件的内容附在下面。'}
- 合格：回复第一行单独写"【验收】通过"，再用一两句话告诉老板交付了什么、在哪里。
- 有小问题：你直接改好（改文件，或者在回复里给出修正版），第一行写"【验收】已修改"，说明改了什么。
- 有大问题：第一行写"【验收】退回"，然后 @负责的人 写清楚要改什么、改到什么标准（这次不要自己重做）。
标签保持中文，哪怕你用英文回复。${checkNotes(of)}${canRead ? '' : deliveredText(c, turn.of)}`;
    }
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
- 如果结论需要动手执行（做文件、写代码、出图等），在最后按分工写"@名字 + 具体任务"，队友会自动接手；你也可以自己做你那部分。${delegateText(m)}`;
    case 'decided':
      return `团队讨论没谈拢，老板已经拍板（见群聊最后一条老板的消息）。不要再讨论，照老板的决定执行：
- 开头一句话复述老板的决定。
- 需要动手的部分按分工写"@名字 + 具体任务"，队友会自动接手；你也可以自己做你那部分。${delegateText(m)}
- 如果老板这条消息其实还没做决定（只是追问、或者补充了要求），就直接回答他，这次不要 @ 任何人，也不要开始做交付文件。`;
    case 'mention':
      return turn.after && turn.after.length
        ? `老板按顺序点名，你排在 ${names(turn.after)} 之后：先看他们刚做完的部分，再接着做你的。`
        : `老板点名让你来做。`;
    case 'handoff':
      return `${nameOf(turn.by)} 在群里 @ 了你，请接着处理交给你的部分。` + (wick('deliveryNote') ? `
做完后在回复最后单独写一段【交付单】，主脑会照着验收：
- 做了什么：一两句话
- 文件：文件名（放在哪）
- 自己查过：核对了哪些（比如数字算过一遍、文件打开看过）
- 没把握的：哪些是估计的、没核实的、没做完的（没有就写"无"）` : '');
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

// 请能看图的队友把图片写成文字说明（给看不到图片的队友读）
function describePrompt(rel) {
  return `你在帮 Hola 团队里看不到图片的队友"看图"。请仔细看这张图片：${rel}（就在当前文件夹里）。
用文字把它完整地描述出来，让没看到图的人也能参与讨论：
- 画面里有什么：主体、人物、产品、场景、构图；
- 图上的所有文字，按原样逐字抄下来（看不清的写"看不清"）；
- 配色、字体、排版风格和整体感觉；
- 如果是截图、图表或表格：把里面的数据和结构写清楚。
只写看到的事实，不评价好坏，不给建议。不要修改任何文件，不要运行命令。直接输出描述，不要开场白。
${replyLangRule()}`;
}

function promptParts(c, m, turn) {
  curActive = c.active || null;
  const discussing = turn.reason === 'initial' || turn.reason === 'discuss' || (turn.reason === 'conclusion' && !turn.consensus);
  // 团队说明末尾那几块会变的资料单独算（长会话里哪块变了只补发哪块，学 dsh 的运行时快照）
  const pieces = { env: envText(), profile: profileText(), pinned: pinnedText(), project: projectText(c), skills: skillsPromptText(c, m) };
  const header = `你是 Hola 团队里的 ${m.name}。Hola 是几位 AI 平等协作的团队，老板（用户）是包工头：他用 @ 指定谁来做、按什么顺序做；没点名时，参与的队友先各自思考，再自己讨论出结论。

团队成员：
${rosterText(m.id)}

基本规则：
1. 大家地位平等，各自发挥长处：可以补充、质疑、接着往下做，不要重复队友已经说过的话。
2. ${discussing ? '讨论阶段提到队友时直接写名字就行，不要用 @（@ 表示正式交活）。' : '需要队友动手时，写"@名字 + 具体要做的事"，他会自动接手。只在真的需要对方动手时才 @，不要 @ 自己，也不要 @ 标着"这次没有参与"的队友。'}
3. ${m.type === 'api' && !canAct(m) ? '你是通过 API 接入的，不能读写文件、不能联网：只根据群聊内容和附在最后的附件文字来思考和写作；需要做文件或查资料时，请能做的队友来做。' : m.type === 'api' ? `你是通过 API 接入的，用 Hola 提供的工具干活：list_files / read_file 读文件（老板发来的附件在"${ATTACH_DIR}"文件夹，资料库里的用"资料库/文件名"），write_file 把交付物保存在对话文件夹里（写成 .docx / .xlsx / .pptx 会自动生成正式的 Office 文件），web_search / fetch_url 查资料${apiFull(m) ? '，run_command 运行命令' : ''}。交付物取清楚的文件名，并在回复里写明，老板才能在群里直接看到和下载。` : `当前目录是这个对话的专属文件夹。交付物放在这里，取清楚的文件名，并在回复里写明。生成的图片、视频、音频也一定要保存到当前目录（不要只留在你自己的界面或临时目录里），老板才能在群里直接看到和下载。老板发来的附件在"${ATTACH_DIR}"文件夹里。Word、Excel、PPT 文件都有系统自动转好的文字版（在"${TEXT_DIR}"文件夹，文件列表里有标注），读不了原文件时就读文字版。`}
4. "${MEMORY_NAME}"是本对话的记忆：系统会在每轮结束后自动整理，你不用改它，但要遵守里面记下的偏好和结论。
5. ${replyLangRule()}像在工作群里说话：先给结论，简洁具体。
6. 下面有【Hola 技能库】时：动手前看一眼，任务符合某个技能就照着做；用了的话，在回复第一行单独写"【技能】技能名"。

${pieces.env}${pieces.profile}${pieces.pinned}${pieces.project}${pieces.skills}`;
  return {
    header,
    pieces,
    base: header.slice(0, header.length - Object.values(pieces).join('').length),
    wall: pinnedRulesText(c) + earlierBossText(c, turn.hide),
    memory: clip(readMemory(c), 6000) || '（空）',
    listing: listingText(c),
    tail: `现在轮到你（${m.name}）。${phaseGuide(c, m, turn)}${workNotes(turn)}${teamCards(c, m, turn)}${MEETING.includes(turn.reason) ? '' : wickEnv.envNotesText()}${docStandardText(c, m, turn)}${holaContext(c, m, turn)}`,
  };
}

// 完整提示词（第一轮、或者没有长会话时）
function agentPrompt(c, m, turn) {
  const p = promptParts(c, m, turn);
  return `${p.header}${p.wall}【本对话记忆（${MEMORY_NAME}）】
${p.memory}

【当前文件夹里的文件】
${p.listing}

===== 群聊记录 =====
${transcript(c, turn.hide)}
===== 记录结束 =====

${p.tail}`;
}

// 长会话（wick sessions）用：各部分的指纹，下次只送变了的
const partHashes = (p) => ({ header: hash(p.header), wall: hash(p.wall), memory: hash(p.memory), listing: hash(p.listing),
  ...(p.pieces ? { base: hash(p.base), ...Object.fromEntries(Object.entries(p.pieces).map(([k, v]) => ['p_' + k, hash(v)])) } : {}) });
const PIECE = { env: '本机环境', profile: '老板的个人资料', pinned: '常驻资料', project: '项目说明', skills: 'Hola 技能库' };
// 完整提示词里送出去的消息
function fullPromptMeta(c, m, turn) {
  return { sent: pickMsgs(c, turn.hide).map((x) => x.id).filter(Boolean), hashes: partHashes(promptParts(c, m, turn)) };
}
// 续接会话时的提示词：只送上次之后的新消息和变了的部分。新消息太多（离上次太久）就返回 null，改送完整提示词
const DELTA_MAX = 60;
function sessionPrompt(c, m, turn, s) {
  const p = promptParts(c, m, turn);
  const h = partHashes(p);
  const old = s.hashes || {};
  const sent = new Set(s.sent || []);
  const fresh = visible(c, turn.hide).filter((x) => x.id && !sent.has(x.id) && x.from !== m.id);
  if (fresh.length > DELTA_MAX) return null;
  const parts = [];
  if (h.header !== old.header) {
    // 只是末尾某几块资料变了：只补发那几块，并说明以新的为准（wick pieceDelta）；团队名单、规则变了就整份重发
    if (wick('pieceDelta') && old.base && h.base === old.base) {
      for (const k of Object.keys(PIECE)) if (h['p_' + k] !== old['p_' + k]) parts.push(`【${PIECE[k]}（有更新，以这份为准，之前的作废）】\n${p.pieces[k].trim() || '（现在没有了）'}`);
    } else parts.push(`【团队说明（有更新）】
${p.header.trim()}`);
  }
  if (h.wall !== old.wall && p.wall) parts.push(p.wall.trim());
  if (h.memory !== old.memory) parts.push(`【本对话记忆（${MEMORY_NAME}）有更新】
${p.memory}`);
  if (h.listing !== old.listing) parts.push(`【当前文件夹里的文件（有变化）】
${p.listing}`);
  parts.push(`===== 群聊新消息（上次之后）=====
${fresh.map(msgLine).join('\n\n') || '（没有新消息）'}
===== 新消息结束 =====`);
  parts.push(p.tail);
  return { text: '（接着上次的对话。上面说过的规则和资料仍然有效，下面只列出上次之后的变化。）\n\n' + parts.join('\n\n'), sent: fresh.map((x) => x.id), hashes: h };
}

module.exports = { describePrompt, curActive, rosterText, msgLine, transcript, pickMsgs, promptParts, fullPromptMeta, sessionPrompt, TAG_NEED, TAG_STANCE, TAG_REVIEW, TAG_OPTION, policyOf, helpersNow, extractOptions, phaseGuide, LOGIN_BAT, loginHint, replyLangRule, agentPrompt };
