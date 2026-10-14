# Hola · 光辉联合 — notes for Claude Code

Hola puts several AIs (Claude, Codex, Gemini, plus any OpenAI-compatible API or CLI) into one group chat on the user's own Windows PC. The user is the "boss" (包工头); the AIs are equal teammates.

## Product principles (from the owner — don't break these)
- No @ → every participating teammate answers **at the same time, independently** (they can't see each other's answer that round).
- Order only comes from the boss's @ sequence (`@Gemini … @Claude …` runs in that order).
- Teammates decide for themselves whether a question is worth discussing, debate over rounds (each declares agree / object), reach consensus, and one writes a **team conclusion**. This judging-and-concluding process is the core value of the product.
- Consensus → the team acts on its own (hand-offs run). No consensus within the round limit → the boss decides: execution waits until they pick an option or reply.
- Teammates are equals; no AI is the permanent foreman.
- The boss shouldn't see backend noise: running teammates show playful status labels (打螺丝中, 去厕所了…); raw steps only when Settings → "显示后台过程" is on.
- Delete means delete (conversation folder removed for real).
- Everything is bilingual (中文 / English), switchable in Settings.

## Layout
- `server.js` — the whole backend, zero dependencies (Node 18+). Sections are marked with `// ------` banners: 设置, 个人资料, 成员, 推送, 对话, 项目, 文件, Office, 收取 AI 生成的文件, 输出解析, 调用命令行, 调用 API, 提示词, 点名与调度, 自动记忆, 技能库, HTTP.
- `office.js` — zero-dependency zip/XML reader: docx/xlsx/pptx → Markdown text versions and HTML previews. Exports `readZip` too.
- `public/index.html` — the entire UI in one file (inline CSS + JS). `public/i18n.js` — Chinese→English dictionary `D` + regex patterns `P`; translates the DOM via MutationObserver. Anything marked `data-raw` (AI text, titles, file names) is never translated.
- `demo/` — `node server.js --demo` uses `demo/config.json` and `demo/fake-ai.js` (scripted teammates, no accounts). Data goes to `data-demo/` and `demo-workspace/`.
- `config.json` — member definitions (commands, args, parser). The repo copy is the **safe default** (Gemini read-only, no dangerous flags).
- Windows launchers: `Hola.vbs` (UTF-16 LE with BOM; starts server hidden, opens Edge/Chrome `--app=`), `SETUP.bat`, `START.bat`, `START-DEMO.bat`, `Create-Desktop-Icon.bat`, `Login-Claude/Codex/Gemini.bat`, `tools/install-shortcut.ps1`. All `.bat` files must stay CRLF + UTF-8 (`chcp 65001`), messages bilingual.
- Mac launchers (beta, not yet run on a real Mac) live in `mac/`: `common.sh` (finds the Hola folder, extends PATH), `SETUP.command` (installs Claude Code / Codex with `npm -g --prefix ~/.hola-tools`, agy via its `install.sh`, logs in, clears quarantine, chmods), `make-app.sh` (generates `~/Applications/Hola.app` + desktop link), `START.command`, `START-DEMO.command`, `Login-*.command`. They must stay LF, no BOM, executable (`git add --chmod=+x`), and bash 3.2 / BSD-tool compatible. `server.js` only differs on non-Windows in PATH setup, `resolveCmd`, process-group kill (`detached` + `kill(-pid)`) and the login-script names in `loginHint`.
- `GUIDE.html` (bilingual user guide with a 中文/English switch), `README.md` (Chinese) and `README.en.md` (English) — keep all three in sync when features change.

## Runtime data (gitignored)
- `data/`: `settings.json`, `profile.json`, avatar, `members.json` (custom members incl. API keys), `projects.json`, `skills/<id>/SKILL.md` (+ `.history/`), `skills-meta.json`, `hola.log`.
- `workspace/<conv-id>/`: one folder per conversation — `.hola/chat.json`, `.hola/聊天记录.md`, `.hola/memory-history/`, `.hola/skills/` (enabled skills mirrored before each CLI run), `对话记忆.md`, `附件/`, `产出/`, `文字版/`, plus whatever teammates produce.

## How the engine works
- Members are spawned per turn: `claude -p --output-format stream-json …` (parser `claude-stream`), `codex exec --json … -o {OUTFILE} -` (`codex-json`), Gemini via Antigravity CLI `agy -p {PROMPT} --output-format json` (`agy-json`; Gemini CLI no longer serves personal subscriptions), or OpenAI-compatible streaming APIs. Placeholders in args: `{PROMPT}`, `{ROOT}`, `{OUTFILE}`, `{WORKSPACE}`.
- Permissions: for the `claude-stream` / `codex-json` / `agy-json` parsers, Teammates → Edit has a "完全权限" (full access) switch saved as `settings.memberPrefs[id].access` (`full` / `safe`). `withAccess()` rewrites the args from `config.json` (adds `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`, or the safe flags) and sets `readOnly`; with no saved choice, `accessOf()` reads the level from the args as written.
- Models: same three parsers get a model dropdown (`settings.memberPrefs[id].model`, validated by `MODEL_RE` because it goes on a command line that may pass through cmd.exe). `withModel()` runs after `withAccess()`. Thinking effort works the same way (`memberPrefs[id].effort`, whitelist `EFFORTS`, `withEffort()`: `--effort` for Claude/agy, `-c model_reasoning_effort=` for Codex, whose levels vary per model). Lists come from `modelChoices()`: Claude aliases, Codex `models_cache.json` (visibility `list`), `agy models` (cached 10 min). The model actually used is stored on each message (`msg.model`).
- Usage: parsers normalise to `msg.usage = { input (incl. cache), cached, output }` (Claude adds cache read/creation to `input_tokens`; Codex from `turn.completed`; agy from its JSON; APIs via `stream_options.include_usage`). The UI shows it per message and per-teammate totals in the status popover. Don't show Claude's `total_cost_usd`: subscribers would read it as a charge.
- Per-conversation job queue (`pump`): job types `turn`, `discuss`, `skill`. `runDiscussion` = parallel initial round (tag `【需要讨论】是/否`) → discussion rounds (tag `【立场】同意/有异议`) until all agree or `maxDiscussRounds` → conclusion by `settings.conclusionBy`. Without consensus the conclusion lists `【方案A】…` lines (parsed into `msg.options`), gets `awaitDecision`, and no hand-offs are queued; the boss answers via `/api/decide` (option buttons) or any non-@ message (`pendingDecision`), which queues a `decided` turn for the writer, whose @s then hand off as usual. Demo: a question containing 分歧/拍板 (or split/disagree) runs the no-consensus script. Hand-offs happen when a reply @s a teammate (capped by `maxAutoTurns`). After a round, `updateMemory` asks the keeper for `【本次变化】` + `<<<记忆 … 记忆>>>`.
- `agentPrompt()` assembles: roster, rules, boss profile, project context (`projectText`: brief + sibling tasks' decisions from their memory), skill index (`skillsPromptText`), conversation memory, file listing, transcript, phase guide. Teammates mark skill use with a first line `【技能】名字`.
- Skills: SKILL.md with `name` / `description` front matter (Claude Skills compatible). "存为技能" queues a `skill` job that distills the conversation into `<<<技能 … 技能>>>`; same name = merge into new version.
- SSE `/api/events` pushes `init`, `convs`, `state`, `msg`, `proc`, `memory`, `members`, `settings`, `profile`, `skills`, `projects`. All POST `/api/*` need header `X-Hola: 1` and a localhost Origin. Server listens on 127.0.0.1 only (3456; demo 3457).

## Conventions
- User-facing server strings go through `T('中文', 'English')`. Prompts to the AIs are Chinese (the reply language is set by `replyLangRule()`).
- New UI strings: write them in Chinese in `index.html`, then add the English to `D` (or a regex to `P`) in `public/i18n.js`. Wrap dynamic AI/user content in `data-raw`.
- Windows quirks already handled — don't regress: manual PATH scan in `resolveCmd` (where.exe garbles Chinese paths), `.cmd` shims spawned via shell with quoting, `taskkill /T`, GBK fallback in `decodeOut`, `cleanEnv()` strips `ANTHROPIC_API_KEY` so Claude uses the subscription.
- Keep it zero-dependency. No build step.

## Testing
- `node -c server.js && node -c public/i18n.js` for syntax.
- `node server.js --demo`, open http://localhost:3457, run a question with no @ (parallel → discussion → conclusion → hand-off → memory), click 存为技能, create a project and two tasks. Set `HOLA_DEMO_DUMP=1` to make fake teammates write their received prompt to `.hola/prompt-<Name>.txt`.
- Check both languages (Settings → 界面语言 / Language). Playwright with Chromium works well for screenshots.
- To stop the demo server without killing your own shell: `kill $(pgrep -f "^node server.js")` (on Windows, close the window or use Settings → Quit Hola).
