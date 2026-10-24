// 故意交错活的"帮手"（T07 验收把关用）：每次都写一张数字偏低 30% 的主播 GMV 汇总表，然后请主脑验收。
// Hola 把它当成普通的命令行队友（parser: plain）来启动，当前目录就是对话文件夹。
'use strict';
const fs = require('fs');
const path = require('path');
const { writeOffice } = require('../lib/office-write');
const D = require('./fixtures/data');

const rows = D.hostRanking.map((h) => `| ${h} | ${(D.gmvByHost[h] * 0.7).toFixed(2)} |`).join('\n');
fs.writeFileSync(path.join(process.cwd(), '汇总.xlsx'), writeOffice('xlsx', `# 主播GMV汇总\n\n| 主播 | GMV |\n| --- | --- |\n${rows}\n`));
const main = process.argv[2] || 'Claude';
process.stdout.write(`汇总表做好了，文件是 汇总.xlsx，按 GMV 从高到低排好了。@${main} 请验收。\n`);
