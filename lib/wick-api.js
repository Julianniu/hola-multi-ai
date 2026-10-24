// Wick · 接口层：API 队友每次请求都经过这里。
// - 接口一时出问题（429 限流、5xx、网络断开）就等一会儿再试，而不是整轮失败（基线 S14：一次 429 就直接失败）；
//   服务商给了 Retry-After 就照它等。401 / 402 / 403 / 404 这类"再试也没用"的不重试。
// - 同一把 Key 同时发出的请求排队（比如 v4-pro 和 flash 用同一把 Key 一起开会），避免一起被限流。
'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_DIR, T, settings, wick } = require('./core');

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const WAIT_MS = [2000, 6000, 15000]; // 最多重试 3 次
const NET_ERR = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR|socket hang up|fetch failed|network|terminated/i;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

// ---------------------------------------------------------------- 同一把 Key 排队

const LIMIT = 3; // 同一把 Key 最多同时 3 个请求
const lanes = new Map();
async function inLane(a, fn) {
  const key = String(a.baseUrl || '') + '|' + String(a.apiKey || '').slice(-12);
  const lane = lanes.get(key) || { busy: 0, wait: [] };
  lanes.set(key, lane);
  if (lane.busy >= LIMIT) await new Promise((r) => lane.wait.push(r));
  lane.busy++;
  try { return await fn(); }
  finally { lane.busy--; const next = lane.wait.shift(); if (next) next(); else if (!lane.busy) lanes.delete(key); }
}

// ---------------------------------------------------------------- 重试

function retryAfter(res) {
  const h = res && res.headers && res.headers.get('retry-after');
  if (!h) return 0;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(60000, s * 1000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.min(60000, Math.max(0, d - Date.now())) : 0;
}

// call() 发一次请求、返回 fetch 的 Response。返回最后一次的 Response（成功或不值得再试的失败）；网络错误重试完仍失败就抛出
async function sendWithRetry(a, call, { signal, proc } = {}) {
  const log = (t) => { if (proc) proc('log', t); };
  return inLane(a, async () => {
    for (let i = 0; ; i++) {
      let res = null, err = null;
      try { res = await call(); } catch (e) { if (e.name === 'AbortError') throw e; err = e; }
      const again = wick('apiRetry') && i < WAIT_MS.length && (err ? NET_ERR.test(String((err.cause && (err.cause.code || err.cause.message)) || err.message)) : RETRY_STATUS.has(res.status));
      if (!again) { if (err) throw err; return res; }
      const wait = Math.max(retryAfter(res), WAIT_MS[i]) + Math.floor(Math.random() * 500);
      const why = err ? T('连不上接口', "can't reach the API") : res.status === 429 ? T('接口忙（限流）', 'the API is rate-limiting') : T(`接口出错（HTTP ${res.status}）`, `the API failed (HTTP ${res.status})`);
      log(T(`${why}，${Math.round(wait / 1000)} 秒后重试（第 ${i + 1} 次）`, `${why}; retrying in ${Math.round(wait / 1000)} s (attempt ${i + 1})`));
      if (res) { try { await res.text(); } catch (_) {} }
      await sleep(wait, signal);
    }
  });
}

// ---------------------------------------------------------------- 花费（wick budget）

// 每百万 token 的单价（元）。DeepSeek 官方价按 1 美元 ≈ 7.2 元换算（2026-10 的官方价，非高峰时段）；
// 别的模型可以在队友资料里自己填（api.price = { input, cached, output }，元 / 百万 token），没填就不计价
const USD = 7.2;
const PRICES = {
  'deepseek-flash': { input: 0.15 * USD, cached: 0.003 * USD, output: 0.6 * USD },
  'deepseek-v4-flash': { input: 0.15 * USD, cached: 0.003 * USD, output: 0.6 * USD },
  'deepseek-v4-pro': { input: 0.66 * USD, cached: 0.022 * USD, output: 1.98 * USD },
};
function priceOf(a) {
  const p = (a || {}).price;
  if (p && Number(p.input) >= 0 && Number(p.output) >= 0) return { input: +p.input, cached: Number(p.cached ?? p.input), output: +p.output };
  return PRICES[String((a || {}).model || '').toLowerCase()] || null;
}
// 一次请求花了多少元（usage 是接口原样返回的）；不知道单价就是 null
function costOf(a, u) {
  const p = priceOf(a);
  if (!p || !u) return null;
  const input = Number(u.prompt_tokens) || 0;
  const cached = Number((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens) || 0;
  const output = Number(u.completion_tokens) || 0;
  return ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
}

// 每天花了多少：data/wick-spend.json { "2026-10-24": 0.12, … }（只留最近 60 天）
const SPEND_FILE = path.join(DATA_DIR, 'wick-spend.json');
let spend = {};
try { spend = JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8')); } catch (_) {}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function addSpend(c, yuan) {
  if (!(yuan > 0)) return;
  if (c) c.cost = Math.round(((c.cost || 0) + yuan) * 1e6) / 1e6;
  const k = today();
  spend[k] = Math.round(((spend[k] || 0) + yuan) * 1e6) / 1e6;
  const keys = Object.keys(spend).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - 60))) delete spend[old];
  try { fs.writeFileSync(SPEND_FILE, JSON.stringify(spend)); } catch (_) {}
}
const spentToday = () => spend[today()] || 0;
// 超了上限就返回一句说明（settings.budget = { perConv, perDay }，单位元，0 / 不填 = 不限）
function overBudget(c) {
  if (!wick('budget')) return '';
  const b = settings.budget || {};
  const conv = Number(b.perConv) || 0, day = Number(b.perDay) || 0;
  if (conv > 0 && c && (c.cost || 0) >= conv) return T(`这个对话已经花了约 ${(c.cost || 0).toFixed(2)} 元，到了每个对话 ${conv} 元的上限`, `This chat has spent about ¥${(c.cost || 0).toFixed(2)}, reaching the per-chat limit of ¥${conv}`);
  if (day > 0 && spentToday() >= day) return T(`今天已经花了约 ${spentToday().toFixed(2)} 元，到了每天 ${day} 元的上限`, `About ¥${spentToday().toFixed(2)} spent today, reaching the daily limit of ¥${day}`);
  return '';
}

module.exports = { sendWithRetry, inLane, RETRY_STATUS, priceOf, costOf, addSpend, spentToday, overBudget, PRICES };
