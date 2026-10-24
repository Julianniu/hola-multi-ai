// 官方版的"清单"：哪些文件算程序本体、怎么算指纹、怎么核对签名。
// 用到它的地方：签名工具（tools/release-sign.js）、启动时的版本标识（lib/build-check.js）、桌面版的自动更新（desktop/updater.js）。
// 改这里要格外小心：已经装出去的桌面版，会一直用它自带的这份来核对以后的更新。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 作者的公钥。对应的私钥只在作者电脑上（.release/，绝不上传）。
const RELEASE_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2na7U/vJ5Cd/DlMn/WQCJv5sZqBcv79qoj9zV2HgN6U=
-----END PUBLIC KEY-----`;

// 程序本体：后台会读、会执行的文件都必须在这里面（config.json 里写着要运行的命令，页面文件决定界面行为，所以都要签名）。
// 桌面版安装包里装的就是这些，程序更新包里也正好是这些。
// 不在里面的：各系统的启动脚本（.bat / .vbs / mac/，桌面版用不到）、package.json（打包工具会改写它，版本号以 release.json 为准）。
function RELEASE_FILES(root) {
  const list = ['server.js', 'office.js', 'config.json', 'LICENSE', 'demo/fake-ai.js', 'demo/config.json', 'tools/release-files.js', 'tools/hola-doc.js', 'tools/hola-team-mcp.js'];
  const add = (dir, re) => { try { for (const f of fs.readdirSync(path.join(root, dir))) if (re.test(f) && fs.statSync(path.join(root, dir, f)).isFile()) list.push(dir ? dir + '/' + f : f); } catch (_) {} };
  add('lib', /\.js$/);
  add('public', /./);
  add('desktop', /\.js$/);
  return [...new Set(list)].filter((f) => fs.existsSync(path.join(root, f))).sort();
}

// 文本文件先去掉 BOM、把 Windows 换行统一成 \n 再算：用 git 下载到 Windows 时换行会被自动转换，不能因此误报
const BINARY = /\.(vbs|png|ico|jpe?g|gif|webp)$/i;
function hashBuffer(name, buf) {
  if (!BINARY.test(name)) buf = Buffer.from(buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function fileHash(p) { return hashBuffer(p, fs.readFileSync(p)); }

// 签名的内容：除了 sig 以外的全部字段，键按字母排好的 JSON（以后加字段也不用改核对的代码）
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function signedBody(rel) { const { sig, ...body } = rel || {}; return canonical(body); }
function verifySignature(rel, pubKey = RELEASE_PUBKEY) {
  try { return !!rel && typeof rel.sig === 'string' && crypto.verify(null, Buffer.from(signedBody(rel)), pubKey, Buffer.from(rel.sig, 'base64')); } catch (_) { return false; }
}

// 清单里的路径只能是普通的相对路径（防止更新包往程序目录外面写东西）
function safeRel(f) {
  return typeof f === 'string' && f.length > 0 && f.length < 300 && !f.includes('\\') && !f.includes('\0') &&
    !/^[a-zA-Z]:/.test(f) && !f.startsWith('/') && f.split('/').every((p) => p && p !== '.' && p !== '..');
}

// 核对一个程序目录：签名对、清单里的每个文件都在而且指纹一致
function verifyDir(dir, pubKey = RELEASE_PUBKEY) {
  let rel;
  try { rel = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')); } catch (_) { return { ok: false, reason: 'no-manifest', changed: [] }; }
  if (!verifySignature(rel, pubKey)) return { ok: false, reason: 'bad-signature', version: rel.version, changed: [] };
  const files = rel.files || {};
  if (!Object.keys(files).every(safeRel)) return { ok: false, reason: 'bad-path', version: rel.version, changed: [] };
  const changed = Object.entries(files).filter(([f, h]) => { try { return fileHash(path.join(dir, f)) !== h; } catch (_) { return true; } }).map(([f]) => f);
  return changed.length ? { ok: false, reason: 'modified', version: rel.version, changed } : { ok: true, version: rel.version, date: rel.date, minShell: rel.minShell };
}

// 版本号比较：1.10.0 > 1.9.3
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

module.exports = { RELEASE_PUBKEY, RELEASE_FILES, hashBuffer, fileHash, canonical, signedBody, verifySignature, safeRel, verifyDir, cmpVersion };
