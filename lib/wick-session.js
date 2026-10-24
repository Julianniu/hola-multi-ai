// Wick · 长会话：每个"对话 × 队友"一个会话（wick sessions，默认关，A/B 通过后再开）。
// 第一轮照旧送完整提示词；之后续接同一个会话，只送"上次之后的新消息"和变了的部分（记忆、文件清单、团队说明）。
// 队友读过的文件、跑过的命令、自己的思路都留在会话里，不用每轮从零开始；也不用每轮把整段群聊重送一遍。
// 记在 .hola/wick-sessions.json：{ 队友id: { sid, sig, sent: [消息id], hashes: {…}, turns, at, dirty } }
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { wick } = require('./core');
const { convDir, rt } = require('./convs');

const MAX_TURNS = 40;           // 续接太多轮后重开一个（会话太长，命令行自己会压缩，但压缩会丢东西）
const MAX_AGE = 24 * 3600e3;    // 隔太久重开

const file = (c) => path.join(convDir(c), '.hola', 'wick-sessions.json');
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

function all(c) {
  const r = rt(c);
  if (!r.wickSess) { try { r.wickSess = JSON.parse(fs.readFileSync(file(c), 'utf8')); } catch (_) { r.wickSess = {}; } }
  return r.wickSess;
}
function save(c) { try { fs.mkdirSync(path.dirname(file(c)), { recursive: true }); fs.writeFileSync(file(c), JSON.stringify(all(c))); } catch (_) {} }

// 换了模型、思考深度、权限、启动参数，会话就不能接着用了
const sigOf = (m) => hash(JSON.stringify([m.type, m.parser, m.model || '', m.effort || '', m.access || '', m.args || [], (m.api || {}).baseUrl || '', (m.api || {}).model || '']));
// 哪些队友能续接：三家订阅命令行 + API 队友（自己加的普通命令行队友不行）
const resumable = (m) => m.type === 'api' || ['claude-stream', 'codex-json', 'agy-json'].includes(m.parser);

// 这一轮能接着用的会话；不能用就返回 null（调用方送完整提示词，开一个新的）
function current(c, m) {
  if (!wick('sessions') || !resumable(m)) return null;
  const s = all(c)[m.id];
  if (!s || s.dirty || !s.sid || s.sig !== sigOf(m) || s.turns >= MAX_TURNS || Date.now() - s.at > MAX_AGE) return null;
  return s;
}
// 开一个新会话（sid 先空着：Codex / Antigravity 的编号要等它启动后报出来；Claude 由我们指定）
function fresh(c, m) {
  if (!wick('sessions') || !resumable(m)) return null;
  const s = { sid: m.parser === 'claude-stream' ? crypto.randomUUID() : '', sig: sigOf(m), sent: [], hashes: {}, turns: 0, at: Date.now(), fresh: true };
  return s;
}
// 这一轮做完：记下会话编号、送过的消息、各部分的指纹
function commit(c, m, s, { sid, sent, hashes }) {
  if (!s) return;
  if (sid) s.sid = sid;
  if (!s.sid) return; // 没拿到编号，下次只能重开
  s.sent = [...new Set([...(s.sent || []), ...(sent || [])])].slice(-2000);
  s.hashes = { ...(s.hashes || {}), ...(hashes || {}) };
  s.turns = (s.turns || 0) + 1;
  s.at = Date.now();
  delete s.fresh;
  delete s.dirty;
  all(c)[m.id] = s;
  save(c);
}
// 半路被叫停、续接失败：这个会话不再用
function drop(c, m) {
  const map = all(c);
  if (map[m.id]) { delete map[m.id]; save(c); }
}

module.exports = { current, fresh, commit, drop, hash, sigOf, resumable };
