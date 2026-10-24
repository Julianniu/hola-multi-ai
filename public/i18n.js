// Hola 界面英文版：界面里的固定文字按词典翻译；AI 回复、用户消息、标题、文件名等标了 data-raw 的内容不翻译。
'use strict';
(function () {
  const store = { get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} } };
  const guess = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  const LANG = store.get('hola.lang') || guess;

  const D = {
    // 侧边栏 / 顶部
    '光辉联合': 'Union of light', '新对话': 'New chat', '你': 'You', '我': 'Me', '系统': 'System',
    '点这里设置头像和偏好': 'Set your avatar and preferences', '队友': 'Teammates', '设置': 'Settings',
    '切换深浅色': 'Toggle dark mode', '对话列表': 'Chats', '队友状态': 'Teammate status',
    '检查中': 'Checking', '检查中…': 'Checking…', '对话记忆': 'Memory', '文件夹': 'Folder',
    '添加图片或文件': 'Add images or files', '说说要做什么，@ 谁就让谁来': 'Describe the task. @ someone to assign it',
    '叫停': 'Stop', '发送': 'Send', '关闭': 'Close', '还没有对话': 'No chats yet', '今天': 'Today', '更早': 'Earlier',
    '删除对话': 'Delete chat', '刚刚': 'just now',
    // 项目
    '项目': 'Projects', '新建项目': 'New project', '编辑项目': 'Edit project', '在这个项目里新建任务': 'New task in this project',
    '新建一个项目，把相关的对话归进去，每个对话就是一个任务，进度一目了然。': 'Create a project and group related chats in it. Each chat becomes a task, so progress is easy to see.',
    '还没有任务，点 + 新建，或把对话拖进来': 'No tasks yet. Click + or drag a chat here', '对话': 'Chats', '所有对话都归进了项目': 'Every chat is in a project',
    '标为完成': 'Mark as done', '标为进行中': 'Mark as in progress', '更多': 'More', '移到项目': 'Move to project', '不放进项目': 'No project',
    '新建项目并移入…': 'New project and move it there…', '重命名': 'Rename',
    '项目把相关的对话归到一起，每个对话就是项目里的一个任务。项目说明会给项目里所有任务的队友看，他们还会参考同项目其他任务定下的结论。': "A project groups related chats; each chat is a task in it. Teammates on every task see the project brief and take into account what the project's other tasks have decided.",
    '项目名称': 'Project name', '比如 双十一大促': 'e.g. Holiday sale campaign', '项目说明': 'Project brief',
    '目标、背景、时间节点、预算、要求……': 'Goal, background, deadlines, budget, requirements…', '写得越具体，队友越不容易跑偏。': 'The more specific it is, the less teammates drift off course.',
    '删除项目': 'Delete project', '请填写项目名称': 'Please enter a project name', '项目已保存': 'Project saved', '项目已创建': 'Project created',
    '显示后台过程（排查问题时用）': 'Show the backend process (for troubleshooting)',
    '打开后能看到每位队友读了哪些文件、跑了什么命令，以及原始报错。平时关着就行。': 'Shows which files each teammate read, which commands they ran, and the raw errors. Leave it off normally.',
    // 技能库
    '技能库': 'Skills', '团队共用的技能库': "The team's shared skill library",
    '技能是可以反复用的做事方法：步骤、分工、标准、模板和踩过的坑。所有对话、所有队友共用。队友动手前会先看技能库，任务对得上就照着做。格式和 Claude Skills 一样（SKILL.md），可以直接导入。': 'A skill is a reusable way of getting something done: steps, who does what, quality standards, templates and lessons learned. Every chat and every teammate shares the library. Before starting, teammates check it and follow any skill that fits the task. The format matches Claude Skills (SKILL.md), so you can import existing ones.',
    '新建技能': 'New skill', '从当前对话整理': 'From this chat', '导入': 'Import', '编辑技能': 'Edit skill',
    '写清楚什么时候用、怎么做。队友会根据"什么时候用"判断要不要读它。': 'Say when to use it and how. Teammates decide whether to read it based on "When to use".',
    '技能名称': 'Skill name', '什么时候用': 'When to use', '具体做法（Markdown）': 'Instructions (Markdown)',
    '比如 小红书种草文案': 'e.g. Product launch copy', '比如 写小红书种草笔记、产品推广文案时使用': 'e.g. Use when writing social posts or product promotion copy',
    '步骤、分工、质量标准、模板、注意事项……': 'Steps, who does what, quality standards, templates, things to watch out for…',
    '启用这个技能': 'Enable this skill', '存为技能': 'Save as skill',
    '把这次的做法沉淀到技能库，下次同类任务直接用': 'Turn how the team did this into a skill, so similar tasks can reuse it',
    '用了技能库里的这个技能': 'Used this skill from the library', '技能已更新': 'Skill updated', '已存为技能': 'Saved as skill',
    '这个技能已经不在技能库里了': 'This skill is no longer in the library', '队友正在把这次的做法整理成技能': 'A teammate is turning this into a skill',
    '已导入技能': 'Skill imported', '技能已保存': 'Skill saved', '请填写技能名称': 'Please enter a skill name', '整理技能中': 'Writing a skill',
    '从对话整理': 'From a chat', '手写': 'Written by hand', '还没用过': 'Not used yet', '技能库还是空的。': 'The skill library is empty.',
    '在团队结论旁点"存为技能"，或者点下面的"从当前对话整理"，让队友把这次的做法沉淀下来；也可以自己新建，或导入现成的 SKILL.md。': 'Click "Save as skill" next to a team conclusion, or "From this chat" below, and a teammate will write up how the team did it. You can also write one yourself or import an existing SKILL.md.',
    // 记忆抽屉
    '只属于这个对话，和其他对话互不相通。每轮讨论或干活结束后会自动整理，队友每次发言前都会先读它。你也可以直接修改，改动会被保留，旧版本存在对话文件夹的 .hola\\memory-history 里。':
      "Belongs to this chat only and is never shared with other chats. It's tidied up automatically after each round, and teammates read it before they speak. You can edit it directly; your edits are kept and older versions are saved in the chat folder under .hola\\memory-history.",
    '重新读取': 'Reload', '保存': 'Save', '已读取最新内容': 'Loaded the latest version', '已保存': 'Saved', '队友刚更新了记忆': 'A teammate just updated the memory',
    '松手就能添加到这条消息': 'Drop to attach to this message',
    // 设置
    '你是包工头。这里设置队友之间怎么讨论。队友的增减和各自擅长什么，在左下角"队友"里管理。':
      "You're the foreman. Set how teammates discuss here. Add or remove teammates and set what they're good at under \"Teammates\" at the bottom left.",
    '内部讨论最多几轮': 'Maximum discussion rounds',
    '不点名时，参与的队友先各自作答；只要有人认为值得讨论，就进入讨论，直到大家都同意或到达轮数上限。':
      'When you don’t @ anyone, the working teammates answer on their own first. If anyone thinks it’s worth discussing, they discuss until everyone agrees or the round limit is reached.',
    '团队结论由谁整理': 'Who writes the team conclusion', '每轮结束后自动整理对话记忆': 'Update conversation memory after each round',
    '由"团队结论由谁整理"的那位队友兼任记忆整理，每轮多用一次额度。': 'Done by the teammate who writes the team conclusion. Costs one extra call per round.',
    '队友之间最多自动接力几次': 'Maximum automatic hand-offs', '队友在回复里 @ 别人会自动交接。超过次数就停下来等你看。': 'When a teammate @s someone in a reply, the work is handed off automatically. Past this number, Hola pauses and waits for you.',
    '重新检查队友': 'Recheck teammates', '退出 Hola': 'Quit Hola', '取消': 'Cancel', '界面语言': 'Language', '设置已保存': 'Settings saved',
    '正在重新检查队友': 'Rechecking teammates', '重新检查': 'Recheck', '管理队友': 'Manage teammates',
    // 个人主页
    '个人主页': 'Your profile', '队友每次干活前都会读这里，按你的习惯来，不用每个对话都重新交代。': 'Teammates read this before every task, so they work your way without you repeating yourself in each chat.',
    '更换头像': 'Change avatar', '移除': 'Remove', '会自动裁成正方形': 'Cropped to a square automatically', '关于你': 'About you',
    '名字 / 昵称': 'Name / nickname', '希望队友怎么称呼你': 'How teammates should address you', '比如：老板、小王、Julian': 'e.g. Boss, Sam, Julian',
    '职位': 'Role', '比如：品牌经理': 'e.g. Brand manager', '公司 / 团队': 'Company / team', '行业': 'Industry', '比如：消费电子、电商': 'e.g. Consumer electronics, e-commerce',
    '关于我': 'About me', '你主要做什么、负责哪些事、常见的工作场景。写得越具体，队友越懂你。': 'What you do, what you own, your typical work. The more specific, the better teammates understand you.',
    '使用偏好': 'Preferences', '回答详略': 'Detail', '简短': 'Brief', '适中': 'Balanced', '详细': 'Thorough', '语气': 'Tone', '专业': 'Professional', '轻松': 'Casual',
    '格式': 'Format', '多用表格清单': 'Tables and lists', '多用段落': 'Paragraphs', '语言': 'Language', '中文': '中文', '跟随我': 'Match mine',
    '讨论风格': 'Debate style', '温和': 'Gentle', '平衡': 'Balanced', '尖锐': 'Sharp', '其他要求': 'Other requirements',
    '每行一条。比如：数字一律用阿拉伯数字；文案里不要用感叹号；给方案时附上预估成本': 'One per line. e.g. Always use numerals; no exclamation marks in copy; include estimated cost with any plan',
    '再点一次已选中的选项可以取消。这些信息只保存在你自己的电脑上，但队友干活时会读到，所以会随任务一起发给对应的 AI 服务。':
      "Click a selected option again to clear it. This is stored only on your computer, but teammates read it while working, so it's sent to their AI services along with each task.",
    '处理中…': 'Processing…', '头像已更新': 'Avatar updated', '这张图片读不了，换一张 PNG 或 JPG 试试': "Can't read this image. Try a PNG or JPG.",
    '个人主页已保存，队友下次干活就会按这个来': 'Profile saved. Teammates will follow it from their next task.', '保存失败': 'Save failed',
    // 队友管理
    '除了 Claude、Codex、Gemini，还可以接入任何 AI：有 OpenAI 兼容 API 的（DeepSeek、通义千问、Kimi、智谱、OpenRouter、本地 Ollama 等），或者有命令行工具的。':
      'Besides Claude, Codex and Gemini, you can add any AI: anything with an OpenAI-compatible API (DeepSeek, Qwen, Kimi, Zhipu GLM, OpenRouter, local Ollama…) or with a command-line tool.',
    '添加队友': 'Add teammate', '完成': 'Done', '填好以后点"保存并测试"，会发一句话试试能不能连上。': 'Fill this in and click "Save and test". Hola sends one message to check the connection.',
    'API 接入': 'API', '命令行': 'Command line', '名字': 'Name', '比如 DeepSeek': 'e.g. DeepSeek', '在群里 @ 它时用这个名字，不能有空格': 'Used when you @ it in chat. No spaces.',
    '颜色': 'Color', '擅长什么': 'Good at', '比如：中文写作、数学推理、代码': 'e.g. Writing, math, code', '大家会按这里分工，写具体一点。': 'The team splits work based on this, so be specific.',
    '服务商': 'Provider', '接口地址': 'API address', 'OpenAI 兼容格式，会自动在后面加上 /chat/completions': 'OpenAI-compatible. /chat/completions is added automatically.',
    '模型名': 'Model', '温度（可不填）': 'Temperature (optional)', '默认': 'Default',
    '只保存在你电脑的 Hola 文件夹里（data\\members.json），不会显示在页面上。': 'Stored only in your Hola folder (data\\members.json) and never shown on the page.',
    '命令': 'Command', '比如 qwen、ollama，或者完整路径': 'e.g. qwen, ollama, or a full path', '参数': 'Arguments', '比如 -p {PROMPT}': 'e.g. -p {PROMPT}',
    '写 {PROMPT} 的地方会换成要它做的事；不写的话，任务会从标准输入传给它。': '{PROMPT} is replaced with the task. Without it, the task is sent on standard input.',
    '输出格式': 'Output format', '普通文字（大多数命令行工具）': 'Plain text (most CLI tools)', 'Claude Code 的 stream-json': 'Claude Code stream-json',
    'Codex 的 JSON 事件': 'Codex JSON events', 'Antigravity 的 JSON': 'Antigravity JSON',
    '只读：它不能写文件（成果写在回复里）': "Read-only: it can't write files (results go in its reply)", '用 --version 检查它是否安装好': 'Use --version to check that it’s installed',
    '启用这位队友': 'Enable this teammate', '删除': 'Delete', '保存并测试': 'Save and test', '内置': 'Built-in', '已停用': 'Disabled', '编辑': 'Edit', '停用': 'Disable', '启用': 'Enable',
    '内置队友只能改颜色、擅长什么，以及是否启用。': 'For built-in teammates you can change the color, what they’re good at, and whether they’re enabled.',
    '内置队友只能改颜色、擅长什么、权限，以及是否启用。': 'For built-in teammates you can change the color, what they’re good at, their permissions, and whether they’re enabled.',
    '完全权限：能运行命令、读写电脑上任何地方的文件，不用确认': 'Full access: can run commands and read or write files anywhere on this PC, without asking',
    '关着是安全模式：只在对话文件夹里干活（Gemini 只能读不能写）。有的 AI 在 Windows 的安全模式下跑不了命令，遇到时打开这个。': 'Off means safe mode: it works only in the chat folder (Gemini can read but not write). Some AIs can’t run commands in safe mode on Windows; turn this on if that happens.',
    '完全权限': 'Full access', '· 完全权限': '· full access',
    '模型': 'Model', '读取中…': 'Loading…', '手动填写…': 'Type it in…', '填模型名，比如 opus': 'Model name, e.g. opus',
    '默认（用它自己的设置）': 'Default (its own setting)', '其他家的模型（会失去多家模型互相讨论的意义）': "Other companies' models (loses the point of different models debating)",
    '列表来自它自己的命令行工具。选了订阅里没有的模型会出错，改回"默认"就好。': 'The list comes from its own command-line tool. Picking a model your subscription doesn’t include will fail; just switch back to "Default".',
    '没读到模型列表，可以选"手动填写"。': 'Couldn’t read the model list. You can choose "Type it in".',
    '思考深度': 'Thinking effort', '想得越深，答得越好，但更慢、更费额度。': 'Deeper thinking gives better answers but is slower and uses more quota.',
    '低': 'Low', '中': 'Medium', '高': 'High', '很高': 'Very high', '最高': 'Max', '极限': 'Ultra',
    '标准宽度': 'Standard width', '加宽': 'Wide', '铺满': 'Full width', '聊天区宽度：标准 / 宽 / 铺满': 'Chat width: standard / wide / full',
    '拖动调整侧栏宽度，双击恢复': 'Drag to resize the sidebar; double-click to reset', '拖动调整预览宽度，双击恢复': 'Drag to resize the preview; double-click to reset',
    '在新窗口打开': 'Open in a new window', '关闭预览': 'Close preview', '收起 / 展开对话列表': 'Hide / show the chat list',
    '这次没有可以干活的队友：要么都没勾选参与，要么不在线。在输入框下方的"参与"里选几位，或者点右上角的光点看原因。': 'No teammate can take this: none are selected, or none are online. Pick some under "Working" below the input box, or click the lights at the top right to see why.',
    '大家会在下一轮讨论里看到老板这条消息。': 'The team will see this message in the next discussion round.',
    '有值得讨论的地方，进入内部讨论 · 第 1 轮': 'Worth discussing: internal discussion · round 1',
    '现在没有在线的队友可以执行。': 'No teammate is online to carry this out.',
    '没有在线的队友，没法整理技能。': 'No teammate is online to write the skill.',
    '老板叫停了，大家先停手。': 'You stopped the team. Everyone has paused.',
    // 主脑、大脑 / 帮手、开会讨论、验收
    '开会讨论': 'Meet', '让几位大脑开会讨论，得出团队结论': 'Have the brains discuss and reach a team conclusion', '发送：由主脑回答': 'Send: the main brain answers',
    '新的用法': "What's new", '知道了': 'Got it', '好': 'OK', '退出': 'Quit', '打开完全权限': 'Turn on full access',
    '开会讨论 · 正在进行': 'Meeting in progress', '大家达成共识': 'Consensus reached', '验收通过': 'Approved', '改好后通过': 'Fixed and approved',
    '新版本已经下载好': 'A new version is ready', '立即重启': 'Restart now', '稍后': 'Later', '去下载': 'Download', '主脑': 'Main brain', '验收': 'Review', '帮手': 'Helper',
    '直接发送，由主脑一个人回答，更快。想听大家一起讨论，点输入框旁的「开会讨论」，或者在主脑的回答下面点「让大家讨论一下」。主脑、干活策略在"设置"里改，大脑 / 帮手在"队友 → 编辑"里改。': 'Sending a message now gets an answer from the main brain alone, which is faster. To hear the whole team, click "Meet" next to the input box, or "Ask the team to discuss" under the main brain\'s answer. Change the main brain and work strategy in Settings, and brains / helpers under Teammates → Edit.',
    '直接发送时由主脑回答；开会时由主脑写团队结论；队友交付的东西由主脑验收。': 'The main brain answers when you just send, writes the team conclusion in meetings, and reviews what teammates deliver.',
    '干活策略': 'Work strategy', '自动（推荐）': 'Automatic (recommended)', '质量优先': 'Quality first', '均衡': 'Balanced', '省钱': 'Save money',
    '决定主脑把多少活交给帮手。自动：主脑用订阅时质量优先，用 API 时均衡。质量优先：主脑能做的都自己做。均衡：主脑想和审，粗活和长文交给帮手。省钱：主脑只出方案和验收。': 'How much work the main brain hands to helpers. Automatic: quality first when the main brain uses a subscription, balanced when it uses an API. Quality first: the main brain does everything it can. Balanced: the main brain thinks and reviews; routine work and long writing go to helpers. Save money: the main brain only plans and reviews.',
    '角色': 'Role', '大脑：参与开会讨论': 'Brain: joins meetings', '帮手：不参与讨论，只接活（做表、搜资料、排版……）': "Helper: doesn't join meetings, only takes work (tables, research, layout…)",
    '帮手适合用便宜、快的模型；交出去的活由主脑验收。': 'Helpers suit cheap, fast models; the main brain reviews their work.',
    '让大家讨论一下': 'Ask the team to discuss', '其他大脑先各自独立作答，再和主脑一起讨论出团队结论': 'The other brains answer independently first, then discuss with the main brain and reach a team conclusion',
    '✓ 验收通过': '✓ Approved', '✓ 改好后通过': '✓ Fixed and approved', '退回重做': 'Sent back', '思考中': 'Thinking', '验收中': 'Reviewing',
    '发送：主脑回答 · 开会讨论：大脑们讨论出团队结论 · @ 某人：按 @ 的顺序来': 'Send: the main brain answers · Meet: the brains discuss and reach a team conclusion · @ someone: in @ order',
    '直接发送，由主脑回答，最快。值得多想想的问题，点「开会讨论」：几位大脑各自独立作答，再讨论、互相挑战，形成共识后给你一个团队结论。想指定谁做、按什么顺序做，就用 @。图片和文件可以直接拖进来或粘贴。': 'Just send for the fastest answer, from the main brain. For questions worth thinking through, click "Meet": the brains answer independently, then discuss, challenge each other and give you a team conclusion once they agree. Use @ to choose who works and in what order. Drag in or paste images and files.',
    '只能把主脑的回答拿去讨论': "Only the main brain's answer can be taken to a meeting", '等这一轮做完再开会': 'Wait until the current work finishes', '等这一轮讨论结束再开会': 'Wait until the current discussion ends', '已经排好队，马上开会': 'A meeting is already queued', '这条回答已经讨论过了': 'This answer has already been discussed',
    // 内置队友改走中转站、读取可用模型、思考深度
    '接入方式': 'How it connects', '订阅登录（命令行）': 'Subscription (command line)', '中转站 / API': 'Relay / API', '中转站': 'Relay',
    '订阅登录：用这台电脑上登录好的命令行工具和你自己的订阅。中转站 / API：填公司或第三方给的接口地址和 Key，不用装命令行工具、不用订阅。': 'Subscription: uses the command-line tool signed in on this PC and your own subscription. Relay / API: enter the address and key from your company or a third party; no command-line tool or subscription needed.',
    '读取可用模型': 'Load available models', '正在读取可用模型…': 'Loading available models…', '— 从列表里选一个 —': '— Pick one from the list —', '其他模型': 'Other models',
    '读取失败': 'Could not load',
    '请填写中转站的接口地址和模型名（可以点"读取可用模型"）': 'Fill in the relay address and model name (you can click "Load available models")',
    // API 队友能动手、常驻资料
    '能动手：读写文件、做 Word / Excel / PPT、上网查资料': 'Can do work: read and write files, make Word / Excel / PowerPoint, look things up online',
    '需要模型支持"工具调用"。点"保存并测试"会自动试一下，不支持的话它就只动脑。': 'Needs a model that supports tool calling. "Save and test" checks it; if not supported, it only thinks.',
    '只动脑': 'Thinking only', '设为常驻': 'Pin', '取消常驻': 'Unpin', '所有对话的队友每次都会参考这份资料': 'Every teammate refers to this file in every chat',
    '已取消常驻': 'Unpinned', '已设为常驻：队友每次都会参考': 'Pinned: teammates will refer to it every time',
    '只有资料库里的文字类文件（Word、Excel、PPT、Markdown、文本、CSV）能设为常驻': 'Only text-type files you uploaded (Word, Excel, PowerPoint, Markdown, text, CSV) can be pinned',
    // 内置浏览器
    '浏览器': 'Browser', '内置浏览器：你和队友都能用': 'Built-in browser: for you and your teammates', '后退': 'Back', '前进': 'Forward', '刷新': 'Reload',
    '输入网址或要搜索的内容': 'Enter an address or search', '关闭浏览器': 'Close browser',
    '内置浏览器': 'Built-in browser', '关闭预览（Esc）': 'Close preview (Esc)', '关闭浏览器（Esc）': 'Close browser (Esc)',
    '这里打不开 PDF 预览。点上面的"在新窗口打开"用浏览器看，或者下载原文件。': "PDF preview isn't available here. Use \"Open in a new window\" above to view it in your browser, or download the original.",
    '在上面输入网址打开网页。队友（目前是 Claude）也能用这个浏览器帮你查资料、操作网页，点按钮和填表前会先问你。': 'Type an address above to open a page. Teammates (currently Claude) can also use this browser to look things up and work on web pages; they ask you before clicking buttons or filling in forms.',
    '想在内置浏览器里操作': 'wants to act in the built-in browser', '来自对话': 'From chat', '允许': 'Allow', '这个对话都允许': 'Allow for this chat', '不允许': "Don't allow",
    '队友在内置浏览器里点按钮、填表前，先问我': 'Ask me before teammates click buttons or fill in forms in the built-in browser',
    '关掉后，队友用内置浏览器时不再逐个征求你同意。浏览器里登录过的网站，队友也能用你的身份操作。': "When off, teammates no longer ask before each action in the built-in browser. On sites you're signed in to there, they act as you.",
    '内置浏览器不打开本机地址和本地文件': "The built-in browser doesn't open local addresses or files", '打不开这个网页': "Couldn't open this page",
    '图片库': 'Images', '文件库': 'Files', '资料库': 'Library', '全部': 'All', '我上传的': 'Uploaded by me', '对话里的': 'From chats',
    '搜索文件名': 'Search file names', '上传': 'Upload', '发到对话': 'Send to chat', '打开对话': 'Open chat', '你发的': 'sent by you',
    '你上传的图片，和所有对话里的图片（你发的、队友做的）都在这里。点"发到对话"，就放进当前对话的输入框，能看图的队友都看得到。': 'Images you uploaded, plus every image from your chats (sent by you or made by teammates). "Send to chat" puts it in the current chat\'s input box, and every teammate that can see images will see it.',
    '你上传的文件，和所有对话里的文件（你发的、队友做的）都在这里。点"发到对话"，就放进当前对话的输入框，Word、Excel、PPT 会自动转成文字版给队友读。': 'Files you uploaded, plus every file from your chats (sent by you or made by teammates). "Send to chat" puts it in the current chat\'s input box; Word, Excel and PowerPoint files get a text version teammates can read.',
    '没有符合条件的文件': 'No matching files', '这里还是空的。点右上角"上传"，或者把文件拖进来。': 'Nothing here yet. Click "Upload" at the top right, or drag files in.',
    '已放进输入框，写上要做什么再发送': 'Added to the input box. Say what to do with it, then send.', '发送失败': 'Could not send',
    '这个模型能看图片（会把图片一起发给它）': 'This model can see images (images are sent along)',
    '不勾也没关系：有图片时，会请能看图的队友先把图片写成文字说明给它。': "Fine to leave off: when there are images, a teammate who can see them writes a text description for this one.",
    '图片说明已写好': 'Image description ready',
    '本对话用量': 'Usage in this chat', '用订阅时计入订阅额度，不另外收费。': 'On a subscription this counts toward your plan’s quota; nothing extra is billed.',
    '打开完全权限？\n\n这位队友将能运行任何命令、修改或删除你电脑上任何地方的文件，而且不会先问你。请只给你信任的 AI 打开，重要文件记得备份。': 'Turn on full access?\n\nThis teammate will be able to run any command and change or delete files anywhere on your PC without asking first. Only turn it on for AIs you trust, and keep backups of important files.',
    '选一个会自动填好地址和推荐的模型名；模型名以服务商文档为准。': 'Picking one fills in the address and a suggested model. Check the provider’s docs for current model names.',
    '填服务商文档里的模型名': "Model name from the provider's docs", '已删除': 'Deleted', '保存中…': 'Saving…', '请填写名字': 'Please enter a name',
    '请填写接口地址和模型名': 'Please enter the API address and model', '请填写命令': 'Please enter a command', '已保存（已停用）': 'Saved (disabled)', '已保存，正在测试连接…': 'Saved. Testing the connection…',
    'DeepSeek（V4 Pro，更强）': 'DeepSeek (V4 Pro, stronger)', 'DeepSeek（Flash，更快更便宜）': 'DeepSeek (Flash, faster and cheaper)', '通义千问（阿里云百炼）': 'Qwen (Alibaba Cloud Bailian)',
    'Kimi（月之暗面）': 'Kimi (Moonshot)', '智谱 GLM': 'Zhipu GLM', 'OpenRouter（一个 Key 用很多模型）': 'OpenRouter (one key, many models)', '本地 Ollama（不用 Key）': 'Local Ollama (no key)', '其他（自己填）': 'Other (fill in yourself)',
    // 对话
    '今天让大家一起做什么？': 'What should the team work on today?',
    '不点名的话，参与的队友会同时独立作答。遇到需要判断的问题，他们会自己讨论、互相挑战，形成共识后给你一个团队结论。想指定谁做、按什么顺序做，就用 @。图片和文件可以直接拖进来或粘贴。':
      "If you don't @ anyone, the working teammates answer independently and at the same time. For questions that need judgement, they discuss, challenge each other and hand you a team conclusion once they agree. Use @ to choose who works and in what order. Drag in or paste images and files.",
    '新品耳机首发，定价 399 还是 499 更合适？说说理由': 'Launching new earbuds: should they be priced at $79 or $99? Explain why.',
    '@Gemini 先查最近耳机类小红书爆款笔记的风格，@Claude 再据此写 5 篇文案，@Codex 最后整理成 Excel 表': '@Gemini research what makes recent viral earbud posts work, @Claude then write 5 posts based on that, @Codex put them in an Excel sheet',
    '我发了一张竞品海报，大家分别从文案、视觉、卖点三个角度点评一下': "I've attached a competitor's poster. Critique it on copy, visuals and selling points.",
    '@Codex 做一个网页小工具：输入活动预算和达人报价，自动算出投放组合': '@Codex build a small web tool: enter a campaign budget and creator rates, and it works out the best mix',
    '参与': 'Working', '（不在线）': '(offline)', '点一下：这次不让 Ta 参与': 'Click to leave them out this time', '点一下：让 Ta 参与': 'Click to include them',
    '不点名：参与的队友同时作答，再自己讨论出结论 · @ 多人：按 @ 的顺序来': "No @: working teammates answer at once, then discuss to a conclusion · @ several: they go in @ order",
    '全员': 'everyone', '参与的人同时作答': 'Working teammates answer at once',
    '被你点名': 'Assigned by you', '独立作答': 'Independent answer', '依次发言': 'In turn', '同意': 'Agree', '有异议': 'Objects', '团队结论': 'Team conclusion',
    '大家达成共识': 'Consensus reached', '仍有分歧，已写明': 'Still split, noted below',
    '仍有分歧，等你拍板': 'Still split, your call', '老板已拍板': 'Decided by you', '请你拍板': 'Your call',
    '你已拍板，队友按你的话执行': 'You decided; the team is following your instructions', '你已拍板，队友按这个方案执行': 'You decided; the team is carrying out this option',
    '点一个方案，或者直接在下面输入框里说你的决定（不用 @）。': 'Pick an option, or just type your decision in the box below (no @ needed).',
    '直接在下面输入框里说你的决定（不用 @）。': 'Just type your decision in the box below (no @ needed).',
    '按你的拍板分工中': 'Assigning work per your decision', '按你的拍板执行': 'Following your decision', '按你的拍板分工': 'Assigning work per your decision', '接手中': 'Taking over', '独立思考中': 'Thinking independently', '自查返工': 'Fixing after check', '返工中': 'Fixing',
    '读队友的观点，思考中': "Reading teammates' views", '整理团队结论': 'Writing the team conclusion', '正在做': 'Working',
    '分工方案，等你开工': 'Work plan, waiting for your go', '已开工': 'Started', '没有开工': 'Not started', '你提了修改意见，正在调整': 'You asked for changes; adjusting', '方案没用上': 'Plan not used', '按上面说的分工': 'As described above', '开工': 'Start', '先不做': 'Not now',
    '开工后接力、验收、返工都自动进行，不再问你。想改分工，直接在下面输入框里说（不用 @）。': 'Once started, hand-offs, review and fixes run on their own without asking you. To change the plan, just say so below (no @ needed).',
    '任务板': 'Task board', '本机经验': 'Lessons from this computer', '队友在这台电脑上踩过两次以上的坑。点"加入"后，以后每个干活的队友都会先知道，少走弯路。': 'Problems your teammates hit at least twice on this computer. Click "Add" and every working teammate will know up front.', '已加入': 'Added', '移除': 'Remove', '体检没通过：': 'Health check failed: ', '这次的做法验收通过了：存成技能，下次同类的活直接照着做': 'This approach passed review: save it as a skill so similar work can follow it next time', '建议加进规矩墙': 'Suggested for the rules wall', '队友从对话里发现你说过"以后都这样"的要求：': 'Your teammates noticed you asked for this from now on:', '加入': 'Add', '不用': 'No thanks', '已加进规矩墙，下一轮起所有队友都会照着做': 'Added to the rules wall. Every teammate follows it from the next turn.', '按推荐配置团队': 'Use the recommended team setup', '推荐的团队配置': 'Recommended team setup', '套用': 'Apply', '先不用': 'Not now', '已按推荐配置好团队': 'Team set up as recommended', '数据去向': 'Where data goes', '这个对话的聊天和文件发给过：': 'This chat and its files were sent to: ', '。命令行队友能直接读对话文件夹里的所有文件；只有 API 队友是由 Hola 决定给它看什么。': ". Command-line teammates can read every file in the conversation folder directly; Hola only controls what API teammates see.", '按你的新要求调整': 'Adjusting to your new request', '调整中': 'Adjusting', '方案已确认': 'Plan approved', '点名': 'Assigned', '接力': 'Hand-off', '返工': 'Fix', '调整': 'Adjust', '执行': 'Carry out', '开会': 'Meeting', '排队': 'Queued', '进行中': 'Running', '已取消': 'Cancelled', '跳过': 'Skipped', '中断': 'Interrupted', '大家': 'Everyone', '收起': 'Collapse', '展开': 'Expand', '改派给': 'Reassign to', '取消这一项（让 Ta 停下）': 'Cancel this step (stop them)', '取消这一项': 'Cancel this step',
    '派活给队友前，先请我确认分工（开工）': 'Ask me to approve the work plan before handing work to teammates',
    '确认一次之后，接力、验收、返工、内置浏览器里的点击都自动进行，不再逐个问你。关掉就全自动。': 'After one approval, hand-offs, review, fixes and clicks in the built-in browser run on their own without asking. Turn this off to make everything automatic.',
    '思考': 'Thinking', '动作': 'Action', '结果': 'Result', '日志': 'Log', '出错': 'Error', '说': 'Said',
    '各自思考中': 'Thinking independently', '内部讨论中': 'Discussing', '整理结论中': 'Writing conclusion', '整理记忆中': 'Updating memory',
    '· 只读': '· read-only', '在线': 'Online', '不在线': 'Offline', '对话记忆已更新': 'Memory updated', '查看': 'View',
    '下载': 'Download', '在文件夹中显示': 'Show in folder', '预览': 'Preview', '打开': 'Open', '文件预览': 'File preview', '下载原文件': 'Download original',
    '附件还在上传': 'Attachments are still uploading', '发送失败：Hola 后台可能没在运行': "Couldn't send: the Hola background service may not be running",
    '先开始一个对话': 'Start a chat first', '请求失败': 'Request failed', 'Hola 后台断开了，正在重连…': 'Lost connection to Hola. Reconnecting…',
    'Hola 已退出，可以关掉这个窗口了。': 'Hola has quit. You can close this window.',
    // Wick：花费上限、单价、规矩墙
    '花费上限（元，0 = 不限）': 'Spending limits (¥, 0 = no limit)', '每个对话': 'Per chat', '每天': 'Per day',
    '只算按用量收费的 API 队友（订阅制的 Claude、Codex、Gemini 不按次收钱）。到了上限就停下来告诉你。': "Only pay-per-use API teammates count (subscription Claude, Codex and Gemini aren't charged per use). When a limit is reached, the team stops and tells you.",
    '单价（元 / 百万 token，可不填）': 'Price (¥ per million tokens, optional)', '输入': 'Input', '命中缓存': 'Cached', '输出': 'Output',
    '用来算花了多少钱、管花费上限。DeepSeek 的官方价已经内置，不用填。': "Used to estimate spending and enforce limits. DeepSeek's official prices are built in.",
    '规矩墙': 'Rules wall', '一行一条。每一条都会原样告诉所有队友，聊多久都不会被忘掉，也不会被压缩。': 'One rule per line. Every teammate gets each rule word for word, however long the chat runs; rules are never shortened or forgotten.',
    '比如：价格一律写成 ¥ 加数字，不写“元”': 'For example: always write prices as ¥ plus the number', '保存规矩': 'Save rules',
    '自动收进来的：你较早说过的话（最近 50 条以外）': 'Added automatically: what you said earlier (beyond the last 50 messages)',
    '已保存，下一轮起所有队友都会照着做': 'Saved. From the next turn on, every teammate follows these rules',
  };

  const P = [
    [/^碰到 (d+) 次$/, (m, n) => `Hit ${n} times`], [/^体检正常，响应 ([d.]+) 秒（(d+) 小时内）$/, (m, s, h) => `Health check OK, ${s}s response (within ${h}h)`], [/^（(d+) 小时内）$/, (m, h) => ` (within ${h}h)`],
    [/^进行中 (\d+)$/, (m, n) => `${n} running`], [/^排队 (\d+)$/, (m, n) => `${n} queued`], [/^完成 (\d+)$/, (m, n) => `${n} done`],
    [/^删除项目「(.+)」？[\s\S]*$/, (m, n) => `Delete the project "${n}"?\n\nIts chats won't be deleted; they move to Chats.`],
    [/^用过 (\d+) 次$/, (m, n) => `Used ${n} time${n === '1' ? '' : 's'}`],
    [/^附带 (\d+) 个文件$/, (m, n) => `${n} file${n === '1' ? '' : 's'} included`],
    [/^(.+) 正在把这次的做法整理成技能…$/, (m, n) => `${n} is turning this into a skill…`],
    [/^删除技能「(.+)」？$/, (m, n) => `Delete the skill "${n}"?`],
    [/^导入失败：([\s\S]+)$/, (m, e) => `Import failed: ${e}`],
    [/^同一文件夹里的其他文件：(.+)$/, (m, f) => `Other files in its folder: ${f}`],
    [/^(\d+) 分钟前$/, (m, n) => `${n} min ago`],
    [/^(\d+)月(\d+)日$/, (m, a, b) => `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+a]} ${b}`],
    [/^(\d+)\/(\d+) 在线$/, (m, a, b) => `${a}/${b} online`],
    [/^(\d+) 位在干活$/, (m, n) => `${n} working`],
    [/^(.+) 在干活$/, (m, n) => `${n} is working`],
    [/^(.+) 交给 Ta$/, (m, n) => `Handed off by ${n}`],
    [/^讨论 · 第 (\d+) 轮$/, (m, n) => `Discussion · round ${n}`],
    [/^过程 (\d+) 步(?: · 用时 ([\d:]+))?$/, (m, n, t) => `Process · ${n} step${n === '1' ? '' : 's'}${t ? ' · ' + t : ''}`],
    [/^产出 (\d+) 个文件$/, (m, n) => `${n} file${n === '1' ? '' : 's'} produced`],
    [/^(\d\d:\d\d) · 已叫停$/, (m, t) => `${t} · stopped`],
    [/^(\d\d:\d\d) · 出错$/, (m, t) => `${t} · error`],
    [/^(.+) 正在整理对话记忆…$/, (m, n) => `${n} is updating the conversation memory…`],
    [/^下载 (.+)$/, (m, n) => `Download ${n}`],
    [/^颜色 (#\w+)$/, (m, c) => `Color ${c}`],
    [/^编辑 (.+)$/, (m, n) => `Edit ${n}`],
    [/^在线 · (.*)$/, (m, v) => `Online · ${v}`],
    [/^在线 (.*)$/, (m, v) => `Online ${v}`],
    [/^已保存（(.+)），留空表示不改$/, (m, k) => `Saved (${k}). Leave blank to keep it`],
    [/^连上了：([\s\S]*)$/, (m, v) => `Connected: ${v.replace(/ · 能动手$/, ' · can do work').replace(/ · 这个模型不支持工具调用，只能动脑$/, " · this model doesn't support tool calling, so it only thinks")}`],
    [/^没连上：([\s\S]*)$/, (m, v) => `Not connected: ${v}`],
    [/^测试失败：([\s\S]*)$/, (m, v) => `Test failed: ${v}`],
    [/^上传失败：([\s\S]*)$/, (m, v) => `Upload failed: ${v}`],
    [/^(.+)，今天让大家一起做什么？$/, (m, n) => `${n}, what should the team work on today?`],
    [/^(.+) ·$/, (m, w) => (D[w] ? D[w] + ' ·' : null)],
    [/^彻底删除「([\s\S]+)」？[\s\S]*$/, (m, n) => `Permanently delete "${n}"?\n\nThe chat history, memory, attachments and every file teammates produced will be deleted for good. This can't be undone.`],
    [/^默认（(.+)）$/, (m, x) => `Default (${D[x] || x})`],
    // 写进对话里的系统消息：保存时是当时的界面语言，切换语言后在这里翻译（英文和服务端 T() 里的英文一致）
    [/^(.+) 不在线，跳过。$/, (m, n) => `${n} is offline, skipped.`],
    [/^还有分歧，继续讨论 · 第 (\d+) 轮$/, (m, k) => `Still disagreeing: discussion · round ${k}`],
    [/^进入内部讨论 · 第 (\d+) 轮$/, (m, k) => `Internal discussion · round ${k}`],
    [/^老板请大家讨论一下 (.+) 的回答$/, (m, n) => `You asked the team to discuss ${n}'s answer`],
    [/^主脑 (.+) 这次不在，由 (.+) 代为验收。$/, (m, a, b) => `The main brain ${a} isn't available, so ${b} reviews this time.`],
    [/^已经退回重做 (\d+) 次了，先停一下，请老板看看怎么处理。$/, (m, k) => `Work has been sent back ${k} times. Pausing so you can decide what to do.`],
    [/^这次只有 (.+) 位大脑在线，开不成会。[\s\S]*$/, (m, n) => `Only ${n} brain is available, so there's no meeting. Pick more brains under "Working" below the input box, or turn a helper into a brain under Teammates.`],
    [/^达成共识，由 (.+) 整理团队结论$/, (m, n) => `Consensus reached, ${n} writes the team conclusion`],
    [/^讨论 (\d+) 轮仍有分歧，由 (.+) 整理结论并写明分歧$/, (m, k, n) => `Still split after ${k} rounds, ${n} writes the conclusion and notes the disagreement`],
    [/^这一轮新增或修改了：(.+)$/, (m, f) => `Added or changed this round: ${f.split('、').join(', ')}`],
    [/^(.+) 这次没有参与（或不在线），(.+) 交给 Ta 的活没有派出去。需要的话，老板可以直接 @ Ta。$/, (m, a, b) => `${a} isn't working on this (or is offline), so ${b}'s hand-off wasn't sent. @ them directly if you want them in.`],
    [/^队友之间已经自动接力 (\d+) 次了，先停一下，等老板看一眼再继续。$/, (m, k) => `Teammates have handed off ${k} times in a row. Pausing here so you can take a look.`],
    [/^「(.+)」· 你发的$/, (m, t) => `"${t}" · sent by you`],
    [/^「(.+)」· (.+) 做的$/, (m, t, n) => `"${t}" · made by ${n}`],
    [/^删除「(.+)」？会从资料库文件夹里永久删除。$/, (m, n) => `Delete "${n}"? It will be permanently removed from the library folder.`],
    [/^(.+) 正在帮看不到图片的队友看图…$/, (m, n) => `${n} is describing the image for teammates who can't see it…`],
    [/^删除队友「(.+)」？[\s\S]*$/, (m, n) => `Delete teammate "${n}"?\n\nPast chats aren't affected.`],
    [/^Hola (\S+) 已经准备好\n\n[\s\S]*$/, (m, v) => `Hola ${v} is ready\n\nThe new version has been downloaded and its official signature verified. It takes effect when Hola restarts. Work in progress will be stopped.`],
    [/^Hola (\S+) 发布了\n\n[\s\S]*$/, (m, v) => `Hola ${v} is out\n\nThis update needs the new installer. "Download" opens the download page; your chats and settings are kept when you install it.`],
    [/^退出 Hola？[\s\S]*$/, () => 'Quit Hola?\n\nAnything in progress will be stopped. Double-click the desktop icon to open it again.'],
  ];

  function tr(s) {
    if (LANG !== 'en' || s == null) return s;
    const k = String(s).trim();
    if (!k || !/[\u4e00-\u9fff]/.test(k)) return s;
    let v = D[k];
    if (v == null) for (const [re, fn] of P) { const m = k.match(re); if (m) { v = fn(...m); if (v != null) break; } }
    return v == null ? s : String(s).replace(k, v);
  }

  const SKIP = 'script,style,textarea,[data-raw]';
  function translate(root) {
    if (LANG !== 'en' || !root) return;
    if (root.nodeType === 3) { if (!root.parentElement || !root.parentElement.closest(SKIP)) { const v = tr(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; } return; }
    if (root.nodeType !== 1 || root.closest(SKIP)) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    let n; while ((n = w.nextNode())) { const v = tr(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
    const els = [root, ...root.querySelectorAll('[placeholder],[title],[aria-label]')];
    for (const el of els) {
      if (el.closest && el.closest('[data-raw]')) continue;
      for (const a of ['placeholder', 'title', 'aria-label']) { const v = el.getAttribute && el.getAttribute(a); if (v) { const t = tr(v); if (t !== v) el.setAttribute(a, t); } }
    }
  }

  window.HOLA_LANG = LANG;
  window.t = tr;
  window.setHolaLang = (l) => { store.set('hola.lang', l); };
  if (LANG === 'en') {
    document.documentElement.lang = 'en';
    const oc = window.confirm.bind(window);
    window.confirm = (m) => oc(tr(m));
    document.addEventListener('DOMContentLoaded', () => {
      translate(document.body);
      new MutationObserver((list) => {
        for (const m of list) {
          if (m.type === 'characterData') translate(m.target);
          else if (m.type === 'attributes') translate(m.target);
          else m.addedNodes.forEach(translate);
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] });
    });
  }
})();
