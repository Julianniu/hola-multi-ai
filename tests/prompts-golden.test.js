// 讨论阶段的提示词（独立作答 / 内部讨论 / 团队结论 / 拍板后执行）和回复里的标签，老板定过：一个字都不许改。
// Wick 可以改提示词"怎么送"（系统提示、只送新消息、长会话），但不能改这几段的原文。
// 这里把原文算成指纹锁住：改了就会失败。只有老板明确同意改这些提示词时，才更新下面的指纹。
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'prompts.js'), 'utf8').replace(/\r\n/g, '\n');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('讨论提示词原文不变', () => {
  it('独立作答、内部讨论、团队结论、拍板后执行的说明一字未改', () => {
    const a = src.indexOf("    case 'initial':");
    const b = src.indexOf("    case 'mention':");
    assert.ok(a > 0 && b > a, '找不到阶段说明（phaseGuide）');
    assert.equal(sha(src.slice(a, b)), 'ce47913b4f1affbe64c491afd5fe205a8b8f5e52b56e3a4ebe60986d1d90ef82');
  });

  it('【需要讨论】【立场】【验收】【方案】标签的识别规则一字未改', () => {
    const tags = src.split('\n').filter((l) => /^const TAG_(NEED|STANCE|REVIEW|OPTION) =/.test(l));
    assert.equal(tags.length, 4);
    assert.equal(sha(tags.join('\n')), 'da9931e2ee37583f0f278ff933cf04985f500182a1c301360abe8dab6bb9370e');
  });
});
