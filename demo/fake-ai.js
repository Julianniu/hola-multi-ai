#!/usr/bin/env node
// Hola 演示模式里的"假队友"：不调用任何真实 AI，按预设剧本回答，
// 用来在没有账号的情况下体验 Hola 的界面和协作流程（同时作答 → 讨论 → 共识结论 → 接力干活）。
'use strict';
const fs = require('fs');
const name = process.argv[2] || 'AI';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  // HOLA_DEMO_DUMP=1：把收到的提示词写到 .hola/prompt-名字.txt；=all：每一次都追加到 .hola/prompts.log（改代码前后对比用）
  if (process.env.HOLA_DEMO_DUMP) {
    try {
      if (process.env.HOLA_DEMO_DUMP === 'all') fs.appendFileSync('.hola/prompts.log', `\n<<<<<PROMPT ${name}>>>>>\n${prompt}`);
      else fs.writeFileSync(`.hola/prompt-${name}.txt`, prompt);
    } catch (_) {}
  }
  // HOLA_DEMO_FAST：自动测试时不用"假装思考"，马上回答
  await sleep(process.env.HOLA_DEMO_FAST ? 20 : 900 + Math.random() * 1400);
  // HOLA_DEMO_SLOW_MEMORY=毫秒：整理记忆故意慢一点（测"整理记忆时点了让大家讨论一下"）
  if (process.env.HOLA_DEMO_SLOW_MEMORY && prompt.includes('记忆整理员')) await sleep(Number(process.env.HOLA_DEMO_SLOW_MEMORY));
  // 测试任务板用：HOLA_DEMO_QUOTA=名字 → 这位队友"额度用完"直接报错；HOLA_DEMO_SLOW_WORK=毫秒 → 接力和被点名的活做得慢一点（好在中途插话、改派、取消、重启）
  if (process.env.HOLA_DEMO_CRASH === name) { process.stderr.write('TypeError: Cannot read properties of undefined (reading "x")\n'); process.exit(1); }
  if (process.env.HOLA_DEMO_QUOTA === name) { process.stderr.write('Error: usage limit reached for this account (429)\n'); process.exit(1); }
  if (process.env.HOLA_DEMO_SLOW_WORK && /@ 了你|老板点名让你来做|老板按顺序点名/.test(prompt)) await sleep(Number(process.env.HOLA_DEMO_SLOW_WORK));
  process.stderr.write(`（演示模式）${name} 在按剧本回答\n`);
  process.stdout.write(reply(prompt) + '\n');
});

function lastBoss(p) {
  const all = p.match(/\[老板[^\]\n]*\] ([^\n]*)/g) || [];
  return (all.pop() || '').replace(/^\[老板[^\]\n]*\] /, '').trim();
}

const VIEWS = {
  Claude: (q) => `我先给个框架。「${q}」这件事，关键是先想清楚目标人群和要达成的结果，再倒推方案：目标不清楚，后面怎么做都会摇摆。`,
  Codex: (q) => `我从落地角度看「${q}」：先估算成本和执行难度。看起来漂亮但做不出来、或者算不过账的方案，都应该先排除。`,
  Gemini: (q) => `我补充一些外部视角：做「${q}」之前，先看看同类做法和用户的真实反馈，别只凭内部判断。`,
};

function skillTag(p) {
  const k = p.match(/【Hola 技能库】[^\n]*\n- ([^：\n]+)：/);
  return k && name === 'Claude' && p.includes('同时、独立作答') ? `【技能】${k[1]}\n` : '';
}

function reply(p) {
  const tag = skillTag(p);
  if (tag) return tag + replyInner(p);
  return replyInner(p);
}

function replyInner(p) {
  if (/用英文（English）|英文界面|都用英文写|技能内容用英文写/.test(p)) return replyEn(p);
  const q = lastBoss(p).replace(/@\S+/g, '').trim().slice(0, 40) || '这个问题';

  // 交付前检查（测试用）：问题里带"半成品"就交一份留着 TODO 的文件，带"假装做好"就说保存了其实没写；
  // 收到 Hola 的返工要求后把文件改好
  if (p.includes('【交付前自动检查】')) {
    fs.writeFileSync('活动方案.md', '# 活动方案\n\n目标：GMV 300 万。\n');
    fs.writeFileSync('报价表.csv', '商品,价格\n云感枕,229\n');
    return '改好了：活动方案.md 补全了目标，报价表.csv 也写好了。';
  }
  if (/半成品/.test(q)) {
    fs.writeFileSync('活动方案.md', '# 活动方案\n\n目标：TODO\n');
    return '做好了：活动方案.md。';
  }
  if (/假装做好/.test(q)) return '已保存：报价表.csv，老板直接看就行。';

  if (p.includes('看不到图片的队友')) return '画面：一张示例图片，中间是三个彩色圆圈。图上没有文字。配色：深蓝底，红绿蓝三色。';
  if (p.includes('技能整理员')) {
    return `【本次变化】把"先定目标人群和结果、再在成本上限内选方案"的决策方法存成了技能
<<<技能
name: 方案决策三步法
description: 需要在几个方向里选一个方案（渠道、定价、选题等）时使用
---
# 方案决策三步法

## 步骤
1. 先写清目标人群和想要的结果，没有这两条不讨论方案。
2. Gemini 查同类做法和真实用户反馈；Claude 给出候选方案和取舍；Codex 估算每个方案的成本和执行难度。
3. 设定成本上限，排除超出上限或落不了地的方案，剩下的按"结果 / 成本"排序。

## 标准
- 结论第一句直接给选择，再用一两句说明关键取舍。
- 要动手的部分写成"@名字 + 具体任务"。

## 踩过的坑
- 只谈方向不算账：一定把成本上限写进结论。
技能>>>`;
  }
  if (p.includes('记忆整理员')) {
    if (/^(hi|hello|你好|大家好|在吗)/i.test(q)) return '【无需更新】';
    // 老板说了"以后……"：演示"规矩候选"（测试第 4 阶段的自动沉淀）
    const rule = /以后/.test(q) ? `\n【规矩候选】\n- ${q}\n` : '';
    return `【本次变化】记下了关于「${q}」的团队结论和后续分工${rule}
<<<记忆
# 对话记忆

## 目标与背景
- 老板在问：${q}
## 老板的偏好与要求
- （演示模式：这里会记下老板说过的要求）
## 已经定下的结论
- 先明确目标人群和结果，再选方案；成本可控为前提
## 进度与待办
- Codex：把结论要点整理成表格
## 重要文件
- 结论要点.csv：团队结论的要点清单
记忆>>>`;
  }

  // 问题里带"分歧"或"拍板"时演示没谈拢：Codex 每轮都有异议，结论列出方案等老板拍板
  const split = /分歧|拍板/.test(q);
  if (p.includes('不要再讨论，照老板的决定执行')) {
    return `按老板的决定执行：先把成本上限定下来，再选具体方案。\n\n@Codex 把结论要点整理成一张表格。`;
  }
  if (p.includes('由你代表团队给老板写结论，请老板拍板')) {
    return `大家都同意先明确目标人群和结果，分歧卡在**先调研还是先算成本**上。

【方案A】先做外部调研，再按调研结果定方案（支持：Gemini、Claude）
【方案B】先定成本上限，只在上限内调研和选方案（支持：Codex）

Gemini 和 Claude 认为不先看真实反馈，成本也估不准；Codex 认为不先定上限，调研范围会失控。我建议选 B：调研可以在上限内做，反过来却容易超支。

（演示模式：接入真实 AI 后，这里会是针对你问题的具体方案。）` +
      // 自动测试用：故意不守规矩、在等拍板的结论里 @ 人，确认 Hola 自己会拦住
      (process.env.HOLA_TEST_DISOBEY ? '\n\n@Codex 先把表格做出来。' : '');
  }

  if (p.includes('同时、独立作答')) {
    if (/^(hi|hello|你好|大家好|在吗)/i.test(q)) return `老板好，${name} 在线，随时可以开工。\n\n【需要讨论】否`;
    return `${(VIEWS[name] || VIEWS.Claude)(q)}\n\n（演示模式：这是预设的示范回答。接入真实 AI 后，这里是它真正的思考。）\n\n【需要讨论】是`;
  }

  const round = (p.match(/内部讨论第 (\d+) 轮/) || [])[1];
  if (round) {
    if (split && name === 'Codex' && round !== '1') {
      return `我还是坚持：不先定成本上限，调研范围会越来越大。这一点大家没有说服我。\n\n【立场】有异议`;
    }
    if (name === 'Codex' && round === '1') {
      return `Claude 的框架我认同，Gemini 说的先看外部反馈也很有必要。\n\n但我有一个实质分歧：大家都没算成本。如果方案执行成本过高，再好的方向也落不了地，建议把"成本上限"作为前提写进结论。\n\n【立场】有异议`;
    }
    if (round === '1') {
      return name === 'Claude'
        ? `Gemini 说的"先看外部反馈"补上了我框架里缺的一步，我吸收进来：先调研，再定目标人群和方案。Codex 的落地视角我也同意。\n\n【立场】同意`
        : `Claude 的框架很清楚，我没有反对意见。补一句：调研时重点看评论区的真实抱怨，比看点赞数有用。\n\n【立场】同意`;
    }
    if (name === 'Codex') return `我看到大家把"先调研"加进去了，只要成本上限也写进结论，我就同意。\n\n【立场】同意`;
    return `Codex 提的成本问题我之前漏了，同意把"成本上限"作为前提写进结论。\n\n【立场】同意`;
  }

  if (p.includes('给老板写最终结论')) {
    return `**结论：先明确目标人群和要达成的结果，在成本上限内选择最容易落地的方案。**

讨论中最关键的取舍：Gemini 提醒要先看外部反馈，Codex 坚持把成本作为前提。两点都已经写进结论。

（演示模式：接入真实 AI 后，这里会是针对你问题的具体答案。）

@Codex 把结论要点整理成一张表格。`;
  }

  // 主脑验收：问题里带"退回"时演示退回重做（用来测"退回太多次就停下"）
  if (p.includes('你是主脑，负责验收')) {
    if (/退回/.test(q)) return `【验收】退回\n表格少了预算一列。\n\n@Codex 补上预算这一列。`;
    return `【验收】通过\n结论要点.csv 核对过了，三条要点和负责人都对，可以直接用。`;
  }
  // 主脑直接回答：要做表时交给帮手
  if (p.includes('由你（主脑）直接回答')) {
    if (/^(hi|hello|你好|大家好|在吗)/i.test(q)) return `老板好，${name} 在线，随时可以开工。`;
    const helper = (p.match(/@帮手（([^）、]+)/) || [])[1];
    if (/表格|做表/.test(q) && helper) return `要点我来定：明确目标人群、设定成本上限、参考外部反馈。\n\n@${helper} 把这三条要点做成表格。`;
    return `${(VIEWS[name] || VIEWS.Claude)(q)}\n\n（演示模式：这是主脑的示范回答。）`;
  }

  if (p.includes('@ 了你')) {
    fs.writeFileSync('结论要点.csv', '﻿要点,负责人\n明确目标人群,团队\n设定成本上限,Codex\n参考外部反馈,Gemini\n');
    // 问题里带"请主脑验收"时，交付的人顺手 @ 主脑（用来测：这种情况也只走一次正式验收）
    return '表格做好了：**结论要点.csv**，三条要点和负责人都列在里面。' + (/请主脑验收/.test(q) ? '\n\n@Claude 请验收。' : '');
  }

  return `收到，${name} 来处理。（演示模式：这是示范回复，接入真实 AI 后就是真正的工作结果。）`;
}

// ---------------------------------------------------------------- English script
const VIEWS_EN = {
  Claude: (q) => `Let me frame it first. For "${q}", the key is to pin down the target audience and the outcome we want, then work backwards to the plan. If the goal is fuzzy, every option will wobble.`,
  Codex: (q) => `Looking at "${q}" from the execution side: estimate cost and effort first. Anything that looks great but can't be built, or doesn't add up financially, should go.`,
  Gemini: (q) => `Some outside perspective: before doing "${q}", look at how others have done it and what real users say. Don't rely only on internal judgement.`,
};

function replyEn(p) {
  const q = lastBoss(p).replace(/@\S+/g, '').trim().slice(0, 60) || 'this';
  const split = /split|disagree/i.test(q);
  if (p.includes('不要再讨论，照老板的决定执行')) {
    return `Following the boss's decision: set the cost ceiling first, then pick the plan.\n\n@Codex turn the key points into a table.`;
  }
  if (p.includes('由你代表团队给老板写结论，请老板拍板')) {
    return `We all agree on defining the audience and outcome first. We're split on **research first or cost first**.

【方案A】Do outside research first, then decide the plan from what we learn (support: Gemini, Claude)
【方案B】Set a cost ceiling first, and research and choose only within it (support: Codex)

Gemini and Claude think costs can't be estimated well without real feedback; Codex thinks research will sprawl without a ceiling. I'd pick B: research fits inside a ceiling, but the reverse tends to overspend.

(Demo mode: with real AIs connected, these would be options specific to your question.)`;
  }
  if (p.includes('技能整理员')) {
    return `【本次变化】Saved the "audience and outcome first, then choose within a cost ceiling" decision method as a skill
<<<技能
name: Three-step decision
description: Use when choosing between several directions (channel, pricing, topic and so on)
---
# Three-step decision

## Steps
1. Write down the target audience and the outcome you want. Don't discuss options without these two.
2. Gemini looks at similar cases and real user feedback; Claude lays out the options and trade-offs; Codex estimates cost and effort for each.
3. Set a cost ceiling, drop options above it or that can't be delivered, and rank the rest by outcome versus cost.

## Standards
- The conclusion opens with the choice, then one or two sentences on the key trade-off.
- Hands-on work is written as "@name + task".

## Lessons learned
- Talking direction without doing the maths: always put the cost ceiling in the conclusion.
技能>>>`;
  }
  if (p.includes('记忆整理员')) {
    if (/^(hi|hello|hey)\b/i.test(q)) return '【无需更新】';
    return `【本次变化】Recorded the team conclusion on "${q}" and the follow-up task
<<<记忆
# Conversation memory

## Goal and background
- The boss asked: ${q}
## Boss's preferences and requirements
- (Demo mode: requirements the boss states would be recorded here)
## Decisions made
- Define the audience and outcome first, then choose a plan within a cost ceiling
## Progress and to-dos
- Codex: turn the key points into a table
## Key files
- key-points.csv: the conclusion's key points
记忆>>>`;
  }
  if (p.includes('同时、独立作答')) {
    if (/^(hi|hello|hey)\b/i.test(q)) return `Hi boss, ${name} is online and ready.\n\n【需要讨论】否`;
    return `${(VIEWS_EN[name] || VIEWS_EN.Claude)(q)}\n\n(Demo mode: this is a scripted answer. With real AIs connected, you'd see their actual thinking here.)\n\n【需要讨论】是`;
  }
  const round = (p.match(/内部讨论第 (\d+) 轮/) || [])[1];
  if (round) {
    if (split && name === 'Codex' && round !== '1') return `I still hold my ground: without a cost ceiling first, the research will keep growing. Nobody has convinced me otherwise.\n\n【立场】有异议`;
    if (name === 'Codex' && round === '1') return `I agree with Claude's framing, and Gemini's point about checking outside feedback is important.\n\nBut I have a real disagreement: nobody has costed this. If execution is too expensive, even the right direction won't land. I suggest we make a cost ceiling a precondition in the conclusion.\n\n【立场】有异议`;
    if (round === '1') return name === 'Claude'
      ? `Gemini's "check outside feedback first" fills a gap in my framework, so I'm adopting it: research first, then define the audience and plan. I also agree with Codex's execution angle.\n\n【立场】同意`
      : `Claude's framework is clear and I have no objection. One addition: when researching, read the real complaints in the comments. They tell you more than like counts.\n\n【立场】同意`;
    if (name === 'Codex') return `I see the team has added "research first". As long as the cost ceiling is in the conclusion too, I agree.\n\n【立场】同意`;
    return `I missed the cost question Codex raised. Agreed: make a cost ceiling a precondition in the conclusion.\n\n【立场】同意`;
  }
  if (p.includes('给老板写最终结论')) {
    return `**Conclusion: define the target audience and the outcome first, then pick the easiest plan to execute within a cost ceiling.**

The key trade-off in the discussion: Gemini insisted on checking outside feedback first, and Codex insisted on cost as a precondition. Both are in the conclusion.

(Demo mode: with real AIs connected, this would be a specific answer to your question.)

@Codex turn the key points into a table.`;
  }
  if (p.includes('你是主脑，负责验收')) return `【验收】通过\nI checked key-points.csv: the three points and owners are right and ready to use.`;
  if (p.includes('由你（主脑）直接回答')) {
    if (/^(hi|hello|hey)\b/i.test(q)) return `Hi boss, ${name} is online and ready.`;
    return `${(VIEWS_EN[name] || VIEWS_EN.Claude)(q)}\n\n(Demo mode: this is the main brain's scripted answer.)`;
  }
  if (p.includes('@ 了你')) {
    fs.writeFileSync('key-points.csv', 'Point,Owner\nDefine the target audience,Team\nSet a cost ceiling,Codex\nCheck outside feedback,Gemini\n');
    return 'Table done: **key-points.csv**, with the three points and their owners.';
  }
  return `Got it, ${name} is on it. (Demo mode: this is a scripted reply. With real AIs connected, you'd get the actual work here.)`;
}
