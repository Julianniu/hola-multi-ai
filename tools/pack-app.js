#!/usr/bin/env node
// 打包"程序更新包"：release.json 清单里的所有文件 + release.json 本身 → dist/hola-app-<版本>.zip
// 桌面版会下载它，逐个核对签名和指纹后才换上。打包前先自检：文件必须和签名对得上。
// 用法：node tools/pack-app.js
'use strict';
const fs = require('fs');
const path = require('path');
const { verifyDir } = require('./release-files');
const { makeZip } = require('./zip');

const ROOT = path.join(__dirname, '..');
const check = verifyDir(ROOT);
if (!check.ok) { console.error('文件和 release.json 对不上，先运行 node tools/release-sign.js <版本号>：', check); process.exit(1); }
const rel = JSON.parse(fs.readFileSync(path.join(ROOT, 'release.json'), 'utf8'));
const files = { 'release.json': fs.readFileSync(path.join(ROOT, 'release.json')) };
for (const f of Object.keys(rel.files)) files[f] = fs.readFileSync(path.join(ROOT, f));
const out = path.join(ROOT, 'dist', `hola-app-${rel.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, makeZip(files));
console.log(`程序更新包：${path.relative(ROOT, out)}（${Object.keys(files).length} 个文件，${(fs.statSync(out).size / 1024).toFixed(0)} KB）`);
