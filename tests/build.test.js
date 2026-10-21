// 官方版标识：在一份模拟"用户下载"的副本上，试各种改动，看左上角会显示什么
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, startHola } = require('./helpers');

const SKIP = /^(\.release|\.hola-dev|\.git|data|data-demo|workspace|demo-workspace|node_modules|dist|tests|CLAUDE\.local\.md)$/;

describe('官方版标识', () => {
  let tmp;
  const copy = () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'copy-'));
    for (const f of fs.readdirSync(ROOT)) if (!SKIP.test(f)) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
    return dir;
  };
  const buildOf = async (dir) => { const h = await startHola({ root: dir }); try { return (await h.init()).build; } finally { await h.stop(); } };
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-build-')); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 }));

  it('原样下载：官方版（发版前必须先签名）', async () => {
    const b = await buildOf(copy());
    // 平时改了代码还没重新签名，这里会是"modified"；发版时（HOLA_RELEASE_CHECK=1）必须是官方版
    if (process.env.HOLA_RELEASE_CHECK) assert.equal(b.status, 'official', '发版前忘了运行 node tools/release-sign.js：' + JSON.stringify(b.changed));
    else assert.ok(['official', 'modified'].includes(b.status), JSON.stringify(b));
    assert.ok(b.version);
  });

  it('Windows 下载时换行被转成 CRLF：不算改动', async () => {
    const dir = copy();
    const before = await buildOf(dir);
    for (const f of ['server.js', 'public/index.html']) {
      const p = path.join(dir, f);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    const b = await buildOf(dir);
    assert.equal(b.status, before.status);
    assert.deepEqual(b.changed || [], before.changed || []);
  });

  it('改了程序文件：显示非官方版，并列出改了哪个', async () => {
    const dir = copy();
    fs.appendFileSync(path.join(dir, 'office.js'), '\n// 被改过\n');
    const b = await buildOf(dir);
    assert.equal(b.status, 'modified');
    assert.ok(b.changed.includes('office.js'));
  });

  it('篡改签名文件或删掉它：非官方版', async () => {
    const dir = copy();
    const f = path.join(dir, 'release.json');
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    r.files['server.js'] = '0'.repeat(64);
    fs.writeFileSync(f, JSON.stringify(r));
    assert.equal((await buildOf(dir)).status, 'unofficial');
    fs.rmSync(f);
    assert.equal((await buildOf(dir)).status, 'unofficial');
  });

  it('作者本机有 .hola-dev：开发版', async () => {
    const dir = copy();
    fs.writeFileSync(path.join(dir, '.hola-dev'), '');
    assert.equal((await buildOf(dir)).status, 'dev');
  });
});
