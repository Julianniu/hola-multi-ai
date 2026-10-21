#!/usr/bin/env node
// GitHub 上测试失败时：把失败的测试名和原因写成"错误提示"（annotation）。
// 公开仓库的提示不用登录也能看到（日志要登录），方便排查。
// 用法：node tools/ci-annotate.js test-results.tap
'use strict';
const fs = require('fs');
let tap = '';
try { tap = fs.readFileSync(process.argv[2], 'utf8'); } catch (_) { console.log('::error title=测试::没找到测试结果文件'); process.exit(0); }
const lines = tap.split(/\r?\n/);
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 1800);
let n = 0;
for (let i = 0; i < lines.length && n < 10; i++) {
  const m = lines[i].match(/^\s*not ok \d+ - (.+)$/);
  if (!m) continue;
  // 跳过只是"里面有子测试失败"的外层分组
  const body = [];
  for (let j = i + 1; j < lines.length && !/^\s*(not ok|ok) \d+/.test(lines[j]); j++) body.push(lines[j].trim());
  const text = body.join('\n');
  if (/failureType: 'subtestsFailed'/.test(text)) continue;
  const err = (text.match(/error: ([\s\S]*?)\n(?:code|name|expected|actual|operator|stack|failureType|location):/) || [])[1] || text;
  const where = (text.match(/location: '([^']+)'/) || [])[1] || '';
  console.log(`::error title=${esc(m[1])}::${esc(where + '\n' + err)}`);
  n++;
}
if (!n) console.log('::error title=测试::有测试失败，但没解析出具体是哪个（可能是测试进程本身崩溃）');
