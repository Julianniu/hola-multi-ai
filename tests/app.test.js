// 桌面版（Electron）：真的把 Hola 应用打开，像人一样打字、点按钮、看预览，再切到英文找漏翻的中文。
// 需要先 npm install（装 electron 和 playwright-core）；没装的话这组测试自动跳过，其他测试照常跑。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, freePort } = require('./helpers');

let electronPath = null, pw = null;
try { electronPath = require('electron'); pw = require('playwright-core'); } catch (_) {}
const skip = !electronPath || !pw || !fs.existsSync(String(electronPath)) ? '没装 electron / playwright-core（npm install 后才测桌面版）' : false;
// 在 GitHub 上发版时（HOLA_REQUIRE_APP=1）桌面版测试必须真的跑，不许跳过
if (skip && process.env.HOLA_REQUIRE_APP) require('node:test').it('桌面版测试必须能跑', () => { throw new Error(skip); });

describe('桌面版', { skip }, () => {
  let app, page, dir, errors = [];
  const $text = (sel) => page.locator(sel).first().innerText();
  async function ask(text) {
    await page.fill('#input', text);
    await page.click('#sendBtn');
  }
  const waitIdle = () => page.waitForFunction(() => !document.body.classList.contains('busy') && !document.querySelector('.row .working'), null, { timeout: 30000 });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hola-app-'));
    // HOLA_APP_EXE：测打包好的应用（比如 dist/win-unpacked/Hola.exe），确认打包时没漏文件
    const exe = process.env.HOLA_APP_EXE;
    app = await pw._electron.launch({
      executablePath: exe || electronPath, args: exe ? [] : [ROOT], cwd: exe ? path.dirname(exe) : ROOT,
      env: { ...process.env, HOLA_DEMO: '1', HOLA_DEMO_FAST: '1', HOLA_TEST_HIDDEN: '1', PORT: String(await freePort()),
        HOLA_DATA_DIR: path.join(dir, 'data'), HOLA_WORKSPACE: path.join(dir, 'workspace'), HOLA_USER_DATA: path.join(dir, 'userdata') },
    });
    page = await app.firstWindow();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.waitForSelector('#buildTag:not([hidden])', { timeout: 30000 });
  });
  after(async () => {
    if (app) await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it('打开应用：窗口标题、版本标识、三位队友在线', async () => {
    assert.equal(await page.title(), 'Hola');
    assert.ok(['开发版', '非官方版'].includes(await $text('#buildTag')) || /^v\d/.test(await $text('#buildTag')));
    await page.waitForFunction(() => /3\/3/.test(document.querySelector('#whoText').textContent), null, { timeout: 15000 });
  });

  it('不点名提问：讨论出结论，接力做出文件，在右侧分屏预览', async () => {
    await ask('新品耳机首发该怎么推广');
    await page.waitForSelector('.row.concl .concl-head', { timeout: 30000 });
    const pv = page.locator('[data-preview]').first();
    await pv.waitFor({ timeout: 30000 });
    await pv.click();
    await page.waitForSelector('#split:not([hidden])');
    assert.equal(await $text('#spName'), '结论要点.csv');
    const frame = page.frameLocator('#spFrame');
    await frame.locator('table').waitFor();
    assert.match(await frame.locator('table').innerText(), /设定成本上限/);
    await page.click('#spClose');
    assert.equal(await page.locator('#split').isHidden(), true);
  });

  it('谈不拢：出现拍板卡片，点方案后按决定分工', async () => {
    await page.click('#newConv');
    await ask('新品耳机首发该怎么推广，有分歧就让我拍板');
    const btn = page.locator('[data-decide][data-key="B"]');
    await btn.waitFor({ timeout: 30000 });
    assert.match(await $text('.decide-h'), /请你拍板/);
    await btn.click();
    await page.waitForSelector('.row .decide-h.done', { timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.row .meta')].some((m) => /交给 Ta/.test(m.textContent)), null, { timeout: 30000 });
  });

  it('布局：宽度按钮、收起侧栏', async () => {
    const w0 = await page.evaluate(() => document.body.dataset.width);
    await page.click('#widthBtn');
    assert.notEqual(await page.evaluate(() => document.body.dataset.width), w0);
    await page.click('#menuBtn');
    assert.equal(await page.locator('#side').isHidden(), true);
    await page.click('#menuBtn');
    assert.equal(await page.locator('#side').isVisible(), true);
  });

  it('切到英文：界面上不应留下没翻译的中文', async () => {
    await page.evaluate(async () => { await api('settings', { uiLang: 'en' }); window.setHolaLang('en'); });
    await page.reload();
    await page.waitForSelector('#buildTag:not([hidden])');
    // 打开几处常用的弹窗，一起检查
    const leftovers = new Set();
    const scan = async (label) => {
      const found = await page.evaluate(() => {
        const out = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const el = n.parentElement;
          if (!el || el.closest('[data-raw],script,style,textarea,select')) continue;
          if (!el.offsetParent && !el.closest('dialog[open]')) continue;
          const t = n.nodeValue.trim();
          if (/[一-鿿]/.test(t)) out.push(t.slice(0, 60));
        }
        return out;
      });
      for (const t of found) leftovers.add(`${label}：${t}`);
    };
    await scan('主界面');
    for (const [label, open] of [['设置', '#openSettings'], ['队友', '#openTeam'], ['个人主页', '#openProfile']]) {
      await page.click(open);
      await page.waitForSelector('dialog[open]');
      await scan(label);
      await page.keyboard.press('Escape');
    }
    // 这两处故意中英并列 / 用中文写语言名，方便找到
    const allowed = /：(界面语言 \/ Language|中文)$/;
    assert.deepEqual([...leftovers].filter((t) => !allowed.test(t)), []);
  });

  it('整个过程没有脚本报错', () => {
    assert.deepEqual(errors, []);
  });
});
