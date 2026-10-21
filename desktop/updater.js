// 桌面版自动更新：只更新"程序"（server.js、lib/、public/ 等）。外壳（Electron 本身）有新版时只提示去下载，不自动运行任何安装包。
// 安全规则：
// - 核对用的公钥和代码都在外壳自己的目录里（这个文件 + 安装包自带的 tools/release-files.js），从不从更新目录加载；
// - 更新包里的 release.json 必须是作者签名的，版本必须比现在新，只解出清单里列出的文件，逐个核对指纹，全部通过才换上；
// - 新版本启动失败（报错或没响应）就标记为坏版本，自动退回安装包自带的版本，以后不再用它。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { RELEASE_PUBKEY, verifySignature, safeRel, hashBuffer, verifyDir, cmpVersion } = require('../tools/release-files');

const MAX_ZIP = 80e6;
const MAX_ENTRY = 30e6;
const API = 'https://api.github.com/repos/Julianniu/hola-multi-ai/releases/latest';

// 读 zip（带大小限制，防止解压炸弹）
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('bad-zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad-zip');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (entries.has(name)) throw new Error('duplicate-entry: ' + name);
    if (usize > MAX_ENTRY || (method !== 0 && method !== 8)) throw new Error('bad-entry: ' + name);
    entries.set(name, { method, csize, usize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()],
    get(name) {
      const f = entries.get(name);
      if (!f) return null;
      const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
      const data = buf.slice(start, start + f.csize);
      const out = f.method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }) : data;
      if (out.length !== f.usize) throw new Error('bad-size: ' + name);
      return out;
    },
  };
}

// 校验并解压一个更新包到 appsDir/<版本号>/。成功返回版本号；任何一步不对都抛出原因，不留下半截文件。
function installBundle(zipBuf, { appsDir, pubKey = RELEASE_PUBKEY, shellVersion, currentVersion }) {
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length > MAX_ZIP) throw new Error('too-big');
  const z = unzip(zipBuf);
  const relBuf = z.get('release.json');
  if (!relBuf) throw new Error('no-manifest');
  let rel;
  try { rel = JSON.parse(relBuf.toString('utf8')); } catch (_) { throw new Error('bad-manifest'); }
  if (!verifySignature(rel, pubKey)) throw new Error('bad-signature');
  if (!/^\d+\.\d+\.\d+$/.test(String(rel.version))) throw new Error('bad-version');
  if (cmpVersion(rel.version, currentVersion) <= 0) throw new Error('not-newer');
  if (cmpVersion(rel.minShell || '0.0.0', shellVersion) > 0) { const e = new Error('needs-new-shell'); e.version = rel.version; throw e; }
  const files = rel.files || {};
  const names = Object.keys(files);
  if (!names.length || !names.every(safeRel)) throw new Error('bad-path');
  for (const n of z.names()) if (n !== 'release.json' && !n.endsWith('/') && !Object.prototype.hasOwnProperty.call(files, n)) throw new Error('unlisted-file: ' + n);

  fs.mkdirSync(appsDir, { recursive: true });
  const staging = path.join(appsDir, `.staging-${rel.version}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const n of names) {
      const b = z.get(n);
      if (!b) throw new Error('missing-file: ' + n);
      if (hashBuffer(n, b) !== files[n]) throw new Error('bad-hash: ' + n);
      const out = path.join(staging, ...n.split('/'));
      if (!out.startsWith(staging + path.sep)) throw new Error('bad-path');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, b);
    }
    fs.writeFileSync(path.join(staging, 'release.json'), relBuf);
    const check = verifyDir(staging, pubKey);
    if (!check.ok || check.version !== rel.version) throw new Error('verify-failed: ' + check.reason);
    const dest = path.join(appsDir, rel.version);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    return rel.version;
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

// current.json：现在用哪个版本、哪些版本是坏的、上次启动有没有报平安
function readPointer(appsDir) {
  try { const p = JSON.parse(fs.readFileSync(path.join(appsDir, 'current.json'), 'utf8')); p.bad = Array.isArray(p.bad) ? p.bad : []; return p; } catch (_) { return { bad: [] }; }
}
function writePointer(appsDir, p) {
  fs.mkdirSync(appsDir, { recursive: true });
  const f = path.join(appsDir, 'current.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(p, null, 2));
  fs.renameSync(f + '.tmp', f);
}
// 换上新版本时记住上一个能用的版本，新版本出问题就退回它（而不是一路退回安装包自带的版本）
function setCurrent(appsDir, version) {
  const p = readPointer(appsDir);
  if (p.version && p.version !== version && !p.bad.includes(p.version)) p.prev = p.version;
  p.version = version;
  delete p.lastStart;
  writePointer(appsDir, p);
}
function markBad(appsDir, version) {
  const p = readPointer(appsDir);
  if (!p.bad.includes(version)) p.bad.push(version);
  if (p.version === version) {
    if (p.prev && !p.bad.includes(p.prev)) p.version = p.prev; else delete p.version;
    delete p.prev;
  }
  delete p.lastStart;
  writePointer(appsDir, p);
}
function markStarted(appsDir) { const p = readPointer(appsDir); if (p.lastStart) { p.lastStart.ok = true; writePointer(appsDir, p); } }

// 启动时选用哪份程序：更新目录里核对通过、比安装包自带的新、没被标记坏的；否则用安装包自带的
function chooseCodeDir({ bundledDir, appsDir, pubKey = RELEASE_PUBKEY }) {
  let bundledVersion = '0.0.0';
  try { bundledVersion = JSON.parse(fs.readFileSync(path.join(bundledDir, 'release.json'), 'utf8')).version || bundledVersion; } catch (_) {}
  const bundled = { dir: bundledDir, version: bundledVersion, updated: false };
  let p = readPointer(appsDir);
  // 上次用更新版启动后没报平安（崩溃或卡住）：把它标成坏版本，退回上一个能用的版本（没有的话就是安装包自带的）
  if (p.lastStart && p.lastStart.ok === false) { markBad(appsDir, p.lastStart.version); p = readPointer(appsDir); }
  if (!p.version || p.bad.includes(p.version) || cmpVersion(p.version, bundledVersion) <= 0) return bundled;
  const dir = path.join(appsDir, p.version);
  const v = verifyDir(dir, pubKey);
  if (!v.ok || v.version !== p.version) { markBad(appsDir, p.version); return bundled; }
  p.lastStart = { version: p.version, ok: false };
  writePointer(appsDir, p);
  return { dir, version: p.version, updated: true };
}

// 去 GitHub 看有没有新版本；有的话下载程序更新包、核对、解压，准备好下次启动用
// fetch 由外壳传进来（Electron 的 net.fetch 会走系统代理）；任何网络问题都安静地失败
async function checkForUpdate({ fetch, apiUrl = API, currentVersion, shellVersion, appsDir, pubKey = RELEASE_PUBKEY }) {
  try {
    const r = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { status: 'error', error: 'HTTP ' + r.status };
    const rel = await r.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(latest) || cmpVersion(latest, currentVersion) <= 0) return { status: 'latest' };
    if (readPointer(appsDir).bad.includes(latest)) return { status: 'latest' };
    const page = /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : 'https://github.com/Julianniu/hola-multi-ai/releases/latest';
    const asset = (rel.assets || []).find((a) => a && a.name === `hola-app-${latest}.zip`);
    if (!asset) return { status: 'needs-shell', version: latest, page };
    const d = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) });
    if (!d.ok) return { status: 'error', error: 'HTTP ' + d.status };
    const buf = Buffer.from(await d.arrayBuffer());
    try {
      const v = installBundle(buf, { appsDir, pubKey, shellVersion, currentVersion });
      setCurrent(appsDir, v);
      return { status: 'ready', version: v, page };
    } catch (e) {
      if (e.message === 'needs-new-shell') return { status: 'needs-shell', version: latest, page };
      return { status: 'error', error: e.message };
    }
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

module.exports = { unzip, installBundle, readPointer, setCurrent, markBad, markStarted, chooseCodeDir, checkForUpdate, API };
