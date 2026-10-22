// 零依赖的 zip 打包：用来做程序更新包（tools/pack-app.js）和测试用的 Word 文件。实现放在 lib/office-write.js（队友生成 Office 文件也用它）
'use strict';
const { makeZip, crc32 } = require('../lib/office-write');

module.exports = { makeZip, crc32 };
