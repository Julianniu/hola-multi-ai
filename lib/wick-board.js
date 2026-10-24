// Wick · 任务板（wick board）：老板这一件事拆成了哪几步、谁在做、做到哪、卡在哪。
// 每一个排进队列的回合（主脑回答、被点名、接力、验收、返工、开会）都是板上的一项；老板能改派还没开始的、取消某一项。
// 存在对话里（c.board，跟聊天记录一起存盘），Hola 重启后据此把没做完的活接着做（engine 的 resumeWork）。
'use strict';
const { broadcast } = require('./core');
const { clip, saveConv } = require('./convs');

let seq = 0;
const SAVE_JOB = ['type', 'member', 'reason', 'by', 'of', 'after', 'problems', 'title', 'subFor', 'reassigned', 'replan', 'task'];

function board(c) { if (!c.board) c.board = { items: [], log: [] }; return c.board; }
function push(c) { broadcast({ type: 'board', conv: c.id, board: c.board || null }); saveConv(c); }

// 老板开了一件新事：清空任务板（plan 是这件事的方案确认状态，见 engine 的方案确认）
function boardReset(c, task) {
  c.board = { task: clip(String(task || '').replace(/\s+/g, ' ').trim(), 80), at: Date.now(), items: [], log: [], plan: null };
  push(c);
}
// 排进队列的一项：job 上记下 id，板上记下谁、干什么、什么状态（job 本身也存一份，重启后能接着排）
function boardAdd(c, job) {
  if (!job.id) job.id = 'j' + Date.now().toString(36) + (++seq).toString(36);
  const saved = {};
  for (const k of SAVE_JOB) if (job[k] !== undefined) saved[k] = job[k];
  board(c).items.push({ id: job.id, member: job.member || '', reason: job.reason || job.type, by: job.by || null, title: job.title || '', status: 'queued', at: Date.now(), job: saved });
  push(c);
  return job;
}
function boardItem(c, id) { return ((c.board && c.board.items) || []).find((x) => x.id === id) || null; }
function boardSet(c, id, patch) {
  const it = boardItem(c, id);
  if (!it) return null;
  Object.assign(it, patch);
  if (patch.member && it.job) it.job.member = patch.member;
  push(c);
  return it;
}
// 板上的一行记录（比如"方案确认后自动允许了一次浏览器点击"），最多留 50 条
function boardLog(c, text) {
  const b = board(c);
  b.log.push({ at: Date.now(), t: String(text) });
  if (b.log.length > 50) b.log.shift();
  push(c);
}
// 还没做完的（排着队的、正在做的）
const openItems = (c) => ((c.board && c.board.items) || []).filter((x) => x.status === 'queued' || x.status === 'running');

module.exports = { board, boardReset, boardAdd, boardItem, boardSet, boardLog, openItems };
