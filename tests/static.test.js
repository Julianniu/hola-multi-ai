// 不用启动 Hola 就能查的：语法、文件格式（换行、编码、可执行）、许可证
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT } = require('./helpers');

const read = (f) => fs.readFileSync(path.join(ROOT, f));
const list = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).map((f) => (dir ? dir + '/' : '') + f);

describe('代码和文件格式', () => {
  it('所有 JS 文件语法正确', () => {
    for (const f of ['server.js', 'office.js', 'public/i18n.js', 'public/app.js', 'demo/fake-ai.js', ...list('lib', /\.js$/), ...list('tools', /\.js$/), ...list('tests', /\.js$/)]) {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
    }
  });

  it('页面只引用拆出去的样式和脚本，不再内嵌', () => {
    const html = read('public/index.html').toString('utf8');
    assert.ok(html.includes('<link rel="stylesheet" href="/app.css">'));
    assert.ok(html.includes('<script src="/app.js"></script>'));
    assert.ok(!/<script>[\s\S]*?<\/script>/.test(html) && !/<style>/.test(html), '不应再有内嵌的脚本或样式');
  });

  it('后台按层拆分：每个模块只依赖更底层的模块', () => {
    const layers = ['core', 'office-write', 'members', 'convs', 'library', 'browser', 'wick-trace', 'wick-guard', 'wick-verify', 'wick-team', 'tools', 'wick-api', 'wick-session', 'wick-env', 'wick-board', 'wick-cards', 'run', 'skills', 'prompts', 'engine', 'build-check', 'http'];
    assert.deepEqual(list('lib', /\.js$/).map((f) => path.basename(f, '.js')).sort(), [...layers].sort());
    for (const [i, name] of layers.entries()) {
      const t = read(`lib/${name}.js`).toString('utf8');
      for (const m of t.matchAll(/require\('\.\/([\w-]+)'\)/g)) {
        assert.ok(layers.indexOf(m[1]) < i, `${name} 不能依赖上层的 ${m[1]}`);
      }
    }
    assert.match(read('server.js').toString('utf8'), /require\('\.\/lib\/http'\)/);
  });

  it('Windows 的 .bat 是 CRLF 换行、UTF-8 无 BOM、开头切到 UTF-8 代码页', () => {
    for (const f of list('', /\.bat$/i)) {
      const t = read(f).toString('utf8');
      assert.ok(!t.startsWith('﻿'), f + ' 不能有 BOM');
      assert.ok(!/[^\r]\n/.test(t), f + ' 必须全是 CRLF');
      assert.match(t, /chcp 65001/, f);
    }
  });

  it('Hola.vbs 是带 BOM 的 UTF-16（中文提示才不会乱码）', () => {
    const b = read('Hola.vbs');
    assert.equal(b[0], 0xff);
    assert.equal(b[1], 0xfe);
  });

  it('Mac 脚本是 LF 换行、无 BOM、以 bash 开头', () => {
    for (const f of list('mac', /\.(sh|command)$/)) {
      const t = read(f).toString('utf8');
      assert.ok(t.startsWith('#!/bin/bash\n'), f);
      assert.ok(!t.includes('\r'), f + ' 不能有 CR');
    }
  });

  it('Mac 脚本没用 Mac 自带旧版 bash（3.2）不支持的写法', () => {
    for (const f of list('mac', /\.(sh|command)$/)) {
      const t = read(f).toString('utf8');
      for (const bad of [/declare -A/, /\$\{\w+,,\}/, /\$\{\w+\^\^\}/, /\bmapfile\b/, /\breadarray\b/, /\|&/, /readlink -f/, /grep -P/, /sed -i\s/, /printf '%q'/]) {
        assert.ok(!bad.test(t), `${f} 用了 ${bad}`);
      }
    }
  });

  it('许可证是 PolyForm Internal Use 原文，带作者声明', () => {
    const t = read('LICENSE').toString('utf8');
    assert.match(t, /^Required Notice: Copyright \d{4} Julianniu/);
    assert.match(t, /# PolyForm Internal Use License 1\.0\.0/);
    assert.match(t, /you may not distribute the software/);
  });

  it('仓库默认配置是安全的：没有危险参数，Gemini 只读', () => {
    const c = JSON.parse(read('config.json'));
    const all = Object.values(c.members).flatMap((m) => m.args).join(' ');
    assert.ok(!/dangerously|bypassPermissions|danger-full-access/.test(all), all);
    assert.equal(c.members.gemini.readOnly, true);
  });

  it('不会把私人文件传上 GitHub', () => {
    const ig = read('.gitignore').toString('utf8');
    for (const x of ['data/', 'workspace/', 'CLAUDE.local.md', '.release/', '.hola-dev']) assert.ok(ig.includes(x), x);
  });
});
