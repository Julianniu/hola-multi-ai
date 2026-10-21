// Hola · 光辉联合
// 老板（你）指挥地位平等的 AI 队友：Claude、Codex、Gemini，以及你自己接入的其他 AI
// 零依赖，只需要 Node.js。启动：node server.js（平时双击桌面的 Hola 图标即可）

'use strict';
// 代码按功能拆在 lib/ 里，只往下依赖：
// core（配置、设置、推送）→ members（队友）→ convs（对话和文件）→ run（调用 AI）→ skills（技能库）
// → prompts（提示词）→ engine（讨论引擎、记忆）→ build-check（官方版校验）→ http（网页接口和启动）
require('./lib/http');
