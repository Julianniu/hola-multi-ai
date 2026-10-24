// Hola · 基础：路径和配置、设置（界面语言）、老板的个人资料、推送给页面
'use strict';
const fs = require('fs');
const path = require('path');
const office = require('../office');

const ROOT = path.join(__dirname, '..'); // 代码根目录（lib 的上一层）
const IS_WIN = process.platform === 'win32';
// Mac 上从程序坞 / 访达打开时 PATH 很短，找不到 node、claude、codex、agy：补上常见的安装位置
if (!IS_WIN) {
  const home = require('os').homedir();
  const extra = [`${home}/.local/bin`, `${home}/.hola-tools/bin`, '/opt/homebrew/bin', '/usr/local/bin', `${home}/.npm-global/bin`];
  const cur = String(process.env.PATH || '').split(':').filter(Boolean);
  process.env.PATH = [...extra.filter((d) => !cur.includes(d)), ...cur].join(':');
}
// node server.js --demo：用内置的演示队友，不需要任何账号就能体验
const DEMO = process.argv.includes('--demo');
const CONFIG_PATH = process.env.TEAM_CONFIG ? path.resolve(process.env.TEAM_CONFIG) : path.join(ROOT, DEMO ? 'demo' : '', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
const PORT = Number(process.env.PORT || cfg.port || 3456);
// HOLA_WORKSPACE / HOLA_DATA_DIR：自动测试用，让每次测试都用一个临时文件夹，不碰真实数据
const WORKSPACE = path.resolve(process.env.HOLA_WORKSPACE || path.resolve(ROOT, cfg.workspace || 'workspace'));
const DATA_DIR = path.resolve(process.env.HOLA_DATA_DIR || path.join(ROOT, DEMO ? 'data-demo' : 'data'));
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TRASH = path.join(WORKSPACE, '.trash');
const MEMORY_NAME = '对话记忆.md';
const ATTACH_DIR = '附件';
const TIMEOUT_MS = Number(cfg.timeoutMinutes || 20) * 60 * 1000;
const HIDDEN = process.env.HOLA_HIDDEN === '1';
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

if (HIDDEN) {
  const logFile = path.join(DATA_DIR, 'hola.log');
  try { if (fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.old'); } catch (_) {}
  const write = (lvl, args) => fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${lvl} ${args.map(String).join(' ')}\n`);
  console.log = (...a) => write('info', a);
  console.error = (...a) => write('error', a);
}
process.on('uncaughtException', (e) => console.error('uncaught', e && e.stack || e));

// ---------------------------------------------------------------- 设置

const DEFAULT_SETTINGS = { uiLang: '', maxDiscussRounds: 3, conclusionBy: 'claude', maxAutoTurns: 10, autoMemory: true, showProcess: false, browserAsk: true, planConfirm: true, policy: 'auto', strengths: {}, memberPrefs: {} };
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (_) {}
// 界面语言：zh / en。T('中文', 'English') 按当前语言取一句
const EN = () => settings.uiLang === 'en';
const syncLang = () => { office.lang = EN() ? 'en' : 'zh'; };
syncLang();
const T = (zh, en) => (EN() ? en : zh);
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }

// Wick 的各项改进各有一个开关（settings.wick.<名字>），没写就用这里的默认值。
// 评测时把某一项关掉，就能在同一份代码里比较"开 / 关"；出了问题也能单独退回旧做法。
const WICK_DEFAULTS = { agyStdin: true, apiRetry: true, apiTools: true, apiGuard: true, rulesWall: true, sessions: true, envCard: true, streamDraft: true, trace: true, webSearch: true, skillsLazy: true, apiSystem: true, apiCompact: true, budget: true, midText: true, verify: true, docGuide: true, replan: true, substitute: true, deliveryNote: true, resume: true, cards: true, ruleHints: true, envNotes: true, skillHints: true, health: true, teamMcp: true };
const wick = (k) => { const w = settings.wick || {}; return k in w ? !!w[k] : !!WICK_DEFAULTS[k]; };

// ---------------------------------------------------------------- 老板的个人资料

const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
const PROFILE_FIELDS = ['name', 'callMe', 'title', 'org', 'industry', 'bio', 'detail', 'tone', 'format', 'language', 'debate', 'extra'];
let profile = {};
try { profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')); } catch (_) {}
function saveProfile() { fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2)); }
function avatarFile() {
  for (const ext of ['png', 'jpg', 'webp']) { const f = path.join(DATA_DIR, 'avatar.' + ext); if (fileExists(f)) return f; }
  return null;
}
function publicProfile() {
  const f = avatarFile();
  let v = 0; try { v = f ? Math.round(fs.statSync(f).mtimeMs) : 0; } catch (_) {}
  return { ...profile, avatar: f ? `/avatar?v=${v}` : '' };
}

const PREF_TEXT = {
  detail: { brief: '回答尽量简短，先给结论，能一句话说清就不要三句', balanced: '回答详略适中', thorough: '回答详细全面，把理由和细节讲透' },
  tone: { pro: '语气正式、专业', casual: '语气轻松、口语化，像同事聊天' },
  format: { lists: '多用表格和清单，方便快速扫读', prose: '多用成段的文字，少用列表' },
  language: { zh: '默认用中文回答', en: '默认用英文回答', follow: '跟随老板使用的语言回答' },
};

function profileText() {
  const p = profile;
  const who = [
    p.name && `名字：${p.name}`, p.callMe && `希望被称呼为：${p.callMe}`,
    p.title && `职位：${p.title}`, p.org && `公司 / 团队：${p.org}`, p.industry && `行业：${p.industry}`,
    p.bio && `关于老板：${p.bio}`,
  ].filter(Boolean);
  const prefs = ['detail', 'tone', 'format', 'language'].map((k) => PREF_TEXT[k][p[k]]).filter(Boolean);
  if (p.extra) prefs.push(...String(p.extra).split(/\n+/).map((x) => x.trim()).filter(Boolean));
  if (!who.length && !prefs.length) return '';
  return `【老板是谁】
${who.length ? who.map((x) => '- ' + x).join('\n') : '- （没填）'}

【老板的长期偏好（所有对话都适用，务必遵守）】
${prefs.length ? prefs.map((x) => '- ' + x).join('\n') : '- （没填）'}

`;
}

function debateText() {
  return {
    gentle: '老板希望讨论温和一些：以补充和完善为主，只在明显有问题时才提反对。',
    sharp: '老板希望讨论尖锐一些：主动唱反调，找出别人方案里最薄弱的地方，不要轻易同意。',
  }[profile.debate] || '';
}

// ---------------------------------------------------------------- 推送

const clients = new Set();
function broadcast(evt) {
  const data = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const res of clients) res.write(data);
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }

module.exports = { ROOT, IS_WIN, DEMO, CONFIG_PATH, cfg, PORT, WORKSPACE, DATA_DIR, SETTINGS_FILE, TRASH, MEMORY_NAME, ATTACH_DIR, TIMEOUT_MS, HIDDEN, DEFAULT_SETTINGS, settings, EN, syncLang, T, saveSettings, WICK_DEFAULTS, wick, PROFILE_FILE, PROFILE_FIELDS, profile, saveProfile, avatarFile, publicProfile, PREF_TEXT, profileText, debateText, clients, broadcast, fileExists };
