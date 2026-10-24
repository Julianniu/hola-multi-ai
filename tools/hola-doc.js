// Hola 文档工具（给命令行队友用，零依赖）：
//   node hola-doc.js 输入.md 输出.docx|pptx|xlsx   用 Markdown 生成按 Hola 文档标准排版的 Word / PPT / Excel，生成后自动检查
//   node hola-doc.js check 文件 [文件…]             检查做好的文件：打不打得开、有没有没写完的占位、PPT 字有没有溢出、Excel 有没有错误值
// 和 API 队友的 write_file 用的是同一个排版器（lib/office-write.js）和同一套检查（lib/wick-verify.js）。
'use strict';
const fs = require('fs');
const path = require('path');
const { writeOffice } = require('../lib/office-write');
const { checkFile } = require('../lib/wick-verify');

function report(file) {
  const r = checkFile(file);
  if (!r.problems.length) { console.log(`检查通过：${path.basename(file)}`); return true; }
  for (const p of r.problems) console.log(`${p.level === 'error' ? '问题' : '提醒'}：${p.msg}`);
  return r.ok;
}

const args = process.argv.slice(2);
if (args[0] === 'check' && args.length > 1) {
  const ok = args.slice(1).map(report).every(Boolean);
  process.exit(ok ? 0 : 1);
} else if (args.length === 2 && /\.(docx|pptx|xlsx)$/i.test(args[1])) {
  const md = fs.readFileSync(args[0], 'utf8');
  fs.mkdirSync(path.dirname(path.resolve(args[1])), { recursive: true });
  fs.writeFileSync(args[1], writeOffice(path.extname(args[1]), md));
  console.log(`已生成：${args[1]}`);
  process.exit(report(args[1]) ? 0 : 1);
} else {
  console.log('用法：node hola-doc.js 输入.md 输出.docx|pptx|xlsx\n      node hola-doc.js check 文件 [文件…]');
  process.exit(2);
}
