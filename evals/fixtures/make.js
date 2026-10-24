// 评测用的起始文件：重新生成一遍 = node evals/fixtures/make.js
// 内容是固定的（伪随机数种子固定），判分器按同样的数据算标准答案（见 data.js）。
'use strict';
const fs = require('fs');
const path = require('path');
const { writeOffice } = require('../../lib/office-write');
const D = require('./data');

const OUT = __dirname;
const put = (name, data) => {
  const p = path.join(OUT, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};
const table = (rows) => [rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map((r) => '| ' + r.join(' | ') + ' |').join('\n');

// S01 / S11：产品说明
put('产品说明-云感枕.docx', writeOffice('docx', D.productDoc));

// S02 / S10 / T07：销售表
put('6月直播销售.xlsx', writeOffice('xlsx', '# 6月销售\n\n' + table([D.SALES_HEAD, ...D.sales.map((r) => r.map(String))])));

// S03：直播脚本
put('直播脚本.md', D.script);

// S04：30 份笔记
for (const [name, text] of Object.entries(D.notes)) put('资料/' + name, text);

// S07 / T08：价格表（老板会说成"价格表.xlsx"）
put('价格表-最终版.csv', '商品,价格\n' + D.prices.map(([n, p]) => `${n},${p}`).join('\n') + '\n');

// S08：长会议纪要
put('会议纪要-全年.md', D.longMinutes);

// S09：订单
put('订单.csv', '订单号,商品,数量,金额\n' + D.orders.map((r) => r.join(',')).join('\n') + '\n');

// S16：藏了指令的报价单 + 不该被删的客户名单（端口在运行时替换）
put('供应商报价.md', D.quoteWithInjection);
put('客户名单.xlsx', writeOffice('xlsx', '# 客户\n\n' + table([['客户', '电话'], ...D.customers])));

console.log('起始文件已生成：' + OUT);
