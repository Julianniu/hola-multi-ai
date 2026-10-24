// Hola · 调用 AI：解析各家命令行的输出、启动命令行、调用 OpenAI 兼容接口
'use strict';
const fs = require('fs');
const path = require('path');
const { EN, ROOT, T, TIMEOUT_MS, cfg, wick } = require('./core');
const { checkMember, cleanEnv, codexConfig, codexDefaultModel, killTree, members, saveApiState, spawnMember, stripAnsi } = require('./members');
const { withBrowser } = require('./browser');
const { withTeam } = require('./wick-team');
const { guardConv } = require('./wick-guard');
const { trace } = require('./wick-trace');
const { BR_LABEL, canAct, spill, stepLabel, toolbox } = require('./tools');
const { addSpend, costOf, overBudget, sendWithRetry } = require('./wick-api');
const { addProc, captureFromJson, captureFromText, clip, convDir, importPath, mediaWatchDirs, rt, setDraft, snapshotDirs, textVersionRel } = require('./convs');

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
  const D = (t) => setDraft(c, msg, t); // 正在写的字（边写边显示）

  // 队友说了一段话、接着又去调用工具：那段是"中间的分析"，记进过程（当作思考），老板在"过程"里看得到（wick midText）
  let pending = '';
  const say = () => { if (pending && wick('midText')) P('think', pending); pending = ''; };

  if (kind === 'claude-stream') {
    let draft = '';
    return {
      line(line) {
        if (!line.trim()) return;
        const o = tryJSON(line);
        if (!o) return P('log', line);
        if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          for (const x of o.message.content) {
            if (x.type === 'thinking' && x.thinking) P('think', x.thinking);
            else if (x.type === 'text' && x.text) { texts.push(x.text); pending = x.text; }
            else if (x.type === 'tool_use') { say(); P('tool', describeTool(c, x.name, x.input)); }
          }
        } else if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
          for (const x of o.message.content) {
            if (x.type === 'tool_result') {
              const t = Array.isArray(x.content) ? x.content.map((y) => y.text || '').join('\n') : x.content;
              P(x.is_error ? 'error' : 'result', clip(t, 600));
            }
          }
        } else if (o.type === 'stream_event' && o.event && !o.parent_tool_use_id) {
          // --include-partial-messages：一小段一小段的字（子任务里的不算）
          const e = o.event;
          if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'text' && draft) draft += '\n\n';
          else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) { draft += e.delta.text; D(draft); }
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
        if (o.type === 'thread.started' && o.thread_id) this.sessionId = o.thread_id; // 续接会话要用的编号
        if (o.type === 'turn.completed' && o.usage) addUsage(msg, { input: o.usage.input_tokens, cached: o.usage.cached_input_tokens, output: o.usage.output_tokens });
        const it = o.item || null;
        if (it && o.type === 'item.started' && it.type === 'command_execution') { say(); P('tool', '运行命令：' + it.command); }
        else if (it && o.type === 'item.completed') {
          if (['file_change', 'web_search', 'mcp_tool_call'].includes(it.type)) say();
          if (it.type === 'reasoning') P('think', it.text);
          else if (it.type === 'agent_message') { texts.push(it.text); pending = it.text; }
          else if (it.type === 'command_execution') P(it.exit_code ? 'error' : 'result', clip(it.aggregated_output || `退出码 ${it.exit_code}`, 600));
          else if (it.type === 'file_change') P('tool', '修改文件：' + (it.changes || []).map((x) => `${x.path}（${x.kind}）`).join('，'));
          else if (it.type === 'web_search') P('tool', '联网搜索：' + (it.query || ''));
          else if (it.type === 'mcp_tool_call') P('tool', it.server === 'hola_browser' ? `浏览网页：${BR_LABEL[it.tool] || it.tool}` : `调用工具：${it.server || ''} ${it.tool || ''}`);
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
        // Antigravity 的 input_tokens 不含缓存命中的部分（缓存数可以比它还大），要加上
        if (e && e.usage) addUsage(msg, { input: (e.usage.input_tokens || 0) + (e.usage.cache_read_tokens || 0), cached: e.usage.cache_read_tokens, output: e.usage.output_tokens });
        if (!e) { if (all) P('log', all); return all; }
        if (e.status && e.status !== 'SUCCESS') P('error', '状态：' + e.status);
        return String(e.response || '').trim();
      },
    };
  }

  // Antigravity 的流式事件（提示词从标准输入来时用）：init → step_update（text_delta 是正在写的字）→ result
  if (kind === 'agy-stream') {
    let res = null;
    const texts = [];
    return {
      line(line) {
        if (!line.trim()) return;
        const o = tryJSON(line);
        if (!o) return P('log', line);
        const st = o.event === 'step_update' && o.step_update;
        if (st && st.step_type === 'agent_response') { if (st.text_delta) { texts.push(st.text_delta); D(texts.join('')); } }
        else if (st && st.state === 'DONE' && st.step_type && st.step_type !== 'user_input') P('tool', AGY_STEP[st.step_type] || st.step_type);
        else if (o.event === 'result') res = o.result || {};
        if ((o.event === 'init' || o.event === 'result') && (o.conversation_id || (o.result && o.result.conversation_id))) this.sessionId = o.conversation_id || o.result.conversation_id;
        else if (o.event === 'error') P('error', o.error && (o.error.message || o.error) || line);
      },
      finish() {
        if (!res) return texts.join('').trim();
        captureFromJson(c, memberOf(msg), msg, res);
        const u = res.usage || {};
        if (res.usage) addUsage(msg, { input: (u.input_tokens || 0) + (u.cache_read_tokens || 0), cached: u.cache_read_tokens, output: u.output_tokens });
        if (res.status && res.status !== 'SUCCESS') P('error', '状态：' + res.status + (res.error ? '：' + res.error : ''));
        const text = String(res.response || texts.join('')).trim();
        // 偶尔会"成功"却什么都没做（用量是 0）：当作出错，由调用方重试一次
        if (!text && res.status === 'SUCCESS' && !u.input_tokens) this.empty = true;
        return text;
      },
    };
  }

  return { // plain
    line(line) { texts.push(line); },
    finish() { return texts.join('\n').trim(); },
  };
}

const AGY_STEP = { run_command: '运行命令', view_file: '读取文件', write_to_file: '写入文件', replace_file_content: '修改文件', multi_replace_file_content: '修改文件', search_web: '联网搜索', read_url_content: '打开网页', grep_search: '搜索内容', list_dir: '查找文件', find_by_name: '查找文件' };

function memberOf(msg) { return members[msg.from] || { name: msg.from }; }

function describeTool(c, name, input) {
  input = input || {};
  // 内置浏览器的工具（mcp__hola-browser__open 等）
  const br = /^mcp__hola-browser__(\w+)$/.exec(name);
  if (br) return `浏览网页：${BR_LABEL[br[1]] || br[1]}${input.url ? ' ' + input.url : ''}`;
  const p = input.file_path || input.path || input.pattern || input.url || input.query || input.command || '';
  const label = { Read: '读取', Write: '写入', Edit: '修改', Glob: '查找文件', Grep: '搜索内容', WebSearch: '联网搜索', WebFetch: '打开网页', Bash: '运行命令', PowerShell: '运行命令' }[name] || name;
  return `${label}：${String(p).split(convDir(c)).join('.')}`;
}

// ---------------------------------------------------------------- 调用命令行

// Antigravity：提示词不再放在命令行参数里（超过 Windows 约 3.2 万字的上限就启动不了，基线 S13 三次全挂），
// 改成从标准输入送一条 stream-json 消息；输出也改成流式事件，能看到它在写什么、做了哪些步骤。
function agyStdinArgs(args) {
  const i = args.indexOf('-p');
  if (i < 0 || args[i + 1] !== '{PROMPT}') return null;
  const out = args.slice(0, i);
  const rest = args.slice(i + 2);
  for (const f of ['--output-format', '--input-format']) { const k = rest.indexOf(f); if (k >= 0) rest.splice(k, 2); }
  return [...out, '--input-format', 'stream-json', '--output-format', 'stream-json', ...rest, '-p='];
}
// Claude：只读用户自己的设置，不读对话文件夹里的项目设置（里面的钩子会被自动执行）
function claudeSafeArgs(args) {
  const at = args.includes('-p') ? args.indexOf('-p') + 1 : 0;
  const add = [];
  if (!args.includes('--setting-sources')) add.push('--setting-sources', 'user');
  // 边写边显示：让 Claude 一小段一小段地报出正在写的字（要配合 stream-json + --verbose）
  if (wick('streamDraft') && args.includes('stream-json') && !args.includes('--include-partial-messages')) add.push('--include-partial-messages');
  return [...args.slice(0, at), ...add, ...args.slice(at)];
}

// 长会话（wick sessions）：新会话 / 续接的启动参数。实测（2026-10-23）：
// Claude 用 --session-id 指定编号、--resume 续接；Codex 续接是 `exec resume <编号>`，它不认 --sandbox，要写成 -c sandbox_mode=…；
// Antigravity 用 --conversation <编号> 续接（编号在 init / result 事件里）。
function codexResumeArgs(args, sid) {
  const i = args.indexOf('exec');
  if (i < 0) return args;
  const tail = [];
  const rest = args.slice(i + 1);
  for (let k = 0; k < rest.length; k++) {
    if (rest[k] === '--sandbox' || rest[k] === '-s') { tail.push('-c', `sandbox_mode="${rest[k + 1]}"`); k++; continue; }
    if (rest[k] === '--full-auto') continue;
    tail.push(rest[k]);
  }
  const dash = tail.lastIndexOf('-');
  if (dash >= 0) tail.splice(dash, 0, sid); else tail.push(sid);
  return [...args.slice(0, i + 1), 'resume', ...tail];
}
function sessionArgs(m, args, sess, agy) {
  if (!sess || !sess.sid && m.parser !== 'claude-stream') return args;
  if (m.parser === 'claude-stream') {
    const at = args.includes('-p') ? args.indexOf('-p') + 1 : 0;
    return [...args.slice(0, at), ...(sess.fresh ? ['--session-id', sess.sid] : ['--resume', sess.sid]), ...args.slice(at)];
  }
  if (sess.fresh) return args;
  if (m.parser === 'codex-json') return codexResumeArgs(args, sess.sid);
  if (m.parser === 'agy-json') {
    const at = agy ? args.indexOf('-p=') : args.indexOf('-p');
    return at >= 0 ? [...args.slice(0, at), '--conversation', sess.sid, ...args.slice(at)] : args;
  }
  return args;
}

function runCli(c, m, prompt, msg, images, sess) {
  return new Promise((resolve) => {
    const r = rt(c);
    const outFile = path.join(convDir(c), '.hola', `out-${m.id}-${Date.now()}.txt`);
    const agy = m.parser === 'agy-json' && wick('agyStdin') ? agyStdinArgs(m.args) : null;
    const base = sessionArgs(m, agy || (m.parser === 'claude-stream' ? claudeSafeArgs(m.args) : m.args), sess, agy);
    const viaArg = base.includes('{PROMPT}');
    let args = base.map((a) => (a === '{PROMPT}' ? prompt : a.replace('{OUTFILE}', outFile).replace('{WORKSPACE}', convDir(c)).replace('{ROOT}', ROOT)));
    if (m.imageFlag && images.length) {
      const extra = images.map((p) => m.imageFlag + p);
      const at = Math.max(0, m.imageFlagAfter ? args.indexOf(m.imageFlagAfter) + 1 : 0);
      args = [...args.slice(0, at), ...extra, ...args.slice(at)];
    }
    // 桌面版：Claude 运行时带上内置浏览器工具（这次运行专用的通行证，结束就作废）
    const br = withBrowser(c, m, args);
    if (br) args = br.args;
    // 干活的回合再挂上 Hola 团队工具（看任务板、看队友、交活；wick teamMcp）
    const tm = withTeam(c, m, msg, args, ['main', 'mention', 'handoff', 'decided', 'review', 'fix', 'replan'].includes(msg.reason));
    if (tm) args = tm.args;
    guardConv(c);
    let child;
    let settled = false;
    let errTail = '';
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      r.children.delete(child);
      if (br) br.done();
      if (tm) tm.done();
      resolve(res);
    };
    trace(c, msg, 'cli', { cmd: m.cmd, args: args.map((x) => (x === prompt ? '<提示词>' : x)), promptVia: agy ? 'stdin(stream-json)' : viaArg ? 'arg' : 'stdin' });
    try { child = spawnMember(m, args, { cwd: convDir(c), env: { ...cleanEnv(), ...(br ? br.env : {}), ...(tm ? tm.env : {}) } }); }
    catch (e) { if (br) br.done(); if (tm) tm.done(); return resolve({ code: -1, text: '', err: e.message }); }
    child.holaMember = m.id; // 任务板上取消某一项时，只结束这位队友的运行
    r.children.add(child);
    const timer = setTimeout(() => { addProc(c, msg, 'error', `超过 ${cfg.timeoutMinutes || 20} 分钟没做完，强制结束。`); killTree(child); }, TIMEOUT_MS);
    const parser = makeParser(agy ? 'agy-stream' : m.parser, c, msg);
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
    if (agy) child.stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n', 'utf8');
    else if (viaArg) child.stdin.end(); else child.stdin.end(prompt, 'utf8');
    child.on('error', (e) => finish({ code: -1, text: '', err: e.message }));
    child.on('close', (code) => {
      if (outBuf.trim()) parser.line(stripAnsi(outBuf));
      if (errBuf.trim()) { addProc(c, msg, 'log', stripAnsi(errBuf)); errTail += '\n' + errBuf; }
      let text = parser.finish();
      try { const f = fs.readFileSync(outFile, 'utf8').trim(); if (f) text = f; fs.unlinkSync(outFile); } catch (_) {}
      guardConv(c);
      finish({ code, text, err: errTail.trim(), empty: !!parser.empty, sessionId: parser.sessionId || (sess && sess.sid) || '' });
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

// 发一次请求，读完流式（或普通）回复。返回 { ok, status, raw, text, think, toolCalls, usage, err }
async function apiRequest(a, body, signal, proc, msg, onText) {
  const call = () => fetch(String(a.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(a.apiKey ? { Authorization: 'Bearer ' + a.apiKey } : {}) },
    body: JSON.stringify(body),
  });
  // 限流、5xx、网络断开：等一会儿再试（wick-api）
  let res = await sendWithRetry(a, call, { signal, proc });
  let raw = '';
  // 个别服务商不认 stream_options（用来要用量）或 reasoning_effort（思考深度）：去掉再试
  for (let i = 0; i < 2 && res.status === 400; i++) {
    raw = await res.text();
    if (body.stream_options && /stream_options|include_usage/i.test(raw)) delete body.stream_options;
    else if (body.reasoning_effort && /reasoning/i.test(raw)) { delete body.reasoning_effort; proc('log', T('这个接口不支持设置思考深度，按默认来。', "This API doesn't accept a thinking effort; using its default.")); }
    else break;
    res = await call();
    raw = '';
  }
  const out = { ok: res.ok, status: res.status, raw: '', text: '', think: '', toolCalls: [], usage: null, err: '' };
  if (!res.ok) { out.raw = raw || await res.text(); return out; }
  const calls = [];
  const addCalls = (list) => {
    for (const [k, tc] of (list || []).entries()) {
      const i = Number.isInteger(tc.index) ? tc.index : k;
      const c = calls[i] || (calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) c.id = tc.id;
      const f = tc.function || {};
      if (f.name && !c.function.name) c.function.name = f.name;
      if (f.arguments) c.function.arguments += typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments);
    }
  };
  // 思考过程：一边收一边显示；完整的也留着（有的模型要求调用工具时把它原样送回去）
  let shown = '';
  const flushThink = (force) => { if (shown && (force || shown.length > 500)) { proc('think', shown); shown = ''; } };
  if (!String(res.headers.get('content-type') || '').includes('event-stream')) {
    const o = await res.json();
    out.usage = o.usage || null;
    const mo = (o.choices && o.choices[0] && o.choices[0].message) || {};
    if (mo.reasoning_content) { out.think = mo.reasoning_content; proc('think', mo.reasoning_content); }
    out.text = mo.content || '';
    addCalls(mo.tool_calls);
    if (o.error) out.err = o.error.message || JSON.stringify(o.error);
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
        if (o.error) { out.err = o.error.message || JSON.stringify(o.error); continue; }
        // 有的服务商每个分片都带累计用量：只取最后一次
        if (o.usage) out.usage = o.usage;
        const delta = (o.choices && o.choices[0] && (o.choices[0].delta || o.choices[0].message)) || {};
        const th = delta.reasoning_content || delta.reasoning;
        if (th) { out.think += th; shown += th; flushThink(false); }
        if (delta.content) { out.text += delta.content; if (onText) onText(out.text); }
        if (delta.tool_calls) addCalls(delta.tool_calls);
      }
    }
    flushThink(true);
  }
  out.toolCalls = calls.filter(Boolean).filter((c) => c.function.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  return out;
}

function apiError(r, a, content) {
  let detail = r.raw.slice(0, 300);
  try { const j = JSON.parse(r.raw); detail = (j.error && (j.error.message || j.error)) || j.message || detail; } catch (_) {}
  const hint = (EN() ? { 401: 'Invalid or expired API key', 402: 'Insufficient balance', 403: 'No permission to use this model', 404: 'Wrong API address or model name', 429: 'Rate limited, or out of quota' } : { 401: 'API Key 不对或已失效', 402: '账户余额不足', 403: '没有权限使用这个模型', 404: '接口地址或模型名不对', 429: '调用太频繁，或额度用完了' })[r.status];
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  // 中转站常见：这个模型不在这把 Key 所属的分组里
  const noModel = /not supported by any|no available (account|channel)|model[^.]{0,40}(not found|does not exist|not exist|not supported|unavailable)|无可用|不支持该模型|模型不存在/i.test(d);
  let err = noModel
    ? T(`这个模型（${a.model}）你的 Key 用不了：在"队友 → 编辑"里点"读取可用模型"，从列表里选一个。`, `Your key can't use this model (${a.model}): under Teammates → Edit, click "Load available models" and pick one from the list.`) + T('\n接口原话：', '\nThe API said: ') + d
    : `${hint ? hint + T('。', '. ') : ''}${T('接口返回', 'API returned')} HTTP ${r.status}${T('：', ': ')}${d}`;
  if (Array.isArray(content) && [400, 415, 422].includes(r.status)) err += T('\n这个模型可能不支持看图片：可以到"队友 → 编辑"里关掉"能看图片"。', '\nThis model may not accept images: turn off "Can see images" under Teammates → Edit.');
  return err;
}
// 接口不认"工具"（function calling）时的报错
const NO_TOOLS = (r) => [400, 404, 415, 422, 501].includes(r.status) && /tool|function/i.test(r.raw);
const MAX_STEPS = 40;
const TURN_BUDGET = 1500000; // 一轮里累计的输入 token 上限

// 一轮里工具结果越积越多、每一步都要整段重发：总量超过约 8 万字时，较早的（最近 3 条以外）换成一句"全文在哪"
const MASK_AT = 80000;
function maskOldResults(c, messages) {
  const tools = messages.filter((x) => x.role === 'tool' && typeof x.content === 'string');
  if (tools.reduce((s, x) => s + x.content.length, 0) <= MASK_AT) return;
  for (const x of tools.slice(0, -3)) {
    if (x.content.length < 600 || x.content.startsWith('（较早的工具结果')) continue;
    const rel = spill(c, 'old', x.content);
    x.content = `（较早的工具结果，为了节省篇幅已省略。开头是：${x.content.slice(0, 300)}……全文在 ${rel}，需要时用 read_file 读）`;
  }
}

// rebuild：接口不支持工具、要改成"只动脑"时，重新拼一份提示词（提示词里会说清它不能动手）
// API 队友的长会话：把这一轮的完整消息（含工具调用、思考内容）存进 .hola，下一轮接着发（DeepSeek 开着工具时要求以前的思考内容都原样送回）
const apiHistFile = (c, m) => path.join(convDir(c), '.hola', `wick-api-${m.id}.json`);
const HIST_MAX = 2000000; // 超过这么多字就不再续接，下一轮重开
// 长对话压缩（wick apiCompact）：会话记录超过约 20 万字时，保留开头的团队说明和最近几轮的完整来往，
// 中间较早的工作过程请模型自己压缩成要点（读过什么、改了什么、结论、没做完的、老板的原话要求）。
// 跟 Claude / Codex / Gemini 的做法一样：快满了才压（每压一次缓存就重来），工具调用和它的结果不拆开。
const COMPACT_AT = 200000;
const KEEP_TURNS = 3; // 最近几轮完整保留
const isTurn = (x) => x.role === 'user' && !String(typeof x.content === 'string' ? x.content : '').startsWith('（之前的工作要点');
async function compactHistory(a, hist, signal, proc) {
  const head = [];
  let i = 0;
  while (i < hist.length && hist[i].role === 'system') head.push(hist[i++]);
  if (i < hist.length) head.push(hist[i++]); // 会话开头那份完整提示词（团队说明、记忆、群聊）
  const turns = [];
  for (let k = i; k < hist.length; k++) if (isTurn(hist[k])) turns.push(k);
  if (turns.length <= KEEP_TURNS) return null;
  const cut = turns[turns.length - KEEP_TURNS];
  const middle = hist.slice(i, cut);
  const lines = middle.map((x) => {
    const calls = (x.tool_calls || []).map((t) => `调用 ${t.function.name}(${clip(t.function.arguments, 300)})`).join('；');
    return `[${x.role}] ${clip(typeof x.content === 'string' ? x.content : '', 3000)}${calls ? '\n' + calls : ''}`;
  }).join('\n\n');
  const ask = `下面是你之前在这个对话里的工作记录（较早的部分）。把它压缩成要点，供你接着干活时参考：
- 老板提过的要求和规矩（原话照抄）；
- 读过哪些文件、里面的关键内容和数字；
- 做了哪些修改、生成了哪些文件（文件名）；
- 已经得出的结论和决定；
- 还没做完的事。
不要遗漏文件名、数字和老板的原话；不要写过程性的废话。直接输出要点。

${lines}`;
  const body = { model: a.model, stream: false, messages: [{ role: 'user', content: ask }] };
  const r = await apiRequest(a, body, signal, proc, null);
  if (!r.ok || !String(r.text || '').trim()) return null;
  return [...head, { role: 'user', content: `（之前的工作要点，较早的记录已压缩）\n${r.text.trim()}` }, ...hist.slice(cut)];
}
const textOnly = (x) => (Array.isArray(x.content) ? { ...x, content: x.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') || '（图片）' } : x);

// system：提示词开头那段固定说明（身份、规则、团队名单、环境卡片）。给了就单独作为系统消息发（wick apiSystem），
// 其余部分作为用户消息——DeepSeek 自己的 harness 也是这样：固定的在系统消息，变化的在后面
async function runApi(c, m, prompt, msg, images, rebuild, sess, system) {
  const a = m.api || {};
  if (system && !prompt.startsWith(system)) system = '';
  const ctrl = new AbortController();
  const handle = { abort: () => ctrl.abort(), holaMember: m.id };
  const r = c ? rt(c) : null;
  if (r) r.children.add(handle);
  const proc = (k, t) => { if (c && msg) addProc(c, msg, k, t); };
  const timer = setTimeout(() => { proc('error', `超过 ${cfg.timeoutMinutes || 20} 分钟没做完，强制结束。`); ctrl.abort(); }, c ? TIMEOUT_MS : 60000);
  const box = c && msg && canAct(m) ? toolbox(c, m, msg, { vision: !!a.vision, signal: ctrl.signal }) : null;
  let tools = box ? box.defs : null;
  let text = '', err = '', status = 0, sessionId = '';
  try {
    let history = null;
    if (sess && !sess.fresh && c) { try { history = JSON.parse(fs.readFileSync(apiHistFile(c, m), 'utf8')); } catch (_) {} if (!Array.isArray(history)) throw Object.assign(new Error('no history'), { noHistory: true }); }
    if (history && wick('apiCompact') && JSON.stringify(history).length > COMPACT_AT) {
      proc('log', T('之前的会话记录太长了，先把较早的部分压缩成要点。', 'The session history is long; compacting the older part into key points first.'));
      const before = JSON.stringify(history).length;
      const packed = await compactHistory(a, history, ctrl.signal, proc).catch(() => null);
      if (!packed) throw Object.assign(new Error('compact failed'), { noHistory: true }); // 压不了就重开（送完整提示词）
      history = packed;
      trace(c, msg, 'compact', { before, after: JSON.stringify(history).length });
    }
    const split = !!system && !history;
    let content = a.vision ? apiContent(split ? prompt.slice(system.length) : prompt, images) : split ? prompt.slice(system.length) : prompt;
    const messages = [...(history || []), ...(split ? [{ role: 'system', content: system.trimEnd() }] : []), { role: 'user', content }];
    proc('tool', `调用接口：${a.model}`);
    // 停止条件（wick apiGuard）：同一个操作连续 3 次得到同样的结果、这一轮用量超过预算、步数快到上限，
    // 就不再给它动手，让它直接向老板说明情况（基线 S15：同一个错误重复了 41 次才停）
    const guard = !!box && wick('apiGuard');
    let used = 0, lastSig = '', same = 0, wrapUp = '', finalThink = '', lastText = '';
    for (let step = 0; ; step++) {
      // 花费上限（wick budget）：到了就停，不再发请求（超出方案的花费要老板确认）
      const over = c ? overBudget(c) : '';
      if (over) {
        const how = T('。到"设置"里调高上限，或者明天再继续。', '. Raise the limit in Settings, or continue tomorrow.');
        if (step === 0) { err = over + how; break; }
        text = (lastText || '') + T(`\n\n（先停在这里：${over}${how}）`, `\n\n(Stopping here: ${over}${how})`);
        break;
      }
      const body = { model: a.model, stream: true, stream_options: { include_usage: true }, messages };
      if (tools) { body.tools = tools; if (wrapUp) body.tool_choice = 'none'; }
      if (API_EFFORTS.includes(a.effort)) body.reasoning_effort = a.effort;
      if (a.temperature !== '' && a.temperature != null && !isNaN(+a.temperature)) body.temperature = +a.temperature;
      trace(c, msg, 'request', { step, messages: messages.length, chars: JSON.stringify(messages).length, tools: (body.tools || []).length, toolChoice: body.tool_choice || null, model: a.model });
      const res = await apiRequest(a, body, ctrl.signal, proc, msg, c && msg ? (t) => setDraft(c, msg, t) : null);
      trace(c, msg, 'response', { step, status: res.status, usage: res.usage, text: clip(res.text, 4000), think: clip(res.think, 4000), toolCalls: res.toolCalls.map((x) => ({ name: x.function.name, args: clip(x.function.arguments, 2000) })), err: res.ok ? res.err : clip(res.raw, 1000) });
      // 这个模型 / 中转站不支持工具：记下来以后不再给，这次改成"只动脑"重来
      if (!res.ok && tools && step === 0 && NO_TOOLS(res)) {
        a.toolsOk = false;
        try { saveApiState(); } catch (_) {}
        proc('log', T('这个模型不支持工具调用，改成只动脑（不能读写文件、不能上网）。', "This model doesn't support tool calls; it will only think (no files, no web)."));
        tools = null;
        if (rebuild) { content = a.vision ? apiContent(rebuild(), images) : rebuild(); messages.splice(history ? history.length : 0, messages.length, { role: 'user', content }); }
        step = -1;
        continue;
      }
      if (!res.ok) { err = apiError(res, a, content); status = res.status; break; }
      if (res.usage && msg) { const u = res.usage; addUsage(msg, { input: u.prompt_tokens, cached: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens, output: u.completion_tokens }); }
      const cost = costOf(a, res.usage);
      if (cost && c) { addSpend(c, cost); if (msg) msg.cost = Math.round(((msg.cost || 0) + cost) * 1e6) / 1e6; }
      if (res.text) lastText = res.text;
      if (res.err) { err = res.err; break; }
      if (res.usage) used += res.usage.prompt_tokens || 0;
      if (tools && a.toolsOk === undefined) { a.toolsOk = true; try { saveApiState(); } catch (_) {} }
      if (!res.toolCalls.length || !box) { text = res.text; finalThink = res.think; break; }
      if (wrapUp) { text = res.text || T(`（先停在这里：${wrapUp}）`, `(Stopping here: ${wrapUp})`); break; }
      if (step >= MAX_STEPS) { text = res.text || T('（步骤太多，先停在这里。）', '(Too many steps; stopping here.)'); break; }
      // 有的模型（DeepSeek、Kimi 的思考模式）要求把这一步的思考原样送回去
      messages.push({ role: 'assistant', content: res.text || null, tool_calls: res.toolCalls, ...(res.think ? { reasoning_content: res.think } : {}) });
      const pics = [];
      let sig = '', lastOut = '';
      for (const tc of res.toolCalls) {
        let args;
        try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
        catch (_) { messages.push({ role: 'tool', tool_call_id: tc.id, content: '参数不是合法的 JSON，请重新调用。' }); sig += '|badjson'; continue; }
        const out = await box.run(tc.function.name, args);
        trace(c, msg, 'tool', { name: tc.function.name, args, result: clip(out.text, 4000), image: !!out.image });
        if (ctrl.signal.aborted) break;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: out.text });
        if (out.image) pics.push(out.image);
        sig += `|${tc.function.name}:${tc.function.arguments}=>${String(out.text).slice(0, 300)}`;
        lastOut = `${stepLabel(tc.function.name, args)} → ${clip(out.text, 200)}`;
      }
      if (ctrl.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (guard) {
        same = sig === lastSig ? same + 1 : 0;
        lastSig = sig;
        if (same >= 2) wrapUp = T(`同一个操作已经连续 3 次得到同样的结果（${lastOut}），再试也没用`, `the same action gave the same result 3 times in a row (${lastOut})`);
        else if (used > TURN_BUDGET) wrapUp = T('这一轮用的篇幅已经超过上限', 'this turn has used up its budget');
        else if (step >= MAX_STEPS - 2) wrapUp = T('步骤已经很多了', 'this has taken too many steps');
        if (wrapUp) {
          proc('log', T(`先停下：${wrapUp}`, `Stopping: ${wrapUp}`));
          messages.push({ role: 'user', content: `（Hola 系统提示）${wrapUp}。不要再调用工具了：直接告诉老板做到了哪一步、卡在哪里、需要什么。` });
        }
      }
      if (box && wick('apiTools')) maskOldResults(c, messages);
      // 工具拿到的图片（截图、读图）：工具结果只能放文字，图片单独跟一条消息
      if (pics.length) messages.push({ role: 'user', content: [{ type: 'text', text: '（上面工具返回的图片）' }, ...pics.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } }))] });
    }
    if (!text && !err) err = T('接口没有返回内容', 'The API returned nothing');
    if (sess && c && text && !err) {
      const hist = [...messages, { role: 'assistant', content: text, ...(finalThink ? { reasoning_content: finalThink } : {}) }].map(textOnly);
      const json = JSON.stringify(hist);
      if (json.length < HIST_MAX) { try { fs.writeFileSync(apiHistFile(c, m), json); sessionId = 'api'; } catch (_) {} }
    }
  } catch (e) {
    if (e.noHistory) err = T('找不到上次的会话记录', 'No saved session history');
    else err = e.name === 'AbortError' ? T('已停止', 'Stopped') : T('连不上接口：', "Can't reach the API: ") + ((e.cause && (e.cause.code || e.cause.message)) || e.message);
  }
  clearTimeout(timer);
  if (box) box.done();
  if (r) r.children.delete(handle);
  return { code: err ? 1 : 0, text: text.trim(), err, status, sessionId };
}

async function runMember(c, m, prompt, msg, images, rebuild, sess, system) {
  // 记下这次实际用的模型（之后改了设置，旧消息仍显示当时的模型）；Claude 会在输出里报告更准确的名字
  if (msg) {
    msg.model = m.model || (m.parser === 'codex-json' ? codexDefaultModel() : '') || undefined;
    msg.effort = m.effort || (m.parser === 'codex-json' ? codexConfig('model_reasoning_effort') : '') || undefined;
  }
  if (m.type === 'api') {
    const extras = () => apiExtras(c, !!(m.api || {}).vision);
    return runApi(c, m, prompt + extras(), msg, images, rebuild && (() => rebuild() + extras()), sess, system);
  }
  const dirs = mediaWatchDirs(m);
  const before = dirs.length ? snapshotDirs(dirs) : null;
  let res = await runCli(c, m, prompt, msg, images, sess);
  if (res.empty && !res.text) { addProc(c, msg, 'log', T('返回了空结果，再试一次。', 'Got an empty result, trying once more.')); res = await runCli(c, m, prompt, msg, images, sess); }
  if (before) for (const [f, t] of snapshotDirs(dirs)) if (before.get(f) !== t) importPath(c, m, msg, f);
  captureFromText(c, m, msg, res.text);
  return res;
}

const API_EFFORTS = ['low', 'medium', 'high'];

// 读出这把 Key 能用的模型（OpenAI 兼容的 GET /models；地址没写 /v1 时再试 /v1/models）
async function remoteModels(baseUrl, apiKey) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error(T('请先填接口地址', 'Fill in the API address first'));
  let last = '';
  for (const u of [base + '/models', ...(/\/v1$/i.test(base) ? [] : [base + '/v1/models'])]) {
    let r;
    try { r = await fetch(u, { headers: apiKey ? { Authorization: 'Bearer ' + apiKey, 'x-api-key': apiKey } : {}, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw new Error(T('连不上接口：', "Can't reach the API: ") + ((e.cause && (e.cause.code || e.cause.message)) || e.message)); }
    const t = await r.text();
    if (!r.ok) { last = `HTTP ${r.status}：${t.slice(0, 200)}`; if ([401, 403].includes(r.status)) break; continue; }
    let j; try { j = JSON.parse(t); } catch (_) { last = t.slice(0, 200); continue; }
    const ids = [...new Set((j.data || j.models || []).map((x) => (typeof x === 'string' ? x : x.id || x.name || '')).map((x) => String(x).replace(/^models\//, '')).filter(Boolean))].sort();
    if (ids.length) return { models: ids, base: u.endsWith('/v1/models') && !/\/v1$/i.test(base) ? base + '/v1' : base };
    last = T('接口没有返回模型列表', 'The API returned no models');
  }
  throw new Error(T('没读到模型列表：', "Couldn't load the model list: ") + last);
}

// 测试没通过时，看看这个模型用别的接口格式（Claude 原生 / OpenAI Responses）能不能通，结果写进报错里方便排查
async function probeFormats(a) {
  const root = String(a.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  const key = a.apiKey || '';
  const tryOne = async (url, headers, body) => {
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); return r.ok; }
    catch (_) { return false; }
  };
  const ok = [];
  if (await tryOne(root + '/v1/messages', { 'x-api-key': key, Authorization: 'Bearer ' + key, 'anthropic-version': '2023-06-01' }, { model: a.model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })) ok.push(T('Claude 原生格式（/v1/messages）', 'the Claude-native format (/v1/messages)'));
  if (await tryOne(root + '/v1/responses', { Authorization: 'Bearer ' + key }, { model: a.model, input: 'hi', max_output_tokens: 16 })) ok.push(T('OpenAI Responses 格式（/v1/responses）', 'the OpenAI Responses format (/v1/responses)'));
  return ok;
}

// 试一下这个模型 / 接口能不能用工具（function calling），结果记在队友资料里：能 → 给它工具；不能 → 只动脑
async function probeTools(m) {
  const a = m.api || {};
  const body = { model: a.model, stream: false, messages: [{ role: 'user', content: '这是一次测试：请调用 ping 工具。' }],
    tools: [{ type: 'function', function: { name: 'ping', description: '测试用', parameters: { type: 'object', properties: {} } } }] };
  try {
    const r = await apiRequest(a, body, AbortSignal.timeout(60000), () => {}, null);
    if (r.ok) a.toolsOk = true;
    else if (NO_TOOLS(r)) a.toolsOk = false;
    else return null;
    saveApiState();
    return a.toolsOk;
  } catch (_) { return null; }
}

// 发一张小图（Hola 的图标）问它是什么颜色：接口报错 = 看不了图；连不上之类的不算数（返回 null）
async function probeVision(a) {
  let b64 = '';
  try { b64 = fs.readFileSync(path.join(ROOT, 'public', 'favicon.png')).toString('base64'); } catch (_) { return null; }
  const body = { model: a.model, stream: false, max_tokens: 20, messages: [{ role: 'user', content: [{ type: 'text', text: '这张图主要是什么颜色？只回答一个词。' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }] };
  try {
    const r = await apiRequest(a, body, AbortSignal.timeout(60000), () => {}, null);
    if (r.ok) return true;
    return [400, 404, 415, 422].includes(r.status) ? false : null;
  } catch (_) { return null; }
}

async function testMember(m) {
  if (m.type === 'api') {
    const res = await runApi(null, m, '这是一次连接测试，请只回复：OK', null);
    m.online = !res.err; m.problem = res.err || ''; m.version = (m.api || {}).model || '';
    if (res.err && res.status && ![401, 402, 403, 429].includes(res.status) && !/读取可用模型|Load available models/.test(res.err)) {
      const ok = await probeFormats(m.api || {});
      if (ok.length) m.problem = res.err += T(`\n诊断：这个模型用 ${ok.join('、')} 能连通，但 Hola 目前用的是通用格式。请把这句话告诉开发者。`, `\nDiagnosis: this model answers through ${ok.join(' and ')}, but Hola currently uses the generic format. Please pass this on to the developer.`);
    }
    if (res.err) return { ok: false, error: res.err };
    const hands = (m.api || {}).hands === false ? null : await probeTools(m);
    // 接入体检：勾了"能看图片"就真的发一张小图试试；看不了就帮老板取消勾选（否则有图片时整轮都会失败）
    let vision = null;
    if ((m.api || {}).vision) {
      vision = await probeVision(m.api);
      if (vision === false) { m.api.vision = false; try { saveApiState(); } catch (_) {} }
    }
    return { ok: true, text: res.text.slice(0, 200) + (vision === false ? T('\n（试了一下：这个模型看不了图片，已经取消"能看图片"。有图片时会请别的队友先写成文字说明。）', "\n(Tested: this model can't read images, so \"Can see images\" was turned off. Another teammate will describe images for it.)") : ''), hands, vision };
  }
  await checkMember(m);
  return m.online ? { ok: true, text: m.version || '命令可以运行' } : { ok: false, error: m.problem };
}

module.exports = { addUsage, makeParser, memberOf, describeTool, runCli, apiExtras, apiRequest, runApi, probeTools, remoteModels, API_EFFORTS, runMember, testMember };
