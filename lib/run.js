// Hola · 调用 AI：解析各家命令行的输出、启动命令行、调用 OpenAI 兼容接口
'use strict';
const fs = require('fs');
const path = require('path');
const { EN, ROOT, T, TIMEOUT_MS, cfg } = require('./core');
const { checkMember, cleanEnv, codexConfig, codexDefaultModel, killTree, members, spawnMember, stripAnsi } = require('./members');
const { withBrowser } = require('./browser');
const { addProc, captureFromJson, captureFromText, clip, convDir, importPath, mediaWatchDirs, rt, snapshotDirs, textVersionRel } = require('./convs');

// ---------------------------------------------------------------- 输出解析

// 用量统一记成 { input（含缓存）, cached, output }，各家口径不同，在这里换算
function addUsage(msg, u) {
  if (!msg || !u) return;
  const n = (x) => (Number.isFinite(+x) ? +x : 0);
  const cur = msg.usage || { input: 0, cached: 0, output: 0 };
  msg.usage = { input: cur.input + n(u.input), cached: cur.cached + n(u.cached), output: cur.output + n(u.output) };
}

function makeParser(kind, c, msg) {
  const texts = [];
  let finalText = '';
  const tryJSON = (line) => { try { return JSON.parse(line); } catch (_) { return null; } };
  const P = (k, t) => addProc(c, msg, k, t);

  if (kind === 'claude-stream') {
    return {
      line(line) {
        if (!line.trim()) return;
        const o = tryJSON(line);
        if (!o) return P('log', line);
        if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          for (const x of o.message.content) {
            if (x.type === 'thinking' && x.thinking) P('think', x.thinking);
            else if (x.type === 'text' && x.text) texts.push(x.text);
            else if (x.type === 'tool_use') P('tool', describeTool(c, x.name, x.input));
          }
        } else if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
          for (const x of o.message.content) {
            if (x.type === 'tool_result') {
              const t = Array.isArray(x.content) ? x.content.map((y) => y.text || '').join('\n') : x.content;
              P(x.is_error ? 'error' : 'result', clip(t, 600));
            }
          }
        } else if (o.type === 'system' && o.subtype === 'init' && o.model) {
          msg.model = o.model;
        } else if (o.type === 'result') {
          const u = o.usage || {};
          // Claude 的 input_tokens 不含缓存读写，要加上
          if (o.usage) addUsage(msg, { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), cached: u.cache_read_input_tokens, output: u.output_tokens });
          if (typeof o.result === 'string') finalText = o.result;
          if (o.is_error) P('error', o.result || o.subtype || '出错了');
        }
      },
      finish() { return (finalText || texts[texts.length - 1] || '').trim(); },
    };
  }

  if (kind === 'codex-json') {
    return {
      line(line) {
        if (!line.trim()) return;
        const o = tryJSON(line);
        if (!o) return P('log', line);
        captureFromJson(c, memberOf(msg), msg, o);
        if (o.type === 'turn.completed' && o.usage) addUsage(msg, { input: o.usage.input_tokens, cached: o.usage.cached_input_tokens, output: o.usage.output_tokens });
        const it = o.item || null;
        if (it && o.type === 'item.started' && it.type === 'command_execution') P('tool', '运行命令：' + it.command);
        else if (it && o.type === 'item.completed') {
          if (it.type === 'reasoning') P('think', it.text);
          else if (it.type === 'agent_message') texts.push(it.text);
          else if (it.type === 'command_execution') P(it.exit_code ? 'error' : 'result', clip(it.aggregated_output || `退出码 ${it.exit_code}`, 600));
          else if (it.type === 'file_change') P('tool', '修改文件：' + (it.changes || []).map((x) => `${x.path}（${x.kind}）`).join('，'));
          else if (it.type === 'web_search') P('tool', '联网搜索：' + (it.query || ''));
          else if (it.type === 'mcp_tool_call') P('tool', `调用工具：${it.server || ''} ${it.tool || ''}`);
          else if (it.type === 'error') P('error', it.message);
        } else if (o.type === 'turn.failed' || o.type === 'error') P('error', (o.error && o.error.message) || o.message || line);
      },
      finish() { return (texts[texts.length - 1] || '').trim(); },
    };
  }

  if (kind === 'agy-json') {
    const lines = [];
    return {
      line(line) { if (line.trim()) lines.push(line); },
      finish() {
        const all = lines.join('\n').trim();
        const env = (t) => { const o = tryJSON(t); return o && typeof o === 'object' && 'response' in o ? o : null; };
        let e = env(all);
        for (let i = lines.length - 1; i >= 0 && !e; i--) e = env(lines[i]);
        if (e) captureFromJson(c, memberOf(msg), msg, e);
        if (e && e.usage) addUsage(msg, { input: e.usage.input_tokens, cached: e.usage.cache_read_tokens, output: e.usage.output_tokens });
        if (!e) { if (all) P('log', all); return all; }
        if (e.status && e.status !== 'SUCCESS') P('error', '状态：' + e.status);
        return String(e.response || '').trim();
      },
    };
  }

  return { // plain
    line(line) { texts.push(line); },
    finish() { return texts.join('\n').trim(); },
  };
}

function memberOf(msg) { return members[msg.from] || { name: msg.from }; }

function describeTool(c, name, input) {
  input = input || {};
  // 内置浏览器的工具（mcp__hola-browser__open 等）
  const br = /^mcp__hola-browser__(\w+)$/.exec(name);
  if (br) return `浏览网页：${{ open: '打开', read: '读网页', screenshot: '截图', click: '点击', type: '输入', scroll: '翻页', back: '后退' }[br[1]] || br[1]}${input.url ? ' ' + input.url : ''}`;
  const p = input.file_path || input.path || input.pattern || input.url || input.query || input.command || '';
  const label = { Read: '读取', Write: '写入', Edit: '修改', Glob: '查找文件', Grep: '搜索内容', WebSearch: '联网搜索', WebFetch: '打开网页', Bash: '运行命令', PowerShell: '运行命令' }[name] || name;
  return `${label}：${String(p).split(convDir(c)).join('.')}`;
}

// ---------------------------------------------------------------- 调用命令行

function runCli(c, m, prompt, msg, images) {
  return new Promise((resolve) => {
    const r = rt(c);
    const outFile = path.join(convDir(c), '.hola', `out-${m.id}-${Date.now()}.txt`);
    const viaArg = m.args.includes('{PROMPT}');
    let args = m.args.map((a) => (a === '{PROMPT}' ? prompt : a.replace('{OUTFILE}', outFile).replace('{WORKSPACE}', convDir(c)).replace('{ROOT}', ROOT)));
    if (m.imageFlag && images.length) {
      const extra = images.map((p) => m.imageFlag + p);
      const at = Math.max(0, m.imageFlagAfter ? args.indexOf(m.imageFlagAfter) + 1 : 0);
      args = [...args.slice(0, at), ...extra, ...args.slice(at)];
    }
    // 桌面版：Claude 运行时带上内置浏览器工具（这次运行专用的通行证，结束就作废）
    const br = withBrowser(c, m, args);
    if (br) args = br.args;
    let child;
    let settled = false;
    let errTail = '';
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      r.children.delete(child);
      if (br) br.done();
      resolve(res);
    };
    try { child = spawnMember(m, args, { cwd: convDir(c), env: br ? { ...cleanEnv(), ...br.env } : cleanEnv() }); }
    catch (e) { if (br) br.done(); return resolve({ code: -1, text: '', err: e.message }); }
    r.children.add(child);
    const timer = setTimeout(() => { addProc(c, msg, 'error', `超过 ${cfg.timeoutMinutes || 20} 分钟没做完，强制结束。`); killTree(child); }, TIMEOUT_MS);
    const parser = makeParser(m.parser, c, msg);
    let outBuf = '';
    let errBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      outBuf += d;
      let i;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const line = stripAnsi(outBuf.slice(0, i).replace(/\r$/, ''));
        outBuf = outBuf.slice(i + 1);
        parser.line(line);
      }
    });
    child.stderr.on('data', (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = stripAnsi(errBuf.slice(0, i).replace(/\r$/, '')).trim();
        errBuf = errBuf.slice(i + 1);
        if (line) { addProc(c, msg, 'log', line); errTail = (errTail + '\n' + line).slice(-800); }
      }
    });
    child.stdin.on('error', () => {});
    if (viaArg) child.stdin.end(); else child.stdin.end(prompt, 'utf8');
    child.on('error', (e) => finish({ code: -1, text: '', err: e.message }));
    child.on('close', (code) => {
      if (outBuf.trim()) parser.line(stripAnsi(outBuf));
      if (errBuf.trim()) { addProc(c, msg, 'log', stripAnsi(errBuf)); errTail += '\n' + errBuf; }
      let text = parser.finish();
      try { const f = fs.readFileSync(outFile, 'utf8').trim(); if (f) text = f; fs.unlinkSync(outFile); } catch (_) {}
      finish({ code, text, err: errTail.trim() });
    });
  });
}

// ---------------------------------------------------------------- 调用 API（OpenAI 兼容）

function apiExtras(c, vision) {
  const lastBoss = [...c.messages].reverse().find((x) => x.from === 'boss');
  const atts = (lastBoss && lastBoss.attachments) || [];
  if (!atts.length) return '';
  const parts = atts.map((a) => {
    if (a.image && vision && API_IMG.test(a.path)) return `\n--- 附件 ${a.name}：图片，已经附在这条消息里，你可以直接看 ---`;
    const tv = textVersionRel(c, a.path);
    if (tv && a.image) { try { return `\n--- 附件 ${a.name}（图片。你看不到原图，下面是能看图的队友写的图片说明）---\n` + clip(fs.readFileSync(path.join(convDir(c), tv), 'utf8'), 20000); } catch (_) {} }
    if (tv) { try { return `\n--- 附件 ${a.name}（已转成文字）---\n` + clip(fs.readFileSync(path.join(convDir(c), tv), 'utf8'), 60000); } catch (_) {} }
    if (/\.(txt|md|csv|json|tsv|html?|xml|ya?ml|js|ts|py)$/i.test(a.path) && a.size < 60000) {
      try { return `\n--- 附件 ${a.name} 的内容 ---\n` + fs.readFileSync(path.join(convDir(c), a.path), 'utf8'); } catch (_) {}
    }
    return `\n--- 附件 ${a.name}：${a.image ? '图片' : '文件'}，你看不到内容，可以参考能读文件的队友的描述 ---`;
  });
  return '\n\n【老板这次发的附件】' + parts.join('\n');
}

// 能发给 API 的图片：常见的位图格式，最多 4 张、每张不超过 8 MB
const API_IMG = /\.(png|jpe?g|gif|webp)$/i;
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function apiContent(prompt, images) {
  const parts = [{ type: 'text', text: prompt }];
  for (const p of (images || []).filter((x) => API_IMG.test(x)).slice(0, 4)) {
    try {
      const b = fs.readFileSync(p);
      if (b.length > 8e6) continue;
      parts.push({ type: 'image_url', image_url: { url: `data:${IMG_MIME[path.extname(p).slice(1).toLowerCase()]};base64,${b.toString('base64')}` } });
    } catch (_) {}
  }
  return parts.length > 1 ? parts : prompt;
}

async function runApi(c, m, prompt, msg, images) {
  const a = m.api || {};
  const ctrl = new AbortController();
  const handle = { abort: () => ctrl.abort() };
  const r = c ? rt(c) : null;
  if (r) r.children.add(handle);
  const proc = (k, t) => { if (c && msg) addProc(c, msg, k, t); };
  const timer = setTimeout(() => { proc('error', `超过 ${cfg.timeoutMinutes || 20} 分钟没做完，强制结束。`); ctrl.abort(); }, c ? TIMEOUT_MS : 60000);
  let text = '', err = '', think = '';
  const flushThink = (force) => { if (think && (force || think.length > 500)) { proc('think', think); think = ''; } };
  try {
    const content = a.vision ? apiContent(prompt, images) : prompt;
    const body = { model: a.model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content }] };
    if (a.temperature !== '' && a.temperature != null && !isNaN(+a.temperature)) body.temperature = +a.temperature;
    proc('tool', `调用接口：${a.model}`);
    const call = () => fetch(String(a.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(a.apiKey ? { Authorization: 'Bearer ' + a.apiKey } : {}) },
      body: JSON.stringify(body),
    });
    let res = await call();
    let raw = '';
    // 个别服务商不认 stream_options（用来要用量），去掉再试一次
    if (res.status === 400) { raw = await res.text(); if (/stream_options|include_usage/i.test(raw)) { delete body.stream_options; res = await call(); raw = ''; } }
    // 有的服务商每个分片都带累计用量：只取最后一次，不累加
    const usageOf = (u) => u && msg && (delete msg.usage, addUsage(msg, { input: u.prompt_tokens, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens, output: u.completion_tokens }));
    if (!res.ok) {
      raw = raw || await res.text();
      let detail = raw.slice(0, 300);
      try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error)) || j.message || detail; } catch (_) {}
      const hint = (EN() ? { 401: 'Invalid or expired API key', 402: 'Insufficient balance', 403: 'No permission to use this model', 404: 'Wrong API address or model name', 429: 'Rate limited, or out of quota' } : { 401: 'API Key 不对或已失效', 402: '账户余额不足', 403: '没有权限使用这个模型', 404: '接口地址或模型名不对', 429: '调用太频繁，或额度用完了' })[res.status];
      err = `${hint ? hint + T('。', '. ') : ''}${T('接口返回', 'API returned')} HTTP ${res.status}${T('：', ': ')}${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
      if (Array.isArray(content) && [400, 415, 422].includes(res.status)) err += T('\n这个模型可能不支持看图片：可以到"队友 → 编辑"里关掉"能看图片"。', '\nThis model may not accept images: turn off "Can see images" under Teammates → Edit.');
    } else if (!String(res.headers.get('content-type') || '').includes('event-stream')) {
      const o = await res.json();
      usageOf(o.usage);
      const mo = (o.choices && o.choices[0] && o.choices[0].message) || {};
      if (mo.reasoning_content) proc('think', mo.reasoning_content);
      text = mo.content || '';
      if (o.error) err = o.error.message || JSON.stringify(o.error);
    } else {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          let o; try { o = JSON.parse(d); } catch (_) { continue; }
          if (o.error) { err = o.error.message || JSON.stringify(o.error); continue; }
          if (o.usage) usageOf(o.usage);
          const delta = (o.choices && o.choices[0] && (o.choices[0].delta || o.choices[0].message)) || {};
          if (delta.reasoning_content || delta.reasoning) { think += delta.reasoning_content || delta.reasoning; flushThink(false); }
          if (delta.content) text += delta.content;
        }
      }
      flushThink(true);
    }
    if (!text && !err) err = T('接口没有返回内容', 'The API returned nothing');
  } catch (e) {
    err = e.name === 'AbortError' ? T('已停止', 'Stopped') : T('连不上接口：', "Can't reach the API: ") + ((e.cause && (e.cause.code || e.cause.message)) || e.message);
  }
  clearTimeout(timer);
  if (r) r.children.delete(handle);
  return { code: err ? 1 : 0, text: text.trim(), err };
}

async function runMember(c, m, prompt, msg, images) {
  // 记下这次实际用的模型（之后改了设置，旧消息仍显示当时的模型）；Claude 会在输出里报告更准确的名字
  if (msg) {
    msg.model = m.model || (m.parser === 'codex-json' ? codexDefaultModel() : '') || undefined;
    msg.effort = m.effort || (m.parser === 'codex-json' ? codexConfig('model_reasoning_effort') : '') || undefined;
  }
  if (m.type === 'api') return runApi(c, m, prompt + apiExtras(c, !!(m.api || {}).vision), msg, images);
  const dirs = mediaWatchDirs(m);
  const before = dirs.length ? snapshotDirs(dirs) : null;
  const res = await runCli(c, m, prompt, msg, images);
  if (before) for (const [f, t] of snapshotDirs(dirs)) if (before.get(f) !== t) importPath(c, m, msg, f);
  captureFromText(c, m, msg, res.text);
  return res;
}

async function testMember(m) {
  if (m.type === 'api') {
    const res = await runApi(null, m, '这是一次连接测试，请只回复：OK', null);
    m.online = !res.err; m.problem = res.err || ''; m.version = (m.api || {}).model || '';
    return res.err ? { ok: false, error: res.err } : { ok: true, text: res.text.slice(0, 200) };
  }
  await checkMember(m);
  return m.online ? { ok: true, text: m.version || '命令可以运行' } : { ok: false, error: m.problem };
}

module.exports = { addUsage, makeParser, memberOf, describeTool, runCli, apiExtras, runApi, runMember, testMember };
