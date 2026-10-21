// 桌面版自动更新，从头到尾真跑一遍：本机假装成 GitHub 发新版本 → 应用下载、核对 → 重启后用上新版本；
// 再发一个坏的新版本 → 启动失败 → 自动退回上一个能用的版本。用测试钥匙签名（只有开发版允许换钥匙）。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ROOT, freePort } = require('./helpers');
const { makeZip } = require('../tools/zip');
const { RELEASE_FILES, fileHash, hashBuffer, signedBody } = require('../tools/release-files');

let electronPath = null, pw = null;
try { electronPath = require('electron'); pw = require('playwright-core'); } catch (_) {}
const skip = !electronPath || !pw || !fs.existsSync(String(electronPath)) ? '没装 electron / playwright-core' : false;
// 在 GitHub 上发版时（HOLA_REQUIRE_APP=1）桌面版测试必须真的跑，不许跳过
if (skip && process.env.HOLA_REQUIRE_APP) require('node:test').it('桌面版测试必须能跑', () => { throw new Error(skip); });

const key = crypto.generateKeyPairSync('ed25519');
function bundle(version, change) {
  const files = {};
  for (const f of RELEASE_FILES(ROOT)) files[f] = fs.readFileSync(path.join(ROOT, f));
  change(files);
  const hashes = Object.fromEntries(Object.entries(files).map(([f, b]) => [f, hashBuffer(f, b)]));
  const body = { version, date: '2026-10-21', minShell: '1.0.0', files: hashes };
  const rel = { ...body, sig: crypto.sign(null, Buffer.from(signedBody(body)), key.privateKey).toString('base64') };
  return makeZip({ 'release.json': JSON.stringify(rel), ...files });
}

describe('桌面版自动更新（真跑一遍）', { skip }, () => {
  let dir, gh, port, latest = null;
  const pointer = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'userdata', 'app', 'current.json'), 'utf8')); } catch (_) { return {}; } };
  async function launch() {
    const app = await pw._electron.launch({
      executablePath: electronPath, args: [ROOT], cwd: ROOT,
      env: { ...process.env, HOLA_TEST_HIDDEN: '1', HOLA_DEMO_FAST: '1', PORT: String(await freePort()),
        HOLA_USER_DATA: path.join(dir, 'userdata'), HOLA_DATA_DIR: path.join(dir, 'data'), HOLA_WORKSPACE: path.join(dir, 'workspace'),
        TEAM_CONFIG: path.join(ROOT, 'demo', 'config.json'), // 用假队友，不调用真实 AI
        HOLA_UPDATE_URL: `http://127.0.0.1:${port}/latest`, HOLA_UPDATE_PUBKEY: key.publicKey.export({ type: 'spki', format: 'pem' }), HOLA_UPDATE_DELAY_MS: '300' },
    });
    return app;
  }
  const waitFor = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-app-update-'));
    port = await freePort();
    gh = http.createServer((req, res) => {
      if (!latest) { res.writeHead(404); return res.end(); }
      if (req.url === '/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ tag_name: 'v' + latest.version, html_url: 'https://github.com/Julianniu/hola-multi-ai/releases/latest',
          assets: [{ name: `hola-app-${latest.version}.zip`, browser_download_url: `http://127.0.0.1:${port}/app.zip` }] }));
      }
      if (req.url === '/app.zip') { res.writeHead(200); return res.end(latest.zip); }
      res.writeHead(404); res.end();
    }).listen(port, '127.0.0.1');
  });
  after(() => { gh.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); });

  it('发现新版本：后台下载、核对，准备好下次用', async () => {
    latest = { version: '9.9.9', zip: bundle('9.9.9', (f) => { f['public/app.js'] = Buffer.concat([f['public/app.js'], Buffer.from("\nwindow.__holaVersion = '9.9.9';\n")]); }) };
    const app = await launch();
    const page = await app.firstWindow();
    await page.waitForSelector('#buildTag:not([hidden])', { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__holaVersion), undefined, '还是旧版本');
    assert.ok(await waitFor(() => pointer().version === '9.9.9'), '应该下载好 9.9.9：' + JSON.stringify(pointer()));
    assert.ok(fs.existsSync(path.join(dir, 'userdata', 'app', '9.9.9', 'server.js')));
    await app.close();
  });

  it('重启后用的就是新版本', async () => {
    latest = null;
    const app = await launch();
    const page = await app.firstWindow();
    await page.waitForSelector('#buildTag:not([hidden])', { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__holaVersion), '9.9.9');
    assert.equal(pointer().lastStart.ok, true, '启动成功要报平安');
    await app.close();
  });

  it('新版本是坏的：启动失败后自动退回上一个能用的版本', async () => {
    latest = { version: '9.9.10', zip: bundle('9.9.10', (f) => { f['server.js'] = Buffer.from("throw new Error('坏掉的更新');\n"); }) };
    let app = await launch();
    await (await app.firstWindow()).waitForSelector('#buildTag:not([hidden])', { timeout: 30000 });
    assert.ok(await waitFor(() => pointer().version === '9.9.10'));
    await app.close();
    latest = null;
    // 这次会用 9.9.10 启动，失败，标记为坏版本后马上退出（快到测试工具可能还没连上）
    try {
      app = await launch();
      if (app.process().exitCode === null) await new Promise((r) => app.process().once('exit', r));
    } catch (_) { /* 应用已经自己退出了 */ }
    assert.ok(await waitFor(() => (pointer().bad || []).includes('9.9.10'), 10000), JSON.stringify(pointer()));
    assert.ok(pointer().bad.includes('9.9.10'), JSON.stringify(pointer()));
    assert.equal(pointer().version, '9.9.9');
    // 再打开：回到 9.9.9，正常工作
    app = await launch();
    const page = await app.firstWindow();
    await page.waitForSelector('#buildTag:not([hidden])', { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__holaVersion), '9.9.9');
    await app.close();
  });
});
