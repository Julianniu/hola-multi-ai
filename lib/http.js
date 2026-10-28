// Hola · 网页接口：页面、文件、预览、所有 /api，以及启动服务
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const office = require('../office');
const { spawn } = require('child_process');
const { EN, ATTACH_DIR, DATA_DIR, HIDDEN, IS_WIN, MEMORY_NAME, PORT, PROFILE_FIELDS, ROOT, T, WORKSPACE, avatarFile, broadcast, clients, fileExists, profile, publicProfile, saveProfile, saveSettings, settings, syncLang } = require('./core');
const { EFFORTS, MODEL_RE, ORDER, PALETTE, PARSERS, RELAY_PARSERS, buildMembers, checkAll, checkChanged, customMembers, members, modelChoices, publicMembers, relays, saveCustomMembers, saveRelays, splitArgs } = require('./members');
const { finishAttachment, broadcastConvList, broadcastProjects, broadcastState, convDir, homeDir, TEXT_DIR, convList, convSummary, convertOffice, convs, createConv, fileInfo, loadConvs, newMsg, projects, readMemory, rt, safeJoin, saveConv, saveProjects, saveTimers, uniqueName } = require('./convs');
const { API_EFFORTS, remoteModels, testMember } = require('./run');
const { SKILLS_DIR, broadcastSkills, importSkill, listSkills, saveSkillMeta, skillMeta, writeSkill } = require('./skills');
const { answerRuleHint, anyRunning, answerPlan, cancelItem, decide, escalate, onBossMessage, pendingDecision, pump, reassign, resumeWork, stopConv } = require('./engine');
const { startEnvProbe, envNotes, setEnvNote } = require('./wick-env');
const { allCards, cardLine, recommendTeam, runHealth } = require('./wick-cards');
const { wick } = require('./core');
const { findTraps } = require('./wick-guard');
const { providerOf } = require('./wick-trace');
const { callTeamTool } = require('./wick-team');
const { spentToday } = require('./wick-api');
const { LIBRARY_DIR, PIN_BUDGET, attachFromLibrary, deleteFromLibrary, libraryFile, listLibrary, setPinned } = require('./library');
const { BUILD } = require('./build-check');
const { answerAsk, browserState, callTool } = require('./browser');
const mcp = require('./mcp');

// ---------------------------------------------------------------- HTTP

// 文件预览（对话里的文件和资料库的文件共用）：Office、表格、文本转成安全的网页；其他（图片、PDF 等）跳到原文件
// theme：页面传来的浅色 / 深色，预览跟着 Hola 走
function previewFile(res, p, rawUrl, theme) {
  const page = (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" }); res.end(html); };
  const name = path.basename(p);
  try {
    if (office.OFFICE_EXT.test(p)) return page(office.toHtml(office.readOffice(p, { visual: true }), name, theme));
    if (/\.(csv|tsv)$/i.test(p)) {
      const txt = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
      const sep = /\.tsv$/i.test(p) ? '\t' : ',';
      const rows = txt.split(/\r?\n/).filter((l) => l.length).slice(0, 1000).map((l) => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; });
      return page(office.previewPage(name, T('表格预览（最多显示 1000 行）', 'Table preview (up to 1000 rows)'), office.htmlTable(rows, true), theme));
    }
    if (/\.(md|txt|json)$/i.test(p)) return page(office.previewPage(name, T('文本预览', 'Text preview'), `<pre>${office.esc(fs.readFileSync(p, 'utf8').slice(0, 500000))}</pre>`, theme));
  } catch (e) { return page(office.previewPage(name, T('没法预览这个文件', "Can't preview this file"), `<p>${office.esc(e.message)}${T('。可以下载原文件查看。', '. Download the original file to view it.')}</p>`, theme)); }
  res.writeHead(302, { Location: rawUrl });
  return res.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac',
};

function sendFile(res, file, download, trusted, req) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
    if (!trusted && (ext === '.html' || ext === '.svg')) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'";
    if (download || !MIME[ext]) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
    // 支持分段读取，视频才能拖动进度条
    const range = req && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size > 0) {
      let start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { b += d; if (b.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
  });
}

function openPath(p) {
  const cmd = IS_WIN ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { spawn(cmd, [p], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(res, path.join(ROOT, 'public', 'index.html'), false, true);
    if (url.pathname === '/api/ping') return json({ ok: true, app: 'hola', data: DATA_DIR });
    if (url.pathname === '/avatar') { const f = avatarFile(); if (!f) { res.writeHead(404); return res.end(); } return sendFile(res, f, false, true); }
    if (/^\/(logo\.svg|favicon\.png|icon-192\.png|i18n\.js|app\.js|app\.css|mercury\.js)$/.test(url.pathname)) return sendFile(res, path.join(ROOT, 'public', url.pathname.slice(1)), false, true);
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ type: 'init', convs: convList(), members: publicMembers(), settings, profile: publicProfile(), skills: listSkills(), projects, workspace: WORKSPACE, build: BUILD, browser: browserState() }) + '\n\n');
      clients.add(res);
      lastClientAt = Date.now();
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); lastClientAt = Date.now(); });
      return;
    }
    let mt = url.pathname.match(/^\/api\/conv\/([\w-]+)$/);
    if (mt) {
      const c = convs.get(mt[1]);
      if (!c) return json({ error: 'not found' }, 404);
      return json({ ...convSummary(c), messages: c.messages, memory: readMemory(c), rules: c.rules || [], cost: c.cost || 0, board: c.board || null, providers: providersOf(c), ruleHints: c.ruleHints || [] });
    }
    mt = url.pathname.match(/^\/preview\/([\w-]+)\/(.+)$/);
    if (mt) {
      const c = convs.get(mt[1]);
      const rel = decodeURIComponent(mt[2]);
      const p = c && safeJoin(convDir(c), rel);
      if (!p || p.includes(path.sep + '.hola') || !fileExists(p)) { res.writeHead(404); return res.end('not found'); }
      return previewFile(res, p, `/files/${c.id}/${rel.split('/').map(encodeURIComponent).join('/')}`, url.searchParams.get('theme'));
    }
    // 资料库里自己上传的文件：看原文件 / 预览
    mt = url.pathname.match(/^\/library(-preview)?\/(.+)$/);
    if (mt) {
      const name = decodeURIComponent(mt[2]);
      const p = !name.includes('/') && libraryFile('lib:' + name);
      if (!p) { res.writeHead(404); return res.end('not found'); }
      if (mt[1]) return previewFile(res, p, '/library/' + encodeURIComponent(name), url.searchParams.get('theme'));
      return sendFile(res, p, url.searchParams.has('download'), false, req);
    }
    if (url.pathname === '/api/library') return json({ items: listLibrary(), dir: LIBRARY_DIR, pinBudget: PIN_BUDGET });
    // 花了多少钱：今天、这个对话（API 队友，订阅制的命令行队友不算）
    // 能力卡（每位队友一句话的实际表现）、推荐的团队配置
    if (url.pathname === '/api/cards') { const out = {}; for (const id of Object.keys(members)) { const c = allCards()[id]; out[id] = { line: cardLine(id, EN()), health: (c && c.health) || null }; } return json({ cards: out }); }
    if (url.pathname === '/api/envnotes') return json({ notes: envNotes() });
    if (url.pathname === '/api/team/recommend') return json(recommendTeam(EN()) || { error: 'no members' });
    if (url.pathname === '/api/mcp') return json(mcp.publicMcp());
    if (url.pathname === '/api/mcp/import') return json({ servers: mcp.importCandidates() });
    if (url.pathname === '/api/spend') { const c = convs.get(url.searchParams.get('conv') || ''); return json({ today: spentToday(), conv: c ? c.cost || 0 : null, budget: settings.budget || {} }); }
    mt = url.pathname.match(/^\/files\/([\w-]+)\/(.+)$/);
    if (mt) {
      const c = convs.get(mt[1]);
      const p = c && safeJoin(convDir(c), decodeURIComponent(mt[2]));
      if (!p || p.includes(path.sep + '.hola')) { res.writeHead(404); return res.end(); }
      return sendFile(res, p, url.searchParams.has('download'), false, req);
    }
    res.writeHead(404);
    return res.end('not found');
  }

  if (req.method === 'POST' && (url.pathname.startsWith('/api/'))) {
    // 只接受 Hola 自己页面发来的请求
    const origin = req.headers.origin;
    const okOrigin = !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!okOrigin || req.headers['x-hola'] !== '1') { res.writeHead(403); return res.end('forbidden'); }

    if (url.pathname === '/api/profile/avatar') {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[String(req.headers['content-type']).split(';')[0]];
      if (!ext) { res.writeHead(400); return res.end('only png/jpeg/webp'); }
      const chunks = []; let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 5e6) req.destroy(); else chunks.push(d); });
      req.on('end', () => {
        for (const e of ['png', 'jpg', 'webp']) { try { fs.unlinkSync(path.join(DATA_DIR, 'avatar.' + e)); } catch (_) {} }
        fs.writeFileSync(path.join(DATA_DIR, 'avatar.' + ext), Buffer.concat(chunks));
        broadcast({ type: 'profile', profile: publicProfile() });
        json({ ok: true, profile: publicProfile() });
      });
      return;
    }

    if (url.pathname === '/api/skills/import') {
      const chunks = []; let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 20e6) req.destroy(); else chunks.push(d); });
      req.on('end', () => {
        try { const id = importSkill(Buffer.concat(chunks), url.searchParams.get('name') || 'SKILL.md'); broadcastSkills(); json({ ok: true, id }); }
        catch (e) { json({ error: e.message }, 400); }
      });
      return;
    }

    if (url.pathname === '/api/library/upload') {
      fs.mkdirSync(LIBRARY_DIR, { recursive: true });
      const name = uniqueName(LIBRARY_DIR, url.searchParams.get('name') || 'file');
      const dest = path.join(LIBRARY_DIR, name);
      const ws = fs.createWriteStream(dest);
      let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 500e6) { req.destroy(); ws.destroy(); fs.rm(dest, () => {}); } });
      req.pipe(ws);
      ws.on('finish', () => { broadcast({ type: 'library' }); json({ ok: true, id: 'lib:' + name, name }); });
      ws.on('error', (e) => json({ error: e.message }, 500));
      return;
    }

    if (url.pathname === '/api/upload') {
      const c = convs.get(url.searchParams.get('conv'));
      if (!c) return json({ error: 'no conv' }, 404);
      const dir = path.join(convDir(c), ATTACH_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const name = uniqueName(dir, url.searchParams.get('name') || 'file');
      const dest = path.join(dir, name);
      const ws = fs.createWriteStream(dest);
      let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 500e6) { req.destroy(); ws.destroy(); fs.rm(dest, () => {}); } });
      req.pipe(ws);
      ws.on('finish', () => json(finishAttachment(c, `${ATTACH_DIR}/${name}`)));
      ws.on('error', (e) => json({ error: e.message }, 500));
      return;
    }

    const body = await readBody(req);
    const c = body.conv ? convs.get(body.conv) : null;
    switch (url.pathname) {
      case '/api/conv/new': return json({ id: createConv(null, body.project).id });
      // 这个对话的工作文件夹（3.2）：选自己电脑上的一个文件夹，队友就在那里读写；folder 为空 = 回到 Hola 默认的位置
      case '/api/conv/folder': {
        if (!c) return json({ error: 'no conv' }, 404);
        if (rt(c).running) return json({ error: T('队友正在干活，等这一轮做完再换文件夹', 'Teammates are working; change the folder after this round') }, 409);
        const raw = String(body.folder || '').trim().replace(/^["']|["']$/g, '');
        if (!raw) {
          delete c.folder; delete c.folderKeep;
          fs.mkdirSync(homeDir(c), { recursive: true });
          saveConv(c); broadcastConvList(); broadcastState(c);
          return json({ ok: true, folder: '', dir: convDir(c) });
        }
        const abs = path.resolve(raw);
        const bad = (zh, en) => json({ error: T(zh, en) }, 400);
        if (!path.isAbsolute(raw)) return bad('请填完整的文件夹路径，比如 D:\\双十一活动资料', 'Please enter a full folder path, e.g. D:\\Campaign');
        let st = null;
        try { st = fs.statSync(abs); } catch (_) {}
        if (!st || !st.isDirectory()) return bad('找不到这个文件夹', 'Folder not found');
        if (path.parse(abs).root === abs || abs === path.resolve(require('os').homedir())) return bad('不能直接用整个磁盘或整个用户文件夹，请选一个具体的文件夹', 'Pick a specific folder, not a whole drive or your home folder');
        const lower = abs.toLowerCase();
        const sysDirs = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData, DATA_DIR, ROOT].filter(Boolean).map((x) => path.resolve(x).toLowerCase());
        if (sysDirs.some((d) => lower === d || lower.startsWith(d + path.sep))) return bad('这是系统或 Hola 程序的文件夹，不能用', 'That is a system or Hola program folder');
        const ws = path.resolve(WORKSPACE).toLowerCase();
        if (lower === ws || lower.startsWith(ws + path.sep)) return bad('这是 Hola 自己的工作区，不用选，默认就在这里', "That is Hola's own workspace; it is already the default");
        for (const o of convs.values()) if (o !== c && o.folder && path.resolve(o.folder).toLowerCase() === lower) return bad(`这个文件夹已经给对话"${o.title}"用了，一个文件夹只能给一个对话`, `This folder is already used by "${o.title}"; one folder per chat`);
        try { fs.mkdirSync(path.join(abs, '.hola'), { recursive: true }); } catch (e) { return bad('这个文件夹写不进去：' + e.message, "Can't write to this folder: " + e.message); }
        c.folder = abs;
        c.folderKeep = findTraps(abs, 6); // 老板自己原有的 CLAUDE.md、AGENTS.md 这类配置，安全检查不去动它
        saveConv(c); broadcastConvList(); broadcastState(c);
        return json({ ok: true, folder: abs, dir: abs });
      }
      case '/api/conv/project':
        if (c) { c.project = body.project && projects.some((p) => p.id === body.project) ? body.project : null; saveConv(c); broadcastConvList(); }
        return json({ ok: true });
      case '/api/conv/status':
        if (c && (body.status === 'done' || body.status === 'doing')) { c.status = body.status; saveConv(c); broadcastConvList(); }
        return json({ ok: true });
      case '/api/projects/save': {
        const d = body.project || {};
        const name = String(d.name || '').trim().slice(0, 40);
        if (!name) return json({ error: T('请填写项目名称', 'Please enter a project name') }, 400);
        let p = projects.find((x) => x.id === d.id);
        if (!p) { p = { id: 'p' + crypto.randomBytes(4).toString('hex'), createdAt: Date.now() }; projects.push(p); }
        p.name = name;
        p.brief = String(d.brief || '').trim().slice(0, 3000);
        saveProjects(); broadcastProjects();
        return json({ ok: true, id: p.id });
      }
      case '/api/projects/delete': {
        const i = projects.findIndex((x) => x.id === body.id);
        if (i >= 0) {
          projects.splice(i, 1); saveProjects();
          for (const x of convs.values()) if (x.project === body.id) { x.project = null; saveConv(x); }
          broadcastProjects(); broadcastConvList();
        }
        return json({ ok: true });
      }
      case '/api/conv/rename':
        if (c && body.title) { c.title = String(body.title).slice(0, 60); saveConv(c); broadcastConvList(); }
        return json({ ok: true });
      case '/api/conv/delete':
        if (c) {
          stopConv(c);
          clearTimeout(saveTimers.get(c.id));
          saveTimers.delete(c.id);
          // 彻底删除：聊天记录、对话记忆、记忆历史版本、附件和产出文件全部删掉，不可恢复。
          // 用的是老板自己选的文件夹时，只删 Hola 自己放进去的东西（.hola、对话记忆、文字版），老板的文件一个不碰
          const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          try {
            if (c.folder) for (const x of ['.hola', MEMORY_NAME, TEXT_DIR]) rm(path.join(c.folder, x));
            rm(homeDir(c));
          } catch (e) { return json({ error: '有文件正被占用，没删干净：' + e.message }, 500); }
          convs.delete(c.id);
          broadcastConvList();
        }
        return json({ ok: true });
      case '/api/send': {
        if (!c) return json({ error: 'no conv' }, 404);
        const text = String(body.text || '').trim();
        const atts = (Array.isArray(body.attachments) ? body.attachments : [])
          .filter((a) => a && a.path && safeJoin(convDir(c), a.path)).map((a) => fileInfo(c, a.path));
        if (text || atts.length) onBossMessage(c, text, atts, body.mode === 'discuss' ? 'discuss' : '');
        return json({ ok: true });
      }
      // 在主脑的回答下面点"让大家讨论一下"
      case '/api/discuss': {
        if (!c) return json({ error: 'no conv' }, 404);
        const err = escalate(c, String(body.msg || ''));
        return err ? json({ error: err }, 400) : json({ ok: true });
      }
      // 开工确认：go = 开工，否则 = 先不做
      // 套用推荐的团队配置：主脑 + 每位队友是大脑还是帮手
      // 本机经验：加入（以后告诉每个干活的队友）/ 不用
      case '/api/envnotes':
        return setEnvNote(String(body.sig || ''), body.status) ? json({ ok: true, notes: envNotes() }) : json({ error: 'bad note' }, 400);
      case '/api/team/apply': {
        const rec = recommendTeam(EN());
        if (!rec) return json({ error: 'no members' }, 400);
        settings.conclusionBy = rec.conclusionBy;
        settings.policy = rec.policy;
        for (const [id, role] of Object.entries(rec.roles)) {
          const p = { ...(settings.memberPrefs[id] || {}) };
          if (role === 'helper') p.role = 'helper'; else delete p.role;
          settings.memberPrefs[id] = p;
        }
        saveSettings();
        buildMembers();
        broadcast({ type: 'settings', settings, members: publicMembers() });
        return json({ ok: true, ...rec });
      }
      case '/api/plan': {
        if (!c) return json({ error: 'no conv' }, 404);
        const err = answerPlan(c, String(body.msg || ''), body.action === 'go');
        return err ? json({ error: err }, 400) : json({ ok: true });
      }
      // 任务板：改派还没开始的一项 / 取消一项
      case '/api/board/reassign': {
        if (!c) return json({ error: 'no conv' }, 404);
        const err = reassign(c, String(body.item || ''), String(body.member || ''));
        return err ? json({ error: err }, 400) : json({ ok: true });
      }
      case '/api/board/cancel': {
        if (!c) return json({ error: 'no conv' }, 404);
        const err = cancelItem(c, String(body.item || ''));
        return err ? json({ error: err }, 400) : json({ ok: true });
      }
      case '/api/decide': {
        if (!c) return json({ error: 'no conv' }, 404);
        const concl = c.messages.find((m) => m.id === body.msg);
        if (!concl || concl !== pendingDecision(c)) return json({ error: T('这条结论已经拍过板了', 'This has already been decided') }, 400);
        const opt = (concl.options || []).find((o) => o.key === body.option);
        if (!opt) return json({ error: 'no option' }, 400);
        const what = opt.text.replace(/\s*[（(]\s*(支持|support)[^）)]*[）)]\s*$/i, '') || opt.text;
        newMsg(c, 'boss', T(`拍板：选方案${opt.key}（${what}）`, `Decision: option ${opt.key} (${what})`), { reason: 'decision' });
        decide(c, concl, opt.key);
        return json({ ok: true });
      }
      case '/api/library/attach': {
        if (!c) return json({ error: 'no conv' }, 404);
        const info = attachFromLibrary(c, body.id);
        return info ? json(info) : json({ error: T('找不到这个文件了', 'That file no longer exists') }, 404);
      }
      case '/api/library/pin':
        if (!setPinned(body.id, !!body.on)) return json({ error: T('只有资料库里的文字类文件（Word、Excel、PPT、Markdown、文本、CSV）能设为常驻', 'Only text-type files you uploaded (Word, Excel, PowerPoint, Markdown, text, CSV) can be pinned') }, 400);
        broadcast({ type: 'library' });
        return json({ ok: true });
      case '/api/library/delete':
        if (!deleteFromLibrary(body.id)) return json({ error: T('只能删除自己上传到资料库的文件', 'Only files you uploaded to the library can be deleted here') }, 400);
        broadcast({ type: 'library' });
        return json({ ok: true });
      // 内置浏览器：队友的工具调用（凭这次运行的通行证），老板对"能不能点 / 输入"的回答
      // Hola 团队工具（命令行队友的 MCP 服务转过来的，凭这次运行的通行证）
      case '/api/team/tool':
        return json(await callTeamTool(String(body.token || ''), String(body.tool || ''), body.args));
      // 外部工具（MCP）：设置 → 连接里增删改、测试；命令行队友的转接服务来要清单和调用
      case '/api/mcp/save':
        try { const s = mcp.saveServer(body.server || {}); return json({ ok: true, server: (await mcp.testServer(s.id)) }); }
        catch (e) { return json({ error: e.message }, 400); }
      case '/api/mcp/test':
        return json({ ok: true, server: await mcp.testServer(String(body.id || '')).catch((e) => ({ error: e.message })) });
      case '/api/mcp/delete':
        mcp.removeServer(String(body.id || ''));
        return json({ ok: true });
      case '/api/mcp/toggle': {
        const all = mcp.publicMcp().servers, s = all.find((x) => x.id === body.id);
        if (!s) return json({ error: 'not found' }, 404);
        if (body.tool) return json({ ok: mcp.setTool(s.id, String(body.tool), body.patch || {}) });
        mcp.saveServer({ ...s, env: s.env, headers: s.headers, ...(body.patch || {}) });
        return json({ ok: true });
      }
      case '/api/mcp/import': {
        if (body.text) { const list = mcp.parseImport(String(body.text)); for (const s of list) mcp.saveServer(s); return json({ ok: true, added: list.length }); }
        return json({ ok: true, added: mcp.importServers(Array.isArray(body.names) ? body.names : []).length });
      }
      case '/api/mcp/tool':
        if (body.list) return json({ tools: mcp.proxyTools(String(body.token || '')) });
        return json(await mcp.callMcp(String(body.token || ''), String(body.tool || ''), body.args));
      case '/api/browser/tool':
        return json(await callTool(String(body.token || ''), String(body.tool || ''), body.args));
      case '/api/browser/answer':
        return json({ ok: answerAsk(String(body.id || ''), body.answer) });
      case '/api/stop':
        if (c) stopConv(c, T('老板叫停了，大家先停手。', 'You stopped the team. Everyone has paused.'), true);
        return json({ ok: true });
      case '/api/profile': {
        const d = body.profile || {};
        for (const k of PROFILE_FIELDS) if (typeof d[k] === 'string') profile[k] = d[k].trim().slice(0, k === 'bio' || k === 'extra' ? 2000 : 100);
        if (body.removeAvatar) for (const e of ['png', 'jpg', 'webp']) { try { fs.unlinkSync(path.join(DATA_DIR, 'avatar.' + e)); } catch (_) {} }
        saveProfile();
        broadcast({ type: 'profile', profile: publicProfile() });
        return json({ ok: true, profile: publicProfile() });
      }
      // 规矩墙：老板亲手整理的规矩（一行一条），每一轮都原样告诉所有队友
      case '/api/rules':
        if (c && Array.isArray(body.rules)) {
          c.rules = body.rules.map((r) => String(r || '').trim().slice(0, 500)).filter(Boolean).slice(0, 50).map((text) => ({ text }));
          saveConv(c);
        }
        return json({ ok: true, rules: c ? c.rules || [] : [] });
      // 规矩候选：加进规矩墙 / 不用
      case '/api/rules/hint': {
        if (!c) return json({ error: 'no conv' }, 404);
        const err = answerRuleHint(c, String(body.text || ''), !!body.add);
        return err ? json({ error: err }, 400) : json({ ok: true, rules: c.rules || [], hints: c.ruleHints || [] });
      }
      case '/api/memory':
        if (c && typeof body.text === 'string') {
          const hist = path.join(convDir(c), '.hola', 'memory-history');
          fs.mkdirSync(hist, { recursive: true });
          const old = readMemory(c);
          if (old && old !== body.text) fs.writeFileSync(path.join(hist, `${new Date().toISOString().replace(/[:.]/g, '-')}-老板修改前.md`), old);
          fs.writeFileSync(path.join(convDir(c), MEMORY_NAME), body.text);
        }
        return json({ ok: true, memory: c ? readMemory(c) : '' });
      case '/api/open':
        if (body.library) { fs.mkdirSync(LIBRARY_DIR, { recursive: true }); openPath(LIBRARY_DIR); return json({ ok: true }); }
        openPath(c ? (body.file ? safeJoin(convDir(c), body.file) || convDir(c) : convDir(c)) : WORKSPACE);
        return json({ ok: true });
      case '/api/conv/active':
        if (c && Array.isArray(body.active)) {
          c.active = body.active.filter((id) => members[id]);
          saveConv(c);
          broadcastState(c);
        }
        return json({ ok: true });
      case '/api/members/save': {
        const d = body.member || {};
        const name = String(d.name || '').trim();
        if (!/^[A-Za-z0-9一-龥._-]{1,20}$/.test(name)) return json({ error: '名字只能用中英文、数字和 . _ -，不能有空格，最多 20 个字' }, 400);
        if (ORDER.some((id) => id !== d.id && members[id].name.toLowerCase() === name.toLowerCase())) return json({ error: '已经有同名的队友了' }, 400);
        const color = /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : null;
        let savedId = d.id;
        const access = d.access === 'full' || d.access === 'safe' ? d.access : null;
        const model = typeof d.cliModel === 'string' ? d.cliModel.trim() : null;
        if (model && !MODEL_RE.test(model)) return json({ error: T('模型名只能用英文字母、数字和 . _ - : /', 'Model names can only use letters, digits and . _ - : /') }, 400);
        const effort = typeof d.cliEffort === 'string' ? d.cliEffort : null;
        if (effort && !EFFORTS.includes(effort)) return json({ error: 'bad effort' }, 400);
        const setPrefs = (id) => {
          const p = { ...(settings.memberPrefs[id] || {}), ...(access ? { access } : {}) };
          if (model !== null) { if (model) p.model = model; else delete p.model; }
          if (effort !== null) { if (effort) p.effort = effort; else delete p.effort; }
          settings.memberPrefs[id] = p;
        };
        // 填进来的 API 接口资料（自己加的 API 队友、改走中转站的内置队友共用）；Key 留空 = 沿用原来的
        const apiFrom = (old) => {
          const a = { baseUrl: String(d.baseUrl || '').trim(), model: String(d.model || '').trim(), apiKey: d.apiKey ? String(d.apiKey).trim() : old.apiKey || '', temperature: d.temperature ?? '', vision: !!d.vision,
            hands: typeof d.hands === 'boolean' ? d.hands : old.hands !== false, full: access ? access === 'full' : !!old.full, effort: API_EFFORTS.includes(d.apiEffort) ? d.apiEffort : '',
            // 单价（元 / 百万 token），用来算花费；不填就用内置的（DeepSeek）或不计价
            price: d.price === null ? null : d.price && Number(d.price.input) >= 0 && Number(d.price.output) >= 0 ? { input: +d.price.input, cached: Number(d.price.cached ?? d.price.input), output: +d.price.output } : old.price || null };
          // 接口、模型、Key 都没变：沿用上次试出来的"能不能用工具"；变了就等"保存并测试"重新试
          if (old.baseUrl === a.baseUrl && old.model === a.model && !d.apiKey && old.toolsOk !== undefined) a.toolsOk = old.toolsOk;
          return a;
        };
        if (d.id && members[d.id] && members[d.id].builtin) {
          const relayable = RELAY_PARSERS.includes((members[d.id].def || {}).parser);
          const via = relayable && d.via === 'relay' ? 'relay' : relayable && d.via === 'sub' ? 'sub' : null;
          if (via === 'relay') {
            const a = apiFrom(relays[d.id] || {});
            if (!a.baseUrl || !a.model) return json({ error: T('请填写中转站的接口地址和模型名', 'Fill in the relay address and model name') }, 400);
            if (!a.apiKey) return json({ error: T('请填写 API Key', 'Fill in the API key') }, 400);
            relays[d.id] = a;
            saveRelays();
          }
          settings.memberPrefs[d.id] = { ...(settings.memberPrefs[d.id] || {}), ...(color ? { color } : {}), ...(typeof d.enabled === 'boolean' ? { enabled: d.enabled } : {}), ...(via ? { via } : {}) };
          // 走中转站时，"完全权限"指的是 API 队友能不能运行命令（存在中转站资料里），不动命令行的权限设置
          if (via === 'relay') { if (model !== null || effort !== null) setPrefs(d.id); } else setPrefs(d.id);
          if (typeof d.strengths === 'string') settings.strengths[d.id] = d.strengths.slice(0, 300);
          saveSettings();
        } else {
          let cm = customMembers.find((x) => x.id === d.id);
          if (!cm) {
            if (d.type === 'api' && !d.apiKey && !/localhost|127\.0\.0\.1/.test(d.baseUrl || '')) return json({ error: '请填写 API Key' }, 400);
            cm = { id: 'm' + crypto.randomBytes(3).toString('hex'), color: color || PALETTE[customMembers.length % PALETTE.length] };
            customMembers.push(cm);
          }
          savedId = cm.id;
          cm.name = name;
          if (color) cm.color = color;
          if (typeof d.strengths === 'string') cm.strengths = d.strengths.slice(0, 300);
          if (typeof d.enabled === 'boolean') cm.enabled = d.enabled;
          delete settings.strengths[cm.id];
          if (d.type === 'api') {
            cm.type = 'api';
            cm.api = apiFrom(cm.api || {});
            delete cm.cmd; delete cm.args; delete cm.parser; delete cm.readOnly; delete cm.versionCheck;
          } else if (d.type === 'cli') {
            cm.type = 'cli';
            cm.cmd = String(d.cmd || '').trim();
            cm.args = splitArgs(String(d.argsText || ''));
            cm.parser = PARSERS.includes(d.parser) ? d.parser : 'plain';
            cm.readOnly = !!d.readOnly;
            cm.versionCheck = d.versionCheck !== false;
            delete cm.api;
          }
          saveCustomMembers();
          if ((access && cm.type !== 'api') || model !== null || effort !== null) { setPrefs(cm.id); saveSettings(); }
        }
        if (d.role === 'helper' || d.role === 'brain') {
          settings.memberPrefs[savedId] = { ...(settings.memberPrefs[savedId] || {}), role: d.role };
          if (d.role === 'brain') delete settings.memberPrefs[savedId].role;
          saveSettings();
        }
        buildMembers();
        checkChanged();
        return json({ ok: true, id: savedId });
      }
      case '/api/members/delete': {
        const i = customMembers.findIndex((x) => x.id === body.id);
        if (i >= 0) { customMembers.splice(i, 1); saveCustomMembers(); buildMembers(); checkChanged(); }
        return json({ ok: true });
      }
      // 读出这把 Key 能用的模型。Key 留空时用已保存的（只在地址没换的情况下，免得把 Key 发到别的网站）
      case '/api/members/remote-models': {
        let key = String(body.apiKey || '').trim();
        if (!key && body.id) {
          const saved = (customMembers.find((x) => x.id === body.id) || {}).api || relays[body.id] || {};
          const host = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };
          if (saved.apiKey && host(saved.baseUrl) && host(saved.baseUrl) === host(body.baseUrl)) key = saved.apiKey;
        }
        try { return json(await remoteModels(body.baseUrl, key)); }
        catch (e) { return json({ error: e.message }); }
      }
      case '/api/models': {
        const m = members[body.id];
        if (!m) return json({ error: T('找不到这位队友', 'Teammate not found') }, 404);
        return json(await modelChoices(m));
      }
      case '/api/members/test': {
        const m = members[body.id];
        if (!m) return json({ ok: false, error: '找不到这位队友' });
        const out = await testMember(m);
        broadcast({ type: 'members', members: publicMembers() });
        return json(out);
      }
      case '/api/recheck':
        checkAll();
        return json({ ok: true });
      case '/api/settings':
        if (body.maxDiscussRounds) settings.maxDiscussRounds = Math.max(1, Math.min(6, Number(body.maxDiscussRounds) || 3));
        if (body.conclusionBy && members[body.conclusionBy]) settings.conclusionBy = body.conclusionBy;
        if (typeof body.autoMemory === 'boolean') settings.autoMemory = body.autoMemory;
        if (typeof body.showProcess === 'boolean') settings.showProcess = body.showProcess;
        if (typeof body.browserAsk === 'boolean') settings.browserAsk = body.browserAsk;
        if (typeof body.planConfirm === 'boolean') settings.planConfirm = body.planConfirm;
        if (['auto', 'quality', 'balanced', 'saving'].includes(body.policy)) settings.policy = body.policy;
        // 主脑：沿用原来"团队结论由谁整理"这一项（mainBrain 是新名字，两个都认）
        if (body.mainBrain && members[body.mainBrain]) settings.conclusionBy = body.mainBrain;
        if (body.uiLang === 'zh' || body.uiLang === 'en') { settings.uiLang = body.uiLang; syncLang(); checkAll(); }
        if (body.maxAutoTurns) settings.maxAutoTurns = Math.max(0, Math.min(50, Number(body.maxAutoTurns) || 10));
        // 花费上限（元，0 = 不限）：每个对话、每天
        if (body.budget && typeof body.budget === 'object') settings.budget = { perConv: Math.max(0, Number(body.budget.perConv) || 0), perDay: Math.max(0, Number(body.budget.perDay) || 0) };
        if (body.strengths && typeof body.strengths === 'object') {
          for (const [k, v] of Object.entries(body.strengths)) if (members[k]) settings.strengths[k] = String(v).slice(0, 300);
        }
        saveSettings();
        broadcast({ type: 'settings', settings, members: publicMembers() });
        return json({ ok: true });
      case '/api/skills/save':
        try { const id = writeSkill(body.skill || {}, (body.skill || {}).id ? {} : { source: 'manual' }); broadcastSkills(); return json({ ok: true, id }); }
        catch (e) { return json({ error: e.message }, 400); }
      case '/api/skills/toggle':
        if (body.id && fs.existsSync(path.join(SKILLS_DIR, String(body.id)))) { skillMeta[body.id] = { ...(skillMeta[body.id] || {}), enabled: !!body.enabled }; saveSkillMeta(); broadcastSkills(); }
        return json({ ok: true });
      case '/api/skills/delete': {
        const dir = body.id && safeJoin(SKILLS_DIR, String(body.id));
        if (dir && dir !== SKILLS_DIR && !String(body.id).startsWith('.')) { fs.rmSync(dir, { recursive: true, force: true }); delete skillMeta[body.id]; saveSkillMeta(); broadcastSkills(); }
        return json({ ok: true });
      }
      case '/api/skills/open': {
        const dir = body.id ? safeJoin(SKILLS_DIR, String(body.id)) : SKILLS_DIR;
        fs.mkdirSync(dir || SKILLS_DIR, { recursive: true });
        openPath(dir || SKILLS_DIR);
        return json({ ok: true });
      }
      case '/api/skills/distill':
        if (!c) return json({ error: 'no conv' }, 404);
        rt(c).jobs.push({ type: 'skill', fromMsg: body.msg || null });
        pump(c);
        return json({ ok: true });
      case '/api/quit':
        json({ ok: true });
        for (const cc of convs.values()) if (cc.rt && cc.rt.running) stopConv(cc);
        mcp.closeAll();
        setTimeout(() => process.exit(0), 300);
        return;
    }
  }
  res.writeHead(404);
  res.end('not found');
});

// 数据去向：这个对话的内容发给过哪些服务商（谁在这个对话里干过活）
function providersOf(c) {
  const seen = new Map();
  for (const m of c.messages) if (members[m.from] && !seen.has(m.from)) seen.set(m.from, providerOf(members[m.from]));
  return [...seen.entries()].map(([id, p]) => ({ id, name: members[id].name, provider: p, api: members[id].type === 'api' }));
}

loadConvs();

// 同一份数据只能开一个 Hola（比如压缩包版和桌面版同时开着，会把对话记录写乱）：
// 数据目录里的 hola.lock 记下正在用它的端口；启动前先问一下那个端口，确实是用这份数据的 Hola 就不启动
const LOCK_FILE = path.join(DATA_DIR, 'hola.lock');
async function otherInstance() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (!l.port || l.pid === process.pid) return 0;
    const j = await (await fetch(`http://127.0.0.1:${l.port}/api/ping`, { signal: AbortSignal.timeout(1500) })).json();
    return j.app === 'hola' && path.resolve(String(j.data || '')) === path.resolve(DATA_DIR) ? l.port : 0;
  } catch (_) { return 0; }
}
otherInstance().then((other) => {
  if (other) {
    console.error(`ANOTHER_INSTANCE：这份数据（${DATA_DIR}）已经有一个 Hola 在用了：http://localhost:${other}`);
    process.exit(3);
  }
  server.listen(PORT, '127.0.0.1', onListening);
});
process.on('exit', () => { try { if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch (_) {} });

function onListening() {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT })); } catch (_) {}
  const link = `http://localhost:${PORT}`;
  console.log(`Hola 已启动：${link}  工作文件夹：${WORKSPACE}`);
  if (!HIDDEN) {
    console.log('\n  关掉这个窗口 Hola 就会停止。平时双击桌面的 Hola 图标更方便。\n');
    if (!process.env.NO_OPEN) {
      if (IS_WIN) spawn('cmd', ['/c', 'start', '', link], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else if (process.platform === 'darwin') spawn('open', [link], { detached: true, stdio: 'ignore' }).unref();
    }
  }
  // 队友在线检查做完，再把重启前没做完的活接着做（wick resume）
  checkAll().then(() => { for (const cc of convs.values()) { try { resumeWork(cc); } catch (_) {} } }).catch(() => {});
  // 定期体检（wick health）：启动 1 分钟后一次，之后每 6 小时（演示模式不跑）
  if (wick('health') && !process.argv.includes('--demo')) { setTimeout(() => runHealth().catch(() => {}), 60000).unref(); setInterval(() => runHealth().catch(() => {}), 6 * 3600e3).unref(); }
  startEnvProbe();
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`端口 ${PORT} 已被占用：Hola 可能已经在运行了，直接打开 http://localhost:${PORT} 即可。`);
  else console.error(e);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});

// 静默运行时：窗口全部关掉、也没有活在跑，30 分钟后自动退出
if (HIDDEN) {
  setInterval(() => {
    if (!clients.size && !anyRunning() && Date.now() - lastClientAt > 30 * 60 * 1000) process.exit(0);
  }, 60 * 1000);
}

let lastClientAt = Date.now();

module.exports = { MIME, sendFile, readBody, openPath, server, lastClientAt };
