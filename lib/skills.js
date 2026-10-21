// Hola · 技能库：所有对话、所有队友共用的技能（读写、导入、给队友看的索引）
'use strict';
const fs = require('fs');
const path = require('path');
const office = require('../office');
const { DATA_DIR, T, broadcast } = require('./core');
const { convDir, safeJoin } = require('./convs');

// ---------------------------------------------------------------- 技能库（所有对话、所有队友共用）
// 每个技能是 data/skills/<id>/SKILL.md（和 Claude Skills 一样的格式：开头 name / description，后面是做法），
// 同一文件夹里还可以放模板、脚本等文件。队友干活前会看技能索引，用到时读 SKILL.md。

const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const SKILLS_META = path.join(DATA_DIR, 'skills-meta.json');
let skillMeta = {};
try { skillMeta = JSON.parse(fs.readFileSync(SKILLS_META, 'utf8')); } catch (_) {}
function saveSkillMeta() { fs.writeFileSync(SKILLS_META, JSON.stringify(skillMeta, null, 2)); }

function parseSkill(text) {
  text = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const out = { name: '', description: '', body: fm ? fm[2] : text };
  if (fm) {
    let key = null;
    for (const line of fm[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (kv) { key = kv[1].toLowerCase(); const v = kv[2].trim().replace(/^["']|["']$/g, ''); if (key === 'name') out.name = v; else if (key === 'description') out.description = v === '|' || v === '>' ? '' : v; }
      else if (key === 'description' && line.trim()) out.description += (out.description ? ' ' : '') + line.trim();
    }
  }
  if (!out.name) { const h = out.body.match(/^#\s+(.+)$/m); if (h) out.name = h[1].trim(); }
  out.body = out.body.trim();
  return out;
}
const yamlStr = (s) => (/^[\w一-鿿][^:#\n]*$/.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s));
function skillText(sk) { return `---\nname: ${yamlStr(sk.name)}\ndescription: ${yamlStr(sk.description.replace(/\s*\n\s*/g, ' '))}\n---\n\n${sk.body.trim()}\n`; }

function skillSlug(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'skill';
  let id = base, n = 2;
  while (fs.existsSync(path.join(SKILLS_DIR, id))) id = `${base}-${n++}`;
  return id;
}
function skillFiles(dir) {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (r !== 'SKILL.md') out.push(r); } };
  try { walk(dir, ''); } catch (_) {}
  return out.slice(0, 50);
}
function listSkills() {
  let dirs = [];
  try { dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch (_) {}
  return dirs.map((id) => {
    const f = path.join(SKILLS_DIR, id, 'SKILL.md');
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
    const sk = parseSkill(txt);
    const meta = skillMeta[id] || {};
    return { id, name: sk.name || id, description: sk.description, body: sk.body, enabled: meta.enabled !== false, uses: meta.uses || 0, lastUsed: meta.lastUsed || 0, source: meta.source || '', fromConv: meta.fromConv || '', updatedAt: fs.statSync(f).mtimeMs, files: skillFiles(path.join(SKILLS_DIR, id)) };
  }).filter(Boolean).sort((a, b) => (b.lastUsed || b.updatedAt) - (a.lastUsed || a.updatedAt));
}
function broadcastSkills() { broadcast({ type: 'skills', skills: listSkills() }); }

function writeSkill(sk, meta = {}) {
  const name = String(sk.name || '').trim().slice(0, 60);
  if (!name) throw new Error(T('请填写技能名称', 'Please enter a skill name'));
  const description = String(sk.description || '').trim().slice(0, 600);
  const body = String(sk.body || '').trim().slice(0, 60000);
  if (!body) throw new Error(T('请填写技能的具体做法', 'Please write the instructions'));
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  let id = sk.id && /^[\w一-鿿.-]+$/.test(sk.id) && fs.existsSync(path.join(SKILLS_DIR, sk.id)) ? sk.id : null;
  if (!id) { const same = listSkills().find((x) => x.name.toLowerCase() === name.toLowerCase()); id = same ? same.id : skillSlug(name); }
  const dir = path.join(SKILLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  try {
    const old = fs.readFileSync(file, 'utf8');
    const hist = path.join(SKILLS_DIR, '.history', id);
    fs.mkdirSync(hist, { recursive: true });
    fs.writeFileSync(path.join(hist, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`), old);
  } catch (_) {}
  fs.writeFileSync(file, skillText({ name, description, body }));
  skillMeta[id] = { ...(skillMeta[id] || {}), ...meta };
  if (typeof sk.enabled === 'boolean') skillMeta[id].enabled = sk.enabled;
  saveSkillMeta();
  return id;
}

function importSkill(buf, filename) {
  if (/\.zip$/i.test(filename)) {
    const zip = office.readZip(buf);
    const mdName = zip.names().filter((n) => /(^|\/)SKILL\.md$/i.test(n)).sort((a, b) => a.length - b.length)[0];
    if (!mdName) throw new Error(T('压缩包里没找到 SKILL.md', 'No SKILL.md found in the zip'));
    const prefix = mdName.slice(0, mdName.length - 'SKILL.md'.length);
    const sk = parseSkill(zip.text(mdName));
    if (!sk.name) sk.name = prefix.split('/').filter(Boolean).pop() || filename.replace(/\.zip$/i, '');
    const id = writeSkill(sk, { source: 'import' });
    const dir = path.join(SKILLS_DIR, id);
    for (const n of zip.names()) {
      if (!n.startsWith(prefix) || n.endsWith('/') || n === mdName) continue;
      const rel = n.slice(prefix.length);
      const dest = safeJoin(dir, rel);
      if (!dest || rel.split('/').some((p) => p.startsWith('.'))) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, zip.bytes(n));
    }
    return id;
  }
  const sk = parseSkill(buf.toString('utf8'));
  if (!sk.name) sk.name = filename.replace(/\.(md|markdown|txt)$/i, '').replace(/^SKILL$/i, 'skill');
  return writeSkill(sk, { source: 'import' });
}

// 每次干活前，把启用的技能同步到对话文件夹的 .hola/skills 里，所有命令行队友都能用相对路径读到
function syncSkillsTo(c) {
  const dest = path.join(convDir(c), '.hola', 'skills');
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
  const list = listSkills().filter((s) => s.enabled);
  for (const s of list) { try { fs.cpSync(path.join(SKILLS_DIR, s.id), path.join(dest, s.id), { recursive: true }); } catch (_) {} }
  return list;
}

function skillsPromptText(c, m) {
  const list = listSkills().filter((s) => s.enabled);
  if (!list.length) return '';
  if (m.type === 'api') {
    let budget = 24000;
    const parts = [];
    for (const s of list) {
      const txt = `### ${s.name}\n适用：${s.description || '（未写）'}\n${s.body}`;
      if (txt.length > budget) { parts.push(`### ${s.name}\n适用：${s.description}\n（内容太长，没有附上）`); continue; }
      budget -= txt.length; parts.push(txt);
    }
    return `【Hola 技能库】团队共用的做事方法。任务符合某个技能的"适用"说明时，就按它的做法来：\n${parts.join('\n\n')}\n\n`;
  }
  return `【Hola 技能库】团队共用的做事方法（老板和队友沉淀下来的）。任务符合某个技能的说明时，先读它的 SKILL.md 再动手，同一文件夹里的模板、脚本按 SKILL.md 说的用：\n` +
    list.map((s) => `- ${s.name}：${s.description || '（没写适用场景，读 SKILL.md 判断）'}（.hola/skills/${s.id}/SKILL.md）`).join('\n') + '\n\n';
}

const TAG_SKILL = /^[ \t>*_]*【\s*(?:技能|用了技能|Skill)\s*】\s*[:：]?\s*(.+?)\s*[*_]*\s*$/m;
function noteSkillUse(text, msg) {
  const mt = text.match(TAG_SKILL);
  if (!mt) return text;
  const all = listSkills();
  const names = mt[1].split(/[、,，;；]/).map((x) => x.trim().replace(/^[「"']|[」"']$/g, '')).filter(Boolean);
  const used = [];
  for (const n of names) {
    const s = all.find((x) => x.name.toLowerCase() === n.toLowerCase() || x.id === n);
    if (s) { used.push({ id: s.id, name: s.name }); skillMeta[s.id] = { ...(skillMeta[s.id] || {}), uses: (skillMeta[s.id]?.uses || 0) + 1, lastUsed: Date.now() }; }
  }
  if (used.length) { msg.skills = used; saveSkillMeta(); broadcastSkills(); }
  return text.replace(TAG_SKILL, '').trim();
}

module.exports = { SKILLS_DIR, SKILLS_META, skillMeta, saveSkillMeta, parseSkill, yamlStr, skillText, skillSlug, skillFiles, listSkills, broadcastSkills, writeSkill, importSkill, syncSkillsTo, skillsPromptText, TAG_SKILL, noteSkillUse };
