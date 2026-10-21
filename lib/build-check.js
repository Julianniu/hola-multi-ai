// Hola · 官方版本校验：核对 release.json 的签名和文件指纹
'use strict';
const path = require('path');
const { ROOT, fileExists } = require('./core');

// ---------------------------------------------------------------- 官方版本校验
// 正式版带 release.json：程序文件的指纹 + 作者私钥的签名（核对的逻辑和公钥在 tools/release-files.js，桌面版自动更新也用它）。
// 签名和指纹都对得上 = 官方版；对不上 = 非官方修改版（界面上会标出来）；有 .hola-dev 文件 = 作者本机的开发版。
// 这挡不住有心人连检查一起删掉，作用是让普通用户分得清手里的是不是官方发布的那份。
function checkBuild() {
  if (fileExists(path.join(ROOT, '.hola-dev'))) return { status: 'dev' };
  try {
    const r = require('../tools/release-files').verifyDir(ROOT);
    if (r.ok) return { status: 'official', version: r.version, date: r.date };
    return { status: r.reason === 'modified' ? 'modified' : 'unofficial', version: r.version, changed: r.changed || [] };
  } catch (_) { return { status: 'unofficial', changed: [] }; }
}
const BUILD = checkBuild();

module.exports = { checkBuild, BUILD };
