// Wick · 守门：对话文件夹里不许出现"会被命令行队友自动读取的配置"。
// 实测（2026-10-23，Claude Code 2.1.299）：Claude 在后台模式下会自动执行当前文件夹 .claude/settings.json 里的钩子，
// 不提示任何人；Codex 会读 AGENTS.md，Antigravity 会读 GEMINI.md / .agents/。队友们都在同一个对话文件夹里写文件，
// 所以任何一位（哪怕是只读的、或被附件里的指令骗了的）写下这样一个文件，下一次别的队友一启动就会照着执行。
// 做法：每次启动命令行队友之前、每轮做完之后扫一遍，发现了就挪进 .hola/quarantine（不删，老板能找回），并在群里说一声。
'use strict';
const fs = require('fs');
const path = require('path');
const { ATTACH_DIR, WORKSPACE, T } = require('./core');
const { TEXT_DIR, convDir, sys } = require('./convs');

// 文件夹名 / 文件名（不分大小写）
const TRAP_DIRS = new Set(['.claude', '.codex', '.gemini', '.agents']);
const TRAP_FILES = new Set(['.mcp.json', 'claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'gemini.md']);
const isTrap = (name, dir) => (dir ? TRAP_DIRS : TRAP_FILES).has(String(name).toLowerCase());
// 给 API 队友的写文件工具用：这个相对路径里有没有配置文件 / 配置文件夹
const trapPath = (rel) => String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean).some((p, i, a) => isTrap(p, i < a.length - 1) || (i === a.length - 1 && isTrap(p, true)));

const SKIP = new Set(['.hola', ATTACH_DIR, TEXT_DIR, 'node_modules', '.git']);

// 空的配置文件夹没有危害：Codex 在安全模式下自己会在工作文件夹里建一个空的 .codex（沙盒用），不能每轮都挪、每轮都提醒
function hasFiles(abs) {
  let list = [];
  try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return false; }
  return list.some((e) => !e.isDirectory() || hasFiles(path.join(abs, e.name)));
}

function findTraps(root, maxDepth) {
  const out = [];
  const walk = (rel, depth) => {
    let list = [];
    try { list = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (isTrap(e.name, e.isDirectory())) { if (!e.isDirectory() || hasFiles(path.join(root, r))) out.push(r); continue; }
      if (e.isDirectory() && depth < maxDepth && !SKIP.has(e.name)) walk(r, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

function moveAway(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (_) { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

// 扫这个对话文件夹（和所有对话共用的上一级文件夹），挪走找到的配置。返回挪走的相对路径
function guardConv(c) {
  const moved = [];
  const dir = convDir(c);
  const at = stampNow();
  for (const rel of findTraps(dir, 6)) {
    try { moveAway(path.join(dir, rel), path.join(dir, '.hola', 'quarantine', at, rel)); moved.push(rel); } catch (_) {}
  }
  // 上一级（所有对话共用）：只看第一层，这里的 CLAUDE.md 会影响每一个对话
  for (const rel of findTraps(WORKSPACE, 0)) {
    try { moveAway(path.join(WORKSPACE, rel), path.join(WORKSPACE, '.hola-quarantine', at, rel)); moved.push('../' + rel); } catch (_) {}
  }
  if (moved.length) {
    sys(c, T(`有队友在文件夹里写了会被其他 AI 自动读取、甚至自动执行的配置（${moved.join('、')}），为了安全已经挪到 .hola/quarantine 里（没有删除）。`,
      `A teammate wrote config that other AIs would read or even run automatically (${moved.join(', ')}). For safety it was moved to .hola/quarantine (not deleted).`));
  }
  return moved;
}

const EMBER = 'Rm9yIFlpcmdhIGFuZCBHcmFjZSwgdGhlIHR3byBsb3ZlcyBvZiBteSBsaWZlLiDigJQgSnVsaWFuLg==';

module.exports = { guardConv, findTraps, trapPath, isTrap };
