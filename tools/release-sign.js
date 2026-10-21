#!/usr/bin/env node
// 给正式版签名：记下每个程序文件的指纹（SHA-256），再用作者的私钥签名，写进 release.json。
// Hola 启动时用内置的公钥核对：文件和签名都对得上才算"官方版"；桌面版的自动更新也靠它。
// 用法（只在作者电脑上运行，私钥绝不能上传）：node tools/release-sign.js 1.0.0 [私钥路径]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RELEASE_FILES, fileHash, signedBody, verifyDir } = require('./release-files');

const ROOT = path.join(__dirname, '..');
const version = process.argv[2];
const keyPath = process.argv[3] || path.join(ROOT, '.release', 'hola-signing-key.pem');
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('用法：node tools/release-sign.js 1.2.3 [私钥路径]'); process.exit(1); }

// 版本号写进 package.json（桌面版外壳的版本、安装包的名字都从这里来）
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== version) { pkg.version = version; fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n'); }

const files = {};
for (const f of RELEASE_FILES(ROOT)) files[f] = fileHash(path.join(ROOT, f));
// minShell：这次的程序要求桌面版外壳至少是哪个版本（外壳有不兼容的改动时调高）
const body = { version, date: new Date().toISOString().slice(0, 10), minShell: pkg.holaMinShell || '1.0.0', files };
const sig = crypto.sign(null, Buffer.from(signedBody(body)), fs.readFileSync(keyPath, 'utf8')).toString('base64');
fs.writeFileSync(path.join(ROOT, 'release.json'), JSON.stringify({ ...body, sig }, null, 2) + '\n');
const check = verifyDir(ROOT);
if (!check.ok) { console.error('签完自检没通过：', check); process.exit(1); }
console.log(`已签名 v${version}，共 ${Object.keys(files).length} 个文件 → release.json（自检通过）`);
