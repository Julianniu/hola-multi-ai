// 自动更新：用一对测试用的钥匙签各种更新包（正常的、被改过的、伪造的、带越界路径的……），看桌面版会不会被骗
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ROOT, startHola } = require('./helpers');
const { makeZip } = require('../tools/zip');
const { RELEASE_FILES, fileHash, hashBuffer, signedBody, verifyDir } = require('../tools/release-files');
const up = require('../desktop/updater');

const key = crypto.generateKeyPairSync('ed25519');
const PUB = key.publicKey.export({ type: 'spki', format: 'pem' });
const sign = (body, k = key.privateKey) => ({ ...body, sig: crypto.sign(null, Buffer.from(signedBody(body)), k).toString('base64') });

// 用当前代码做一个"新版本"的更新包；opts 可以在签名前后动手脚
function bundle(version, opts = {}) {
  const files = {}, hashes = {};
  for (const f of RELEASE_FILES(ROOT)) { files[f] = fs.readFileSync(path.join(ROOT, f)); hashes[f] = fileHash(path.join(ROOT, f)); }
  let body = { version, date: '2026-10-21', minShell: opts.minShell || '1.0.0', files: hashes };
  if (opts.beforeSign) opts.beforeSign(body, files);
  const rel = sign(body, opts.signKey);
  if (opts.afterSign) opts.afterSign(rel, files);
  return makeZip({ 'release.json': JSON.stringify(rel), ...files });
}

describe('自动更新', () => {
  let tmp, appsDir, bundledDir;
  const fresh = () => { appsDir = fs.mkdtempSync(path.join(tmp, 'apps-')); };
  const install = (zip, current = '1.0.0') => up.installBundle(zip, { appsDir, pubKey: PUB, shellVersion: '1.0.0', currentVersion: current });
  const leftovers = () => fs.readdirSync(appsDir).filter((f) => f !== 'current.json');
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-update-'));
    bundledDir = path.join(tmp, 'bundled');
    fs.mkdirSync(bundledDir);
    fs.writeFileSync(path.join(bundledDir, 'release.json'), JSON.stringify({ version: '1.0.0' }));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 }));

  it('正常的新版本：核对通过，解压到自己的文件夹', () => {
    fresh();
    assert.equal(install(bundle('1.1.0')), '1.1.0');
    assert.ok(verifyDir(path.join(appsDir, '1.1.0'), PUB).ok);
    assert.deepEqual(leftovers(), ['1.1.0'], '不能留下临时文件夹');
  });

  it('更新包里的文件被改过：拒绝，什么都不写', () => {
    fresh();
    assert.throws(() => install(bundle('1.1.0', { afterSign: (rel, files) => { files['lib/engine.js'] = Buffer.from('// 被植入的代码\n'); } })), /bad-hash: lib\/engine\.js/);
    assert.deepEqual(leftovers(), []);
  });

  it('别人用自己的钥匙签名：拒绝', () => {
    fresh();
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    assert.throws(() => install(bundle('1.1.0', { signKey: other })), /bad-signature/);
  });

  it('签名之后改了清单（比如版本号）：拒绝', () => {
    fresh();
    assert.throws(() => install(bundle('1.1.0', { afterSign: (rel) => { rel.version = '9.9.9'; } })), /bad-signature/);
  });

  it('夹带清单里没有的文件：拒绝', () => {
    fresh();
    const zip = bundle('1.1.0', { afterSign: (rel, files) => { files['lib/backdoor.js'] = Buffer.from('x'); } });
    assert.throws(() => install(zip), /unlisted-file: lib\/backdoor\.js/);
  });

  it('清单里有越界路径（就算签了名）：拒绝，不会写到程序目录外面', () => {
    for (const bad of ['../evil.js', 'lib/../../evil.js', 'C:/evil.js', '/etc/evil', 'lib\\evil.js']) {
      fresh();
      const zip = bundle('1.1.0', { beforeSign: (body, files) => { body.files[bad] = hashBuffer(bad, Buffer.from('x')); files[bad] = Buffer.from('x'); } });
      assert.throws(() => install(zip), /bad-path/, bad);
      assert.ok(!fs.existsSync(path.join(tmp, 'evil.js')));
    }
  });

  it('版本不比现在新：不装', () => {
    fresh();
    assert.throws(() => install(bundle('1.0.0')), /not-newer/);
    assert.throws(() => install(bundle('0.9.9')), /not-newer/);
    assert.throws(() => install(bundle('1.1.0'), '1.10.0'), /not-newer/, '1.10.0 比 1.1.0 新');
  });

  it('需要更新外壳才能用的版本：不装，只提示', () => {
    fresh();
    assert.throws(() => install(bundle('2.0.0', { minShell: '2.0.0' })), /needs-new-shell/);
    assert.deepEqual(leftovers(), []);
  });

  it('启动时选版本：用核对通过的新版本，启动成功后一直用它', () => {
    fresh();
    up.setCurrent(appsDir, install(bundle('1.1.0')));
    const c = up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB });
    assert.deepEqual([c.version, c.updated], ['1.1.0', true]);
    up.markStarted(appsDir);
    assert.equal(up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB }).version, '1.1.0');
  });

  it('新版本启动失败：下次自动退回安装包自带的版本，并且不再用它', () => {
    fresh();
    up.setCurrent(appsDir, install(bundle('1.1.0')));
    assert.equal(up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB }).version, '1.1.0');
    // 没有报平安（崩溃了）
    const back = up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB });
    assert.deepEqual([back.version, back.updated], ['1.0.0', false]);
    assert.ok(up.readPointer(appsDir).bad.includes('1.1.0'));
    assert.equal(up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB }).version, '1.0.0');
  });

  it('连续两次更新、第二个启动失败：退回上一个能用的版本', () => {
    fresh();
    up.setCurrent(appsDir, install(bundle('1.1.0')));
    up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB });
    up.markStarted(appsDir);
    up.setCurrent(appsDir, install(bundle('1.2.0'), '1.1.0'));
    assert.equal(up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB }).version, '1.2.0');
    const back = up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB }); // 1.2.0 没报平安
    assert.equal(back.version, '1.1.0');
    assert.ok(up.readPointer(appsDir).bad.includes('1.2.0'));
  });

  it('装好以后文件被人改了：启动时发现，退回自带版本', () => {
    fresh();
    up.setCurrent(appsDir, install(bundle('1.1.0')));
    fs.appendFileSync(path.join(appsDir, '1.1.0', 'server.js'), '\n// 被改过\n');
    assert.equal(up.chooseCodeDir({ bundledDir, appsDir, pubKey: PUB }).updated, false);
    assert.ok(up.readPointer(appsDir).bad.includes('1.1.0'));
  });

  describe('去 GitHub 检查', () => {
    const release = (tag, withAsset = true) => ({ tag_name: 'v' + tag, html_url: 'https://github.com/Julianniu/hola-multi-ai/releases/tag/v' + tag,
      assets: withAsset ? [{ name: `hola-app-${tag}.zip`, browser_download_url: 'https://example.invalid/app.zip' }] : [] });
    const fakeFetch = (rel, zip) => async (url) => (url.includes('app.zip')
      ? { ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) }
      : { ok: true, json: async () => rel });
    const check = (fetch) => up.checkForUpdate({ fetch, currentVersion: '1.0.0', shellVersion: '1.0.0', appsDir, pubKey: PUB });

    it('有新版本：下载、核对、准备好下次启动用', async () => {
      fresh();
      const r = await check(fakeFetch(release('1.2.0'), bundle('1.2.0')));
      assert.deepEqual([r.status, r.version], ['ready', '1.2.0']);
      assert.equal(up.readPointer(appsDir).version, '1.2.0');
    });
    it('已经是最新：什么都不做', async () => {
      fresh();
      assert.equal((await check(fakeFetch(release('1.0.0'), null))).status, 'latest');
    });
    it('只有新安装包、没有程序更新包：提示去下载页', async () => {
      fresh();
      const r = await check(fakeFetch(release('1.3.0', false), null));
      assert.equal(r.status, 'needs-shell');
      assert.match(r.page, /^https:\/\/github\.com\/Julianniu\//);
    });
    it('下载到的是假包：不装', async () => {
      fresh();
      const other = crypto.generateKeyPairSync('ed25519').privateKey;
      const r = await check(fakeFetch(release('1.2.0'), bundle('1.2.0', { signKey: other })));
      assert.equal(r.status, 'error');
      assert.equal(up.readPointer(appsDir).version, undefined);
    });
    it('没网：安静地失败，不报错、不卡住', async () => {
      fresh();
      const t0 = Date.now();
      const r = await check(async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); });
      assert.equal(r.status, 'error');
      assert.ok(Date.now() - t0 < 1000);
    });
    it('标记过坏的版本：不再下载', async () => {
      fresh();
      up.markBad(appsDir, '1.2.0');
      assert.equal((await check(fakeFetch(release('1.2.0'), bundle('1.2.0')))).status, 'latest');
    });
  });

  // 发版时（HOLA_BUNDLE_DIR=dist）：拿刚打出来的、用作者真钥匙签名的更新包，按桌面版的流程装一遍，再跑起来
  it('发布用的程序更新包：能通过官方签名核对，装好能用', { skip: !process.env.HOLA_BUNDLE_DIR && '只在发版时测' }, async () => {
    fresh();
    const zipName = fs.readdirSync(process.env.HOLA_BUNDLE_DIR).find((f) => /^hola-app-\d+\.\d+\.\d+\.zip$/.test(f));
    assert.ok(zipName, '没找到 hola-app-x.y.z.zip');
    const v = up.installBundle(fs.readFileSync(path.join(process.env.HOLA_BUNDLE_DIR, zipName)), { appsDir, shellVersion: '999.0.0', currentVersion: '0.0.0' });
    assert.equal(zipName, `hola-app-${v}.zip`);
    assert.ok(verifyDir(path.join(appsDir, v)).ok, '用内置的作者公钥核对');
    const h = await startHola({ root: path.join(appsDir, v) });
    try {
      assert.equal((await h.init()).build.status, 'official');
      const id = await h.newConv();
      assert.equal((await h.ask(id, '大家好')).added.filter((m) => m.reason === 'initial').length, 3);
    } finally { await h.stop(); }
  });

  it('更新包解出来的程序真的能用（没漏文件）', async () => {
    fresh();
    const v = install(bundle('1.1.0'));
    const h = await startHola({ root: path.join(appsDir, v) });
    try {
      const id = await h.newConv();
      const { added } = await h.ask(id, '大家好', { mode: 'discuss' });
      assert.equal(added.filter((m) => m.reason === 'initial').length, 3);
      assert.equal((await fetch(h.base + '/app.js')).status, 200);
    } finally { await h.stop(); }
  });
});
