// Hola · 网页接口：页面、文件、预览、所有 /api，以及启动服务
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const office = require('../office');
const { spawn } = require('child_process');
const { ATTACH_DIR, DATA_DIR, HIDDEN, IS_WIN, MEMORY_NAME, PORT, PROFILE_FIELDS, ROOT, T, WORKSPACE, avatarFile, broadcast, clients, fileExists, profile, publicProfile, saveProfile, saveSettings, settings, syncLang } = require('./core');
const { EFFORTS, MODEL_RE, ORDER, PALETTE, PARSERS, buildMembers, checkAll, checkChanged, customMembers, members, modelChoices, publicMembers, saveCustomMembers, splitArgs } = require('./members');
const { broadcastConvList, broadcastProjects, broadcastState, convDir, convList, convSummary, convertOffice, convs, createConv, fileInfo, loadConvs, newMsg, projects, readMemory, rt, safeJoin, saveConv, saveProjects, saveTimers, uniqueName } = require('./convs');
const { testMember } = require('./run');
const { SKILLS_DIR, broadcastSkills, importSkill, listSkills, saveSkillMeta, skillMeta, writeSkill } = require('./skills');
const { anyRunning, decide, onBossMessage, pendingDecision, pump, stopConv } = require('./engine');
const { BUILD } = require('./build-check');

// ---------------------------------------------------------------- HTTP

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
    if (/^\/(logo\.svg|favicon\.png|icon-192\.png|i18n\.js|app\.js|app\.css)$/.test(url.pathname)) return sendFile(res, path.join(ROOT, 'public', url.pathname.slice(1)), false, true);
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ type: 'init', convs: convList(), members: publicMembers(), settings, profile: publicProfile(), skills: listSkills(), projects, workspace: WORKSPACE, build: BUILD }) + '\n\n');
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
      return json({ ...convSummary(c), messages: c.messages, memory: readMemory(c) });
    }
    mt = url.pathname.match(/^\/preview\/([\w-]+)\/(.+)$/);
    if (mt) {
      const c = convs.get(mt[1]);
      const rel = decodeURIComponent(mt[2]);
      const p = c && safeJoin(convDir(c), rel);
      if (!p || p.includes(path.sep + '.hola') || !fileExists(p)) { res.writeHead(404); return res.end('not found'); }
      const page = (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" }); res.end(html); };
      const name = path.basename(p);
      try {
        if (office.OFFICE_EXT.test(p)) return page(office.toHtml(office.readOffice(p), name));
        if (/\.(csv|tsv)$/i.test(p)) {
          const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
          const sep = /\.tsv$/i.test(p) ? '\t' : ',';
          const rows = txt.split(/\r?\n/).filter((l) => l.length).slice(0, 1000).map((l) => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; });
          return page(office.previewPage(name, T('表格预览（最多显示 1000 行）', 'Table preview (up to 1000 rows)'), office.htmlTable(rows, true)));
        }
        if (/\.(md|txt|json)$/i.test(p)) return page(office.previewPage(name, T('文本预览', 'Text preview'), `<pre>${office.esc(fs.readFileSync(p, 'utf8').slice(0, 500000))}</pre>`));
      } catch (e) { return page(office.previewPage(name, T('没法预览这个文件', "Can't preview this file"), `<p>${office.esc(e.message)}${T('。可以下载原文件查看。', '. Download the original file to view it.')}</p>`)); }
      res.writeHead(302, { Location: `/files/${c.id}/${rel.split('/').map(encodeURIComponent).join('/')}` });
      return res.end();
    }
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
      ws.on('finish', () => { convertOffice(c, `${ATTACH_DIR}/${name}`); json(fileInfo(c, `${ATTACH_DIR}/${name}`)); });
      ws.on('error', (e) => json({ error: e.message }, 500));
      return;
    }

    const body = await readBody(req);
    const c = body.conv ? convs.get(body.conv) : null;
    switch (url.pathname) {
      case '/api/conv/new': return json({ id: createConv(null, body.project).id });
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
          // 彻底删除：聊天记录、对话记忆、记忆历史版本、附件和产出文件全部删掉，不可恢复
          try { fs.rmSync(convDir(c), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { return json({ error: '有文件正被占用，没删干净：' + e.message }, 500); }
          convs.delete(c.id);
          broadcastConvList();
        }
        return json({ ok: true });
      case '/api/send': {
        if (!c) return json({ error: 'no conv' }, 404);
        const text = String(body.text || '').trim();
        const atts = (Array.isArray(body.attachments) ? body.attachments : [])
          .filter((a) => a && a.path && safeJoin(convDir(c), a.path)).map((a) => fileInfo(c, a.path));
        if (text || atts.length) onBossMessage(c, text, atts);
        return json({ ok: true });
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
      case '/api/stop':
        if (c) stopConv(c, T('老板叫停了，大家先停手。', 'You stopped the team. Everyone has paused.'));
        return json({ ok: true });
      case '/api/profile': {
        const d = body.profile || {};
        for (const k of PROFILE_FIELDS) if (typeof d[k] === 'string') profile[k] = d[k].trim().slice(0, k === 'bio' || k === 'extra' ? 2000 : 100);
        if (body.removeAvatar) for (const e of ['png', 'jpg', 'webp']) { try { fs.unlinkSync(path.join(DATA_DIR, 'avatar.' + e)); } catch (_) {} }
        saveProfile();
        broadcast({ type: 'profile', profile: publicProfile() });
        return json({ ok: true, profile: publicProfile() });
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
        if (d.id && members[d.id] && members[d.id].builtin) {
          settings.memberPrefs[d.id] = { ...(settings.memberPrefs[d.id] || {}), ...(color ? { color } : {}), ...(typeof d.enabled === 'boolean' ? { enabled: d.enabled } : {}) };
          setPrefs(d.id);
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
            const old = cm.api || {};
            cm.type = 'api';
            cm.api = { baseUrl: String(d.baseUrl || '').trim(), model: String(d.model || '').trim(), apiKey: d.apiKey ? String(d.apiKey).trim() : old.apiKey || '', temperature: d.temperature ?? '' };
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
          if (access || model !== null || effort !== null) { setPrefs(cm.id); saveSettings(); }
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
        if (body.uiLang === 'zh' || body.uiLang === 'en') { settings.uiLang = body.uiLang; syncLang(); checkAll(); }
        if (body.maxAutoTurns) settings.maxAutoTurns = Math.max(0, Math.min(50, Number(body.maxAutoTurns) || 10));
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
        setTimeout(() => process.exit(0), 300);
        return;
    }
  }
  res.writeHead(404);
  res.end('not found');
});

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
  checkAll();
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
