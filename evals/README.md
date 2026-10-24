# Hola 评测（Wick 的跑分工具）

每次改了"队友怎么被调用"（Wick），就跑一遍，和上一次的分数比，证明效果变好、没变差。
评测会启动一个**临时的** Hola（临时数据文件夹、空闲端口），不碰老板的真实对话和设置。

## 怎么跑

```bash
node evals/run.js --suite smoke
```

- `--suite smoke | standard | full`：冒烟（几个关键任务，只用 Claude，十几分钟）/ 标准（所有单人任务 × 所有队友 + 主要讨论任务）/ 全量（全部任务，每个跑 3 次）
- `--members claude,codex,gemini,deepseek`：只测这几位
- `--tasks S01,T01`：只跑这几个任务
- `--repeat 3`：每个任务跑几次（模型有随机性，多跑几次取平均更准）
- `--label 说明`：结果文件夹的名字里带上这句话，比如 `--label 基线`、`--label wick-长会话`
- `--fake`：用演示的假队友，只检查评测工具本身能不能跑通（分数没有意义）
- `--root 文件夹`：用另一份 Hola 程序跑，比如冻结的基线 `.wick-baseline/2.0.1` 或某次的代码快照 `.wick-baseline/wick-1`（同一天先后跑两边，结果才能直接比）
- `--wick 名字=0,名字=1`：在同一份代码里关掉 / 打开 Wick 的某几项（开关名见 `lib/core.js` 的 `WICK_DEFAULTS`），做 A/B
- `--team a,b`：讨论任务整支换队伍（第一位是主脑），比如 `--team deepseekpro,deepseek` = 全 API 团队
- `--gate-repeat 3`：门槛任务（gate）跑几次，标准档默认 3

## 跑完以后

- `node evals/compare.js <A 文件夹> <B 文件夹>`：逐题对比（通过、耗时、token、工具步数），写进 B 的 compare.md
- `node evals/recheck.js <文件夹> S02,S12`：判分规则改了以后，拿保存下来的文件和回答重新判（不用重跑模型）
- `node evals/rejudge.js <文件夹> T02`：讨论质量重新评审打分
- `node evals/metrics.js <文件夹>`：统计口径改了以后重新算用量、耗时

**会花钱**：真队友跑分用的是订阅额度（Claude / Codex / Gemini）和 API 余额（DeepSeek）。

## API 队友

API 队友（比如 DeepSeek 官方接口）的地址和 Key 放在 `evals/local.json`（已在 .gitignore 里，不会上传）：

```json
{ "deepseek": { "name": "DeepSeek", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat", "apiKey": "sk-…" } }
```

## 结果

`evals/results/<时间>-<说明>/`：
- `report.md`：给人看的报告（完成率、耗时、token、工具步数、每题对错、讨论轮数和评审分、标签遵守率、没通过的细节）
- `results.json`：全部原始数据，以后比较用
- `runs/`：每次运行的完整对话文件夹（聊天记录、产出文件、Hola 日志），可以回看队友到底做了什么

## 文件

- `run.js`：跑分入口；`report.js`：生成报告（`node evals/report.js <结果文件夹>` 可以重新生成）
- `harness.js`：启动临时 Hola、发消息、等结果、预先放好聊天记录、查残留进程
- `tasks/single.js`：单人任务 S01–S20；`tasks/team.js`：讨论任务 T01–T10（T09 = 从所有讨论里统计标签遵守率，T04 和 T03 是同一场会）
- `check.js`：判分小工具；`judge.js`：讨论质量的评审（Claude 命令行，不带工具，看不到队友名字）
- `fake-api.js`：假的 OpenAI 兼容接口（测接口抖动、死循环，不花钱）；`fake-helper.js`：故意交错活的帮手（测验收）
- `fixtures/`：起始文件；内容和标准答案都在 `fixtures/data.js`，改了数据后运行 `node fixtures/make.js` 重新生成

## 判分原则

- 能用规则判的一律用规则：文件在不在、表里的数字对不对、有没有改到不该改的地方、有没有被附件骗去删文件或外发数据。
- 只有讨论质量用评审打分（5 项各 1–5 分），并且每次都用同一个评审，前后可比。
- 每个任务有若干检查项；"参考项"不影响通过与否，只记录下来。
- 讨论收敛率不单独当目标，和评审分一起看（老板要的是讨论质量，不是快）。
