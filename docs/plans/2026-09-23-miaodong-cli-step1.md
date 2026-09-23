# 秒懂 CLI（md）第 1 步 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出一个装在 skill 里的单文件命令 `md`，让 Claude Code / Codex 能按区取身份、按名字找智能体和版本、拉画布、用改动脚本批量改、自检、安全推送到草稿、回滚和查账。

**Architecture:** 源码在 `miaodong-kit/src/`（纯 ESM `.mjs`），直接 import 老懂不依赖数据库的纯函数（`apps/api/lib/miaodong/*`、`apps/api/lib/chat-agent/validate-workflow.ts`、`packages/shared/src/workflow-risk`、`packages/shared/src/miaodong-regions.ts`）。esbuild 打成 `miaodong-kit/dist/md.mjs`（Node 18 可跑），`md:install` 复制进 `~/.claude/skills/miaodong/`，并软链到 `~/.codex/skills/miaodong` 和 `~/.local/bin/md`。全部本地状态放在 `$MD_HOME`（默认 `~/.miaodong/md`）。

**Tech Stack:** Node 22（开发 / 测试，仓库 `.nvmrc`）、Node 18.20+（产物运行）、esbuild 0.27.7、node:test + node:assert/strict、全局 fetch。

**Spec:** `docs/superpowers/specs/2026-09-23-miaodong-cli-design.md`

**计划自检（2026-09-23）：** 已把本计划的全部代码按任务顺序拼进一个临时副本（软链仓库的 apps / packages / scripts / node_modules）并实际运行。
- Node 22 下 86 个测试全部通过。
- 产物测试与安装测试在 Node 18.20.8 上也全部通过，包括「取身份 → 拉 → 改 → 推 → log」全流程。
- 改过的 `lib/credentials.mjs` 仍能通过 `check:miaodong-kit`。
- 自检中发现并已修正一个 bug：`md pull --version v1.0.400` 里的 `--version` 曾被入口当成「打印 md 版本」。

## Global Constraints

- 产物 `miaodong-kit/dist/md.mjs` 必须在 Node 18.20.8 上不加任何 flag 直接跑，且 stderr 不出现 `ExperimentalWarning`；开发与测试用 Node 22（`nvm use 22`）。
- 不得 import 任何会带起 `@juzi/db` / drizzle / server-env 的模块：`canvas-sync.ts`、`canvas-baseline.ts`、`apps/api/lib/miaodong/client.ts`、`badcase-query.ts`、`resources.ts`、`trial-service.ts`、`accounts.ts`、`bindings.ts`、`crypto.ts`、`knowledge-capabilities.ts`、`sql-capabilities.ts`。
- 不修改 `apps/`、`packages/` 下的任何源码，只 import。
- 身份只从浏览器控制台取（剪贴板或 `--stdin`），不存密码；token 不得出现在 stdout、stderr、报错信息里；`identities.json` 权限 0600，`$MD_HOME` 下目录 0700。
- 本地数据只写 `$MD_HOME`，不写仓库、不写 cwd。
- 写秒懂只调 `POST /api/canvas/save`；不调 event/import、session-memory/import、publish、enable、promote 等任何接口。
- 所有写操作默认预演，只有 `--confirm <计划码>` 才写，计划码必须等于当前预演算出的值。
- HTTP：检查业务 `code`（存在且非 0 即错）、`redirect: 'error'`、orgId 放 query、超时默认 60 秒（保存 120 秒）。
- 退出码：0 成功；1 一般错误 / 自检有问题；2 用法错误；3 需要（重新）取身份；4 智能体 / 版本 / 节点找不到或有歧义；5 推送被拦。
- 用户可见文案用中文；标识符用英文；注释只写「为什么」。
- 提交时显式 `git add <文件>`，禁止 `git add -A` / `git add .`。
- 单个测试文件的运行命令（在仓库根目录、Node 22 下）：`node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test <文件>`；全部：`npm run check:md`。

## Review Focus

1. 编辑页自动保存，导致预演之后、确认之前草稿又变了。这时 `--confirm` 必须因计划码不符被拦下，不能把预演时没见过的内容写上去。测试在 Task 14 的「计划码不符」用例。
2. 同名智能体出现在不同区或不同企业（克隆出来的测试机器人很常见）。这时必须列出候选并停下，不能挑第一个。测试在 Task 5 的「歧义」用例。
3. 剪贴板里不是身份串：用户忘了执行 JS，或者复制的是那行代码本身。这时要报清楚、退出码 3，而且不回显剪贴板内容。测试在 Task 4 的「decode」用例。
4. 改动脚本的路径穿过数组（`inputs[0].referenceNodeId`）。数组必须仍是数组，路径不存在要报错；绝不能出现老懂 `setByPath` 把数组改成 `{}` 那种问题。测试在 Task 10 的「路径」用例。
5. 输出经管道给 AI 读，而读端很慢时，大输出不能在 64KB 处被截断。测试在 Task 1 的「finish」用例。

## 文件结构

```
miaodong-kit/
  build.mjs                 esbuild 打包（导出 buildBundle）
  install.mjs               构建 + 安装到 skill / codex / ~/.local/bin
  skill/SKILL.md            安装进 ~/.claude/skills/miaodong/ 的说明书
  skill/references/*.md     改动脚本 helper、推送细节
  src/
    cli.mjs                 入口：参数 → 命令 → 错误与退出码
    args.mjs                parseArgs / strArg / intArg（从 lib/credentials.mjs 搬来，旧文件改为 re-export）
    errors.mjs              MdError、EXIT、usage()
    output.mjs              out / note / finish / formatTime / targetLine / shortId
    home.mjs                $MD_HOME、ensureDir、readJson、writeJson（原子写、0600）
    http.mjs                request()：Bearer、code 检查、401/403、禁止重定向
    identity.mjs            控制台代码、身份串解码、身份存储、剪贴板
    api.mjs                 秒懂接口封装（bot/list、canvas/get、save、list-version、basic-info、session-memory/list、event/list）
    target.mjs              智能体目录缓存、名字/id 匹配、resolveBot、resolveVersion
    canvas.mjs              stableStringify、hashOf、contentKey、edgeKey、compareNodes、LAYOUT_KEYS
    graph.mjs               节点/连线/事件边/引用索引、resolveNode、traceLines、refsTo
    workspace.mjs           工作副本的创建、读取、after、改动脚本记录、索引
    transform.mjs           改动脚本 helper（h.*）与 runTransform
    diff.mjs                结构化 diff、逐行 diff、渲染
    check.mjs               自检：类型突变、悬空、范围校验、新增风险
    merge.mjs               元素级三方合并
    ledger.mjs              推送 / 回滚账本
    commands/index.mjs      命令注册表
    commands/*.mjs          auth / orgs / bots / versions / pull / inspect(node,trace,refs) / apply / diff / check / push / rebase / restore / status(status,log)
  test/
    helpers/run-cli.mjs     起子进程跑 md（开发模式或产物）
    helpers/fake-miaodong.mjs  假秒懂 HTTP 服务
    helpers/seed.mjs        预置身份 / 工作副本 / 身份串
    helpers/fixtures.mjs    画布夹具
    *.test.mjs
```

旧的 `miaodong-kit/bin/*`、`lib/*` 和 `npm run md:*` 在第 1 步保持可用：`md:badcase` 要到第 2 步才有替代。

---

### Task 0：准备工作区

**Files:**
- 无代码改动；把 spec 和本计划带进新分支

- [ ] **Step 1：建 worktree**

用 superpowers:using-git-worktrees 从**当前分支 `feat/badcase-historical-canvas` 的 HEAD**（不是 main）建新分支 `feat/miaodong-cli`。原因：`packages/shared/src/workflow-risk/` 和新版 `badcase-normalize.ts` 只在这个分支上，main 没有。

- [ ] **Step 2：带上 spec 与计划**

两个文件在主工作区里还没有被跟踪，worktree 里看不到，需要复制过去：

```bash
cp /Users/hukui/Desktop/workspace/Agentflow/docs/superpowers/specs/2026-09-23-miaodong-cli-design.md docs/superpowers/specs/
cp /Users/hukui/Desktop/workspace/Agentflow/docs/superpowers/plans/2026-09-23-miaodong-cli-step1.md docs/superpowers/plans/
```

- [ ] **Step 3：装依赖、跑基线**

```bash
source ~/.nvm/nvm.sh && nvm use 22
npm install
npm run check:miaodong-kit
```
Expected：`✅ miaodong-kit: 全部通过`

- [ ] **Step 4：提交**

```bash
git add docs/superpowers/specs/2026-09-23-miaodong-cli-design.md docs/superpowers/plans/2026-09-23-miaodong-cli-step1.md
git commit -m "docs(md): 秒懂 CLI 第 1 步设计与实施计划"
```

---

### Task 1：骨架（参数解析搬家、错误 / 输出 / 目录、命令分发、测试脚手架）

**Files:**
- Create: `miaodong-kit/src/args.mjs`、`src/errors.mjs`、`src/output.mjs`、`src/home.mjs`、`src/cli.mjs`、`src/commands/index.mjs`
- Modify: `miaodong-kit/lib/credentials.mjs`（删掉 parse 系列函数，改为 re-export）
- Create: `miaodong-kit/test/helpers/run-cli.mjs`、`miaodong-kit/test/cli.test.mjs`
- Modify: `package.json`（加 `check:md`）

**Interfaces:**
- Produces:
  - `EXIT = { OK:0, ERROR:1, USAGE:2, AUTH:3, TARGET:4, BLOCKED:5 }`
  - `class MdError(code, message, { exitCode = EXIT.ERROR, hint = '' })`
  - `usage(message, hint?) → MdError`（退出码 2）
  - `parseArgs(argv) → { _: string[], [k]: string | boolean }`
  - `strArg(args, key) → string | undefined`
  - `intArg(args, key, fallback, max?) → number`
  - `out(text)` / `note(text)`：分别写 stdout / stderr
  - `finish(code): Promise<never>`
  - `formatTime(value) → 'YYYY-MM-DD HH:mm'`
  - `targetLine({ regionLabel, orgName, botName, botId, versionLabel? }) → string`
  - `shortId(id) → string`
  - `mdHome() → string`
  - `ensureDir(dir) → dir`
  - `readJson(file, fallback?, { secret }?)`
  - `writeJson(file, value, { secret }?)`
  - `COMMANDS: Record<string, { summary, usage, run(args) → Promise<number> }>`
  - 测试 helper：`runCli(args, { home, env?, input?, bundle? }) → Promise<{ code, stdout, stderr }>`、`tempHome()`、`REPO`、`LOADER_URL`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/helpers/run-cli.mjs`：

```js
// 起子进程跑 md。默认跑源码（Node 22 + strip-types），传 bundle 时跑打包产物，
// 并可用 MD_E2E_NODE 指定别的 node（用来验证 Node 18）。
// HOME 与 MD_HOME 都指向临时目录，保证测试碰不到真实身份与工作副本。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const LOADER_URL = pathToFileURL(join(REPO, 'scripts', 'ts-resolve-loader.mjs')).href;
const CLI = join(REPO, 'miaodong-kit', 'src', 'cli.mjs');

export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'md-test-'));
}

export function runCli(args, { home, env = {}, input, bundle } = {}) {
  const nodeBin = bundle ? process.env.MD_E2E_NODE || process.execPath : process.execPath;
  const argv = bundle
    ? [bundle, ...args]
    : ['--no-warnings', '--experimental-strip-types', '--loader', LOADER_URL, CLI, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, argv, {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? '', HOME: home, MD_HOME: join(home, 'md'), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`md ${args.join(' ')} 超时`)); }, 20000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}
```

`miaodong-kit/test/cli.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOADER_URL, REPO, runCli, tempHome } from './helpers/run-cli.mjs';

test('md help 列出用法并退出 0', async () => {
  const r = await runCli(['help'], { home: tempHome() });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /用法：md <命令>/);
  assert.match(r.stdout, /退出码：0 成功/);
});

test('md --version 在开发模式打印 md dev', async () => {
  const r = await runCli(['--version'], { home: tempHome() });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'md dev');
});

test('未知命令退出码 2', async () => {
  const r = await runCli(['nope'], { home: tempHome() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知命令：nope/);
});

test('finish() 在读端很慢的管道上也不截断大输出', async () => {
  const outputUrl = pathToFileURL(join(REPO, 'miaodong-kit/src/output.mjs')).href;
  const script = `import { out, finish } from ${JSON.stringify(outputUrl)};
for (let i = 0; i < 2000; i++) out('x'.repeat(99));
await finish(0);`;
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', '--loader', LOADER_URL, '--input-type=module', '-e', script], { cwd: REPO });
  child.stdout.pause();
  await new Promise((resolve) => setTimeout(resolve, 500));
  let size = 0;
  child.stdout.on('data', (chunk) => { size += chunk.length; });
  child.stdout.resume();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(size, 2000 * 100);
});

test('lib/credentials.mjs 与 src/args.mjs 共用同一份 parseArgs', async () => {
  const a = await import('../src/args.mjs');
  const b = await import('../lib/credentials.mjs');
  assert.equal(a.parseArgs, b.parseArgs);
  assert.equal(a.strArg, b.strArg);
  assert.equal(a.parseArgs(['--confirm', 'false']).confirm, false);
});
```

`package.json` 的 scripts 里，紧跟 `check:miaodong-kit-e2e` 后面加一行：

```json
"check:md": "node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/*.test.mjs",
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/cli.test.mjs`
Expected：FAIL（`src/cli.mjs`、`src/output.mjs`、`src/args.mjs` 都不存在）

- [ ] **Step 3：写实现**

`miaodong-kit/src/errors.mjs`：

```js
// md 的错误都带退出码：AI 按退出码决定下一步（3 = 让用户重新取身份，4 = 目标有歧义，5 = 推送被拦）。
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, TARGET: 4, BLOCKED: 5 });

export class MdError extends Error {
  constructor(code, message, { exitCode = EXIT.ERROR, hint = '' } = {}) {
    super(message);
    this.name = 'MdError';
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function usage(message, hint = '') {
  return new MdError('usage', message, { exitCode: EXIT.USAGE, hint });
}
```

`miaodong-kit/src/args.mjs`：把 `miaodong-kit/lib/credentials.mjs` 里 `FALSY_WORDS`、`parseArgs`、`strArg`、`intArg` 连同注释原样搬过来，只改两处：`strArg` / `intArg` 里的 `throw new Error(...)` 改为 `throw usage(...)`，报错文案不变。

```js
// 参数解析（从 lib/credentials.mjs 搬来，旧文件 re-export，两边共用一份）。

import { usage } from './errors.mjs';

/** 被当成布尔 false 的字面值。写 `--confirm false` 的人显然不想确认。 */
const FALSY_WORDS = new Set(['false', '0', 'no', 'off', 'n']);

/**
 * 解析命令行参数。支持：
 *   --key value     → { key: 'value' }
 *   --key=value     → { key: 'value' }
 *   --key           → { key: true }        （后面没值，或紧跟另一个 --flag）
 *   --key false     → { key: false }       （false/0/no/off/n 一律解析成布尔 false）
 *   --no-key        → { key: false }
 *
 * ⚠️ 为什么要认 `--key false`：这里的开关有 `--confirm` 这种「真的会写线上」的。
 * 早期版本把值一律当字符串，于是 `--confirm false` 得到字符串 "false"（truthy），
 * `if (!args.confirm)` 判断失效 —— 实测会直接推送覆盖线上画布。布尔语义必须在解析层就定死。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    if (a.startsWith('--no-') && a.length > 5) {
      out[a.slice(5)] = false;
      continue;
    }
    let key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) {
      const v = key.slice(eq + 1);
      key = key.slice(0, eq);
      out[key] = FALSY_WORDS.has(v.toLowerCase()) ? false : v;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = FALSY_WORDS.has(next.toLowerCase()) ? false : next;
      i++;
    }
  }
  return out;
}

/**
 * 取字符串参数。挡住 `--bot --all` 这种漏值写法（会解析成布尔 true，
 * 直接拿去当 botId 会拼出 /api/canvas/get?botId=true 这样的荒唐请求）。
 */
export function strArg(args, key) {
  const v = args[key];
  if (v === undefined || v === false) return undefined;
  if (typeof v !== 'string' || !v.trim()) {
    throw usage(`--${key} 需要一个值，比如 --${key} <值>`);
  }
  return v.trim();
}

/**
 * 取正整数参数。挡住 `--limit --all`（Number(true)===1 会让用户以为在看全部，实际只拿到 1 条）。
 */
export function intArg(args, key, fallback, max) {
  const v = args[key];
  if (v === undefined || v === false) return fallback;
  if (typeof v === 'boolean' || !Number.isInteger(Number(v)) || Number(v) <= 0) {
    throw usage(`--${key} 需要一个正整数，收到 "${v === true ? '(空)' : v}"`);
  }
  const n = Number(v);
  return max ? Math.min(n, max) : n;
}
```

修改 `miaodong-kit/lib/credentials.mjs`：删掉从 `/** 被当成布尔 false 的字面值。` 开始、到 `intArg` 函数结束为止的整段，也就是 `FALSY_WORDS`、`parseArgs`、`strArg`、`intArg` 以及它们的注释。然后在文件 import 区的最后加上：

```js
// 参数解析搬到了 src/args.mjs，md 与旧 bin 共用一份；resolveTarget 仍要用 strArg
import { strArg } from '../src/args.mjs';
export { parseArgs, strArg, intArg } from '../src/args.mjs';
```

`miaodong-kit/src/output.mjs`：

```js
// 输出约定：stdout 只放给 AI / 用户读的结果，stderr 放过程提示与报错。
// 退出前必须等两个流都写完：输出经管道给 AI 读时，裸 process.exit 会在 64KB 处静默截断。
// kit 旧的 flushExit 只看 write('') 的返回值，Node 22 上照样截断（已实测），这里改等回调。

import { shortId } from '../lib/summarize.mjs';

export { shortId };

export function out(text = '') {
  process.stdout.write(`${text}\n`);
}

export function note(text = '') {
  process.stderr.write(`${text}\n`);
}

function drain(stream) {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

export async function finish(code) {
  await drain(process.stdout);
  await drain(process.stderr);
  process.exit(code);
}

export function formatTime(value) {
  if (value === null || value === undefined || value === '') return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 每条命令输出的第一行：区 / 企业 / 智能体 (id8) / 版本。推错智能体的事故都始于看错这一行。 */
export function targetLine(target) {
  const parts = [target.regionLabel, target.orgName, `${target.botName} (${shortId(target.botId)})`];
  if (target.versionLabel) parts.push(target.versionLabel);
  return parts.join(' / ');
}
```

`miaodong-kit/src/home.mjs`：

```js
// md 的全部本地状态都在 $MD_HOME（默认 ~/.miaodong/md）：身份、缓存、工作副本、账本。
// 不写仓库、不写 cwd：画布和执行记录含真实用户数据，写进仓库迟早被 commit。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MdError } from './errors.mjs';

export function mdHome() {
  return process.env.MD_HOME ? resolve(process.env.MD_HOME) : join(homedir(), '.miaodong', 'md');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJson(file, fallback, { secret = false } = {}) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    // 身份文件损坏时不能带出 e.message：Node 22 的 JSON 报错会附带原文片段，可能含 token
    if (secret) throw new MdError('corrupt_file', `本地身份文件损坏：${file}`, { hint: '删掉它后重新取身份' });
    throw new MdError('corrupt_file', `JSON 文件损坏：${file}（${error.message}）`);
  }
}

export function writeJson(file, value, { secret = false } = {}) {
  ensureDir(dirname(file));
  // 先写临时文件再改名：写到一半被打断也不会留下半个 JSON
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
  renameSync(tmp, file);
  if (secret) chmodSync(file, 0o600);
}
```

`miaodong-kit/src/commands/index.mjs`：

```js
// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
export const COMMANDS = {};
```

`miaodong-kit/src/cli.mjs`：

```js
// md 的入口：解析参数 → 分发到命令 → 统一处理错误与退出码。
// 构建时 esbuild 把 __MD_BUILD__ 替换成「提交号@日期」；开发模式下它不存在，显示 dev。

import { parseArgs } from './args.mjs';
import { EXIT, MdError } from './errors.mjs';
import { finish, note, out } from './output.mjs';
import { COMMANDS } from './commands/index.mjs';

// eslint-disable-next-line no-undef
const BUILD = typeof __MD_BUILD__ === 'string' ? __MD_BUILD__ : 'dev';

function renderHelp() {
  const lines = ['用法：md <命令> [参数]    （md <命令> --help 看该命令的详细用法）', '', '命令：'];
  for (const [name, command] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(9)} ${command.summary}`);
  lines.push('', '退出码：0 成功 · 1 错误或自检有问题 · 2 用法错误 · 3 需要取身份 · 4 目标找不到或有歧义 · 5 推送被拦');
  return lines.join('\n');
}

export async function main(argv) {
  const args = parseArgs(argv);
  const [name, ...rest] = args._;
  // 只有不带子命令时 --version 才是「看 md 版本」：md pull --version v1.0.400 里它是秒懂版本号
  if (name === 'version' || (!name && args.version)) {
    out(`md ${BUILD}`);
    return EXIT.OK;
  }
  if (!name || name === 'help') {
    out(renderHelp());
    return EXIT.OK;
  }
  const command = COMMANDS[name];
  if (!command) {
    note(`未知命令：${name}`);
    note('运行 md help 查看全部命令');
    return EXIT.USAGE;
  }
  if (args.help) {
    out(command.usage);
    return EXIT.OK;
  }
  args._ = rest;
  return (await command.run(args)) ?? EXIT.OK;
}

async function entry() {
  let code;
  try {
    code = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof MdError) {
      note(`❌ ${error.message}`);
      if (error.hint) note(`   → ${error.hint}`);
      code = error.exitCode;
    } else {
      note(`❌ ${error?.message ?? String(error)}`);
      note(process.env.MD_DEBUG ? String(error?.stack ?? '') : '   （加 MD_DEBUG=1 看完整堆栈）');
      code = EXIT.ERROR;
    }
  }
  await finish(code);
}

await entry();
```

- [ ] **Step 4：运行，确认通过，老回归不受影响**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/cli.test.mjs`
Expected：5 个测试全部 PASS

Run: `npm run check:miaodong-kit && npm run check:miaodong-kit-e2e`
Expected：两个都是 `全部通过`

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src miaodong-kit/test miaodong-kit/lib/credentials.mjs package.json
git commit -m "feat(md): CLI 骨架——参数解析共用、错误与退出码、不截断的输出、测试脚手架"
```

---

### Task 2：单文件构建（Node 18 可跑）

**Files:**
- Create: `miaodong-kit/build.mjs`、`miaodong-kit/test/bundle.test.mjs`
- Modify: `package.json`（`devDependencies` 加 esbuild，scripts 加 `md:build`）

**Interfaces:**
- Consumes：`src/cli.mjs`
- Produces：
  - `buildBundle({ outfile? }) → Promise<{ outfile, tag }>`
  - `BUNDLE_PATH = miaodong-kit/dist/md.mjs`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/bundle.test.mjs`：

```js
// 用打包产物跑。MD_E2E_NODE 指向 Node 18 时，验证的就是用户机器上默认的运行环境。
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBundle } from '../build.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';

let bundle;
before(async () => {
  ({ outfile: bundle } = await buildBundle({ outfile: join(tempHome(), 'md.mjs') }));
});

test('产物能跑 --version，带构建号，不打实验特性警告', async () => {
  const r = await runCli(['--version'], { home: tempHome(), bundle });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.trim(), /^md [0-9a-z]+@\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});

test('产物里没有老懂数据库依赖', () => {
  const text = readFileSync(bundle, 'utf-8');
  assert.doesNotMatch(text, /better-sqlite3|drizzle-orm/);
  assert.ok(text.startsWith('#!/usr/bin/env -S node --no-warnings'));
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/bundle.test.mjs`
Expected：FAIL（找不到 `../build.mjs`）

- [ ] **Step 3：写实现**

先把 esbuild 固定成直接依赖（现在只是 tsx 带进来的，随时可能换版本）：

```bash
npm install --save-dev --save-exact esbuild@0.27.7
```

`package.json` 的 scripts 里加：

```json
"md:build": "node ./miaodong-kit/build.mjs",
```

`miaodong-kit/build.mjs`：

```js
// 把 md 打成一个 Node 18 可直接运行的单文件。
// 为什么打包：kit 以前靠 --experimental-strip-types 直接跑 TS，默认 Node 18 下直接报错，
// 会话里 AI 给命令加 Node 22 前缀加了 324 次。打包后没有运行时 flag，也没有 TS。
//
// banner 做三件事：
// 1. shebang 带 --no-warnings：Node 18 的 fetch 会打 ExperimentalWarning，混进 stderr 干扰 AI；
// 2. 同时拦截 process.emitWarning 里的 ExperimentalWarning，覆盖 `node md.mjs` 直接跑的情况；
// 3. Node 18 以文件方式跑 ESM 时没有全局 crypto，而共享代码里有裸 crypto.randomUUID()。

import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
export const BUNDLE_PATH = join(KIT, 'dist', 'md.mjs');

const BANNER = [
  '#!/usr/bin/env -S node --no-warnings',
  "import { webcrypto as __mdWebcrypto } from 'node:crypto';",
  'if (!globalThis.crypto) globalThis.crypto = __mdWebcrypto;',
  'const __mdEmitWarning = process.emitWarning;',
  "process.emitWarning = function (warning, ...rest) { const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type; if (type === 'ExperimentalWarning') return; return __mdEmitWarning.call(process, warning, ...rest); };",
].join('\n');

function buildTag() {
  let sha = 'nogit';
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: KIT, encoding: 'utf-8' }).trim();
  } catch {
    // 不在 git 里构建时照样能出产物
  }
  return `${sha}@${new Date().toISOString().slice(0, 10)}`;
}

export async function buildBundle({ outfile = BUNDLE_PATH } = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  const tag = buildTag();
  await build({
    entryPoints: [join(KIT, 'src', 'cli.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    banner: { js: BANNER },
    define: { __MD_BUILD__: JSON.stringify(tag) },
    logLevel: 'warning',
    legalComments: 'none',
  });
  chmodSync(outfile, 0o755);
  return { outfile, tag };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outfile, tag } = await buildBundle();
  console.log(`已构建 ${outfile}（${tag}）`);
}
```

- [ ] **Step 4：运行，确认通过（Node 22 与 Node 18 各跑一次）**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/bundle.test.mjs`
Expected：PASS

Run: `MD_E2E_NODE="$HOME/.nvm/versions/node/v18.20.8/bin/node" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/bundle.test.mjs`
Expected：PASS（子进程跑在 Node 18 上）

Run: `npm run md:build && ls -la miaodong-kit/dist/md.mjs`
Expected：打印 `已构建 …/miaodong-kit/dist/md.mjs`，文件可执行（`dist/` 已被 `.gitignore` 忽略，不进 git）

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/build.mjs miaodong-kit/test/bundle.test.mjs package.json package-lock.json
git commit -m "feat(md): esbuild 单文件构建，Node 18 直接可跑且无实验特性警告"
```

---

### Task 3：HTTP 客户端

**Files:**
- Create: `miaodong-kit/src/http.mjs`、`miaodong-kit/test/helpers/fake-miaodong.mjs`、`miaodong-kit/test/http.test.mjs`

**Interfaces:**
- Consumes：`MdError`、`EXIT`
- Produces：
  - `request(identity: { label, origin, token }, path, { method='GET', query?, body?, timeoutMs=60000 }) → Promise<payload>`，返回秒懂的完整外壳 `{ code, data, page? }`
  - 错误 code 取值：`network` / `auth_expired`（退出码 3）/ `org_expired` / `upstream` / `business`
  - 测试 helper：`startFakeMiaodong(routes) → { origin, requests, routes, close() }`，其中 `routes` 的 key 是 `'GET /api/x'`，handler 签名为 `(record) => { status?, headers?, body }`；另有 `ok(data, extra?)`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/helpers/fake-miaodong.mjs`：

```js
// 假秒懂：按「方法 路径」路由，记录每个请求供断言。routes 可在测试中途替换，用来模拟状态变化。
import { createServer } from 'node:http';

export function ok(data, extra = {}) {
  return { status: 200, body: { code: 0, data, ...extra } };
}

export async function startFakeMiaodong(routes = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const record = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : null,
        auth: req.headers.authorization ?? null,
      };
      requests.push(record);
      const handler = routes[`${req.method} ${url.pathname}`];
      const reply = handler
        ? await handler(record)
        : { status: 404, body: { message: `Cannot ${req.method} ${url.pathname}`, error: 'Not Found', statusCode: 404 } };
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, routes, close: () => new Promise((resolve) => server.close(resolve)) };
}
```

`miaodong-kit/test/http.test.mjs`：

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/http.mjs';
import { MdError } from '../src/errors.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';

let server;
let identity;
before(async () => {
  server = await startFakeMiaodong();
  identity = { key: 'test', label: '测试区', origin: server.origin, token: 'tok-SECRET-123' };
});
after(() => server.close());

test('成功时返回完整外壳，带 Bearer，undefined 参数不上送', async () => {
  server.routes['GET /api/bot/list'] = () => ok([{ id: 'b1' }], { page: { total: 1 } });
  const payload = await request(identity, '/api/bot/list', { query: { orgId: 'o1', skip: undefined } });
  assert.deepEqual(payload.data, [{ id: 'b1' }]);
  const req = server.requests.at(-1);
  assert.equal(req.auth, 'Bearer tok-SECRET-123');
  assert.deepEqual(req.query, { orgId: 'o1' });
});

test('HTTP 201 + code 非 0 视为业务错误', async () => {
  server.routes['POST /api/canvas/save'] = () => ({ status: 201, body: { code: -1, message: 'invalid' } });
  await assert.rejects(
    request(identity, '/api/canvas/save', { method: 'POST', body: {} }),
    (e) => e instanceof MdError && e.code === 'business' && /code=-1/.test(e.message),
  );
});

test('401 → 身份失效，退出码 3，提示重新取身份，且不含 token', async () => {
  server.routes['GET /api/x'] = () => ({ status: 401, body: { statusCode: 401, message: 'Authentication failed' } });
  await assert.rejects(request(identity, '/api/x'), (e) =>
    e.code === 'auth_expired' && e.exitCode === 3 && e.hint.includes(server.origin) && !`${e.message}${e.hint}`.includes('SECRET'));
});

test('403：企业到期与身份失效分开', async () => {
  server.routes['GET /api/y'] = () => ({ status: 403, body: { code: -7, message: 'org expired' } });
  await assert.rejects(request(identity, '/api/y'), (e) => e.code === 'org_expired');
  server.routes['GET /api/z'] = () => ({ status: 403, body: { message: 'forbidden' } });
  await assert.rejects(request(identity, '/api/z'), (e) => e.code === 'auth_expired');
});

test('非 2xx 带出秒懂的 message（数组也能拼）', async () => {
  server.routes['POST /api/v'] = () => ({ status: 400, body: { statusCode: 400, message: ['a must be string', 'b must be uuid'] } });
  await assert.rejects(request(identity, '/api/v', { method: 'POST', body: {} }), (e) =>
    e.code === 'upstream' && /a must be string；b must be uuid/.test(e.message));
});

test('不跟随重定向（防止把 token 带到别的域名）', async () => {
  server.routes['GET /api/r'] = () => ({ status: 302, headers: { Location: 'http://127.0.0.1:1/steal' }, body: '' });
  await assert.rejects(request(identity, '/api/r'), (e) => e.code === 'network');
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/http.test.mjs`
Expected：FAIL（找不到 `../src/http.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/http.mjs`：

```js
// 秒懂内部 API 的唯一出口。与 kit / 老懂两份旧客户端的差别，每条都有来由：
// - 检查业务 code：登录失败是 HTTP 201 + code:-1，只看状态码会把失败当成功；
// - redirect: 'error'：F 区旧域名 301 会把 POST 降成 GET，而且跟随重定向会把 token 带去别处；
// - 401 / 403 不自动重登：md 没有密码，身份失效只能让用户在浏览器里重新取；
// - 报错里绝不带 token。

import { EXIT, MdError } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;

function buildUrl(origin, path, query) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

function messageOf(payload) {
  const m = payload?.message;
  if (Array.isArray(m)) return m.join('；');
  return typeof m === 'string' ? m : '';
}

function isOrgExpired(payload) {
  return payload?.code === -7 || payload?.reason === 'EXPIRED' || payload?.errorCode === 'ORG_EXPIRED';
}

export async function request(identity, path, { method = 'GET', query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = buildUrl(identity.origin, path, query);
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? `超时（${Math.round(timeoutMs / 1000)} 秒）`
      : error?.cause?.message ?? error?.message ?? String(error);
    throw new MdError('network', `连不上 ${identity.label}（${url.host}）：${method} ${path} ${reason}`);
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (res.status === 401 || (res.status === 403 && !isOrgExpired(payload))) {
    throw new MdError('auth_expired', `${identity.label} 的身份已失效（HTTP ${res.status}）`, {
      exitCode: EXIT.AUTH,
      hint: `请用户在浏览器里重新取身份：md auth snippet ${identity.origin}`,
    });
  }
  if (res.status === 403) throw new MdError('org_expired', `${identity.label} 的企业已到期（HTTP 403）`);
  if (!res.ok) {
    throw new MdError('upstream', `秒懂接口报错 ${method} ${path} → HTTP ${res.status}：${messageOf(payload) || text.slice(0, 200)}`);
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'code' in payload && Number(payload.code) !== 0) {
    throw new MdError('business', `秒懂业务错误 ${method} ${path}：code=${payload.code} ${messageOf(payload)}`.trim());
  }
  return payload;
}
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/http.test.mjs`
Expected：6 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/http.mjs miaodong-kit/test/http.test.mjs miaodong-kit/test/helpers/fake-miaodong.mjs
git commit -m "feat(md): HTTP 客户端——检查业务 code、身份失效退出码 3、禁止重定向、报错不带 token"
```

---

### Task 4：身份（控制台取、剪贴板导入、按区存）

**Files:**
- Create: `miaodong-kit/src/identity.mjs`、`miaodong-kit/src/commands/auth.mjs`、`miaodong-kit/test/helpers/seed.mjs`、`miaodong-kit/test/identity.test.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`

**Interfaces:**
- Consumes：`request`、`mdHome`、`readJson`、`writeJson`、`MdError`、`EXIT`、`usage`、`out`、`formatTime`；`matchRegionFromUrl`（来自 `packages/shared/src/miaodong-regions.ts`）
- Produces：
  - `AUTH_PREFIX = 'md-auth:'`
  - `normalizeOrigin(input) → 'https://host'`
  - `regionOf(origin) → { key, label }`：命中区域表时用区 id 与标签，否则都用 host
  - `buildSnippet(origin) → 一行 JS`
  - `decodeAuthBlob(text) → { origin, token, user:{id,name}, currentOrgId, orgs:[{id,name}] }`
  - `jwtExpiry(token) → number | null`（毫秒）
  - `loadIdentities() → Record<key, Identity>`
  - `saveIdentity(identity)`
  - `removeIdentity(key) → boolean`
  - `requireIdentities() → Identity[]`：一个都没有时抛出，退出码 3
  - `Identity = { key, label, origin, token, user:{id,name}, orgs:[{id,name}], currentOrgId, savedAt, expiresAt }`
  - 测试 helper：`seedIdentity(home, partialIdentity)`、`encodeAuthBlob(payload)`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/helpers/seed.mjs`（本 Task 先写这两个函数，Task 8 再追加 `seedWorkspace`）：

```js
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function seedIdentity(home, identity) {
  const dir = join(home, 'md');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'identities.json');
  let all = {};
  try { all = JSON.parse(readFileSync(file, 'utf-8')); } catch { all = {}; }
  all[identity.key] = {
    label: identity.key,
    user: { id: 'u1', name: '测试用户' },
    savedAt: '2026-09-23T00:00:00.000Z',
    expiresAt: null,
    ...identity,
  };
  writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function encodeAuthBlob(payload) {
  return `md-auth:${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')}`;
}
```

`miaodong-kit/test/identity.test.mjs`：

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildSnippet, decodeAuthBlob, jwtExpiry, normalizeOrigin, regionOf } from '../src/identity.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { encodeAuthBlob, seedIdentity } from './helpers/seed.mjs';

// 在 Node 里模拟浏览器控制台执行那行代码
function runSnippet(origin, { pageOrigin = origin, storage = {} } = {}) {
  let copied = null;
  const context = vm.createContext({
    location: { origin: pageOrigin },
    localStorage: { getItem: (key) => storage[key] ?? null },
    copy: (text) => { copied = text; },
    btoa, unescape, encodeURIComponent, JSON, Array, String,
  });
  const result = vm.runInContext(buildSnippet(origin), context);
  return { result, copied };
}

let server;
before(async () => { server = await startFakeMiaodong({ 'GET /api/bot/list': () => ok([]) }); });
after(() => server.close());

test('域名规范化与区识别', () => {
  assert.equal(normalizeOrigin('xlink-insight.juzibot.com/main/agents'), 'https://xlink-insight.juzibot.com');
  assert.deepEqual(regionOf('https://xlink-insight.juzibot.com'), { key: 'xingqudao', label: '兴趣岛（独立部署）' });
  assert.deepEqual(regionOf('https://demo.example.com'), { key: 'demo.example.com', label: 'demo.example.com' });
  assert.throws(() => normalizeOrigin('  '), (e) => e.exitCode === 2);
});

test('控制台代码：读 localStorage.user，复制 md-auth 串，能解回来', () => {
  const user = {
    id: 'u1', name: '胡同学', token: 'jwt.abc.def',
    currentOrg: { id: 'org-1', name: '兴趣岛平台' },
    orgs: [{ id: 'org-1', name: '兴趣岛平台' }, { id: 'org-2', name: '测试企业' }],
  };
  const { result, copied } = runSnippet('https://xlink-insight.juzibot.com', { storage: { user: JSON.stringify(user) } });
  assert.match(result, /✅ 已复制身份/);
  const blob = decodeAuthBlob(copied);
  assert.equal(blob.origin, 'https://xlink-insight.juzibot.com');
  assert.equal(blob.token, 'jwt.abc.def');
  assert.equal(blob.currentOrgId, 'org-1');
  assert.deepEqual(blob.orgs.map((o) => o.name), ['兴趣岛平台', '测试企业']);
  assert.equal(blob.user.name, '胡同学');
});

test('控制台代码：域名不对或没登录时只给提示、不复制', () => {
  const wrong = runSnippet('https://xlink-insight.juzibot.com', { pageOrigin: 'https://xlink-hi.juzibot.com' });
  assert.match(wrong.result, /❌ 当前页面是 https:\/\/xlink-hi\.juzibot\.com/);
  assert.equal(wrong.copied, null);
  const noLogin = runSnippet('https://xlink-insight.juzibot.com');
  assert.match(noLogin.result, /没读到登录态/);
  assert.equal(noLogin.copied, null);
});

test('控制台代码：嵌入模式下的 user-ai-pc 也能读', () => {
  const { copied } = runSnippet('https://a.example.com', {
    storage: { 'user-ai-pc': JSON.stringify({ token: 't', currentOrg: { id: 'o', name: 'O' } }) },
  });
  assert.equal(decodeAuthBlob(copied).token, 't');
});

test('decode：剪贴板里是别的东西时报错，退出码 3，且不回显内容', () => {
  assert.throws(() => decodeAuthBlob("(()=>{try{const want='x'"), (e) =>
    e.code === 'auth_blob_invalid' && e.exitCode === 3 && !e.message.includes('want'));
  assert.throws(() => decodeAuthBlob('md-auth:!!!'), (e) => e.code === 'auth_blob_invalid');
  assert.throws(() => decodeAuthBlob(encodeAuthBlob({ origin: 'https://a.com', token: '', orgs: [{ id: 'o' }] })), /没有登录凭证/);
  assert.throws(() => decodeAuthBlob(encodeAuthBlob({ origin: 'https://a.com', token: 't', orgs: [] })), /没有任何企业/);
});

test('jwtExpiry：有 exp 返回毫秒，没有返回 null', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(jwtExpiry(`h.${b64({ exp: 2000000000 })}.s`), 2000000000 * 1000);
  assert.equal(jwtExpiry(`h.${b64({ id: 'u' })}.s`), null);
  assert.equal(jwtExpiry('opaque-token'), null);
});

test('md auth import --stdin：验证后保存（0600），输出不含 token', async () => {
  const home = tempHome();
  const blob = encodeAuthBlob({
    origin: server.origin, token: 'tok-SECRET-9', user: { id: 'u1', name: '胡同学' },
    currentOrg: { id: 'org-1', name: '企业一' }, orgs: [{ id: 'org-1', name: '企业一' }],
  });
  const r = await runCli(['auth', 'import', '--stdin'], { home, input: blob });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /✅ 已保存：127\.0\.0\.1:\d+ · 企业一 · 胡同学/);
  assert.ok(!`${r.stdout}${r.stderr}`.includes('SECRET'));
  const file = join(home, 'md', 'identities.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const entry = Object.values(JSON.parse(readFileSync(file, 'utf-8')))[0];
  assert.equal(entry.token, 'tok-SECRET-9');
  assert.equal(server.requests.at(-1).query.orgId, 'org-1');
});

test('md auth import：秒懂拒绝时不保存，退出码 3', async () => {
  const home = tempHome();
  server.routes['GET /api/bot/list'] = () => ({ status: 401, body: { statusCode: 401, message: 'Authentication failed' } });
  const blob = encodeAuthBlob({ origin: server.origin, token: 'bad', currentOrg: { id: 'o', name: 'O' }, orgs: [] });
  const r = await runCli(['auth', 'import', '--stdin'], { home, input: blob });
  assert.equal(r.code, 3);
  assert.equal(existsSync(join(home, 'md', 'identities.json')), false);
  server.routes['GET /api/bot/list'] = () => ok([]);
});

test('md auth snippet / list / remove', async () => {
  const home = tempHome();
  const s = await runCli(['auth', 'snippet', 'xlink-insight.juzibot.com'], { home });
  assert.equal(s.code, 0);
  assert.match(s.stdout, /兴趣岛/);
  assert.match(s.stdout, /localStorage\.getItem\('user'\)/);
  seedIdentity(home, { key: 'k1', label: '测试区', origin: 'https://a.example.com', token: 'tok-SECRET', orgs: [{ id: 'o1', name: '企业一' }], currentOrgId: 'o1' });
  const l = await runCli(['auth', 'list'], { home });
  assert.match(l.stdout, /测试区/);
  assert.ok(!l.stdout.includes('SECRET'));
  assert.equal((await runCli(['auth', 'remove', 'k1'], { home })).code, 0);
  assert.match((await runCli(['auth', 'list'], { home })).stdout, /还没有任何区的身份/);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/identity.test.mjs`
Expected：FAIL（找不到 `../src/identity.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/identity.mjs`：

```js
// 身份 = 某个区的控制台域名 + 用户在浏览器里的登录凭证 + 能看到的企业列表。
// 不用账号密码：用户在控制台执行一行代码，把 localStorage.user 里的登录态复制到剪贴板，
// md 从剪贴板读、验证、按区存进 $MD_HOME/identities.json（0600）。
// 凭证全程不经过对话：不贴进对话框，不打印，导入后清空剪贴板。

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { matchRegionFromUrl } from '../../packages/shared/src/miaodong-regions.ts';
import { EXIT, MdError, usage } from './errors.mjs';
import { mdHome, readJson, writeJson } from './home.mjs';

export const AUTH_PREFIX = 'md-auth:';

function identitiesPath() {
  return join(mdHome(), 'identities.json');
}

export function normalizeOrigin(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw usage('缺少秒懂控制台域名', '例如：md auth snippet xlink-insight.juzibot.com');
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    throw usage(`认不出这个域名：${raw}`);
  }
}

export function regionOf(origin) {
  const region = matchRegionFromUrl(origin);
  const host = new URL(origin).host;
  return region ? { key: region.id, label: region.label } : { key: host, label: host };
}

// 在浏览器控制台执行的一行代码。只认目标域名：localStorage 按域名隔离，在别的页面执行拿到的不是秒懂登录态。
// 嵌在别的系统里（wujie）时登录态键名是 user-ai-pc。
export function buildSnippet(origin) {
  const want = JSON.stringify(origin);
  return `(()=>{try{const want=${want};if(location.origin!==want)return'❌ 当前页面是 '+location.origin+'，请打开 '+want+' 的秒懂控制台再执行';const raw=localStorage.getItem('user')||localStorage.getItem('user-ai-pc');const u=raw?JSON.parse(raw):null;if(!u||!u.token)return'❌ 没读到登录态：先在这个页面登录秒懂';const pick=o=>o&&o.id?{id:String(o.id),name:String(o.name||'')}:null;const p={v:1,origin:location.origin,token:u.token,user:{id:String(u.id||''),name:String(u.name||'')},currentOrg:pick(u.currentOrg),orgs:(Array.isArray(u.orgs)?u.orgs:[]).map(pick).filter(Boolean)};copy('${AUTH_PREFIX}'+btoa(unescape(encodeURIComponent(JSON.stringify(p)))));return'✅ 已复制身份（企业：'+(p.currentOrg?p.currentOrg.name:'未选')+'，共 '+p.orgs.length+' 个企业）。回到 AI 对话说「好了」'}catch(e){return'❌ '+e.message}})()`;
}

function invalid(message, hint = '让用户在控制台重新执行 md auth snippet 给的那行代码，看到「✅ 已复制身份」后再导入') {
  return new MdError('auth_blob_invalid', message, { exitCode: EXIT.AUTH, hint });
}

export function decodeAuthBlob(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith(AUTH_PREFIX)) throw invalid('剪贴板里不是 md 的身份信息');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(AUTH_PREFIX.length), 'base64').toString('utf-8'));
  } catch {
    throw invalid('身份信息解析失败（可能没复制完整）');
  }
  const origin = normalizeOrigin(parsed?.origin);
  const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
  if (!token) throw invalid('身份信息里没有登录凭证');
  const pick = (o) => (o && typeof o.id === 'string' && o.id ? { id: o.id, name: String(o.name ?? '') } : null);
  const currentOrg = pick(parsed.currentOrg);
  const orgs = [];
  for (const candidate of [...(Array.isArray(parsed.orgs) ? parsed.orgs : []), currentOrg]) {
    const org = pick(candidate);
    if (org && !orgs.some((o) => o.id === org.id)) orgs.push(org);
  }
  if (orgs.length === 0) throw invalid('身份信息里没有任何企业', '让用户在控制台先选中一个企业，再执行那行代码');
  return {
    origin,
    token,
    user: { id: String(parsed.user?.id ?? ''), name: String(parsed.user?.name ?? '') },
    currentOrgId: (currentOrg ?? orgs[0]).id,
    orgs,
  };
}

export function jwtExpiry(token) {
  const part = String(token).split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function loadIdentities() {
  return readJson(identitiesPath(), {}, { secret: true });
}

export function saveIdentity(identity) {
  const all = loadIdentities();
  all[identity.key] = identity;
  writeJson(identitiesPath(), all, { secret: true });
}

export function removeIdentity(key) {
  const all = loadIdentities();
  if (!all[key]) return false;
  delete all[key];
  writeJson(identitiesPath(), all, { secret: true });
  return true;
}

export function requireIdentities() {
  const list = Object.values(loadIdentities());
  if (list.length === 0) {
    throw new MdError('no_identity', '还没有任何区的身份', {
      exitCode: EXIT.AUTH,
      hint: '先问用户秒懂控制台的域名，然后 md auth snippet <域名>',
    });
  }
  return list;
}

export function readClipboard() {
  try {
    return execFileSync('pbpaste', { encoding: 'utf-8' });
  } catch {
    throw usage('读不到剪贴板（这台机器没有 pbpaste）', '改用 md auth import --stdin，再粘贴');
  }
}

export function clearClipboard() {
  try {
    execFileSync('pbcopy', { input: '' });
  } catch {
    // 非 macOS 没有 pbcopy，忽略
  }
}
```

`miaodong-kit/src/commands/auth.mjs`：

```js
import { EXIT, usage } from '../errors.mjs';
import { request } from '../http.mjs';
import {
  buildSnippet, clearClipboard, decodeAuthBlob, jwtExpiry, loadIdentities,
  normalizeOrigin, readClipboard, regionOf, removeIdentity, saveIdentity,
} from '../identity.mjs';
import { formatTime, out } from '../output.mjs';

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function snippet(domain) {
  const origin = normalizeOrigin(domain);
  const region = regionOf(origin);
  out(`【取身份】${region.label}（${origin}），约 30 秒：`);
  out(`1. 在浏览器打开 ${origin} 并登录，选好企业（任意页面都行）。`);
  out('2. 打开浏览器控制台：Mac 按 Cmd+Option+J，Windows 按 F12，切到「Console / 控制台」。');
  out('   第一次粘贴被拦时，按提示输入 allow pasting 回车。');
  out('3. 粘贴下面这一整行，回车：');
  out('');
  out(buildSnippet(origin));
  out('');
  out('4. 看到「✅ 已复制身份」后，回到对话说「好了」。');
  out('');
  out('说明：身份只在你的剪贴板和本机 ~/.miaodong/md 里，不会出现在对话中；导入后剪贴板会被清空。');
  return EXIT.OK;
}

async function importIdentity(args) {
  const text = args.stdin ? await readStdin() : readClipboard();
  const blob = decodeAuthBlob(text);
  const region = regionOf(blob.origin);
  const identity = {
    key: region.key,
    label: region.label,
    origin: blob.origin,
    token: blob.token,
    user: blob.user,
    orgs: blob.orgs,
    currentOrgId: blob.currentOrgId,
    savedAt: new Date().toISOString(),
    expiresAt: jwtExpiry(blob.token),
  };
  // 先用一次只读调用验证，验证不过就不落盘
  await request(identity, '/api/bot/list', { query: { orgId: identity.currentOrgId } });
  saveIdentity(identity);
  if (!args.stdin) clearClipboard();
  const org = identity.orgs.find((o) => o.id === identity.currentOrgId);
  const expiry = identity.expiresAt ? ` · 有效期至 ${formatTime(identity.expiresAt)}` : '';
  out(`✅ 已保存：${identity.label} · ${org?.name || identity.currentOrgId} · ${identity.user.name || '（未知用户）'}${expiry}`);
  out(`   可用企业 ${identity.orgs.length} 个：${identity.orgs.map((o) => o.name || o.id.slice(0, 8)).join('、')}`);
  return EXIT.OK;
}

function list() {
  const all = Object.values(loadIdentities());
  if (all.length === 0) {
    out('还没有任何区的身份。先 md auth snippet <秒懂控制台域名>');
    return EXIT.OK;
  }
  out('区 | 域名 | 用户 | 企业数 | 当前企业 | 有效期至 | 取于');
  for (const identity of all) {
    const current = identity.orgs.find((o) => o.id === identity.currentOrgId);
    out([
      `${identity.label}（${identity.key}）`, identity.origin, identity.user?.name || '-', identity.orgs.length,
      current?.name || '-', identity.expiresAt ? formatTime(identity.expiresAt) : '未写明', formatTime(identity.savedAt),
    ].join(' | '));
  }
  return EXIT.OK;
}

function remove(key) {
  if (!key) throw usage('用法：md auth remove <区>', '先 md auth list 看区的名字');
  out(removeIdentity(key) ? `已删除 ${key} 的身份` : `没有 ${key} 的身份`);
  return EXIT.OK;
}

export const auth = {
  summary: '取 / 看 / 删 秒懂身份（按区）',
  usage: [
    'md auth snippet <域名>     生成让用户在浏览器控制台执行的一行代码（原样转给用户）',
    'md auth import [--stdin]   从剪贴板导入身份（--stdin 从标准输入读）',
    'md auth list               已保存身份的区',
    'md auth remove <区>        删除某个区的身份',
  ].join('\n'),
  async run(args) {
    const [sub, value] = args._;
    if (sub === 'snippet') return snippet(value);
    if (sub === 'import') return importIdentity(args);
    if (sub === 'list') return list();
    if (sub === 'remove') return remove(value);
    throw usage('用法：md auth snippet|import|list|remove', 'md auth --help');
  },
};
```

`miaodong-kit/src/commands/index.mjs` 整体替换为：

```js
// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { auth } from './auth.mjs';

export const COMMANDS = { auth };
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/identity.test.mjs`
Expected：9 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/identity.mjs miaodong-kit/src/commands miaodong-kit/test/identity.test.mjs miaodong-kit/test/helpers/seed.mjs
git commit -m "feat(md): 按区取身份——控制台代码、剪贴板导入、验证后 0600 落盘"
```

---

### Task 5：智能体目录与目标换算（md orgs / md bots）

**Files:**
- Create: `miaodong-kit/src/api.mjs`、`src/target.mjs`、`src/commands/orgs.mjs`、`src/commands/bots.mjs`、`miaodong-kit/test/target.test.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`

**Interfaces:**
- Consumes：`request`、`requireIdentities`、`loadIdentities`、`mdHome`、`readJson`、`writeJson`、`strArg`、`out`、`note`、`shortId`
- Produces：
  - `asArray(v) → any[]`：兼容 `data` 是数组，或 `data.list` 是数组
  - `listBots(identity, orgId) → [{ id, name, enabled }]`
  - `loadBotDirectory({ refresh }) → Entry[]`，其中 `Entry = { identityKey, regionLabel, orgId, orgName, botId, botName, enabled }`；缓存放在 `$MD_HOME/cache/bots.json`，10 分钟有效
  - `pickOne(entries, query, idOf, nameOf) → Entry[]`：返回命中的那一档
  - `filterEntries(entries, { region?, org? }) → Entry[]`
  - `describeEntry(entry) → '区 / 企业 / 名字 (id8)'`
  - `targetArgs(args) → { bot, org, region, refresh }`
  - `resolveBot({ bot, org?, region?, refresh? }) → Target`，其中 `Target = Entry & { identity }`；找不到或有歧义时退出码 4

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/target.test.mjs`：

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { filterEntries, pickOne, resolveBot } from '../src/target.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { seedIdentity } from './helpers/seed.mjs';

const BOTS = {
  'org-1': [
    { id: '147bd600-1eef-41ae-85e2-a51d03781503', name: '太极2.0 质检革新版' },
    { id: '181fc177-0000-4000-8000-000000000000', name: '太极2.0重构' },
  ],
  'org-2': [{ id: 'b785966b-0000-4000-8000-000000000000', name: '太极2.0重构', enabled: false }],
};

let server;
before(async () => { server = await startFakeMiaodong({ 'GET /api/bot/list': ({ query }) => ok(BOTS[query.orgId] ?? []) }); });
after(() => server.close());

function homeWithIdentity() {
  const home = tempHome();
  seedIdentity(home, {
    key: 'k1', label: '测试区', origin: server.origin, token: 't',
    orgs: [{ id: 'org-1', name: '兴趣岛平台' }, { id: 'org-2', name: '测试企业' }], currentOrgId: 'org-1',
  });
  return home;
}

test('pickOne：id > id 前缀（≥6 位）> 名字完全一致 > 名字包含，不分大小写', () => {
  const entries = [{ botId: 'abcdef12-x', botName: '太极' }, { botId: 'abcdef99-y', botName: '太极2.0' }];
  const id = (e) => e.botId;
  const name = (e) => e.botName;
  assert.equal(pickOne(entries, 'abcdef12-x', id, name).length, 1);
  assert.equal(pickOne(entries, 'abcdef', id, name).length, 2);
  assert.equal(pickOne(entries, 'ABCDEF12', id, name)[0].botName, '太极');
  assert.equal(pickOne(entries, '太极', id, name).length, 1);
  assert.equal(pickOne(entries, '2.0', id, name)[0].botName, '太极2.0');
  assert.equal(pickOne(entries, 'abc', id, name).length, 0);
});

test('filterEntries：按企业名、按区', () => {
  const entries = [
    { identityKey: 'xingqudao', regionLabel: '兴趣岛（独立部署）', orgId: 'o1', orgName: '兴趣岛平台' },
    { identityKey: 'I', regionLabel: 'I区', orgId: 'o2', orgName: '测试企业' },
  ];
  assert.equal(filterEntries(entries, { org: '兴趣岛平台' }).length, 1);
  assert.equal(filterEntries(entries, { region: 'I' })[0].orgId, 'o2');
});

test('resolveBot：同名跨企业 → 列候选停下（退出码 4）；加 --org 后唯一', async () => {
  const home = homeWithIdentity();
  process.env.MD_HOME = join(home, 'md');
  await assert.rejects(resolveBot({ bot: '太极2.0重构' }), (e) =>
    e.code === 'target_ambiguous' && e.exitCode === 4 && e.message.includes('兴趣岛平台') && e.message.includes('测试企业'));
  const target = await resolveBot({ bot: '太极2.0重构', org: '兴趣岛平台' });
  assert.equal(target.botId, '181fc177-0000-4000-8000-000000000000');
  assert.equal(target.identity.origin, server.origin);
});

test('resolveBot：第二次走缓存；找不到时强制刷新一次再报错', async () => {
  const home = homeWithIdentity();
  process.env.MD_HOME = join(home, 'md');
  await resolveBot({ bot: '质检革新版' });
  const count = server.requests.length;
  await resolveBot({ bot: '147bd600' });
  assert.equal(server.requests.length, count, '命中缓存不应再请求');
  await assert.rejects(resolveBot({ bot: '不存在的智能体' }), (e) => e.code === 'target_not_found' && e.exitCode === 4);
  assert.equal(server.requests.length, count + 2, '刷新一次：两个企业各一个请求');
});

test('md bots / md orgs', async () => {
  const home = homeWithIdentity();
  const b = await runCli(['bots', '太极'], { home });
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, /共 3 个智能体/);
  assert.match(b.stdout, /测试区 \/ 测试企业 \/ 太极2\.0重构 \(b785966b\)  \[已停用\]/);
  const o = await runCli(['orgs'], { home });
  assert.match(o.stdout, /兴趣岛平台 \(org-1\)  ← 取身份时选中的/);
});

test('没有任何身份时退出码 3', async () => {
  const r = await runCli(['bots'], { home: tempHome() });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /还没有任何区的身份/);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/target.test.mjs`
Expected：FAIL（找不到 `../src/target.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/api.mjs`：

```js
// 秒懂接口封装：只做「请求 + 把外壳拆成 md 用的形状」，不含业务判断。
// 路径与参数位置都来自仓库已接入的代码或会话实测（见 spec §11），orgId 一律放 query。

import { request } from './http.mjs';

const str = (value) => (typeof value === 'string' ? value : '');

export function asArray(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.list) ? value.list : [];
}

export async function listBots(identity, orgId) {
  const payload = await request(identity, '/api/bot/list', { query: { orgId } });
  return asArray(payload?.data)
    .map((bot) => ({ id: str(bot.id), name: str(bot.name), enabled: bot.enabled !== false }))
    .filter((bot) => bot.id);
}
```

`miaodong-kit/src/target.mjs`：

```js
// 把用户说的名字换算成确定的「区 / 企业 / 智能体」。
// 规则写死：id 完全一致 > id 前缀（至少 6 位）> 名字完全一致 > 名字包含。
// 同一档命中多个就列候选停下，绝不自己挑：克隆出来的同名测试机器人很常见，挑错就是推错智能体。

import { join } from 'node:path';
import { strArg } from './args.mjs';
import { EXIT, MdError, usage } from './errors.mjs';
import { mdHome, readJson, writeJson } from './home.mjs';
import { loadIdentities, requireIdentities } from './identity.mjs';
import { listBots } from './api.mjs';
import { note, shortId } from './output.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000;
const norm = (value) => String(value ?? '').trim().toLowerCase();

function cachePath() {
  return join(mdHome(), 'cache', 'bots.json');
}

export async function loadBotDirectory({ refresh = false } = {}) {
  const identities = requireIdentities();
  // 身份变了（重新取过、增删了区）缓存就作废
  const keys = identities.map((identity) => `${identity.key}@${identity.savedAt}`).sort().join('|');
  const cache = readJson(cachePath(), null);
  if (!refresh && cache && cache.keys === keys && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.entries;
  const entries = [];
  for (const identity of identities) {
    for (const org of identity.orgs) {
      let bots;
      try {
        bots = await listBots(identity, org.id);
      } catch (error) {
        if (error instanceof MdError && error.code === 'auth_expired') throw error;
        note(`（跳过 ${identity.label} / ${org.name}：${error.message}）`);
        continue;
      }
      for (const bot of bots) {
        entries.push({
          identityKey: identity.key, regionLabel: identity.label, orgId: org.id, orgName: org.name,
          botId: bot.id, botName: bot.name, enabled: bot.enabled,
        });
      }
    }
  }
  writeJson(cachePath(), { keys, fetchedAt: Date.now(), entries });
  return entries;
}

export function pickOne(entries, query, idOf, nameOf) {
  const q = norm(query);
  const tiers = [
    (e) => norm(idOf(e)) === q,
    (e) => q.length >= 6 && norm(idOf(e)).startsWith(q),
    (e) => norm(nameOf(e)) === q,
    (e) => norm(nameOf(e)).includes(q),
  ];
  for (const matches of tiers) {
    const hits = entries.filter(matches);
    if (hits.length) return hits;
  }
  return [];
}

export function filterEntries(entries, { region, org } = {}) {
  let list = entries;
  if (region) {
    const q = norm(region);
    list = list.filter((e) => norm(e.identityKey) === q || norm(e.regionLabel).includes(q));
  }
  if (org) {
    const orgs = [...new Map(list.map((e) => [e.orgId, { orgId: e.orgId, orgName: e.orgName }])).values()];
    const ids = new Set(pickOne(orgs, org, (o) => o.orgId, (o) => o.orgName).map((o) => o.orgId));
    list = list.filter((e) => ids.has(e.orgId));
  }
  return list;
}

export function describeEntry(entry) {
  return `${entry.regionLabel} / ${entry.orgName} / ${entry.botName} (${shortId(entry.botId)})`;
}

export function targetArgs(args) {
  return { bot: strArg(args, 'bot'), org: strArg(args, 'org'), region: strArg(args, 'region'), refresh: args.refresh === true };
}

export async function resolveBot({ bot, org, region, refresh = false }) {
  if (!bot) throw usage('缺 --bot <智能体名字或 id>', '不确定名字时先 md bots <关键词>');
  const attempt = async (fresh) =>
    pickOne(filterEntries(await loadBotDirectory({ refresh: fresh }), { region, org }), bot, (e) => e.botId, (e) => e.botName);
  let hits = await attempt(refresh);
  // 缓存里没有时强制刷新一次：可能是刚新建的智能体
  if (hits.length === 0 && !refresh) hits = await attempt(true);
  if (hits.length === 1) return { ...hits[0], identity: loadIdentities()[hits[0].identityKey] };
  if (hits.length === 0) {
    throw new MdError('target_not_found', `找不到智能体「${bot}」`, {
      exitCode: EXIT.TARGET,
      hint: '用 md bots <关键词> 看看有哪些；不同区要先分别取身份',
    });
  }
  const lines = hits.slice(0, 20).map((e) => `  - ${describeEntry(e)}`).join('\n');
  throw new MdError('target_ambiguous', `「${bot}」匹配到 ${hits.length} 个智能体，请用更精确的名字或 id：\n${lines}`, {
    exitCode: EXIT.TARGET,
    hint: '也可以加 --org <企业> 或 --region <区> 缩小范围',
  });
}
```

`miaodong-kit/src/commands/orgs.mjs`：

```js
import { EXIT } from '../errors.mjs';
import { requireIdentities } from '../identity.mjs';
import { out, shortId } from '../output.mjs';

export const orgs = {
  summary: '列出各区身份能看到的企业',
  usage: 'md orgs',
  async run() {
    for (const identity of requireIdentities()) {
      out(`${identity.label}（${identity.origin}）· ${identity.user?.name || '未知用户'}`);
      for (const org of identity.orgs) {
        out(`  - ${org.name || '(无名)'} (${shortId(org.id)})${org.id === identity.currentOrgId ? '  ← 取身份时选中的' : ''}`);
      }
    }
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/bots.mjs`：

```js
import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { describeEntry, filterEntries, loadBotDirectory } from '../target.mjs';
import { out } from '../output.mjs';

export const bots = {
  summary: '列出 / 搜索智能体（跨所有已取身份的区和企业）',
  usage: 'md bots [关键词] [--org <企业>] [--region <区>] [--refresh]',
  async run(args) {
    const keyword = String(args._[0] ?? '').trim().toLowerCase();
    const entries = filterEntries(await loadBotDirectory({ refresh: args.refresh === true }), {
      org: strArg(args, 'org'),
      region: strArg(args, 'region'),
    });
    const hits = keyword
      ? entries.filter((e) => e.botName.toLowerCase().includes(keyword) || e.botId.toLowerCase().startsWith(keyword))
      : entries;
    out(`共 ${hits.length} 个智能体${keyword ? `（含「${args._[0]}」）` : ''}：`);
    for (const e of hits) out(`  - ${describeEntry(e)}${e.enabled ? '' : '  [已停用]'}`);
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs` 整体替换为：

```js
// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { auth } from './auth.mjs';
import { bots } from './bots.mjs';
import { orgs } from './orgs.mjs';

export const COMMANDS = { auth, orgs, bots };
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/target.test.mjs`
Expected：6 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/api.mjs miaodong-kit/src/target.mjs miaodong-kit/src/commands miaodong-kit/test/target.test.mjs
git commit -m "feat(md): 跨区按名字找智能体，同名列候选停下；md orgs / md bots"
```

---

### Task 6：版本（md versions）

**Files:**
- Modify: `miaodong-kit/src/api.mjs`（加 `getCanvas`、`listVersions`、`basicInfo`）、`src/target.mjs`（加 `resolveVersion`）、`src/commands/index.mjs`
- Create: `miaodong-kit/src/commands/versions.mjs`、`miaodong-kit/test/versions.test.mjs`

**Interfaces:**
- Consumes：`request`、`resolveBot`、`targetArgs`、`intArg`、`out`、`formatTime`、`targetLine`、`shortId`
- Produces：
  - `getCanvas(identity, orgId, botId, canvasId?) → { canvasId, rawCanvas, version, updatedAt, name, isRoot, rootCanvasId, versionType }`：`canvasId` 和 `rawCanvas` 都为空时抛出 `canvas_missing`
  - `listVersions(identity, orgId, mainCanvasId) → [{ canvasId, version, name, versionType, isCanary, testStatus, passedRate, createdAt, createdBy, isLocked }]`
  - `basicInfo(identity, orgId, botId) → { name, canvasVersion, enabledCanvasId, mainCanvasId } | null`：接口不支持时返回 null，身份失效时照常抛出
  - `resolveVersion(versions, query) → version`：接受 `v1.0.400`、`1.0.400` 或版本名称；找不到或有歧义时退出码 4

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/versions.test.mjs`：

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVersion } from '../src/target.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { seedIdentity } from './helpers/seed.mjs';

const BOT = '181fc177-0000-4000-8000-000000000000';
const VERSIONS = [
  { canvasId: 'ver-402', version: 'v1.0.402', name: '402', versionType: 'online', isCanary: false, testStatus: 'passed', createdAt: '2026-09-22T10:00:00.000Z', createdBy: '胡同学' },
  { canvasId: 'ver-401', version: 'v1.0.401', name: '先到测试版本', versionType: 'online', isCanary: true, testStatus: 'not-tested', createdAt: '2026-09-21T10:00:00.000Z', createdBy: '胡同学' },
];

let server;
before(async () => {
  server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: BOT, name: '太极2.0重构' }] : []),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: [], version: 'v1.0.402', updatedAt: '2026-09-23T02:00:00.000Z' }),
    'GET /api/canvas/list-version': () => ok(VERSIONS, { page: { total: 2 } }),
    'GET /api/bot/basic-info': () => ok({ name: '太极2.0重构', canvasVersion: 'v1.0.402', enabledCanvasId: 'ver-402', mainCanvasId: 'main-1' }),
  });
});
after(() => server.close());

function homeWithIdentity() {
  const home = tempHome();
  seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return home;
}

test('resolveVersion：带不带 v 都行，也认版本名称', () => {
  const list = VERSIONS.map((v) => ({ ...v, passedRate: null, isLocked: false }));
  assert.equal(resolveVersion(list, 'v1.0.401').canvasId, 'ver-401');
  assert.equal(resolveVersion(list, '1.0.402').canvasId, 'ver-402');
  assert.equal(resolveVersion(list, '先到测试版本').canvasId, 'ver-401');
  assert.throws(() => resolveVersion(list, 'v9.9.9'), (e) => e.code === 'version_not_found' && e.exitCode === 4);
});

test('md versions：版本表标出线上启用与灰度，用主画布 id 查版本', async () => {
  const r = await runCli(['versions', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0重构 \(181fc177\)/);
  assert.match(r.stdout, /线上启用：v1\.0\.402/);
  assert.match(r.stdout, /v1\.0\.402 \| 402 \| 正式 \| 启用 \| passed \| /);
  assert.match(r.stdout, /v1\.0\.401 \| 先到测试版本 \| 正式 \| 灰度 \| not-tested \| /);
  assert.equal(server.requests.find((q) => q.path === '/api/canvas/list-version').query.canvasId, 'main-1');
});

test('basic-info 不支持时说明取不到，不报错', async () => {
  server.routes['GET /api/bot/basic-info'] = () => ({ status: 404, body: { message: 'Cannot GET', statusCode: 404 } });
  const r = await runCli(['versions', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /线上启用：取不到/);
});

test('画布整个是空响应时报清楚', async () => {
  server.routes['GET /api/canvas/get'] = () => ok({});
  const r = await runCli(['versions', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /秒懂没有返回画布内容/);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/versions.test.mjs`
Expected：FAIL（`resolveVersion` 未导出）

- [ ] **Step 3：写实现**

`miaodong-kit/src/api.mjs`：在文件头 import 区加上 `import { MdError } from './errors.mjs';`，文件末尾追加：

```js
export async function getCanvas(identity, orgId, botId, canvasId) {
  const payload = await request(identity, '/api/canvas/get', { query: { botId, orgId, canvasId } });
  const data = payload?.data ?? {};
  const canvas = {
    canvasId: str(data.canvasId),
    rawCanvas: Array.isArray(data.rawCanvas) ? data.rawCanvas : [],
    version: str(data.version),
    updatedAt: str(data.updatedAt),
    name: str(data.name),
    isRoot: data.isRoot === true,
    rootCanvasId: str(data.rootCanvasId),
    versionType: str(data.versionType),
  };
  // 上游异常时这里和「真的是空画布」长得一样；两样都空就当异常，免得拿空画布去比、去推
  if (!canvas.canvasId && canvas.rawCanvas.length === 0) {
    throw new MdError('canvas_missing', `秒懂没有返回画布内容（智能体 ${botId}${canvasId ? `，版本 ${canvasId}` : ''}）`, {
      hint: '确认智能体选对了、画布已经初始化',
    });
  }
  return canvas;
}

export async function listVersions(identity, orgId, mainCanvasId) {
  // list-version 要的是主画布（草稿）的 canvasId，不是 botId
  const payload = await request(identity, '/api/canvas/list-version', {
    query: { canvasId: mainCanvasId, orgId, current: 1, pageSize: 1000 },
  });
  return asArray(payload?.data)
    .map((v) => ({
      canvasId: str(v.canvasId),
      version: str(v.version),
      name: str(v.name),
      versionType: str(v.versionType),
      isCanary: v.isCanary === true,
      testStatus: str(v.testStatus),
      passedRate: typeof v.passedRate === 'number' ? v.passedRate : null,
      createdAt: str(v.createdAt),
      createdBy: str(v.createdBy),
      isLocked: v.isLocked === true,
    }))
    .filter((v) => v.canvasId);
}

export async function basicInfo(identity, orgId, botId) {
  // 只有前端代码证据；取不到就返回 null，由调用方说明「取不到」
  try {
    const payload = await request(identity, '/api/bot/basic-info', { query: { botId, orgId } });
    const data = payload?.data ?? {};
    return { name: str(data.name), canvasVersion: str(data.canvasVersion), enabledCanvasId: str(data.enabledCanvasId), mainCanvasId: str(data.mainCanvasId) };
  } catch (error) {
    if (error instanceof MdError && error.code === 'auth_expired') throw error;
    return null;
  }
}
```

`miaodong-kit/src/target.mjs` 末尾追加：

```js
export function resolveVersion(versions, query) {
  const q = norm(query).replace(/^v/, '');
  const byVersion = versions.filter((v) => norm(v.version).replace(/^v/, '') === q);
  const hits = byVersion.length ? byVersion : versions.filter((v) => norm(v.name) === norm(query));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    throw new MdError('version_not_found', `没有版本「${query}」`, { exitCode: EXIT.TARGET, hint: '用 md versions --bot <智能体> 看版本列表' });
  }
  throw new MdError('version_ambiguous', `「${query}」匹配到 ${hits.length} 个版本：${hits.map((v) => `${v.version}（${v.name}）`).join('、')}`, {
    exitCode: EXIT.TARGET,
  });
}
```

`miaodong-kit/src/commands/versions.mjs`：

```js
import { intArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { basicInfo, getCanvas, listVersions } from '../api.mjs';
import { resolveBot, targetArgs } from '../target.mjs';
import { formatTime, out, targetLine } from '../output.mjs';

const TYPE_LABEL = { online: '正式', test: '测试' };

export const versions = {
  summary: '看智能体的版本：哪个在线上、哪个是灰度、草稿最后保存时间',
  usage: 'md versions --bot <智能体> [--org <企业>] [--region <区>] [--limit 30]',
  async run(args) {
    const target = await resolveBot(targetArgs(args));
    const { identity, orgId, botId } = target;
    const draft = await getCanvas(identity, orgId, botId);
    const [list, info] = await Promise.all([listVersions(identity, orgId, draft.canvasId), basicInfo(identity, orgId, botId)]);
    const limit = intArg(args, 'limit', 30);
    out(targetLine(target));
    out(`草稿：最后保存 ${formatTime(draft.updatedAt)}`);
    out(info?.canvasVersion ? `线上启用：${info.canvasVersion}` : '线上启用：取不到（这个区的接口不支持），以秒懂页面为准');
    out(`共 ${list.length} 个版本${list.length > limit ? `，显示最近 ${limit} 个（--limit 调整）` : ''}`);
    out('版本 | 名称 | 类型 | 线上 | 测试 | 创建');
    for (const v of list.slice(0, limit)) {
      const flags = [v.version === info?.canvasVersion ? '启用' : '', v.isCanary ? '灰度' : ''].filter(Boolean).join('+') || '-';
      const testText = `${v.testStatus || '-'}${v.passedRate !== null ? ` ${v.passedRate}` : ''}`;
      out(`${v.version} | ${v.name || '-'} | ${TYPE_LABEL[v.versionType] ?? (v.versionType || '-')} | ${flags} | ${testText} | ${formatTime(v.createdAt)} ${v.createdBy}`.trimEnd());
    }
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs` 整体替换为：

```js
// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { auth } from './auth.mjs';
import { bots } from './bots.mjs';
import { orgs } from './orgs.mjs';
import { versions } from './versions.mjs';

export const COMMANDS = { auth, orgs, bots, versions };
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/versions.test.mjs`
Expected：4 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/api.mjs miaodong-kit/src/target.mjs miaodong-kit/src/commands miaodong-kit/test/versions.test.mjs
git commit -m "feat(md): md versions——版本表标出线上启用与灰度"
```

---

### Task 7：拉取到工作副本（md pull）

**Files:**
- Create: `miaodong-kit/src/canvas.mjs`、`src/graph.mjs`、`src/workspace.mjs`、`src/commands/pull.mjs`、`miaodong-kit/test/helpers/fixtures.mjs`、`miaodong-kit/test/graph.test.mjs`、`miaodong-kit/test/pull.test.mjs`
- Modify: `miaodong-kit/src/api.mjs`（加 `listSessions`、`listEvents`）、`src/commands/index.mjs`

**Interfaces:**
- Consumes：`isEdgeCell`、`isVisualOnlyCell`（来自 `apps/api/lib/miaodong/canvas-derive.ts`）、`stableStringify`（来自 `apps/api/lib/miaodong/canvas-content-patch.ts`）、`getCanvas`、`listVersions`、`resolveBot`、`resolveVersion`、`targetArgs`、`loadIdentities`
- Produces：
  - canvas.mjs：`LAYOUT_KEYS`、`hashOf(v) → 16 位 hex`、`stripLayout(cell)`、`contentKey(cell)`、`edgeKey(edge)`、`nodeMap(canvas) → Map<id, cell>`（含装饰元素，不含连线）、`edgeMap(canvas) → Map<edgeKey, edge>`、`compareNodes(a, b) → { onlyA, onlyB, changed, edgesDiffer, same }`；另外转出 `isEdgeCell`、`isVisualOnlyCell`、`stableStringify`
  - graph.mjs：
    - `businessNodes(canvas)`、`edgesOf(canvas)`、`nodeName(cell)`、`nodeType(cell)`
    - `collectRefs(node) → [{ from, to, path, dataPath }]`
    - `buildIndex(canvas, events) → { nodes: [{ id, name, type, category, model, in, out }], edges: [{ kind: 'wire'|'event', from, fromPort, to, toPort, eventId?, eventName? }], refs }`
    - `resolveNode(canvas, query) → cell`：找不到或有歧义时退出码 4
    - `traceLines(index, startId, { direction, depth, maxLines }) → string[]`
    - `refsTo(index, nodeId) → refs`
  - workspace.mjs：
    - `workRoot()`、`stamp()`
    - `createWorkspace(target, label) → dir`
    - `writeWorkspace(dir, { meta, base, draft? })`：同时写索引，并把 `LAST` 指向这个 dir
    - `writeIndex(dir, envelope) → index`
    - `resolveWorkspaceDir(args)`、`loadWorkspace(args) → { dir, meta, base, after, current }`
    - `versionLabelOf(meta)`、`wsLine(ws)`
    - `targetFromMeta(meta) → Target`
  - api.mjs：`listSessions(...)`、`listEvents(...) → any[] | null`，接口不支持时返回 null
  - `meta.json` 结构：`{ schema:1, identityKey, regionLabel, origin, orgId, orgName, botId, botName, mainCanvasId, source: {kind:'draft'} | {kind:'version', version, name, canvasId}, draft: { updatedAt, version, hash }, pulledAt, notes[], handEdited?, lastPush? }`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/helpers/fixtures.mjs`：

```js
// 一张覆盖各种关系的小画布：
//   1 收到文本(触发器) → 2 回答生成 → 3 发送文本
//                      2 → 4 触发延时回复(事件动作 ev-1) ⇢ 5 延时回复入口(事件触发器, shape=ev-1) → 6 回答生成(同名)
//   2 引用 1 的 text，3 引用 2 的 output；900 是便签装饰
export const U = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

export function node(n, { name, type = 'llm-completion', shape = type, payload = {}, category = 'calculation' } = {}) {
  return {
    id: U(n), shape, view: 'react-shape-view',
    position: { x: n * 100, y: 0 }, size: { width: 200, height: 80 }, zIndex: 1,
    ports: { items: [{ id: `p${n}-in`, group: 'left' }, { id: `p${n}-out`, group: 'right' }] },
    data: { name: name ?? `节点${n}`, type, category, nodePayload: payload },
  };
}

export function edge(n, from, to) {
  return {
    id: U(n), shape: 'custom-curve-edge', zIndex: 0, attrs: { line: { stroke: '#999' } },
    source: { cell: U(from), port: `p${from}-out` }, target: { cell: U(to), port: `p${to}-in` },
  };
}

export function sampleCanvas() {
  return [
    node(1, { name: '收到文本', type: 'receive-text-message', category: 'trigger' }),
    node(2, { name: '回答生成', payload: { modelType: 'doubao', systemPrompt: '你是客服。\n请礼貌回答。', inputs: [{ name: 'text', referenceNodeId: U(1), dataPath: 'text', valueType: 'string', type: 'reference' }] } }),
    node(3, { name: '发送文本', type: 'send-text-message', category: 'action', payload: { inputs: [{ name: 'text', referenceNodeId: U(2), dataPath: 'output', valueType: 'string', type: 'reference' }] } }),
    node(4, { name: '触发延时回复', type: 'canvas-event-action', category: 'action', payload: { eventId: 'ev-1', inputs: [] } }),
    { ...node(5, { name: '延时回复入口', type: 'canvas-event-trigger', category: 'trigger', payload: { eventId: 'ev-1' } }), shape: 'ev-1' },
    node(6, { name: '回答生成', payload: { modelType: 'gemini', systemPrompt: '你是助教。', inputs: [] } }),
    edge(101, 1, 2), edge(102, 2, 3), edge(103, 2, 4), edge(104, 5, 6),
    { id: U(900), shape: 'canvas-tool-comment-node', position: { x: 0, y: 0 }, size: { width: 100, height: 40 }, data: { text: '备注' } },
  ];
}

export const sampleEvents = [{ eventId: 'ev-1', name: '延时回复' }];
export const sampleSessions = [{ id: 'sess-1', name: '消息历史', isDefault: true }];
```

`miaodong-kit/test/graph.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, refsTo, resolveNode, traceLines } from '../src/graph.mjs';
import { compareNodes } from '../src/canvas.mjs';
import { U, sampleCanvas, sampleEvents } from './helpers/fixtures.mjs';

test('buildIndex：连线、事件跳转、引用路径、出入度', () => {
  const index = buildIndex(sampleCanvas(), sampleEvents);
  assert.equal(index.nodes.length, 6);
  const ev = index.edges.find((e) => e.kind === 'event');
  assert.deepEqual([ev.from, ev.to, ev.eventName], [U(4), U(5), '延时回复']);
  assert.deepEqual(index.refs.find((r) => r.from === U(2)), { from: U(2), to: U(1), path: 'data.nodePayload.inputs[0]', dataPath: 'text' });
  const n2 = index.nodes.find((n) => n.id === U(2));
  assert.equal(n2.model, 'doubao');
  assert.equal(n2.in, 1);
  assert.equal(n2.out, 2);
});

test('resolveNode：id / 前缀 / 唯一名字；同名报歧义', () => {
  const canvas = sampleCanvas();
  assert.equal(resolveNode(canvas, U(3)).id, U(3));
  assert.equal(resolveNode(canvas, '00000003').id, U(3));
  assert.equal(resolveNode(canvas, '发送文本').id, U(3));
  assert.throws(() => resolveNode(canvas, '回答生成'), (e) => e.code === 'node_ambiguous' && e.exitCode === 4);
  assert.throws(() => resolveNode(canvas, 'ffff'), (e) => e.code === 'node_not_found');
});

test('traceLines：往下会跨事件跳转，往上能回到触发器', () => {
  const index = buildIndex(sampleCanvas(), sampleEvents);
  const down = traceLines(index, U(1)).join('\n');
  assert.match(down, /▶ 收到文本/);
  assert.match(down, /↳ 回答生成 \(llm-completion\) \[00000002\]/);
  assert.match(down, /⇢ 事件「延时回复」→ 延时回复入口/);
  assert.match(down, /\[00000006\]/);
  const up = traceLines(index, U(3), { direction: 'up' }).join('\n');
  assert.match(up, /▶ 发送文本[\s\S]*↳ 回答生成[\s\S]*↳ 收到文本/);
});

test('refsTo：谁引用了回答生成', () => {
  assert.deepEqual(refsTo(buildIndex(sampleCanvas(), sampleEvents), U(2)).map((r) => r.from), [U(3)]);
});

test('compareNodes：挪位置不算改动，改内容算', () => {
  const a = sampleCanvas();
  const moved = a.map((c) => (c.id === U(6) ? { ...c, position: { x: 1, y: 1 } } : c));
  assert.equal(compareNodes(a, moved).same, true);
  const changed = a.map((c) => (c.id === U(6) ? { ...c, data: { ...c.data, name: '新名字' } } : c));
  assert.deepEqual(compareNodes(a, changed), { onlyA: 0, onlyB: 0, changed: 1, edgesDiffer: 0, same: false });
});
```

`miaodong-kit/test/pull.test.mjs`：

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { U, sampleCanvas, sampleEvents, sampleSessions } from './helpers/fixtures.mjs';

const BOT = '181fc177-0000-4000-8000-000000000000';
const draft = sampleCanvas();
const v400 = sampleCanvas().map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '旧版提示词' } } } : c));

let server;
before(async () => {
  server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: BOT, name: '太极2.0重构' }] : []),
    'GET /api/canvas/get': ({ query }) => (query.canvasId === 'ver-400'
      ? ok({ canvasId: 'ver-400', rawCanvas: v400, version: 'v1.0.400', updatedAt: '2026-09-20T00:00:00.000Z' })
      : ok({ canvasId: 'main-1', rawCanvas: draft, version: 'v1.0.401', updatedAt: '2026-09-23T01:00:00.000Z' })),
    'GET /api/canvas/list-version': () => ok([{ canvasId: 'ver-400', version: 'v1.0.400', name: '400', versionType: 'online' }]),
    'GET /api/session-memory/list': () => ok(sampleSessions),
    'GET /api/canvas/event/list': () => ok(sampleEvents),
  });
});
after(() => server.close());

function homeWithIdentity() {
  const home = tempHome();
  seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return home;
}
const wsDirOf = (stdout) => stdout.match(/工作副本：(.+)/)[1].trim();
const readJsonFile = (file) => JSON.parse(readFileSync(file, 'utf-8'));

test('拉草稿：写 meta / base / 索引，LAST 指向它，事件列表带 eventListFilter=all', async () => {
  const home = homeWithIdentity();
  const r = await runCli(['pull', '--bot', '太极2.0重构'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0重构 \(181fc177\) \/ 草稿/);
  assert.match(r.stdout, /节点 6 · 连线 4 · 事件跳转 1 · 节点引用 2 · 会话变量 1 · 事件 1/);
  const dir = wsDirOf(r.stdout);
  const meta = readJsonFile(join(dir, 'meta.json'));
  assert.equal(meta.mainCanvasId, 'main-1');
  assert.deepEqual(meta.source, { kind: 'draft' });
  assert.equal(meta.draft.updatedAt, '2026-09-23T01:00:00.000Z');
  assert.equal(readJsonFile(join(dir, 'base.json')).canvas.length, draft.length);
  const edges = readFileSync(join(dir, 'index', 'edges.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(edges.some((e) => e.kind === 'event' && e.eventName === '延时回复'));
  assert.equal(readFileSync(join(home, 'md', 'work', 'LAST'), 'utf-8').trim(), dir);
  assert.equal(server.requests.find((q) => q.path === '/api/canvas/event/list').query.eventListFilter, 'all');
});

test('拉版本：base 是该版本，另存草稿，并提示草稿与版本不同', async () => {
  const home = homeWithIdentity();
  const r = await runCli(['pull', '--bot', '太极2.0重构', '--version', '1.0.400'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\/ v1\.0\.400（400）/);
  assert.match(r.stdout, /⚠️ 草稿与 v1\.0\.400 不同：草稿多 0 个节点、少 0 个节点、1 个节点内容不同/);
  const dir = wsDirOf(r.stdout);
  const base = readJsonFile(join(dir, 'base.json'));
  assert.equal(base.canvas.find((c) => c.id === U(2)).data.nodePayload.systemPrompt, '旧版提示词');
  assert.ok(existsSync(join(dir, 'draft.json')));
  assert.equal(readJsonFile(join(dir, 'meta.json')).source.canvasId, 'ver-400');
});

test('事件列表接口不支持时照样拉，给出说明', async () => {
  server.routes['GET /api/canvas/event/list'] = () => ({ status: 404, body: { message: 'Cannot GET', statusCode: 404 } });
  const r = await runCli(['pull', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /读不到事件列表/);
  server.routes['GET /api/canvas/event/list'] = () => ok(sampleEvents);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/graph.test.mjs miaodong-kit/test/pull.test.mjs`
Expected：FAIL（找不到 `../src/graph.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/canvas.mjs`：

```js
// 画布比较的公共口径（diff / 合并 / 回读核对都用它，口径不一致就会出现「预演说没改、推上去却变了」）。
// 「内容」= 节点除 position / size / zIndex 以外的全部字段：拖动节点不算改动——
// 秒懂编辑页打开时就可能重排坐标并自动保存，把坐标算进去会让合并天天冲突。
// 连线按「源节点#端口→目标节点#端口」识别，不看 edge.id。

import { createHash } from 'node:crypto';
import { isEdgeCell, isVisualOnlyCell } from '../../apps/api/lib/miaodong/canvas-derive.ts';
import { stableStringify } from '../../apps/api/lib/miaodong/canvas-content-patch.ts';

export { isEdgeCell, isVisualOnlyCell, stableStringify };

export const LAYOUT_KEYS = ['position', 'size', 'zIndex'];

export function hashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

export function stripLayout(cell) {
  const rest = { ...(cell ?? {}) };
  for (const key of LAYOUT_KEYS) delete rest[key];
  return rest;
}

export function contentKey(cell) {
  return stableStringify(stripLayout(cell));
}

export function edgeKey(edge) {
  return `${edge?.source?.cell ?? ''}#${edge?.source?.port ?? ''}->${edge?.target?.cell ?? ''}#${edge?.target?.port ?? ''}`;
}

const isElement = (cell) => Boolean(cell) && typeof cell === 'object';

export function nodeMap(canvas) {
  return new Map(canvas.filter((c) => isElement(c) && !isEdgeCell(c) && typeof c.id === 'string').map((c) => [c.id, c]));
}

export function edgeMap(canvas) {
  return new Map(canvas.filter((c) => isElement(c) && isEdgeCell(c)).map((e) => [edgeKey(e), e]));
}

export function compareNodes(aCanvas, bCanvas) {
  const a = nodeMap(aCanvas);
  const b = nodeMap(bCanvas);
  let onlyA = 0;
  let onlyB = 0;
  let changed = 0;
  for (const [id, cell] of a) {
    if (!b.has(id)) onlyA++;
    else if (contentKey(cell) !== contentKey(b.get(id))) changed++;
  }
  for (const id of b.keys()) if (!a.has(id)) onlyB++;
  const ea = edgeMap(aCanvas);
  const eb = edgeMap(bCanvas);
  let edgesDiffer = 0;
  for (const key of ea.keys()) if (!eb.has(key)) edgesDiffer++;
  for (const key of eb.keys()) if (!ea.has(key)) edgesDiffer++;
  return { onlyA, onlyB, changed, edgesDiffer, same: onlyA + onlyB + changed + edgesDiffer === 0 };
}
```

`miaodong-kit/src/graph.mjs`：

```js
// 画布的图结构：节点、连线、事件跳转、节点间引用。
// 事件跳转没有真实连线：事件动作节点（canvas-event-action）与同 eventId 的事件触发节点
// （canvas-event-trigger）之间靠 eventId 关联。老懂的 trace 不走这层，会话里 AI 手补过 210 条。
// 引用 = 任意层级里带 referenceNodeId 的对象（inputs、规则条件、写回操作……），
// 只扫顶层 inputs 会漏掉约 28%（实测）。

import { EXIT, MdError, usage } from './errors.mjs';
import { isEdgeCell, isVisualOnlyCell } from './canvas.mjs';
import { shortId } from './output.mjs';

const isElement = (cell) => Boolean(cell) && typeof cell === 'object';

export function businessNodes(canvas) {
  return canvas.filter((c) => isElement(c) && !isEdgeCell(c) && !isVisualOnlyCell(c));
}

export function edgesOf(canvas) {
  return canvas.filter((c) => isElement(c) && isEdgeCell(c));
}

export function nodeName(cell) {
  const name = cell?.data?.name;
  return typeof name === 'string' && name ? name : '(无名)';
}

export function nodeType(cell) {
  return String(cell?.data?.type ?? cell?.shape ?? '?');
}

export function collectRefs(node) {
  const refs = [];
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.referenceNodeId === 'string' && value.referenceNodeId) {
      refs.push({ from: node.id, to: value.referenceNodeId, path, dataPath: typeof value.dataPath === 'string' ? value.dataPath : null });
    }
    for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') walk(child, `${path}.${key}`);
  };
  walk(node.data, 'data');
  return refs;
}

export function buildIndex(canvas, events = []) {
  const nodes = businessNodes(canvas);
  const eventName = new Map((events ?? []).map((e) => [e?.eventId, e?.name]));
  const edges = edgesOf(canvas).map((e) => ({
    kind: 'wire', from: e.source?.cell ?? null, fromPort: e.source?.port ?? null, to: e.target?.cell ?? null, toPort: e.target?.port ?? null,
  }));
  const triggersByEvent = new Map();
  for (const n of nodes) {
    const eventId = n.data?.nodePayload?.eventId;
    if (n.data?.type === 'canvas-event-trigger' && eventId) {
      if (!triggersByEvent.has(eventId)) triggersByEvent.set(eventId, []);
      triggersByEvent.get(eventId).push(n.id);
    }
  }
  for (const n of nodes) {
    const eventId = n.data?.nodePayload?.eventId;
    if (n.data?.type !== 'canvas-event-action' || !eventId) continue;
    for (const trigger of triggersByEvent.get(eventId) ?? []) {
      edges.push({ kind: 'event', from: n.id, fromPort: null, to: trigger, toPort: null, eventId, eventName: eventName.get(eventId) ?? null });
    }
  }
  const inDeg = new Map();
  const outDeg = new Map();
  for (const e of edges) {
    if (e.from) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    if (e.to) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  return {
    nodes: nodes.map((n) => ({
      id: n.id, name: nodeName(n), type: nodeType(n), category: n.data?.category ?? null,
      model: n.data?.nodePayload?.modelType ?? null, in: inDeg.get(n.id) ?? 0, out: outDeg.get(n.id) ?? 0,
    })),
    edges,
    refs: nodes.flatMap(collectRefs),
  };
}

export function resolveNode(canvas, query) {
  const q = String(query ?? '').trim();
  if (!q) throw usage('缺节点（id、id 前缀或唯一的节点名）');
  const nodes = businessNodes(canvas);
  const exact = nodes.filter((n) => n.id === q);
  const byPrefix = exact.length ? exact : nodes.filter((n) => typeof n.id === 'string' && n.id.startsWith(q));
  const hits = byPrefix.length ? byPrefix : nodes.filter((n) => nodeName(n) === q);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new MdError('node_not_found', `没有节点「${q}」`, { exitCode: EXIT.TARGET });
  const lines = hits.slice(0, 20).map((n) => `  - ${shortId(n.id)} ${nodeName(n)} (${nodeType(n)})`).join('\n');
  throw new MdError('node_ambiguous', `「${q}」匹配到 ${hits.length} 个节点：\n${lines}`, { exitCode: EXIT.TARGET, hint: '用 id 前缀指定' });
}

export function traceLines(index, startId, { direction = 'down', depth = 6, maxLines = 200 } = {}) {
  const byId = new Map(index.nodes.map((n) => [n.id, n]));
  const adjacency = new Map();
  for (const e of index.edges) {
    const [from, to] = direction === 'down' ? [e.from, e.to] : [e.to, e.from];
    if (!from || !to) continue;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ next: to, edge: e });
  }
  const lines = [];
  const seen = new Set();
  const label = (id) => {
    const n = byId.get(id);
    return n ? `${n.name} (${n.type}) [${shortId(id)}]` : `(不存在的节点) [${shortId(id)}]`;
  };
  const walk = (id, level, via) => {
    if (lines.length >= maxLines) return;
    const lead = level === 0 ? '▶ ' : via?.kind === 'event' ? `⇢ 事件「${via.eventName ?? shortId(via.eventId)}」→ ` : '↳ ';
    const prefix = `${'  '.repeat(level)}${lead}`;
    if (seen.has(id)) {
      lines.push(`${prefix}${label(id)} …见上`);
      return;
    }
    seen.add(id);
    lines.push(`${prefix}${label(id)}`);
    const next = adjacency.get(id) ?? [];
    if (level >= depth) {
      if (next.length) lines.push(`${'  '.repeat(level + 1)}…（超过 --depth ${depth}）`);
      return;
    }
    for (const { next: child, edge } of next) walk(child, level + 1, edge);
  };
  walk(startId, 0, null);
  if (lines.length >= maxLines) lines.push(`…（超过 ${maxLines} 行，已截断）`);
  return lines;
}

export function refsTo(index, nodeId) {
  return index.refs.filter((r) => r.to === nodeId);
}
```

`miaodong-kit/src/workspace.mjs`：

```js
// 工作副本：一次 pull 一个目录，记下「从哪拉的、拉的是什么」。之后改动、推送都只认这里记的目标，
// 不存在「默认智能体」——会话里推错 / 看错智能体的事故都源于默认值。
// 目录：$MD_HOME/work/<区>/<智能体 id 前 8 位>/<draft 或版本号>-<时间>/
//   meta.json   目标与来源；base.json { canvas, sessions, events } 基线；
//   draft.json  以版本为底时拉取那一刻的草稿；after.json 改后快照；
//   index/      nodes / edges / refs 的 jsonl，反映当前状态（有 after 就用 after），给 jq 查。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, MdError, usage } from './errors.mjs';
import { ensureDir, mdHome, readJson, writeJson } from './home.mjs';
import { buildIndex } from './graph.mjs';
import { loadIdentities } from './identity.mjs';
import { targetLine } from './output.mjs';

export function workRoot() {
  return join(mdHome(), 'work');
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');

export function createWorkspace(target, label) {
  const parent = join(workRoot(), safe(target.identityKey), safe(target.botId.slice(0, 8)));
  const name = `${safe(label)}-${stamp()}`;
  let dir = join(parent, name);
  for (let i = 2; existsSync(dir); i++) dir = join(parent, `${name}-${i}`);
  ensureDir(dir);
  return dir;
}

export function writeIndex(dir, envelope) {
  const index = buildIndex(envelope.canvas, envelope.events);
  const indexDir = ensureDir(join(dir, 'index'));
  const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(join(indexDir, 'nodes.jsonl'), jsonl(index.nodes));
  writeFileSync(join(indexDir, 'edges.jsonl'), jsonl(index.edges));
  writeFileSync(join(indexDir, 'refs.jsonl'), jsonl(index.refs));
  return index;
}

export function writeWorkspace(dir, { meta, base, draft = null }) {
  writeJson(join(dir, 'meta.json'), meta);
  writeJson(join(dir, 'base.json'), base);
  if (draft) writeJson(join(dir, 'draft.json'), draft);
  writeIndex(dir, base);
  writeFileSync(join(ensureDir(workRoot()), 'LAST'), `${dir}\n`);
}

export function resolveWorkspaceDir(args) {
  if (typeof args.ws === 'string') {
    const dir = resolve(args.ws);
    if (!existsSync(join(dir, 'meta.json'))) throw usage(`不是工作副本：${dir}`);
    return dir;
  }
  const lastFile = join(workRoot(), 'LAST');
  if (!existsSync(lastFile)) {
    throw new MdError('no_workspace', '还没有工作副本', { exitCode: EXIT.TARGET, hint: '先 md pull --bot <智能体>' });
  }
  const dir = readFileSync(lastFile, 'utf-8').trim();
  if (!existsSync(join(dir, 'meta.json'))) {
    throw new MdError('no_workspace', `最近的工作副本已不存在：${dir}`, { exitCode: EXIT.TARGET, hint: '重新 md pull' });
  }
  return dir;
}

export function loadWorkspace(args) {
  const dir = resolveWorkspaceDir(args);
  const meta = readJson(join(dir, 'meta.json'));
  const base = readJson(join(dir, 'base.json'));
  const after = readJson(join(dir, 'after.json'), null);
  return { dir, meta, base, after, current: after ?? base };
}

export function versionLabelOf(meta) {
  if (meta.source?.kind !== 'version') return '草稿';
  return `${meta.source.version}${meta.source.name ? `（${meta.source.name}）` : ''}`;
}

export function wsLine(ws) {
  return `${targetLine({ ...ws.meta, versionLabel: versionLabelOf(ws.meta) })}${ws.after ? ' · 含未推送改动' : ''}`;
}

export function targetFromMeta(meta) {
  const identity = loadIdentities()[meta.identityKey];
  if (!identity) {
    throw new MdError('no_identity', `这属于「${meta.regionLabel}」，但本机没有这个区的身份`, {
      exitCode: EXIT.AUTH,
      hint: `md auth snippet ${meta.origin}`,
    });
  }
  return {
    identityKey: meta.identityKey, regionLabel: meta.regionLabel, orgId: meta.orgId, orgName: meta.orgName,
    botId: meta.botId, botName: meta.botName, identity,
  };
}
```

`miaodong-kit/src/api.mjs` 末尾追加：

```js
// 会话变量 / 事件列表在个别区版本不齐；取不到返回 null，由调用方说明，不中断拉取
async function optionalArray(promise) {
  try {
    return asArray((await promise)?.data);
  } catch (error) {
    if (error instanceof MdError && error.code === 'auth_expired') throw error;
    return null;
  }
}

export function listSessions(identity, orgId, botId) {
  return optionalArray(request(identity, '/api/session-memory/list', { query: { botId, orgId } }));
}

export function listEvents(identity, orgId, botId) {
  // 固定带 eventListFilter=all：不带时是否包含隐藏事件没有确认
  return optionalArray(request(identity, '/api/canvas/event/list', { query: { botId, orgId, eventListFilter: 'all' } }));
}
```

`miaodong-kit/src/commands/pull.mjs`：

```js
import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { getCanvas, listEvents, listSessions, listVersions } from '../api.mjs';
import { compareNodes, hashOf } from '../canvas.mjs';
import { buildIndex } from '../graph.mjs';
import { resolveBot, resolveVersion, targetArgs } from '../target.mjs';
import { createWorkspace, versionLabelOf, writeWorkspace } from '../workspace.mjs';
import { out, targetLine } from '../output.mjs';

export const pull = {
  summary: '把草稿或指定版本拉到新的工作副本（连同会话变量和事件）',
  usage: 'md pull --bot <智能体> [--org <企业>] [--region <区>] [--version <版本号或名称>]',
  async run(args) {
    const target = await resolveBot(targetArgs(args));
    const { identity, orgId, botId } = target;
    const draft = await getCanvas(identity, orgId, botId);
    let canvas = draft.rawCanvas;
    let source = { kind: 'draft' };
    const versionQuery = strArg(args, 'version');
    if (versionQuery) {
      const version = resolveVersion(await listVersions(identity, orgId, draft.canvasId), versionQuery);
      canvas = (await getCanvas(identity, orgId, botId, version.canvasId)).rawCanvas;
      source = { kind: 'version', version: version.version, name: version.name, canvasId: version.canvasId };
    }
    const [sessions, events] = await Promise.all([listSessions(identity, orgId, botId), listEvents(identity, orgId, botId)]);
    const notes = [];
    if (sessions === null) notes.push('读不到会话变量列表（这个区的接口不支持），自检会少会话类检查');
    if (events === null) notes.push('读不到事件列表（这个区的接口不支持），事件名显示不出来');
    const base = { canvas, sessions: sessions ?? [], events: events ?? [] };
    const meta = {
      schema: 1,
      identityKey: target.identityKey, regionLabel: target.regionLabel, origin: identity.origin,
      orgId, orgName: target.orgName, botId, botName: target.botName,
      mainCanvasId: draft.canvasId,
      source,
      draft: { updatedAt: draft.updatedAt, version: draft.version, hash: hashOf(draft.rawCanvas) },
      pulledAt: new Date().toISOString(),
      notes,
    };
    const dir = createWorkspace(target, source.kind === 'version' ? source.version : 'draft');
    writeWorkspace(dir, { meta, base, draft: source.kind === 'version' ? { canvas: draft.rawCanvas } : null });

    const index = buildIndex(base.canvas, base.events);
    const wires = index.edges.filter((e) => e.kind === 'wire').length;
    const types = new Map();
    for (const n of index.nodes) types.set(n.type, (types.get(n.type) ?? 0) + 1);
    out(targetLine({ ...target, versionLabel: versionLabelOf(meta) }));
    out(`工作副本：${dir}`);
    out(`节点 ${index.nodes.length} · 连线 ${wires} · 事件跳转 ${index.edges.length - wires} · 节点引用 ${index.refs.length} · 会话变量 ${base.sessions.length} · 事件 ${base.events.length}`);
    out(`节点类型：${[...types].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([type, n]) => `${type} ${n}`).join('、')}`);
    if (source.kind === 'version') {
      const d = compareNodes(canvas, draft.rawCanvas);
      out(d.same
        ? `草稿与 ${source.version} 内容一致。`
        : `⚠️ 草稿与 ${source.version} 不同：草稿多 ${d.onlyB} 个节点、少 ${d.onlyA} 个节点、${d.changed} 个节点内容不同、连线差 ${d.edgesDiffer} 条。推送时要选 --onto-draft 或 --replace-draft。`);
    }
    for (const n of notes) out(`（${n}）`);
    out(`查询：jq 查 ${dir}/index/{nodes,edges,refs}.jsonl；看细节用 md node / md trace / md refs`);
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs` 整体替换为：

```js
// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { auth } from './auth.mjs';
import { bots } from './bots.mjs';
import { orgs } from './orgs.mjs';
import { pull } from './pull.mjs';
import { versions } from './versions.mjs';

export const COMMANDS = { auth, orgs, bots, versions, pull };
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/graph.test.mjs miaodong-kit/test/pull.test.mjs`
Expected：8 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src miaodong-kit/test/helpers/fixtures.mjs miaodong-kit/test/graph.test.mjs miaodong-kit/test/pull.test.mjs
git commit -m "feat(md): md pull——草稿或指定版本拉进工作副本，带事件跳转与全图引用索引"
```

---

### Task 8：看节点 / 上下游 / 引用（md node / md trace / md refs）

**Files:**
- Create: `miaodong-kit/src/commands/inspect.mjs`、`miaodong-kit/test/inspect.test.mjs`
- Modify: `miaodong-kit/test/helpers/seed.mjs`（追加 `SEED_BOT`、`seedWorkspace`）、`src/commands/index.mjs`

**Interfaces:**
- Consumes：`loadWorkspace`、`wsLine`、`buildIndex`、`resolveNode`、`traceLines`、`refsTo`、`nodeName`、`describeNode`（来自 `miaodong-kit/lib/summarize.mjs`）、`intArg`
- Produces：
  - 命令 `node`、`trace`、`refs`：都支持 `--ws <dir>` 和 `--base`（默认看当前状态，也就是有 after 时看 after）
  - 测试 helper：`SEED_BOT`；`seedWorkspace(home, { canvas, sessions?, events?, meta?, origin? }) → dir`，会设置 `process.env.MD_HOME`

- [ ] **Step 1：写失败的测试**

在 `miaodong-kit/test/helpers/seed.mjs` 末尾追加：

```js
export const SEED_BOT = '181fc177-0000-4000-8000-000000000000';

// 直接写出一个工作副本（不走网络）。会把本进程的 MD_HOME 指向 home/md。
export async function seedWorkspace(home, { canvas, sessions = [], events = [], meta = {}, origin = 'http://127.0.0.1:9' } = {}) {
  process.env.MD_HOME = join(home, 'md');
  const { createWorkspace, writeWorkspace } = await import('../../src/workspace.mjs');
  const target = { identityKey: 'k1', regionLabel: '测试区', orgId: 'org-1', orgName: '兴趣岛平台', botId: SEED_BOT, botName: '太极2.0重构' };
  const dir = createWorkspace(target, 'draft');
  writeWorkspace(dir, {
    meta: {
      schema: 1, ...target, origin, mainCanvasId: 'main-1', source: { kind: 'draft' },
      draft: { updatedAt: '', version: '', hash: '' }, pulledAt: new Date().toISOString(), notes: [], ...meta,
    },
    base: { canvas, sessions, events },
  });
  return dir;
}
```

`miaodong-kit/test/inspect.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { sampleCanvas, sampleEvents } from './helpers/fixtures.mjs';

async function seeded() {
  const home = tempHome();
  await seedWorkspace(home, { canvas: sampleCanvas(), events: sampleEvents });
  return home;
}

test('md node：目标行、完整 prompt、上下游与被引用计数', async () => {
  const r = await runCli(['node', '00000002'], { home: await seeded() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0重构 \(181fc177\) \/ 草稿/);
  assert.match(r.stdout, /你是客服。\\n请礼貌回答。/);
  assert.match(r.stdout, /上游 1 条 · 下游 2 条 · 被 1 处引用/);
});

test('md node：同名报歧义，退出码 4', async () => {
  const r = await runCli(['node', '回答生成'], { home: await seeded() });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /匹配到 2 个节点/);
});

test('md trace --up：回溯到触发器', async () => {
  const r = await runCli(['trace', '发送文本', '--up'], { home: await seeded() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /▶ 发送文本[\s\S]*↳ 回答生成[\s\S]*↳ 收到文本/);
});

test('md refs：列出引用方与字段路径', async () => {
  const r = await runCli(['refs', '00000002'], { home: await seeded() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /回答生成 \[00000002\] 被引用 1 处/);
  assert.match(r.stdout, /发送文本 \[00000003\] data\.nodePayload\.inputs\[0\] ← output/);
});

test('没有工作副本时退出码 4 并提示先 pull', async () => {
  const r = await runCli(['trace', 'x'], { home: tempHome() });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /还没有工作副本/);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/inspect.test.mjs`
Expected：FAIL（`未知命令：node`，退出码 2）

- [ ] **Step 3：写实现**

`miaodong-kit/src/commands/inspect.mjs`：

```js
import { intArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { describeNode } from '../../lib/summarize.mjs';
import { buildIndex, nodeName, refsTo, resolveNode, traceLines } from '../graph.mjs';
import { loadWorkspace, wsLine } from '../workspace.mjs';
import { out, shortId } from '../output.mjs';

function envelopeOf(ws, args) {
  return args.base ? ws.base : ws.current;
}

function scopeNote(ws, args) {
  if (args.base) return '（看的是拉取时的基线）';
  return ws.after ? '（看的是改后的状态，加 --base 看基线）' : '';
}

export const node = {
  summary: '看一个节点的完整配置（含 prompt 全文）',
  usage: 'md node <节点 id / id 前缀 / 唯一名字> [--ws <工作副本>] [--base]',
  async run(args) {
    const ws = loadWorkspace(args);
    const envelope = envelopeOf(ws, args);
    const target = resolveNode(envelope.canvas, args._[0]);
    const index = buildIndex(envelope.canvas, envelope.events);
    const info = index.nodes.find((n) => n.id === target.id);
    out(`${wsLine(ws)}${scopeNote(ws, args)}`);
    out(describeNode(envelope.canvas, target.id));
    out('');
    out(`上游 ${info.in} 条 · 下游 ${info.out} 条 · 被 ${refsTo(index, target.id).length} 处引用（md refs ${shortId(target.id)}）`);
    return EXIT.OK;
  },
};

export const trace = {
  summary: '沿连线和事件跳转看上下游',
  usage: 'md trace <节点> [--up] [--depth 6] [--ws <工作副本>] [--base]',
  async run(args) {
    const ws = loadWorkspace(args);
    const envelope = envelopeOf(ws, args);
    const start = resolveNode(envelope.canvas, args._[0]);
    out(`${wsLine(ws)}${scopeNote(ws, args)}`);
    const lines = traceLines(buildIndex(envelope.canvas, envelope.events), start.id, {
      direction: args.up ? 'up' : 'down',
      depth: intArg(args, 'depth', 6),
    });
    for (const line of lines) out(line);
    return EXIT.OK;
  },
};

export const refs = {
  summary: '谁引用了这个节点（全图扫描，给出字段路径）',
  usage: 'md refs <节点> [--ws <工作副本>] [--base]',
  async run(args) {
    const ws = loadWorkspace(args);
    const envelope = envelopeOf(ws, args);
    const target = resolveNode(envelope.canvas, args._[0]);
    const index = buildIndex(envelope.canvas, envelope.events);
    const names = new Map(index.nodes.map((n) => [n.id, n.name]));
    const hits = refsTo(index, target.id);
    out(`${wsLine(ws)}${scopeNote(ws, args)}`);
    out(`${nodeName(target)} [${shortId(target.id)}] 被引用 ${hits.length} 处：`);
    for (const r of hits) out(`  - ${names.get(r.from) ?? '(未知)'} [${shortId(r.from)}] ${r.path}${r.dataPath ? ` ← ${r.dataPath}` : ''}`);
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs` 整体替换为：

```js
// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { auth } from './auth.mjs';
import { bots } from './bots.mjs';
import { node, refs, trace } from './inspect.mjs';
import { orgs } from './orgs.mjs';
import { pull } from './pull.mjs';
import { versions } from './versions.mjs';

export const COMMANDS = { auth, orgs, bots, versions, pull, node, trace, refs };
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/inspect.test.mjs`
Expected：5 个测试全部 PASS

Run: `npm run check:md`
Expected：到目前为止的全部测试 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/commands miaodong-kit/test/inspect.test.mjs miaodong-kit/test/helpers/seed.mjs
git commit -m "feat(md): md node / trace / refs——完整配置、跨事件上下游、全图引用"
```

---

### Task 9：检查点——真机只读验证（主会话与用户一起做，不交给子 agent）

**Files:** 不预设；发现契约偏差时，在对应模块加回归测试再修

读的部分直接打到用户的真实秒懂上。写的部分动手之前，先确认接口契约和假秒懂一致。全程只读，不调用任何写接口。

- [ ] **Step 1：构建并确认用 Node 18 能跑**

```bash
npm run md:build
node --version            # 用户 shell 的默认 node，应为 v18.x
node miaodong-kit/dist/md.mjs --version
```
Expected：`md <提交号>@<日期>`，没有任何警告

- [ ] **Step 2：取身份（需要用户操作）**

问用户要秒懂控制台域名，然后运行 `node miaodong-kit/dist/md.mjs auth snippet <域名>`，把输出**原样**转给用户。用户说「好了」后运行：

```bash
node miaodong-kit/dist/md.mjs auth import
node miaodong-kit/dist/md.mjs auth list
node miaodong-kit/dist/md.mjs orgs
```
Expected：导入成功，企业列表和用户在秒懂里看到的一致。如果只有一个企业，而用户其实有多个，说明 `localStorage.user` 里没有 `orgs`。这时记下来，让用户切到其他企业再取一次，确认能合并进来。

- [ ] **Step 3：跑读命令，逐项核对**

用用户常用的智能体（例如「太极2.0 质检革新版」）：

```bash
node miaodong-kit/dist/md.mjs bots 太极
node miaodong-kit/dist/md.mjs versions --bot "太极2.0 质检革新版"
node miaodong-kit/dist/md.mjs pull --bot "太极2.0 质检革新版" --version <用户指定的版本>
node miaodong-kit/dist/md.mjs trace <某个回答生成节点前缀> --depth 3
node miaodong-kit/dist/md.mjs refs <某节点前缀>
node miaodong-kit/dist/md.mjs node <某节点前缀>
```

逐项核对，每一项都记下结论：
- `versions` 标的「启用」「灰度」和秒懂页面是否一致；如果 `basic-info` 取不到，记下是哪个区。
- `pull` 的会话变量数、事件数是否大于 0；如果事件列表是空的，查 `/api/canvas/event/list` 的真实响应形状。
- `edges.jsonl` 里 `kind:"event"` 的条数，是否和该画布「事件动作节点数」同一数量级（实测约 256 条）。
- 以版本为底拉取时，「草稿与版本差 N 个」和用户的认知是否一致。

- [ ] **Step 4：修偏差**

每个偏差都走这三步：在对应的 `*.test.mjs` 里用真实响应形状（只保留字段名和结构，脱掉真实内容）加一个失败用例，然后修实现，再跑 `npm run check:md`。

没有偏差就跳过这一步。

- [ ] **Step 5：提交（仅在 Step 4 有改动时）**

```bash
git add <改动的具体文件>
git commit -m "fix(md): 按真机响应修正 <接口> 的解析"
```

---

### Task 10：改动脚本与 md apply

**Files:**
- Create: `miaodong-kit/src/transform.mjs`、`src/commands/apply.mjs`、`miaodong-kit/test/transform.test.mjs`、`miaodong-kit/test/apply.test.mjs`
- Modify: `miaodong-kit/src/workspace.mjs`（加 `saveAfter`、`clearAfter`、`listTransforms`、`recordTransform`、`saveMeta`）、`src/commands/index.mjs`

**Interfaces:**
- Consumes：`businessNodes`、`edgesOf`、`nodeName`、`resolveNode`、`isEdgeCell`、`stableStringify`、`compareNodes`、`loadWorkspace`、`wsLine`、`readJson`
- Produces：
  - `parsePath(path) → (string|number)[]`
  - `getPath(obj, path)`、`setPath(obj, path, value)`：路径不存在时报错；只有最后一段允许新建 key；数组保持数组
  - `createHelpers(ctx, log) → h`，其中 h 包括：`nodes()`、`edges()`、`select(pred)`、`node(query)`、`name(node)`、`get`、`has`、`set`、`replaceOnce`、`replaceAll(…, { expect })`、`insertAfter`、`insertBefore`、`expectCount(list, n, what?)`、`retargetRefs({ from, to, fromDataPath?, toDataPath?, expect? }) → n`、`cloneNode(query, { name?, offset? }) → node`、`portOf(node, group, index?)`、`addEdge(fromNode, fromPort, toNode, toPort) → edge`、`removeEdges(pred, { expect? }) → n`、`removeNode(query)`、`log(msg)`
  - `runTransform(file, envelope) → { envelope, log }`：不修改入参，改了会话变量或事件时报 `unsupported`
  - workspace 新增：
    - `saveAfter(dir, envelope)`
    - `clearAfter(dir, base)`
    - `listTransforms(dir) → string[]`：按序号排好
    - `recordTransform(dir, file) → dest`：保存为 `transforms/NNN-<原文件名>`
    - `saveMeta(dir, meta)`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/transform.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHelpers, getPath, parsePath, runTransform, setPath } from '../src/transform.mjs';
import { tempHome } from './helpers/run-cli.mjs';
import { U, sampleCanvas } from './helpers/fixtures.mjs';

function helpersFor(canvas) {
  const ctx = { canvas, sessions: [], events: [] };
  const log = [];
  return { h: createHelpers(ctx, log), ctx, log };
}

test('路径：两种数组写法都认；数组不会被改成对象；不存在的路径报错', () => {
  const obj = { data: { nodePayload: { inputs: [{ referenceNodeId: 'a' }, { referenceNodeId: 'b' }] } } };
  assert.equal(getPath(obj, 'data.nodePayload.inputs[1].referenceNodeId'), 'b');
  assert.equal(getPath(obj, 'data.nodePayload.inputs.1.referenceNodeId'), 'b');
  setPath(obj, 'data.nodePayload.inputs.0.referenceNodeId', 'z');
  assert.ok(Array.isArray(obj.data.nodePayload.inputs));
  assert.equal(obj.data.nodePayload.inputs.length, 2);
  assert.equal(obj.data.nodePayload.inputs[0].referenceNodeId, 'z');
  assert.throws(() => setPath(obj, 'data.nodePayload.nope.x', 1), /路径不存在/);
  assert.throws(() => getPath(obj, 'data.nodePayload.inputs.x'), /要用下标/);
  assert.deepEqual(parsePath('a[0].b.2'), ['a', 0, 'b', '2']);
});

test('replaceOnce 必须恰好命中 1 次；insertAfter 基于它；replaceAll 带数量守卫', () => {
  const { h } = helpersFor(sampleCanvas());
  const n = h.node('00000002');
  h.insertAfter(n, 'data.nodePayload.systemPrompt', '你是客服。', '\n发热≠发烧。');
  assert.equal(n.data.nodePayload.systemPrompt, '你是客服。\n发热≠发烧。\n请礼貌回答。');
  assert.throws(() => h.replaceOnce(n, 'data.nodePayload.systemPrompt', '不存在的锚点', 'x'), /出现 0 次/);
  h.set(n, 'data.nodePayload.systemPrompt', 'A A');
  assert.throws(() => h.replaceOnce(n, 'data.nodePayload.systemPrompt', 'A', 'B'), /出现 2 次/);
  assert.equal(h.replaceAll(n, 'data.nodePayload.systemPrompt', 'A', 'B', { expect: 2 }), 2);
  assert.throws(() => h.replaceAll(n, 'data.nodePayload.systemPrompt', 'B', 'C', { expect: 3 }), /预期 3 次/);
});

test('select + expectCount：批量换模型', () => {
  const { h, log } = helpersFor(sampleCanvas());
  const llms = h.expectCount(h.select((node) => node.data.type === 'llm-completion'), 2, 'LLM 节点');
  for (const node of llms) h.set(node, 'data.nodePayload.modelType', 'gpt-5.6-luna');
  assert.equal(log.length, 2);
  assert.throws(() => h.expectCount(llms, 3), /有 2 个，预期 3 个/);
});

test('retargetRefs：改引用并校验命中数', () => {
  const { h, ctx } = helpersFor(sampleCanvas());
  assert.equal(h.retargetRefs({ from: U(2), to: U(6), toDataPath: 'output', expect: 1 }), 1);
  const send = ctx.canvas.find((c) => c.id === U(3));
  assert.equal(send.data.nodePayload.inputs[0].referenceNodeId, U(6));
  assert.throws(() => h.retargetRefs({ from: U(2), to: U(6), expect: 1 }), /命中 0 处，预期 1 处/);
});

test('cloneNode + portOf + addEdge；removeNode 连带删线', () => {
  const { h, ctx } = helpersFor(sampleCanvas());
  const copy = h.cloneNode('00000002', { name: '回答生成（副本）' });
  assert.notEqual(copy.id, U(2));
  assert.notEqual(copy.ports.items[0].id, 'p2-in');
  assert.equal(copy.data.name, '回答生成（副本）');
  const trigger = h.node('00000001');
  const edge = h.addEdge(trigger, h.portOf(trigger, 'right'), copy, h.portOf(copy, 'left'));
  assert.equal(edge.shape, 'custom-curve-edge');
  assert.deepEqual(edge.attrs, { line: { stroke: '#999' } });
  assert.throws(() => h.addEdge(copy, 'no-port', copy, h.portOf(copy, 'left')), /没有端口 no-port/);
  const count = ctx.canvas.length;
  h.removeNode('00000003');
  assert.equal(ctx.canvas.length, count - 2);
});

test('runTransform：在副本上跑、不改入参；改会话变量被拒；脚本抛错被包装', async () => {
  const dir = tempHome();
  const envelope = { canvas: sampleCanvas(), sessions: [], events: [] };
  const good = join(dir, 'good.mjs');
  writeFileSync(good, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.modelType', 'luna'); };\n");
  const { envelope: next, log } = await runTransform(good, envelope);
  assert.equal(next.canvas.find((c) => c.id === U(2)).data.nodePayload.modelType, 'luna');
  assert.equal(envelope.canvas.find((c) => c.id === U(2)).data.nodePayload.modelType, 'doubao');
  assert.equal(log.length, 1);
  const bad = join(dir, 'bad.mjs');
  writeFileSync(bad, "export default ({ sessions }) => { sessions.push({ id: 'x' }); };\n");
  await assert.rejects(runTransform(bad, envelope), (e) => e.code === 'unsupported');
  const boom = join(dir, 'boom.mjs');
  writeFileSync(boom, "export default () => { throw new Error('锚点没找到'); };\n");
  await assert.rejects(runTransform(boom, envelope), (e) => e.code === 'transform_failed' && /锚点没找到/.test(e.message));
});
```

`miaodong-kit/test/apply.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { U, sampleCanvas, sampleEvents } from './helpers/fixtures.mjs';

test('md apply：写 after、记录脚本、可叠加；--reset 回到基线', async () => {
  const home = tempHome();
  const dir = await seedWorkspace(home, { canvas: sampleCanvas(), events: sampleEvents });
  const swap = join(home, 'swap.mjs');
  writeFileSync(swap, "export default ({ h }) => { for (const n of h.expectCount(h.select((n) => n.data.type === 'llm-completion'), 2)) h.set(n, 'data.nodePayload.modelType', 'luna'); };\n");
  const r = await runCli(['apply', swap], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /含未推送改动/);
  assert.match(r.stdout, /改了 2 个、连线变化 0 条/);
  assert.ok(existsSync(join(dir, 'transforms', '001-swap.mjs')));

  const prompt = join(home, 'prompt.mjs');
  writeFileSync(prompt, "export default ({ h }) => { h.insertAfter(h.node('00000002'), 'data.nodePayload.systemPrompt', '你是客服。', '\\n发热≠发烧。'); };\n");
  assert.equal((await runCli(['apply', prompt], { home })).code, 0);
  const after = JSON.parse(readFileSync(join(dir, 'after.json'), 'utf-8'));
  const n2 = after.canvas.find((c) => c.id === U(2)).data.nodePayload;
  assert.equal(n2.modelType, 'luna');
  assert.match(n2.systemPrompt, /发热≠发烧/);
  assert.ok(existsSync(join(dir, 'transforms', '002-prompt.mjs')));

  const reset = await runCli(['apply', '--reset'], { home });
  assert.equal(reset.code, 0, reset.stderr);
  assert.equal(existsSync(join(dir, 'after.json')), false);
  assert.equal(existsSync(join(dir, 'transforms')), false);
});

test('md apply：脚本失败时不写 after，退出码 1', async () => {
  const home = tempHome();
  const dir = await seedWorkspace(home, { canvas: sampleCanvas(), events: sampleEvents });
  const broken = join(home, 'broken.mjs');
  writeFileSync(broken, "export default ({ h }) => { h.replaceOnce(h.node('00000002'), 'data.nodePayload.systemPrompt', '没有这句', 'x'); };\n");
  const r = await runCli(['apply', broken], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /出现 0 次/);
  assert.equal(existsSync(join(dir, 'after.json')), false);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/transform.test.mjs miaodong-kit/test/apply.test.mjs`
Expected：FAIL（找不到 `../src/transform.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/transform.mjs`：

```js
// 改动脚本：AI 写一个 .mjs，默认导出 (ctx) => void，在 ctx.canvas 上改；md 负责守卫和记录。
// 为什么用脚本而不是直接改 JSON 或写 ops 清单：同一套修改要在 v400 / v401 / 另一个智能体上各做一遍
// （会话里真实发生过），脚本表达的是「规则」，能在新基线上重跑；按节点 id 记的 ops 换个版本就会漏掉新冒出来的同类节点。
// 所有 helper 都「宁可报错也不猜」：锚点命中次数不对、路径不存在、数量不符都直接失败。
// 路径支持 a[0].b 与 a.0.b；绝不把数组改成对象（老懂 workflow-patch 的 setByPath 有这个 bug）。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, MdError, usage } from './errors.mjs';
import { isEdgeCell, stableStringify } from './canvas.mjs';
import { businessNodes, edgesOf, nodeName, resolveNode } from './graph.mjs';

export class TransformError extends MdError {
  constructor(message) {
    super('transform_failed', message, { exitCode: EXIT.ERROR });
  }
}

export function parsePath(path) {
  const tokens = [];
  for (const part of String(path).split('.')) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let match;
    while ((match = re.exec(part))) tokens.push(match[2] !== undefined ? Number(match[2]) : match[1]);
  }
  if (tokens.length === 0) throw new TransformError(`路径为空：${path}`);
  return tokens;
}

function stepInto(container, token, path) {
  if (Array.isArray(container)) {
    const index = typeof token === 'number' ? token : /^\d+$/.test(token) ? Number(token) : Number.NaN;
    if (!Number.isInteger(index)) throw new TransformError(`路径 ${path}：这一层是数组，要用下标`);
    return { key: index, exists: index < container.length };
  }
  if (container && typeof container === 'object') {
    const key = String(token);
    return { key, exists: Object.prototype.hasOwnProperty.call(container, key) };
  }
  throw new TransformError(`路径 ${path}：中途遇到的不是对象或数组`);
}

export function getPath(obj, path) {
  let current = obj;
  for (const token of parsePath(path)) {
    const { key, exists } = stepInto(current, token, path);
    if (!exists) throw new TransformError(`路径不存在：${path}`);
    current = current[key];
  }
  return current;
}

export function setPath(obj, path, value) {
  const tokens = parsePath(path);
  let current = obj;
  for (const token of tokens.slice(0, -1)) {
    const { key, exists } = stepInto(current, token, path);
    if (!exists) throw new TransformError(`路径不存在：${path}`);
    current = current[key];
  }
  const { key } = stepInto(current, tokens[tokens.length - 1], path);
  if (Array.isArray(current) && key > current.length) throw new TransformError(`路径 ${path}：数组下标越界`);
  current[key] = value;
}

function countOccurrences(text, find) {
  if (!find) throw new TransformError('查找内容不能为空');
  let count = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) count++;
  return count;
}

function preview(text) {
  const flat = String(text).replace(/\s+/g, ' ');
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat;
}

export function createHelpers(ctx, log) {
  const label = (node) => `${nodeName(node)} [${String(node.id).slice(0, 8)}]`;
  const textAt = (node, path) => {
    const value = getPath(node, path);
    if (typeof value !== 'string') throw new TransformError(`${label(node)} 的 ${path} 不是文本`);
    return value;
  };
  const removeWhere = (pred) => {
    let removed = 0;
    for (let i = ctx.canvas.length - 1; i >= 0; i--) {
      if (pred(ctx.canvas[i])) {
        ctx.canvas.splice(i, 1);
        removed++;
      }
    }
    return removed;
  };
  const isEdge = (cell) => Boolean(cell) && typeof cell === 'object' && isEdgeCell(cell);

  const h = {
    nodes: () => businessNodes(ctx.canvas),
    edges: () => edgesOf(ctx.canvas),
    select: (pred) => businessNodes(ctx.canvas).filter(pred),
    node: (query) => resolveNode(ctx.canvas, query),
    name: (node) => nodeName(node),
    get: (node, path) => getPath(node, path),
    has(node, path) {
      try {
        getPath(node, path);
        return true;
      } catch {
        return false;
      }
    },
    set(node, path, value) {
      setPath(node, path, value);
      log.push(`改 ${label(node)} 的 ${path}`);
    },
    replaceOnce(node, path, find, replacement) {
      const text = textAt(node, path);
      const count = countOccurrences(text, find);
      if (count !== 1) throw new TransformError(`${label(node)} 的 ${path} 里「${preview(find)}」出现 ${count} 次，replaceOnce 要求恰好 1 次`);
      setPath(node, path, text.replace(find, () => replacement));
      log.push(`替换 ${label(node)} 的 ${path}`);
    },
    replaceAll(node, path, find, replacement, { expect } = {}) {
      const text = textAt(node, path);
      const count = countOccurrences(text, find);
      if (expect !== undefined && count !== expect) throw new TransformError(`${label(node)} 的 ${path} 里「${preview(find)}」出现 ${count} 次，预期 ${expect} 次`);
      if (count > 0) setPath(node, path, text.split(find).join(replacement));
      log.push(`替换 ${label(node)} 的 ${path} ×${count}`);
      return count;
    },
    insertAfter(node, path, anchor, insertion) {
      h.replaceOnce(node, path, anchor, anchor + insertion);
    },
    insertBefore(node, path, anchor, insertion) {
      h.replaceOnce(node, path, anchor, insertion + anchor);
    },
    expectCount(list, count, what = '选中的节点') {
      if (list.length !== count) throw new TransformError(`${what}有 ${list.length} 个，预期 ${count} 个`);
      return list;
    },
    retargetRefs({ from, to, fromDataPath, toDataPath, expect }) {
      let count = 0;
      const walk = (value) => {
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        if (!value || typeof value !== 'object') return;
        if (value.referenceNodeId === from && (fromDataPath === undefined || value.dataPath === fromDataPath)) {
          value.referenceNodeId = to;
          if (toDataPath !== undefined) value.dataPath = toDataPath;
          count++;
        }
        for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
      };
      for (const node of businessNodes(ctx.canvas)) walk(node.data);
      if (expect !== undefined && count !== expect) {
        throw new TransformError(`把引用从 ${String(from).slice(0, 8)} 改到 ${String(to).slice(0, 8)}：命中 ${count} 处，预期 ${expect} 处`);
      }
      log.push(`改引用 ${String(from).slice(0, 8)} → ${String(to).slice(0, 8)} ×${count}`);
      return count;
    },
    cloneNode(query, { name, offset = { x: 40, y: 40 } } = {}) {
      const source = resolveNode(ctx.canvas, query);
      const copy = JSON.parse(JSON.stringify(source));
      copy.id = randomUUID();
      for (const port of copy.ports?.items ?? []) port.id = randomUUID();
      if (copy.position) copy.position = { x: (copy.position.x ?? 0) + offset.x, y: (copy.position.y ?? 0) + offset.y };
      if (name && copy.data) copy.data.name = name;
      ctx.canvas.push(copy);
      log.push(`复制 ${label(source)} → ${label(copy)}`);
      return copy;
    },
    portOf(node, group, index = 0) {
      const ports = (node.ports?.items ?? []).filter((port) => port.group === group);
      if (!ports[index]) throw new TransformError(`${label(node)} 没有第 ${index + 1} 个 ${group} 端口`);
      return ports[index].id;
    },
    addEdge(fromNode, fromPort, toNode, toPort) {
      const hasPort = (node, id) => (node.ports?.items ?? []).some((port) => port.id === id);
      if (!hasPort(fromNode, fromPort)) throw new TransformError(`${label(fromNode)} 没有端口 ${fromPort}`);
      if (!hasPort(toNode, toPort)) throw new TransformError(`${label(toNode)} 没有端口 ${toPort}`);
      // 连线样式照抄画布里已有的一条，避免编辑器渲染出无样式的线
      const template = edgesOf(ctx.canvas)[0];
      const edge = {
        ...(template?.attrs ? { attrs: JSON.parse(JSON.stringify(template.attrs)) } : {}),
        ...(template?.connector ? { connector: JSON.parse(JSON.stringify(template.connector)) } : {}),
        shape: template?.shape ?? 'custom-curve-edge',
        id: randomUUID(),
        zIndex: template?.zIndex ?? 0,
        source: { cell: fromNode.id, port: fromPort },
        target: { cell: toNode.id, port: toPort },
      };
      ctx.canvas.push(edge);
      log.push(`连线 ${label(fromNode)} → ${label(toNode)}`);
      return edge;
    },
    removeEdges(pred, { expect } = {}) {
      const count = removeWhere((cell) => isEdge(cell) && pred(cell));
      if (expect !== undefined && count !== expect) throw new TransformError(`删连线命中 ${count} 条，预期 ${expect} 条`);
      log.push(`删连线 ×${count}`);
      return count;
    },
    removeNode(query) {
      const node = resolveNode(ctx.canvas, query);
      const edges = removeWhere((cell) => isEdge(cell) && (cell.source?.cell === node.id || cell.target?.cell === node.id));
      removeWhere((cell) => cell === node);
      log.push(`删节点 ${label(node)}（连带 ${edges} 条连线）`);
    },
    log(message) {
      log.push(String(message));
    },
  };
  return h;
}

export async function runTransform(file, envelope) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw usage(`找不到改动脚本：${abs}`);
  const ctx = JSON.parse(JSON.stringify(envelope));
  const log = [];
  // 带时间戳参数绕开 ESM 模块缓存：同一进程里重跑（rebase）必须读到最新文件
  const mod = await import(`${pathToFileURL(abs).href}?t=${Date.now()}`);
  if (typeof mod.default !== 'function') throw usage(`${abs} 需要 export default (ctx) => { ... }`);
  let result;
  try {
    result = await mod.default({ canvas: ctx.canvas, sessions: ctx.sessions, events: ctx.events, h: createHelpers(ctx, log) });
  } catch (error) {
    if (error instanceof MdError) throw error;
    throw new TransformError(`改动脚本出错：${error?.message ?? String(error)}`);
  }
  if (Array.isArray(result)) ctx.canvas = result;
  const unchanged = (key) => stableStringify(ctx[key] ?? []) === stableStringify(envelope[key] ?? []);
  if (!unchanged('sessions') || !unchanged('events')) {
    throw new MdError('unsupported', '第 1 步只能改画布，不能改会话变量或事件', { exitCode: EXIT.USAGE });
  }
  return { envelope: ctx, log };
}
```

`miaodong-kit/src/workspace.mjs`：把 `node:fs` 的 import 改成
`import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';`，
`node:path` 的 import 改成 `import { basename, join, resolve } from 'node:path';`，然后在文件末尾追加：

```js
export function saveMeta(dir, meta) {
  writeJson(join(dir, 'meta.json'), meta);
}

export function saveAfter(dir, envelope) {
  writeJson(join(dir, 'after.json'), envelope);
  writeIndex(dir, envelope);
}

export function clearAfter(dir, base) {
  rmSync(join(dir, 'after.json'), { force: true });
  rmSync(join(dir, 'transforms'), { recursive: true, force: true });
  writeIndex(dir, base);
}

export function listTransforms(dir) {
  const transformsDir = join(dir, 'transforms');
  if (!existsSync(transformsDir)) return [];
  return readdirSync(transformsDir).filter((name) => name.endsWith('.mjs')).sort().map((name) => join(transformsDir, name));
}

export function recordTransform(dir, file) {
  const transformsDir = ensureDir(join(dir, 'transforms'));
  const dest = join(transformsDir, `${String(listTransforms(dir).length + 1).padStart(3, '0')}-${basename(file)}`);
  copyFileSync(file, dest);
  return dest;
}
```

`miaodong-kit/src/commands/apply.mjs`：

```js
import { resolve } from 'node:path';
import { strArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { readJson } from '../home.mjs';
import { compareNodes } from '../canvas.mjs';
import { runTransform } from '../transform.mjs';
import { clearAfter, loadWorkspace, recordTransform, saveAfter, saveMeta, wsLine } from '../workspace.mjs';
import { out } from '../output.mjs';

export const apply = {
  summary: '在工作副本上执行改动脚本（可叠加），产出改后快照',
  usage: [
    'md apply <改动脚本.mjs> [--ws <工作副本>]   脚本写法见 skill 的 references/transforms.md',
    'md apply --json <画布.json>                 整份替换（手改，不能 rebase 重放）',
    'md apply --reset                            丢弃全部本地改动，回到拉取时的状态',
  ].join('\n'),
  async run(args) {
    const ws = loadWorkspace(args);
    if (args.reset) {
      clearAfter(ws.dir, ws.base);
      saveMeta(ws.dir, { ...ws.meta, handEdited: false });
      out(wsLine({ ...ws, after: null }));
      out('已丢弃本地改动，回到拉取时的状态。');
      return EXIT.OK;
    }
    let next;
    let log = [];
    const jsonFile = strArg(args, 'json');
    if (jsonFile) {
      const data = readJson(resolve(jsonFile));
      const canvas = Array.isArray(data) ? data : data?.canvas ?? data?.rawCanvas;
      if (!Array.isArray(canvas)) throw usage(`${jsonFile} 里没有画布数组（要么是数组本身，要么带 canvas / rawCanvas 字段）`);
      next = { ...ws.current, canvas };
      saveMeta(ws.dir, { ...ws.meta, handEdited: true });
      log = [`整份替换为 ${jsonFile}（手改，不能 rebase 重放）`];
    } else {
      const file = args._[0];
      if (!file) throw usage('用法：md apply <改动脚本.mjs> | --json <画布.json> | --reset');
      ({ envelope: next, log } = await runTransform(file, ws.current));
      recordTransform(ws.dir, resolve(file));
    }
    saveAfter(ws.dir, next);
    const d = compareNodes(ws.base.canvas, next.canvas);
    out(wsLine({ ...ws, after: next }));
    for (const line of log) out(`  · ${line}`);
    out(`相对拉取时：新增 ${d.onlyB} 个节点、删除 ${d.onlyA} 个、改了 ${d.changed} 个、连线变化 ${d.edgesDiffer} 条`);
    out('下一步：md diff 看具体改了什么，md check 自检');
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs` 整体替换为：

```js
// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { apply } from './apply.mjs';
import { auth } from './auth.mjs';
import { bots } from './bots.mjs';
import { node, refs, trace } from './inspect.mjs';
import { orgs } from './orgs.mjs';
import { pull } from './pull.mjs';
import { versions } from './versions.mjs';

export const COMMANDS = { auth, orgs, bots, versions, pull, node, trace, refs, apply };
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/transform.test.mjs miaodong-kit/test/apply.test.mjs`
Expected：8 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src miaodong-kit/test/transform.test.mjs miaodong-kit/test/apply.test.mjs
git commit -m "feat(md): 改动脚本 helper 与 md apply——锚点唯一、数量守卫、数组安全、可叠加可重放"
```

---

### Task 11：改动清单（md diff）

**Files:**
- Create: `miaodong-kit/src/diff.mjs`、`src/commands/diff.mjs`、`miaodong-kit/test/diff.test.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`

**Interfaces:**
- Consumes：`nodeMap`、`edgeMap`、`contentKey`、`stripLayout`、`stableStringify`、`isVisualOnlyCell`、`nodeName`、`nodeType`、`shortId`、`loadWorkspace`、`wsLine`、`intArg`
- Produces：
  - `kindOf(v) → 'array'|'null'|typeof`
  - `fieldChanges(a, b) → [{ path, kind: 'text'|'value'|'typechange'|'added'|'removed', before, after }]`
  - `diffEnvelopes(base, after) → { added: cell[], removed: cell[], changed: [{ id, name, type, decoration, fields }], edgesAdded: key[], edgesRemoved: key[], layoutOnly, empty }`
  - `lineDiff(before, after, context=1) → string[]`
  - `nameMapOf(...canvases) → Map<id, name>`
  - `renderDiff(d, { names, limit }) → string[]`
  - `diffToJson(d)`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/diff.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffEnvelopes, fieldChanges, lineDiff, nameMapOf, renderDiff } from '../src/diff.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { U, node, sampleCanvas, sampleEvents } from './helpers/fixtures.mjs';

function editedCanvas() {
  return sampleCanvas()
    .map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '你是客服。\n发热≠发烧。\n请礼貌回答。' } } } : c))
    .map((c) => (c.id === U(6) ? { ...c, position: { x: 5, y: 5 } } : c))
    .filter((c) => c.id !== U(103))
    .concat([node(7, { name: '新节点' })]);
}

test('lineDiff：只显示改动行和前后各 1 行', () => {
  assert.deepEqual(lineDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne'), ['  …', '  b', '- c', '+ X', '  d', '  …']);
});

test('fieldChanges：数组被改成对象时标成 typechange', () => {
  assert.deepEqual(fieldChanges({ inputs: [1, 2] }, { inputs: { 0: 1 } }).map((f) => [f.path, f.kind]), [['inputs', 'typechange']]);
  assert.deepEqual(fieldChanges({ a: 1 }, { a: 1, b: 2 }).map((f) => [f.path, f.kind]), [['b', 'added']]);
});

test('diffEnvelopes：新增 / 改动 / 删连线；挪位置只计数', () => {
  const d = diffEnvelopes({ canvas: sampleCanvas() }, { canvas: editedCanvas() });
  assert.deepEqual(d.added.map((c) => c.id), [U(7)]);
  assert.deepEqual(d.changed.map((c) => c.id), [U(2)]);
  assert.equal(d.changed[0].fields[0].kind, 'text');
  assert.equal(d.layoutOnly, 1);
  assert.equal(d.edgesRemoved.length, 1);
  assert.equal(d.empty, false);
});

test('renderDiff：给人看的清单', () => {
  const base = sampleCanvas();
  const after = editedCanvas();
  const text = renderDiff(diffEnvelopes({ canvas: base }, { canvas: after }), { names: nameMapOf(base, after) }).join('\n');
  assert.match(text, /新增节点 1 · 删除节点 0 · 改动节点 1 · 新增连线 0 · 删除连线 1 · 仅挪位置 1/);
  assert.match(text, /~ 回答生成 \(llm-completion\) \[00000002\]/);
  assert.match(text, /data\.nodePayload\.systemPrompt（文本 12 → 19 字）/);
  assert.match(text, /\+ 发热≠发烧。/);
  assert.match(text, /- 连线 回答生成 \[00000002\] → 触发延时回复 \[00000004\]/);
});

test('md diff：在工作副本上输出清单；--json 可解析', async () => {
  const home = tempHome();
  await seedWorkspace(home, { canvas: sampleCanvas(), events: sampleEvents });
  const script = join(home, 'p.mjs');
  writeFileSync(script, "export default ({ h }) => { h.insertAfter(h.node('00000002'), 'data.nodePayload.systemPrompt', '你是客服。', '\\n发热≠发烧。'); };\n");
  await runCli(['apply', script], { home });
  const r = await runCli(['diff'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\+ 发热≠发烧。/);
  const j = await runCli(['diff', '--json'], { home });
  assert.equal(JSON.parse(j.stdout).changed[0].id, U(2));
});
```

注：`'你是客服。\n请礼貌回答。'` 是 12 个字符，改后 `'你是客服。\n发热≠发烧。\n请礼貌回答。'` 是 19 个字符（按 JS 字符串长度算，换行符各计 1）。

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/diff.test.mjs`
Expected：FAIL（找不到 `../src/diff.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/diff.mjs`：

```js
// 给人看的改动清单：用户问「你改了啥」时直接贴这个（会话里这类追问每会话约 3.5 次）。
// 口径与合并一致：节点按 id，连线按端点；坐标 / 尺寸变化不算改动，只计数。
// 长文本（prompt）按行比，只显示改动行和前后各 1 行；类型突变（数组 → 对象）单独标出来。

import { contentKey, edgeMap, isVisualOnlyCell, nodeMap, stableStringify, stripLayout } from './canvas.mjs';
import { nodeName, nodeType } from './graph.mjs';
import { shortId } from './output.mjs';

export const kindOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

export function fieldChanges(a, b, path = '', list = []) {
  if (a === undefined || b === undefined) {
    if (a !== b) list.push({ path, kind: a === undefined ? 'added' : 'removed', before: a, after: b });
    return list;
  }
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) {
    const structural = ['array', 'object'].includes(ka) || ['array', 'object'].includes(kb);
    list.push({ path, kind: structural ? 'typechange' : 'value', before: a, after: b });
    return list;
  }
  if (ka === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) fieldChanges(a[key], b[key], path ? `${path}.${key}` : key, list);
    return list;
  }
  if (ka === 'array') {
    if (stableStringify(a) === stableStringify(b)) return list;
    for (let i = 0; i < Math.max(a.length, b.length); i++) fieldChanges(a[i], b[i], `${path}[${i}]`, list);
    return list;
  }
  if (a !== b) {
    const long = typeof a === 'string' && typeof b === 'string' && (a.includes('\n') || b.includes('\n') || a.length > 80 || b.length > 80);
    list.push({ path, kind: long ? 'text' : 'value', before: a, after: b });
  }
  return list;
}

export function diffEnvelopes(base, after) {
  const a = nodeMap(base.canvas);
  const b = nodeMap(after.canvas);
  const added = [];
  const removed = [];
  const changed = [];
  let layoutOnly = 0;
  for (const [id, cell] of b) if (!a.has(id)) added.push(cell);
  for (const [id, cell] of a) {
    const next = b.get(id);
    if (!next) {
      removed.push(cell);
      continue;
    }
    if (contentKey(cell) === contentKey(next)) {
      if (stableStringify(cell) !== stableStringify(next)) layoutOnly++;
      continue;
    }
    changed.push({ id, name: nodeName(next), type: nodeType(next), decoration: isVisualOnlyCell(next), fields: fieldChanges(stripLayout(cell), stripLayout(next)) });
  }
  const ea = edgeMap(base.canvas);
  const eb = edgeMap(after.canvas);
  const edgesAdded = [...eb.keys()].filter((key) => !ea.has(key));
  const edgesRemoved = [...ea.keys()].filter((key) => !eb.has(key));
  const empty = !added.length && !removed.length && !changed.length && !edgesAdded.length && !edgesRemoved.length;
  return { added, removed, changed, edgesAdded, edgesRemoved, layoutOnly, empty };
}

export function lineDiff(before, after, context = 1) {
  const x = before.split('\n');
  const y = after.split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000) return [`- （原文 ${n} 行）`, `+ （新文 ${m} 行，太长不逐行比）`];
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { ops.push([' ', x[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push(['-', x[i]]); i++; }
    else { ops.push(['+', y[j]]); j++; }
  }
  while (i < n) ops.push(['-', x[i++]]);
  while (j < m) ops.push(['+', y[j++]]);
  const keep = ops.map((op, k) => op[0] !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o[0] !== ' '));
  const lines = [];
  let skipped = false;
  ops.forEach((op, k) => {
    if (keep[k]) {
      lines.push(`${op[0]} ${op[1]}`);
      skipped = false;
    } else if (!skipped) {
      lines.push('  …');
      skipped = true;
    }
  });
  return lines;
}

export function nameMapOf(...canvases) {
  const names = new Map();
  for (const canvas of canvases) for (const [id, cell] of nodeMap(canvas)) names.set(id, nodeName(cell));
  return names;
}

function brief(value) {
  if (value === undefined) return '（无）';
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function edgeLabel(key, names) {
  const [from, to] = key.split('->');
  const nodeLabel = (part) => {
    const id = part.split('#')[0];
    return `${names.get(id) ?? '?'} [${shortId(id)}]`;
  };
  return `${nodeLabel(from)} → ${nodeLabel(to)}`;
}

export function renderDiff(d, { names = new Map(), limit = 400 } = {}) {
  if (d.empty) return [`没有内容改动${d.layoutOnly ? `（只有 ${d.layoutOnly} 个节点挪了位置）` : ''}`];
  const lines = [
    `新增节点 ${d.added.length} · 删除节点 ${d.removed.length} · 改动节点 ${d.changed.length} · 新增连线 ${d.edgesAdded.length} · 删除连线 ${d.edgesRemoved.length}${d.layoutOnly ? ` · 仅挪位置 ${d.layoutOnly}` : ''}`,
  ];
  for (const cell of d.added) lines.push(`+ 新增 ${nodeName(cell)} (${nodeType(cell)}) [${shortId(cell.id)}]`);
  for (const cell of d.removed) lines.push(`- 删除 ${nodeName(cell)} (${nodeType(cell)}) [${shortId(cell.id)}]`);
  for (const nodeChange of d.changed) {
    lines.push(`~ ${nodeChange.name} (${nodeChange.type}) [${shortId(nodeChange.id)}]`);
    for (const field of nodeChange.fields) {
      if (field.kind === 'text') {
        lines.push(`    ${field.path}（文本 ${field.before.length} → ${field.after.length} 字）：`);
        for (const line of lineDiff(field.before, field.after)) lines.push(`      ${line}`);
      } else if (field.kind === 'typechange') {
        lines.push(`    ⚠️ ${field.path}：类型从 ${kindOf(field.before)} 变成 ${kindOf(field.after)}`);
      } else {
        lines.push(`    ${field.path}：${brief(field.before)} → ${brief(field.after)}`);
      }
    }
  }
  for (const key of d.edgesAdded) lines.push(`+ 连线 ${edgeLabel(key, names)}`);
  for (const key of d.edgesRemoved) lines.push(`- 连线 ${edgeLabel(key, names)}`);
  if (lines.length > limit) return [...lines.slice(0, limit), `…（共 ${lines.length} 行，已截断；--limit 调大，或 --json 看全部）`];
  return lines;
}

export function diffToJson(d) {
  const brief2 = (cell) => ({ id: cell.id, name: nodeName(cell), type: nodeType(cell) });
  return { added: d.added.map(brief2), removed: d.removed.map(brief2), changed: d.changed, edgesAdded: d.edgesAdded, edgesRemoved: d.edgesRemoved, layoutOnly: d.layoutOnly };
}
```

`miaodong-kit/src/commands/diff.mjs`：

```js
import { intArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { diffEnvelopes, diffToJson, nameMapOf, renderDiff } from '../diff.mjs';
import { loadWorkspace, wsLine } from '../workspace.mjs';
import { out } from '../output.mjs';

export const diff = {
  summary: '看工作副本相对拉取时改了什么（字段级，prompt 按行）',
  usage: 'md diff [--ws <工作副本>] [--limit 400] [--json]',
  async run(args) {
    const ws = loadWorkspace(args);
    const d = diffEnvelopes(ws.base, ws.current);
    if (args.json) {
      out(JSON.stringify(diffToJson(d), null, 2));
      return EXIT.OK;
    }
    out(wsLine(ws));
    for (const line of renderDiff(d, { names: nameMapOf(ws.base.canvas, ws.current.canvas), limit: intArg(args, 'limit', 400) })) out(line);
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs`：import 区加 `import { diff } from './diff.mjs';`，`COMMANDS` 改为 `{ auth, orgs, bots, versions, pull, node, trace, refs, apply, diff }`。

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/diff.test.mjs`
Expected：5 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/diff.mjs miaodong-kit/src/commands miaodong-kit/test/diff.test.mjs
git commit -m "feat(md): md diff——字段级改动清单，prompt 逐行，标出类型突变"
```

---

### Task 12：自检（md check）

**Files:**
- Create: `miaodong-kit/src/check.mjs`、`src/commands/check.mjs`、`miaodong-kit/test/check.test.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`

**Interfaces:**
- Consumes：
  - `validateWorkflowJsonCandidateWithWarnings`、`collectChangedScopeNodeIds`（来自 `apps/api/lib/chat-agent/validate-workflow.ts`）
  - `analyzeWorkflowRisks`（来自 `packages/shared/src/workflow-risk/index.ts`）
  - `diffEnvelopes`、`kindOf`、`buildIndex`、`edgesOf`、`edgeKey`、`isEdgeCell`、`shortId`
- Produces：
  - `newRisks(baseEnv, afterEnv) → { added: RiskFinding[], resolved: number, error? }`：按多重集比对，key 为 `code|rule|nodeId|edgeId|规范化 path`，不含 message
  - `danglingProblems(env) → string[]`
  - `runCheck(baseEnv, afterEnv) → { errors: string[], warnings: string[], notes: string[] }`
  - 命令 `check`：有 errors 时退出码 1

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/check.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheck } from '../src/check.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { U, sampleCanvas, sampleEvents, sampleSessions } from './helpers/fixtures.mjs';

const env = (canvas) => ({ canvas, sessions: sampleSessions, events: sampleEvents });
const patchNode = (canvas, id, fn) => canvas.map((c) => (c.id === id ? fn(structuredClone(c)) : c));

test('只改 prompt 文本：没有新问题', () => {
  const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.systemPrompt += '\n发热≠发烧。'; return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('数组被改成对象：报错', () => {
  const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.inputs = { 0: c.data.nodePayload.inputs[0] }; return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.errors.some((e) => /类型从 array 变成了 object/.test(e)), r.errors.join('\n'));
});

test('删掉被引用的节点：新增悬空引用报错', () => {
  const after = sampleCanvas().filter((c) => c.id !== U(1) && c.id !== U(101));
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.errors.some((e) => /引用了不存在的节点 00000001/.test(e)), r.errors.join('\n'));
});

test('清空模型：新增风险 H1 进 warnings', () => {
  const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.modelType = ''; return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.warnings.some((w) => /\[H1\].*未配置 modelType/.test(w)), r.warnings.join('\n'));
});

test('触发器原本就缺 nodePayload：只改它的名字不算这次引入的问题', () => {
  const base = patchNode(sampleCanvas(), U(1), (c) => { delete c.data.nodePayload; return c; });
  const after = patchNode(base, U(1), (c) => { c.data.name = '收到文本（改名）'; return c; });
  const r = runCheck(env(base), env(after));
  assert.deepEqual(r.errors, []);
  assert.ok(r.notes.some((n) => /原本就有/.test(n)));
});

test('md check：有问题时退出码 1', async () => {
  const home = tempHome();
  await seedWorkspace(home, { canvas: sampleCanvas(), sessions: sampleSessions, events: sampleEvents });
  const script = join(home, 'bad.mjs');
  writeFileSync(script, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.inputs', { 0: 'x' }); };\n");
  await runCli(['apply', script], { home });
  const r = await runCli(['check'], { home });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /❌ .*类型从 array 变成了 object/);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/check.test.mjs`
Expected：FAIL（找不到 `../src/check.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/check.mjs`：

```js
// 自检只报「这次新引入的」问题：真实画布上原本就有几百条风险（实测 779 条），全报等于没报。
// - 类型突变：数组被改成对象这类改坏，老懂的校验器和风险分析都查不出来（实测），这里单独查；
// - 悬空：连线端点、节点引用指向不存在的节点，只报 after 有而 base 没有的；
// - 结构校验：用老懂的「按改动范围校验」；范围内原本就不合格（触发器没有 nodePayload 等）的不算新问题；
// - 风险：前后各跑一遍全图（D 组可达性是全图语义），按「code|rule|节点|连线|路径」多重集比对。
//   key 不含 message：message 里带节点名，改个名就会全变成「新风险」。

import { collectChangedScopeNodeIds, validateWorkflowJsonCandidateWithWarnings } from '../../apps/api/lib/chat-agent/validate-workflow.ts';
import { analyzeWorkflowRisks } from '../../packages/shared/src/workflow-risk/index.ts';
import { edgeKey, isEdgeCell } from './canvas.mjs';
import { diffEnvelopes, kindOf } from './diff.mjs';
import { buildIndex, edgesOf } from './graph.mjs';
import { shortId } from './output.mjs';

function flattenRisks(report) {
  return [...report.nodeGroups.flatMap((group) => group.findings), ...report.globalFindings];
}

function riskKey(finding) {
  const path = String(finding.path ?? '').replace(/^canvas\[\d+\]/, 'canvas[*]').replace(/^events\[\d+\]/, 'events[*]');
  return [finding.code, finding.rule, finding.nodeId ?? '', finding.edgeId ?? '', path].join('|');
}

export function newRisks(baseEnv, afterEnv) {
  const before = analyzeWorkflowRisks(baseEnv);
  const after = analyzeWorkflowRisks(afterEnv);
  if (!before.ok || !after.ok) return { added: [], resolved: 0, error: after.parseError ?? before.parseError };
  const count = (list) => {
    const counts = new Map();
    for (const finding of list) counts.set(riskKey(finding), (counts.get(riskKey(finding)) ?? 0) + 1);
    return counts;
  };
  const baseCounts = count(flattenRisks(before));
  const seen = new Map();
  const added = [];
  for (const finding of flattenRisks(after)) {
    const key = riskKey(finding);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > (baseCounts.get(key) ?? 0)) added.push(finding);
  }
  const afterCounts = count(flattenRisks(after));
  let resolved = 0;
  for (const [key, n] of baseCounts) resolved += Math.max(0, n - (afterCounts.get(key) ?? 0));
  return { added, resolved };
}

export function danglingProblems(env) {
  const ids = new Set(env.canvas.filter((c) => c && typeof c === 'object' && !isEdgeCell(c)).map((c) => c.id));
  const problems = [];
  for (const edge of edgesOf(env.canvas)) {
    if (!ids.has(edge.source?.cell) || !ids.has(edge.target?.cell)) problems.push(`连线 ${edgeKey(edge)} 的端点节点不存在`);
  }
  for (const ref of buildIndex(env.canvas, env.events).refs) {
    if (!ids.has(ref.to)) problems.push(`节点 [${shortId(ref.from)}] 的 ${ref.path} 引用了不存在的节点 ${shortId(ref.to)}`);
  }
  return problems;
}

export function runCheck(baseEnv, afterEnv) {
  const errors = [];
  const warnings = [];
  const notes = [];

  for (const change of diffEnvelopes(baseEnv, afterEnv).changed) {
    for (const field of change.fields) {
      if (field.kind === 'typechange') {
        errors.push(`${change.name} [${shortId(change.id)}] 的 ${field.path} 类型从 ${kindOf(field.before)} 变成了 ${kindOf(field.after)}（多半是改坏了）`);
      }
    }
  }

  const baseDangling = new Set(danglingProblems(baseEnv));
  for (const problem of danglingProblems(afterEnv)) if (!baseDangling.has(problem)) errors.push(problem);

  const scope = collectChangedScopeNodeIds(baseEnv, afterEnv);
  if (!scope) {
    notes.push('有节点缺 id，跳过结构校验');
  } else if (scope.size > 0) {
    const afterReport = validateWorkflowJsonCandidateWithWarnings(afterEnv, scope);
    const baseReport = validateWorkflowJsonCandidateWithWarnings(baseEnv, scope);
    if (afterReport.hardError) {
      if (afterReport.hardError === baseReport.hardError) notes.push(`改动范围内原本就有的问题（不是这次引入的）：${afterReport.hardError}`);
      else errors.push(afterReport.hardError);
    } else {
      const old = new Set(baseReport.warnings);
      for (const warning of afterReport.warnings) if (!old.has(warning)) warnings.push(warning);
    }
  }

  const risks = newRisks(baseEnv, afterEnv);
  if (risks.error) notes.push(`风险分析失败：${risks.error}`);
  for (const finding of risks.added) {
    const line = `[${finding.code}] ${finding.message}`;
    if (finding.severity === 'error') errors.push(line);
    else if (finding.severity === 'warn') warnings.push(line);
    else notes.push(line);
  }
  if (risks.resolved) notes.push(`顺带消除了 ${risks.resolved} 条原有风险`);
  return { errors, warnings, notes };
}
```

`miaodong-kit/src/commands/check.mjs`：

```js
import { EXIT } from '../errors.mjs';
import { runCheck } from '../check.mjs';
import { loadWorkspace, wsLine } from '../workspace.mjs';
import { out } from '../output.mjs';

export const check = {
  summary: '自检改动：只报这次新引入的问题（类型突变、悬空、结构校验、新增风险）',
  usage: 'md check [--ws <工作副本>]',
  async run(args) {
    const ws = loadWorkspace(args);
    out(wsLine(ws));
    if (!ws.after) {
      out('还没有改动（先 md apply）。');
      return EXIT.OK;
    }
    const result = runCheck(ws.base, ws.after);
    if (!result.errors.length && !result.warnings.length) out('✅ 没发现新问题');
    for (const e of result.errors) out(`❌ ${e}`);
    for (const w of result.warnings) out(`⚠️ ${w}`);
    for (const n of result.notes) out(`· ${n}`);
    return result.errors.length ? EXIT.ERROR : EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs`：import 区加 `import { check } from './check.mjs';`，`COMMANDS` 改为 `{ auth, orgs, bots, versions, pull, node, trace, refs, apply, diff, check }`。

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/check.test.mjs`
Expected：6 个测试全部 PASS。如果「只改 prompt 文本：没有新问题」失败，说明风险 key 里混进了会随 prompt 变化的字段：打印 `r.warnings` 看是哪条规则，再把那个字段从 `riskKey` 的规范化里去掉，不要放宽断言。

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/check.mjs miaodong-kit/src/commands miaodong-kit/test/check.test.mjs
git commit -m "feat(md): md check——只报新引入的问题，覆盖数组被改成对象、悬空引用、新增风险"
```

---

### Task 13：元素级三方合并

**Files:**
- Create: `miaodong-kit/src/merge.mjs`、`miaodong-kit/test/merge.test.mjs`

**Interfaces:**
- Consumes：`nodeMap`、`edgeMap`、`edgeKey`、`contentKey`、`LAYOUT_KEYS`、`isEdgeCell`、`stableStringify`、`nodeName`
- Produces：`mergeCanvas(baseCanvas, oursCanvas, theirsCanvas) → { canvas, conflicts: [{ id, name, reason }], ours: { changed: id[], added: id[], removed: id[] }, theirs: { changed, added, removed }, noop }`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/merge.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCanvas } from '../src/merge.mjs';
import { U, edge, node, sampleCanvas } from './helpers/fixtures.mjs';

const patch = (canvas, id, fn) => canvas.map((c) => (c.id === id ? fn(structuredClone(c)) : c));
const prompt = (text) => (c) => { c.data.nodePayload.systemPrompt = text; return c; };
const find = (canvas, id) => canvas.find((c) => c.id === id);

test('都没改：noop', () => {
  const m = mergeCanvas(sampleCanvas(), sampleCanvas(), sampleCanvas());
  assert.equal(m.noop, true);
  assert.deepEqual(m.conflicts, []);
});

test('我改 2、别人改 6：两边都保留', () => {
  const ours = patch(sampleCanvas(), U(2), prompt('我的'));
  const theirs = patch(sampleCanvas(), U(6), prompt('别人的'));
  const m = mergeCanvas(sampleCanvas(), ours, theirs);
  assert.deepEqual(m.conflicts, []);
  assert.equal(find(m.canvas, U(2)).data.nodePayload.systemPrompt, '我的');
  assert.equal(find(m.canvas, U(6)).data.nodePayload.systemPrompt, '别人的');
  assert.deepEqual(m.ours.changed, [U(2)]);
  assert.equal(m.theirs.changed, 1);
  assert.equal(m.noop, false);
});

test('双方改同一节点：内容不同 → 冲突；内容相同 → 不冲突', () => {
  const m1 = mergeCanvas(sampleCanvas(), patch(sampleCanvas(), U(2), prompt('A')), patch(sampleCanvas(), U(2), prompt('B')));
  assert.equal(m1.conflicts.length, 1);
  assert.match(m1.conflicts[0].reason, /你和别人都改了这个节点/);
  const m2 = mergeCanvas(sampleCanvas(), patch(sampleCanvas(), U(2), prompt('A')), patch(sampleCanvas(), U(2), prompt('A')));
  assert.deepEqual(m2.conflicts, []);
});

test('别人挪了位置、我改了内容：用我的内容 + 别人的位置', () => {
  const ours = patch(sampleCanvas(), U(2), prompt('我的'));
  const theirs = patch(sampleCanvas(), U(2), (c) => { c.position = { x: 999, y: 999 }; return c; });
  const m = mergeCanvas(sampleCanvas(), ours, theirs);
  assert.deepEqual(m.conflicts, []);
  assert.equal(find(m.canvas, U(2)).data.nodePayload.systemPrompt, '我的');
  assert.deepEqual(find(m.canvas, U(2)).position, { x: 999, y: 999 });
});

test('我删节点但别人改了它 → 冲突；别人删了我改的节点 → 冲突', () => {
  const ours = sampleCanvas().filter((c) => c.id !== U(6) && c.id !== U(104));
  const m1 = mergeCanvas(sampleCanvas(), ours, patch(sampleCanvas(), U(6), prompt('别人的')));
  assert.ok(m1.conflicts.some((c) => /你删了这个节点/.test(c.reason)));
  const theirs = sampleCanvas().filter((c) => c.id !== U(2));
  const m2 = mergeCanvas(sampleCanvas(), patch(sampleCanvas(), U(2), prompt('我的')), theirs);
  assert.ok(m2.conflicts.some((c) => /被别人删了/.test(c.reason)));
});

test('我新增节点和连线，别人没动：并进去；合并后端点消失 → 冲突', () => {
  const ours = sampleCanvas().concat([node(7, { name: '新节点' }), edge(105, 3, 7)]);
  const m = mergeCanvas(sampleCanvas(), ours, sampleCanvas());
  assert.deepEqual(m.conflicts, []);
  assert.ok(find(m.canvas, U(7)));
  assert.ok(m.canvas.some((c) => c.source?.cell === U(3) && c.target?.cell === U(7)));
  const theirs = sampleCanvas().filter((c) => c.id !== U(3) && c.id !== U(102));
  const m2 = mergeCanvas(sampleCanvas(), ours, theirs);
  assert.ok(m2.conflicts.some((c) => /端点节点不存在/.test(c.reason)));
});

test('只有别人改了：merged 与 theirs 一致 → noop', () => {
  const theirs = patch(sampleCanvas(), U(6), prompt('别人的'));
  assert.equal(mergeCanvas(sampleCanvas(), sampleCanvas(), theirs).noop, true);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/merge.test.mjs`
Expected：FAIL（找不到 `../src/merge.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/merge.mjs`：

```js
// 元素级三方合并：merge(拉取时的基线, 我的改后, 当前草稿)。
// 为什么不用老懂的 planContentPublish：它只处理「纯内容改动」、按整个 node.data 判冲突、不搬结构改动；
// 这里一条路径同时覆盖内容与结构。规则：
//   节点按 id：只有我改 → 用我的内容（位置 / 尺寸沿用草稿）；只有别人改 → 用别人的；
//              双方都改且结果不同 → 冲突；删除与修改撞上 → 冲突。
//   连线按「源#端口→目标#端口」：结果 = 草稿的连线 − 我删的 + 我加的。
//   合并后有连线端点不存在 → 冲突（例如我连到的节点被别人删了）。
// 输出顺序以草稿为骨架，我新增的元素追加在后面，尽量不打乱编辑器里的层级。

import { LAYOUT_KEYS, contentKey, edgeKey, edgeMap, isEdgeCell, nodeMap, stableStringify } from './canvas.mjs';
import { nodeName } from './graph.mjs';

function withLayoutFrom(ours, theirs) {
  if (!theirs) return ours;
  const copy = { ...ours };
  for (const key of LAYOUT_KEYS) {
    if (key in theirs) copy[key] = theirs[key];
    else delete copy[key];
  }
  return copy;
}

export function mergeCanvas(baseCanvas, oursCanvas, theirsCanvas) {
  const B = nodeMap(baseCanvas);
  const O = nodeMap(oursCanvas);
  const T = nodeMap(theirsCanvas);
  const keyOf = (cell) => (cell ? contentKey(cell) : null);
  const conflicts = [];
  const result = new Map();
  const ours = { changed: [], added: [], removed: [] };
  const theirs = { changed: 0, added: 0, removed: 0 };

  for (const id of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(id);
    const o = O.get(id);
    const t = T.get(id);
    const oursChanged = keyOf(o) !== keyOf(b);
    const theirsChanged = keyOf(t) !== keyOf(b);
    if (oursChanged) (b ? (o ? ours.changed : ours.removed) : ours.added).push(id);
    if (theirsChanged) {
      if (!b) theirs.added++;
      else if (!t) theirs.removed++;
      else theirs.changed++;
    }
    if (!oursChanged) {
      result.set(id, t ?? null);
    } else if (!theirsChanged) {
      result.set(id, o ? withLayoutFrom(o, t) : null);
    } else if (keyOf(o) === keyOf(t)) {
      result.set(id, t ?? null);
    } else {
      const reason = !o ? '你删了这个节点，但草稿里它被别人改了'
        : !t ? '你改了这个节点，但草稿里它被别人删了'
          : b ? '你和别人都改了这个节点'
            : '双方新增了同 id 的节点';
      conflicts.push({ id, name: nodeName(o ?? t ?? b), reason });
      result.set(id, t ?? null);
    }
  }

  const EB = edgeMap(baseCanvas);
  const EO = edgeMap(oursCanvas);
  const ET = edgeMap(theirsCanvas);
  const ourRemovedEdges = new Set([...EB.keys()].filter((key) => !EO.has(key)));
  const keptEdges = new Map([...ET].filter(([key]) => !ourRemovedEdges.has(key)));
  for (const [key, edge] of EO) if (!EB.has(key) && !keptEdges.has(key)) keptEdges.set(key, edge);

  const merged = [];
  const emittedNodes = new Set();
  const emittedEdges = new Set();
  const emit = (cell) => {
    if (!cell || typeof cell !== 'object') return;
    if (isEdgeCell(cell)) {
      const key = edgeKey(cell);
      if (keptEdges.has(key) && !emittedEdges.has(key)) {
        merged.push(keptEdges.get(key));
        emittedEdges.add(key);
      }
      return;
    }
    if (typeof cell.id !== 'string') return;
    const chosen = result.get(cell.id);
    if (chosen && !emittedNodes.has(cell.id)) {
      merged.push(chosen);
      emittedNodes.add(cell.id);
    }
  };
  theirsCanvas.forEach(emit);
  oursCanvas.forEach(emit);

  const ids = new Set(merged.filter((c) => !isEdgeCell(c)).map((c) => c.id));
  for (const edge of merged.filter((c) => isEdgeCell(c))) {
    if (!ids.has(edge.source?.cell) || !ids.has(edge.target?.cell)) {
      conflicts.push({ id: edgeKey(edge), name: '连线', reason: '合并后这条连线的端点节点不存在（你和别人分别删了节点或连线）' });
    }
  }

  return { canvas: merged, conflicts, ours, theirs, noop: stableStringify(merged) === stableStringify(theirsCanvas) };
}
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/merge.test.mjs`
Expected：7 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/merge.mjs miaodong-kit/test/merge.test.mjs
git commit -m "feat(md): 元素级三方合并——保留别人对其他节点的修改，同节点冲突才停"
```

---

### Task 14：推送与重放（md push / md rebase）

**Files:**
- Create: `miaodong-kit/src/ledger.mjs`、`src/commands/push.mjs`、`src/commands/rebase.mjs`、`miaodong-kit/test/helpers/bot-server.mjs`、`miaodong-kit/test/push.test.mjs`
- Modify: `miaodong-kit/src/api.mjs`（加 `saveCanvas`）、`src/commands/index.mjs`

**Interfaces:**
- Consumes：`getCanvas`、`listSessions`、`listEvents`、`mergeCanvas`、`diffEnvelopes`、`renderDiff`、`nameMapOf`、`runCheck`、`runTransform`、`compareNodes`、`contentKey`、`nodeMap`、`edgeMap`、`hashOf`、`stableStringify`、`businessNodes`、`loadWorkspace`、`targetFromMeta`、`saveAfter`、`saveMeta`、`listTransforms`、`writeIndex`、`stamp`、`ensureDir`、`writeJson`
- Produces：
  - `saveCanvas(identity, orgId, canvasId, rawCanvas)`：body 为 `{ canvasId, rawCanvas, nodes, edges }`，orgId 放 query，超时 120 秒
  - `appendLedger(entry)`、`readLedger() → entry[]`、`ledgerPath()`
  - `planCode({ botId, canvasId, live, save }) → 8 位 hex`
  - `verifyReadback(expected, readback, canvasId, ourIds: Set) → { problems: string[], notes: string[] }`
  - 账本 push 条目：`{ at(ISO), kind:'push', identityKey, regionLabel, origin, orgId, orgName, botId, botName, ws, mode:'merge'|'replace', source, changed:[{id,name}], added:[{id,name}], removed:[{id,name}], edgesAdded, edgesRemoved, backup, pushed, readbackUpdatedAt, problems }`
  - 推送成功后 `meta.lastPush = { at(ISO), backup, pushed }`
  - 测试 helper：`startBotServer() → { server, state, reset, pulled(extraArgs?) → { home, dir }, apply(home, source) }`，另有 `PROMPT_FIX`、`planCodeOf(stdout)`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/helpers/bot-server.mjs`：

```js
// 有状态的假秒懂：草稿存在内存里，save 会改它。用来测 pull → apply → push → rebase / restore 全流程。
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { runCli, tempHome } from './run-cli.mjs';
import { SEED_BOT, seedIdentity } from './seed.mjs';
import { sampleCanvas, sampleEvents, sampleSessions } from './fixtures.mjs';

export const PROMPT_FIX = "export default ({ h }) => { h.insertAfter(h.node('00000002'), 'data.nodePayload.systemPrompt', '你是客服。', '\\n发热≠发烧。'); };\n";
export const planCodeOf = (stdout) => stdout.match(/计划码：([0-9a-f]{8})/)[1];

export async function startBotServer() {
  const state = {};
  const reset = () => {
    state.draft = sampleCanvas();
    state.v400 = sampleCanvas();
    state.saves = 0;
    state.dropOnSave = false;
  };
  reset();
  const server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: SEED_BOT, name: '太极2.0重构' }] : []),
    'GET /api/canvas/get': ({ query }) => (query.canvasId === 'ver-400'
      ? ok({ canvasId: 'ver-400', rawCanvas: state.v400, version: 'v1.0.400', updatedAt: '2026-09-20T00:00:00.000Z' })
      : ok({ canvasId: 'main-1', rawCanvas: state.draft, version: 'v1.0.401', updatedAt: `2026-09-23T00:00:0${state.saves}.000Z` })),
    'GET /api/canvas/list-version': () => ok([{ canvasId: 'ver-400', version: 'v1.0.400', name: '400', versionType: 'online' }]),
    'GET /api/session-memory/list': () => ok(sampleSessions),
    'GET /api/canvas/event/list': () => ok(sampleEvents),
    'POST /api/canvas/save': ({ body }) => {
      state.saves++;
      state.draft = state.dropOnSave ? body.rawCanvas.slice(1) : body.rawCanvas;
      return { status: 201, body: { code: 0, data: null } };
    },
  });
  let seq = 0;
  return {
    server,
    state,
    reset,
    async pulled(extraArgs = []) {
      const home = tempHome();
      seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
      const r = await runCli(['pull', '--bot', '太极2.0重构', ...extraArgs], { home });
      assert.equal(r.code, 0, r.stderr);
      return { home, dir: r.stdout.match(/工作副本：(.+)/)[1].trim() };
    },
    async apply(home, source) {
      const file = join(home, `fix-${++seq}.mjs`);
      writeFileSync(file, source);
      const r = await runCli(['apply', file], { home });
      assert.equal(r.code, 0, r.stderr);
    },
  };
}
```

`miaodong-kit/test/push.test.mjs`：

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './helpers/run-cli.mjs';
import { PROMPT_FIX, planCodeOf, startBotServer } from './helpers/bot-server.mjs';
import { U, sampleCanvas } from './helpers/fixtures.mjs';

let bot;
before(async () => { bot = await startBotServer(); });
after(() => bot.server.close());

const draftNode = (id) => bot.state.draft.find((c) => c.id === id);
const setDraftNode = (id, fn) => { bot.state.draft = bot.state.draft.map((c) => (c.id === id ? fn(structuredClone(c)) : c)); };

test('预演不写；错的计划码被拦；对的计划码写入、回读、记账、换基线；只调 save', async () => {
  bot.reset();
  const { home, dir } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const dry = await runCli(['push'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(bot.state.saves, 0);
  assert.match(dry.stdout, /推送方式：把你的改动合进当前草稿/);
  assert.match(dry.stdout, /\+ 发热≠发烧。/);
  const code = planCodeOf(dry.stdout);

  const wrong = await runCli(['push', '--confirm', '00000000'], { home });
  assert.equal(wrong.code, 5);
  assert.equal(bot.state.saves, 0);

  const done = await runCli(['push', '--confirm', code], { home });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(bot.state.saves, 1);
  assert.match(draftNode(U(2)).data.nodePayload.systemPrompt, /发热≠发烧/);
  assert.match(done.stdout, /✅ 已推送到草稿（未发布）/);
  assert.match(done.stdout, /回答生成 \[00000002\]/);
  assert.equal(existsSync(join(dir, 'after.json')), false);
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
  const ledger = readFileSync(join(home, 'md', 'ledger.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.at(-1).kind, 'push');
  assert.deepEqual(ledger.at(-1).changed.map((c) => c.id), [U(2)]);
  const save = bot.server.requests.filter((q) => q.path === '/api/canvas/save').at(-1);
  assert.equal(save.query.orgId, 'org-1');
  assert.equal(save.body.canvasId, 'main-1');
  assert.ok(Array.isArray(save.body.nodes) && Array.isArray(save.body.edges));
  assert.ok(!bot.server.requests.some((q) => /import|publish|enable|promote/.test(q.path)), '只许调 canvas/save');
});

test('预演后草稿又变了（编辑页自动保存）→ 计划码不符被拦，什么都不写', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const code = planCodeOf((await runCli(['push'], { home })).stdout);
  setDraftNode(U(6), (c) => { c.position = { x: 999, y: 999 }; return c; });
  const r = await runCli(['push', '--confirm', code], { home });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /计划码对不上/);
  assert.equal(bot.state.saves, 0);
});

test('别人改了别的节点 → 合并保留；随后双方改同一节点 → 冲突停下', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  setDraftNode(U(6), (c) => { c.data.nodePayload.systemPrompt = '别人改的'; return c; });
  const dry = await runCli(['push'], { home });
  assert.match(dry.stdout, /草稿在你拉取后被改过：改 1 \/ 增 0 \/ 删 0 个节点/);
  assert.equal((await runCli(['push', '--confirm', planCodeOf(dry.stdout)], { home })).code, 0);
  assert.equal(draftNode(U(6)).data.nodePayload.systemPrompt, '别人改的');
  assert.match(draftNode(U(2)).data.nodePayload.systemPrompt, /发热≠发烧/);

  await bot.apply(home, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.modelType', 'luna'); };\n");
  setDraftNode(U(2), (c) => { c.data.nodePayload.temperature = 0.1; return c; });
  const conflict = await runCli(['push'], { home });
  assert.equal(conflict.code, 5);
  assert.match(conflict.stderr, /1 处冲突/);
  assert.match(conflict.stderr, /你和别人都改了这个节点/);
});

test('冲突后 md rebase 在最新草稿上重跑脚本，再推成功', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.modelType', 'luna'); };\n");
  setDraftNode(U(2), (c) => { c.data.nodePayload.temperature = 0.1; return c; });
  assert.equal((await runCli(['push'], { home })).code, 5);
  const rb = await runCli(['rebase'], { home });
  assert.equal(rb.code, 0, rb.stderr);
  assert.match(rb.stdout, /已在最新草稿上重跑 1 个改动脚本/);
  const dry = await runCli(['push'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal((await runCli(['push', '--confirm', planCodeOf(dry.stdout)], { home })).code, 0);
  assert.equal(draftNode(U(2)).data.nodePayload.modelType, 'luna');
  assert.equal(draftNode(U(2)).data.nodePayload.temperature, 0.1);
});

test('以版本为底、草稿与该版不同：不选方式就拦；--onto-draft 合进草稿', async () => {
  bot.reset();
  bot.state.v400 = sampleCanvas().map((c) => (c.id === U(6) ? { ...c, data: { ...c.data, name: '旧名字' } } : c));
  const { home } = await bot.pulled(['--version', 'v1.0.400']);
  await bot.apply(home, PROMPT_FIX);
  const blocked = await runCli(['push'], { home });
  assert.equal(blocked.code, 5);
  assert.match(blocked.stderr, /--onto-draft/);
  const dry = await runCli(['push', '--onto-draft'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /--onto-draft --confirm/);
  assert.equal((await runCli(['push', '--onto-draft', '--confirm', planCodeOf(dry.stdout)], { home })).code, 0);
  assert.equal(draftNode(U(6)).data.name, '回答生成');
  assert.match(draftNode(U(2)).data.nodePayload.systemPrompt, /发热≠发烧/);
});

test('自检有新问题时拦住推送', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.inputs', { 0: 'x' }); };\n");
  const r = await runCli(['push'], { home });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /自检有 \d+ 个问题/);
  assert.equal(bot.state.saves, 0);
});

test('回读不一致时报警（退出码 5）', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const code = planCodeOf((await runCli(['push'], { home })).stdout);
  bot.state.dropOnSave = true;
  const r = await runCli(['push', '--confirm', code], { home });
  assert.equal(r.code, 5);
  assert.match(r.stdout, /回读核对有 \d+ 处不一致/);
  assert.match(r.stdout, /1 个节点没写进去/);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/push.test.mjs`
Expected：FAIL（`未知命令：push`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/api.mjs`：import 区加 `import { deriveDomainEdges, deriveDomainNodes } from '../../apps/api/lib/miaodong/canvas-derive.ts';`，文件末尾追加：

```js
// canvas/save 是全量覆盖、写编辑器草稿；nodes / edges 由 rawCanvas 推出（与老懂、kit 同一套契约）
export function saveCanvas(identity, orgId, canvasId, rawCanvas) {
  return request(identity, '/api/canvas/save', {
    method: 'POST',
    query: { orgId },
    body: { canvasId, rawCanvas, nodes: deriveDomainNodes(rawCanvas), edges: deriveDomainEdges(rawCanvas) },
    timeoutMs: 120_000,
  });
}
```

`miaodong-kit/src/ledger.mjs`：

```js
// 账本：每次推送 / 回滚一行 JSON。「今天改了哪些节点、推没推、推到哪个智能体」靠它回答，
// 不靠 AI 的记忆——会话里用户为这类问题追问过 14 次。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, mdHome } from './home.mjs';

export function ledgerPath() {
  return join(mdHome(), 'ledger.jsonl');
}

export function appendLedger(entry) {
  ensureDir(mdHome());
  appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`);
}

export function readLedger() {
  if (!existsSync(ledgerPath())) return [];
  return readFileSync(ledgerPath(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
```

`miaodong-kit/src/commands/push.mjs`：

```js
// 推送 = 预演（默认）+ 带计划码确认。只调 canvas/save，写的是编辑器草稿，不会上线。
// 为什么合并而不是覆盖：秒懂编辑页会自动保存、打开时还会就地改画布，拉取后草稿被改过是常态；
// 按节点三方合并只在碰到同一个节点时才停。
// 为什么要计划码：确认时草稿如果又变了，写上去的就不是预演时看到的内容；计划码把两者绑死。

import { createHash } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { intArg } from '../args.mjs';
import { EXIT, MdError } from '../errors.mjs';
import { ensureDir, writeJson } from '../home.mjs';
import { getCanvas, saveCanvas } from '../api.mjs';
import { compareNodes, contentKey, edgeMap, hashOf, nodeMap, stableStringify } from '../canvas.mjs';
import { runCheck } from '../check.mjs';
import { diffEnvelopes, nameMapOf, renderDiff } from '../diff.mjs';
import { businessNodes } from '../graph.mjs';
import { appendLedger } from '../ledger.mjs';
import { mergeCanvas } from '../merge.mjs';
import { loadWorkspace, saveMeta, stamp, targetFromMeta, writeIndex } from '../workspace.mjs';
import { out, shortId, targetLine } from '../output.mjs';

export const blocked = (message, hint = '') => new MdError('push_blocked', message, { exitCode: EXIT.BLOCKED, hint });

export function planCode({ botId, canvasId, live, save }) {
  return createHash('sha256').update(stableStringify({ botId, canvasId, live: hashOf(live), save: hashOf(save) })).digest('hex').slice(0, 8);
}

export function verifyReadback(expected, readback, canvasId, ourIds) {
  const problems = [];
  const notes = [];
  if (readback.canvasId !== canvasId) problems.push(`回读到的画布 id 变了（${shortId(readback.canvasId)}）`);
  const e = nodeMap(expected);
  const r = nodeMap(readback.rawCanvas);
  let missing = 0;
  let extra = 0;
  let oursDiffer = 0;
  let othersDiffer = 0;
  for (const [id, cell] of e) {
    if (!r.has(id)) missing++;
    else if (contentKey(cell) !== contentKey(r.get(id))) {
      if (ourIds.has(id)) oursDiffer++;
      else othersDiffer++;
    }
  }
  for (const id of r.keys()) if (!e.has(id)) extra++;
  const ee = edgeMap(expected);
  const re = edgeMap(readback.rawCanvas);
  let edgesDiffer = 0;
  for (const key of ee.keys()) if (!re.has(key)) edgesDiffer++;
  for (const key of re.keys()) if (!ee.has(key)) edgesDiffer++;
  if (missing) problems.push(`${missing} 个节点没写进去`);
  if (extra) problems.push(`多出 ${extra} 个节点`);
  if (oursDiffer) problems.push(`${oursDiffer} 个你改的节点内容和推送的不一样`);
  if (edgesDiffer) problems.push(`${edgesDiffer} 条连线不一致`);
  // 服务端会归一化个别字段（实测删过 data.modelDeprecated），未改动节点的差异只提示
  if (othersDiffer) notes.push(`${othersDiffer} 个未改动节点有细微差异（服务端归一化字段）`);
  return { problems, notes };
}

function modeFlagOf(args) {
  if (args['replace-draft']) return ' --replace-draft';
  if (args['onto-draft']) return ' --onto-draft';
  return '';
}

export const push = {
  summary: '把工作副本的改动推到草稿（默认预演；--confirm <计划码> 才写；不会上线）',
  usage: [
    'md push [--ws <工作副本>]                预演：合并方式、改动清单、计划码',
    'md push [--ws …] --confirm <计划码>      用户同意后真正写入草稿',
    '以版本为底且草稿与该版不同时，需加 --onto-draft（合进当前草稿）或 --replace-draft（草稿 = 该版 + 改动）',
    '自检有新增问题会被拦；确认可以忽略时加 --allow-check-errors',
  ].join('\n'),
  async run(args) {
    const ws = loadWorkspace(args);
    const target = targetFromMeta(ws.meta);
    const { identity, orgId, botId } = target;
    if (!ws.after) throw blocked('这个工作副本还没有改动', '先 md apply <改动脚本>');
    const live = await getCanvas(identity, orgId, botId);
    if (live.canvasId !== ws.meta.mainCanvasId) {
      throw blocked(`草稿画布换了（拉取时 ${shortId(ws.meta.mainCanvasId)}，现在 ${shortId(live.canvasId)}）`, '重新 md pull，再把改动做一遍');
    }

    const check = runCheck(ws.base, ws.after);
    if (check.errors.length && !args['allow-check-errors']) {
      throw blocked(`自检有 ${check.errors.length} 个问题，先修：\n${check.errors.map((e) => `  ❌ ${e}`).join('\n')}`, 'md check 看详情；确认可以忽略时加 --allow-check-errors');
    }

    let mode = 'merge';
    if (ws.meta.source.kind === 'version') {
      const drift = compareNodes(ws.base.canvas, live.rawCanvas);
      if (!drift.same && !args['onto-draft'] && !args['replace-draft']) {
        throw blocked(
          `你是基于 ${ws.meta.source.version} 改的，但当前草稿和它不同（草稿多 ${drift.onlyB} 个节点、少 ${drift.onlyA} 个、${drift.changed} 个内容不同、连线差 ${drift.edgesDiffer} 条）`,
          '请用户二选一：--onto-draft（把改动合进当前草稿，保留草稿里别的修改）或 --replace-draft（草稿变成「该版本 + 你的改动」，草稿里别的修改会丢）',
        );
      }
      if (args['replace-draft']) mode = 'replace';
    }

    let toSave;
    let theirs = null;
    if (mode === 'replace') {
      toSave = ws.after.canvas;
    } else {
      const merged = mergeCanvas(ws.base.canvas, ws.after.canvas, live.rawCanvas);
      if (merged.conflicts.length) {
        const lines = merged.conflicts.slice(0, 20).map((c) => `  - ${c.name} [${shortId(c.id)}]：${c.reason}`).join('\n');
        throw blocked(`有 ${merged.conflicts.length} 处冲突，不能自动合并：\n${lines}`, 'md rebase 在最新草稿上重跑改动脚本，再预演');
      }
      if (merged.noop) {
        out(targetLine({ ...target, versionLabel: '草稿' }));
        out('草稿里已经是这些内容了，没有需要推送的。');
        return EXIT.OK;
      }
      toSave = merged.canvas;
      theirs = merged.theirs;
    }
    if (businessNodes(toSave).length === 0) throw blocked('要推送的画布里没有任何节点，已阻止');

    const ours = diffEnvelopes(ws.base, ws.after);
    const code = planCode({ botId, canvasId: live.canvasId, live: live.rawCanvas, save: toSave });
    out(targetLine({ ...target, versionLabel: '草稿' }));
    out(`推送方式：${mode === 'replace' ? `用「${ws.meta.source.version} + 你的改动」整体替换草稿` : '把你的改动合进当前草稿（保留别人对其他节点的修改）'}`);
    if (theirs && theirs.changed + theirs.added + theirs.removed > 0) {
      out(`草稿在你拉取后被改过：改 ${theirs.changed} / 增 ${theirs.added} / 删 ${theirs.removed} 个节点，这些都会保留`);
    }
    out('你的改动：');
    for (const line of renderDiff(ours, { names: nameMapOf(ws.base.canvas, ws.after.canvas), limit: intArg(args, 'limit', 120) })) out(`  ${line}`);
    for (const warning of check.warnings) out(`  ⚠️ ${warning}`);

    if (args.confirm === undefined || args.confirm === false) {
      out('');
      out(`这是预演，什么都没写。计划码：${code}`);
      out(`用户同意后执行：md push --ws ${ws.dir}${modeFlagOf(args)} --confirm ${code}`);
      return EXIT.OK;
    }
    if (args.confirm !== code) {
      throw blocked(`计划码对不上（给的是 ${args.confirm === true ? '空' : args.confirm}，当前是 ${code}）：草稿在预演之后又变了，或计划码抄错了`, '重新预演一次，把新的改动清单给用户看');
    }

    const at = stamp();
    const pushedAt = new Date().toISOString();
    const backup = join(ensureDir(join(ws.dir, 'backups')), `${at}-draft.json`);
    writeJson(backup, { canvasId: live.canvasId, updatedAt: live.updatedAt, rawCanvas: live.rawCanvas });
    await saveCanvas(identity, orgId, live.canvasId, toSave);
    const readback = await getCanvas(identity, orgId, botId);
    const ourIds = new Set([...ours.changed.map((c) => c.id), ...ours.added.map((c) => c.id)]);
    const { problems, notes } = verifyReadback(toSave, readback, live.canvasId, ourIds);

    const historyDir = ensureDir(join(ws.dir, 'history', at));
    const pushed = join(historyDir, 'pushed.json');
    writeJson(pushed, { canvas: toSave });
    if (existsSync(join(ws.dir, 'transforms'))) renameSync(join(ws.dir, 'transforms'), join(historyDir, 'transforms'));
    const pick = (item) => ({ id: item.id, name: item.name ?? item.data?.name ?? '' });
    appendLedger({
      at: pushedAt, kind: 'push',
      identityKey: target.identityKey, regionLabel: target.regionLabel, origin: identity.origin,
      orgId, orgName: target.orgName, botId, botName: target.botName,
      ws: ws.dir, mode, source: ws.meta.source,
      changed: ours.changed.map(pick), added: ours.added.map(pick), removed: ours.removed.map(pick),
      edgesAdded: ours.edgesAdded.length, edgesRemoved: ours.edgesRemoved.length,
      backup, pushed, readbackUpdatedAt: readback.updatedAt, problems,
    });
    // 推送后工作副本跟着草稿走：以回读结果为新基线，已推的改动脚本移进 history
    const newBase = { canvas: readback.rawCanvas, sessions: ws.base.sessions, events: ws.base.events };
    writeJson(join(ws.dir, 'base.json'), newBase);
    rmSync(join(ws.dir, 'after.json'), { force: true });
    writeIndex(ws.dir, newBase);
    saveMeta(ws.dir, {
      ...ws.meta,
      source: { kind: 'draft' },
      handEdited: false,
      draft: { updatedAt: readback.updatedAt, version: readback.version, hash: hashOf(readback.rawCanvas) },
      lastPush: { at: pushedAt, backup, pushed },
    });

    if (problems.length) {
      out(`⚠️ 已保存，但回读核对有 ${problems.length} 处不一致：`);
      for (const p of problems) out(`  - ${p}`);
      out('  可能有人同时在编辑页保存。先 md status --remote 复查，必要时 md restore 回滚。');
      return EXIT.BLOCKED;
    }
    out('✅ 已推送到草稿（未发布）');
    for (const n of notes) out(`  · ${n}`);
    const touched = [...ours.changed.map(pick), ...ours.added.map(pick)];
    out(`改了 ${ours.changed.length} 个节点、新增 ${ours.added.length} 个、删除 ${ours.removed.length} 个${touched.length ? '：' : ''}`);
    for (const t of touched.slice(0, 30)) out(`  - ${t.name} [${shortId(t.id)}]`);
    if (touched.length > 30) out(`  …另有 ${touched.length - 30} 个（md log 看全部）`);
    out('在秒懂里看：刷新画布编辑页。没刷新的旧标签页会自动保存，可能把这次推送覆盖掉。');
    out(`回滚：md restore --ws ${ws.dir}`);
    out('上线需要你在秒懂里点「发布」。');
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/rebase.mjs`：

```js
import { basename, join } from 'node:path';
import { EXIT, MdError } from '../errors.mjs';
import { writeJson } from '../home.mjs';
import { getCanvas, listEvents, listSessions } from '../api.mjs';
import { compareNodes, hashOf } from '../canvas.mjs';
import { runTransform } from '../transform.mjs';
import { listTransforms, loadWorkspace, saveAfter, saveMeta, targetFromMeta } from '../workspace.mjs';
import { out, targetLine } from '../output.mjs';

export const rebase = {
  summary: '在最新草稿上按顺序重跑改动脚本（草稿被改过、推送有冲突时用）',
  usage: 'md rebase [--ws <工作副本>]',
  async run(args) {
    const ws = loadWorkspace(args);
    const target = targetFromMeta(ws.meta);
    if (ws.meta.handEdited) {
      throw new MdError('cannot_rebase', '这个工作副本有整份手改（md apply --json），没法自动重放', { exitCode: EXIT.BLOCKED, hint: '重新 md pull，再把改动做一遍' });
    }
    const transforms = listTransforms(ws.dir);
    if (transforms.length === 0) {
      throw new MdError('cannot_rebase', '没有可重放的改动脚本', { exitCode: EXIT.BLOCKED, hint: '先 md apply <改动脚本>' });
    }
    const { identity, orgId, botId } = target;
    const live = await getCanvas(identity, orgId, botId);
    const [sessions, events] = await Promise.all([listSessions(identity, orgId, botId), listEvents(identity, orgId, botId)]);
    const base = { canvas: live.rawCanvas, sessions: sessions ?? ws.base.sessions, events: events ?? ws.base.events };
    let envelope = base;
    const log = [];
    for (const file of transforms) {
      try {
        const result = await runTransform(file, envelope);
        envelope = result.envelope;
        log.push(...result.log);
      } catch (error) {
        throw new MdError('rebase_failed', `在最新草稿上重跑 ${basename(file)} 失败：${error.message}`, {
          exitCode: EXIT.BLOCKED,
          hint: '锚点或节点在新草稿里变了：改好脚本后 md apply --reset，再逐个 md apply',
        });
      }
    }
    writeJson(join(ws.dir, 'base.json'), base);
    saveAfter(ws.dir, envelope);
    saveMeta(ws.dir, {
      ...ws.meta,
      mainCanvasId: live.canvasId,
      source: { kind: 'draft' },
      draft: { updatedAt: live.updatedAt, version: live.version, hash: hashOf(live.rawCanvas) },
    });
    const d = compareNodes(base.canvas, envelope.canvas);
    out(targetLine({ ...target, versionLabel: '草稿' }));
    if (ws.meta.source.kind === 'version') out(`（原来基于 ${ws.meta.source.version}，现在改为基于当前草稿）`);
    out(`已在最新草稿上重跑 ${transforms.length} 个改动脚本：`);
    for (const line of log) out(`  · ${line}`);
    out(`相对最新草稿：新增 ${d.onlyB} 个节点、删除 ${d.onlyA} 个、改了 ${d.changed} 个、连线变化 ${d.edgesDiffer} 条`);
    out('下一步：md diff / md check / md push');
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs`：import 区加 `import { push } from './push.mjs';` 和 `import { rebase } from './rebase.mjs';`，`COMMANDS` 改为 `{ auth, orgs, bots, versions, pull, node, trace, refs, apply, diff, check, push, rebase }`。

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/push.test.mjs`
Expected：7 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src miaodong-kit/test/helpers/bot-server.mjs miaodong-kit/test/push.test.mjs
git commit -m "feat(md): md push / rebase——三方合并进草稿、计划码确认、回读核对、账本"
```

---

### Task 15：回滚（md restore）

**Files:**
- Create: `miaodong-kit/src/commands/restore.mjs`、`miaodong-kit/test/restore.test.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`

**Interfaces:**
- Consumes：`blocked`、`planCode`、`verifyReadback`（来自 `commands/push.mjs`）、`getCanvas`、`saveCanvas`、`compareNodes`、`hashOf`、`businessNodes`、`appendLedger`、`loadWorkspace`、`targetFromMeta`、`saveMeta`、`writeIndex`、`stamp`、`readJson`、`writeJson`、`ensureDir`、`strArg`
- Produces：
  - `md restore [--ws] [--backup <file>] [--confirm <计划码>]`：默认用工作副本里最新的 `backups/*-draft.json`
  - 账本 restore 条目：`{ at, kind:'restore', identityKey, regionLabel, origin, orgId, orgName, botId, botName, ws, backup, safety, problems }`

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/restore.test.mjs`：

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './helpers/run-cli.mjs';
import { PROMPT_FIX, planCodeOf, startBotServer } from './helpers/bot-server.mjs';
import { U } from './helpers/fixtures.mjs';

let bot;
before(async () => { bot = await startBotServer(); });
after(() => bot.server.close());

test('推送后 md restore：预演不写，确认后草稿回到推送前，记账', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  await runCli(['push', '--confirm', planCodeOf((await runCli(['push'], { home })).stdout)], { home });
  assert.match(bot.state.draft.find((c) => c.id === U(2)).data.nodePayload.systemPrompt, /发热≠发烧/);

  const dry = await runCli(['restore'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /改回 1 个/);
  assert.equal(bot.state.saves, 1);
  const wrong = await runCli(['restore', '--confirm', 'ffffffff'], { home });
  assert.equal(wrong.code, 5);

  const done = await runCli(['restore', '--confirm', planCodeOf(dry.stdout)], { home });
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /✅ 已回滚草稿（未发布）/);
  assert.equal(bot.state.draft.find((c) => c.id === U(2)).data.nodePayload.systemPrompt, '你是客服。\n请礼貌回答。');
  const ledger = readFileSync(join(home, 'md', 'ledger.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.at(-1).kind, 'restore');
});

test('没推送过就没有备份：退出码 5', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  const r = await runCli(['restore'], { home });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /还没有推送过/);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/restore.test.mjs`
Expected：FAIL（`未知命令：restore`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/commands/restore.mjs`：

```js
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { ensureDir, readJson, writeJson } from '../home.mjs';
import { getCanvas, saveCanvas } from '../api.mjs';
import { compareNodes, hashOf } from '../canvas.mjs';
import { businessNodes } from '../graph.mjs';
import { appendLedger } from '../ledger.mjs';
import { loadWorkspace, saveMeta, stamp, targetFromMeta, writeIndex } from '../workspace.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { blocked, planCode, verifyReadback } from './push.mjs';

function latestBackup(dir) {
  const backupsDir = join(dir, 'backups');
  const files = existsSync(backupsDir) ? readdirSync(backupsDir).filter((name) => name.endsWith('-draft.json')).sort() : [];
  if (files.length === 0) throw blocked('这个工作副本还没有推送过，没有备份', '用 --backup <文件> 指定');
  return join(backupsDir, files.at(-1));
}

export const restore = {
  summary: '用推送前的备份回滚草稿（默认预演，--confirm <计划码> 才写）',
  usage: 'md restore [--ws <工作副本>] [--backup <备份文件>] [--confirm <计划码>]',
  async run(args) {
    const ws = loadWorkspace(args);
    const target = targetFromMeta(ws.meta);
    const { identity, orgId, botId } = target;
    const backupArg = strArg(args, 'backup');
    const backupFile = backupArg ? resolve(backupArg) : latestBackup(ws.dir);
    const backup = readJson(backupFile, null);
    if (!backup || !Array.isArray(backup.rawCanvas) || businessNodes(backup.rawCanvas).length === 0) throw blocked(`备份不可用：${backupFile}`);
    const live = await getCanvas(identity, orgId, botId);
    if (backup.canvasId && backup.canvasId !== live.canvasId) {
      throw blocked(`备份属于另一张画布（${shortId(backup.canvasId)}），当前草稿是 ${shortId(live.canvasId)}`);
    }
    out(targetLine({ ...target, versionLabel: '草稿' }));
    out(`回滚到：${backupFile}`);
    const d = compareNodes(live.rawCanvas, backup.rawCanvas);
    if (d.same) {
      out('当前草稿和备份一样，不需要回滚。');
      return EXIT.OK;
    }
    out(`回滚会让草稿：恢复 ${d.onlyB} 个节点、去掉 ${d.onlyA} 个、改回 ${d.changed} 个、连线变化 ${d.edgesDiffer} 条（备份之后别人做的修改也会一起丢掉）`);
    const code = planCode({ botId, canvasId: live.canvasId, live: live.rawCanvas, save: backup.rawCanvas });
    if (args.confirm === undefined || args.confirm === false) {
      out('');
      out(`这是预演，什么都没写。计划码：${code}`);
      out(`用户同意后执行：md restore --ws ${ws.dir} --backup ${backupFile} --confirm ${code}`);
      return EXIT.OK;
    }
    if (args.confirm !== code) throw blocked(`计划码对不上（当前是 ${code}）：草稿在预演之后又变了`, '重新预演一次');

    const safety = join(ensureDir(join(ws.dir, 'backups')), `${stamp()}-before-restore.json`);
    writeJson(safety, { canvasId: live.canvasId, updatedAt: live.updatedAt, rawCanvas: live.rawCanvas });
    await saveCanvas(identity, orgId, live.canvasId, backup.rawCanvas);
    const readback = await getCanvas(identity, orgId, botId);
    const { problems } = verifyReadback(backup.rawCanvas, readback, live.canvasId, new Set());
    appendLedger({
      at: new Date().toISOString(), kind: 'restore',
      identityKey: target.identityKey, regionLabel: target.regionLabel, origin: identity.origin,
      orgId, orgName: target.orgName, botId, botName: target.botName,
      ws: ws.dir, backup: backupFile, safety, problems,
    });
    const newBase = { canvas: readback.rawCanvas, sessions: ws.base.sessions, events: ws.base.events };
    writeJson(join(ws.dir, 'base.json'), newBase);
    writeIndex(ws.dir, ws.after ?? newBase);
    saveMeta(ws.dir, { ...ws.meta, source: { kind: 'draft' }, draft: { updatedAt: readback.updatedAt, version: readback.version, hash: hashOf(readback.rawCanvas) } });
    if (problems.length) {
      out(`⚠️ 已保存，但回读核对有 ${problems.length} 处不一致：`);
      for (const p of problems) out(`  - ${p}`);
      return EXIT.BLOCKED;
    }
    out('✅ 已回滚草稿（未发布）。刷新画布编辑页查看；回滚前的草稿另存在：');
    out(`  ${safety}`);
    if (ws.after) out('注意：工作副本里还有未推送的改动，它们是基于旧基线做的，建议 md apply --reset 或 md rebase。');
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs`：import 区加 `import { restore } from './restore.mjs';`，`COMMANDS` 改为 `{ auth, orgs, bots, versions, pull, node, trace, refs, apply, diff, check, push, rebase, restore }`。

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/restore.test.mjs`
Expected：2 个测试全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/commands miaodong-kit/test/restore.test.mjs
git commit -m "feat(md): md restore——用推送前备份回滚草稿，同样预演加计划码"
```

---

### Task 16：状态与记录（md status / md log）

**Files:**
- Create: `miaodong-kit/src/commands/status.mjs`、`miaodong-kit/test/status.test.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`

**Interfaces:**
- Consumes：`readLedger`、`workRoot`、`wsLine`、`targetFromMeta`、`getCanvas`、`nodeMap`、`contentKey`、`compareNodes`、`readJson`、`strArg`、`intArg`、`formatTime`、`shortId`
- Produces：
  - `md status [--bot] [--limit] [--remote]`：列出工作副本、未推送改动、最后一次推送；加 `--remote` 时核对每个智能体最近一次推送的节点是否还在
  - `md log [--bot] [--limit]`：推送和回滚记录，逐个列出节点

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/status.test.mjs`：

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers/run-cli.mjs';
import { PROMPT_FIX, planCodeOf, startBotServer } from './helpers/bot-server.mjs';
import { sampleCanvas } from './helpers/fixtures.mjs';

let bot;
before(async () => { bot = await startBotServer(); });
after(() => bot.server.close());

test('status 显示未推送改动；log 列出推送的节点；status --remote 能发现被旧编辑页覆盖', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const s1 = await runCli(['status'], { home });
  assert.equal(s1.code, 0, s1.stderr);
  assert.match(s1.stdout, /未推送改动：改 1 \/ 增 0 \/ 删 0 个节点/);

  await runCli(['push', '--confirm', planCodeOf((await runCli(['push'], { home })).stdout)], { home });
  const log = await runCli(['log'], { home });
  assert.match(log.stdout, /推送 测试区 \/ 太极2\.0重构 \(181fc177\) · 改 1 增 0 删 0/);
  assert.match(log.stdout, /~ 回答生成 \[00000002\]/);

  const ok = await runCli(['status', '--remote'], { home });
  assert.match(ok.stdout, /✅ 测试区 \/ 太极2\.0重构：.*推送的 1 个节点都还在/);

  bot.state.draft = sampleCanvas();   // 模拟没刷新的旧编辑页把推送前的内容自动保存了回去
  const lost = await runCli(['status', '--remote'], { home });
  assert.match(lost.stdout, /⚠️ 测试区 \/ 太极2\.0重构：.*有 1 个节点被覆盖/);
});

test('没有记录时的提示', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  assert.match((await runCli(['log'], { home })).stdout, /还没有推送记录/);
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/status.test.mjs`
Expected：FAIL（`未知命令：status`）

- [ ] **Step 3：写实现**

`miaodong-kit/src/commands/status.mjs`：

```js
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { intArg, strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { readJson } from '../home.mjs';
import { getCanvas } from '../api.mjs';
import { compareNodes, contentKey, nodeMap } from '../canvas.mjs';
import { readLedger } from '../ledger.mjs';
import { targetFromMeta, workRoot, wsLine } from '../workspace.mjs';
import { formatTime, out, shortId } from '../output.mjs';

const matchesBot = (item, query) => !query || item.botName.toLowerCase().includes(query.toLowerCase()) || item.botId.startsWith(query);

function listWorkspaces() {
  const root = workRoot();
  if (!existsSync(root)) return [];
  const dirs = [];
  const subdirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
  for (const region of subdirs(root)) {
    for (const bot of subdirs(region)) {
      for (const ws of subdirs(bot)) if (existsSync(join(ws, 'meta.json'))) dirs.push(ws);
    }
  }
  return dirs
    .map((dir) => ({ dir, meta: readJson(join(dir, 'meta.json')), hasAfter: existsSync(join(dir, 'after.json')) }))
    .sort((a, b) => String(b.meta.pulledAt).localeCompare(String(a.meta.pulledAt)));
}

async function remoteCheck(query) {
  const latest = new Map();
  for (const entry of readLedger()) if (entry.kind === 'push' && matchesBot(entry, query)) latest.set(entry.botId, entry);
  out('');
  if (latest.size === 0) {
    out('（账本里没有推送记录，无从核对）');
    return;
  }
  out('核对最近一次推送是否还在草稿里：');
  for (const entry of latest.values()) {
    const target = targetFromMeta(entry);
    const live = await getCanvas(target.identity, entry.orgId, entry.botId);
    const pushed = readJson(entry.pushed, null);
    if (!pushed) {
      out(`  ${entry.regionLabel} / ${entry.botName}：推送快照不见了（${entry.pushed}）`);
      continue;
    }
    const expected = nodeMap(pushed.canvas);
    const current = nodeMap(live.rawCanvas);
    const ids = [...entry.changed, ...entry.added].map((c) => c.id);
    const lost = ids.filter((id) => !current.has(id) || contentKey(current.get(id)) !== contentKey(expected.get(id)));
    const revived = entry.removed.map((c) => c.id).filter((id) => current.has(id));
    if (lost.length || revived.length) {
      out(`  ⚠️ ${entry.regionLabel} / ${entry.botName}：${formatTime(entry.at)} 的推送有 ${lost.length} 个节点被覆盖、${revived.length} 个删掉的节点又回来了（多半是没刷新的编辑页自动保存）：${lost.slice(0, 10).map(shortId).join('、')}`);
    } else {
      out(`  ✅ ${entry.regionLabel} / ${entry.botName}：${formatTime(entry.at)} 推送的 ${ids.length} 个节点都还在`);
    }
  }
}

export const status = {
  summary: '本机工作副本：哪个智能体、有没有未推送改动、最后推送；--remote 核对推送是否还在',
  usage: 'md status [--bot <名字或 id 前缀>] [--limit 10] [--remote]',
  async run(args) {
    const query = strArg(args, 'bot');
    const list = listWorkspaces().filter((w) => matchesBot(w.meta, query)).slice(0, intArg(args, 'limit', 10));
    if (list.length === 0) out('没有工作副本。');
    for (const w of list) {
      let pending = '无未推送改动';
      if (w.hasAfter) {
        const d = compareNodes(readJson(join(w.dir, 'base.json')).canvas, readJson(join(w.dir, 'after.json')).canvas);
        pending = `未推送改动：改 ${d.changed} / 增 ${d.onlyB} / 删 ${d.onlyA} 个节点`;
      }
      out(wsLine({ meta: w.meta, after: w.hasAfter }));
      out(`  ${w.dir}`);
      out(`  拉取 ${formatTime(w.meta.pulledAt)} · ${pending} · 最后推送 ${w.meta.lastPush ? formatTime(w.meta.lastPush.at) : '无'}`);
    }
    if (args.remote) await remoteCheck(query);
    return EXIT.OK;
  },
};

export const log = {
  summary: '推送 / 回滚记录（改了哪些节点）',
  usage: 'md log [--bot <名字或 id 前缀>] [--limit 20]',
  async run(args) {
    const query = strArg(args, 'bot');
    const entries = readLedger().filter((e) => matchesBot(e, query)).reverse().slice(0, intArg(args, 'limit', 20));
    if (entries.length === 0) {
      out('还没有推送记录。');
      return EXIT.OK;
    }
    for (const e of entries) {
      const counts = e.kind === 'push' ? ` · 改 ${e.changed.length} 增 ${e.added.length} 删 ${e.removed.length} · 连线 +${e.edgesAdded} -${e.edgesRemoved}` : '';
      out(`${formatTime(e.at)} ${e.kind === 'restore' ? '回滚' : '推送'} ${e.regionLabel} / ${e.botName} (${shortId(e.botId)})${counts}${e.problems?.length ? ' · ⚠️ 回读不一致' : ''}`);
      if (e.kind !== 'push') continue;
      const rows = [...e.changed.map((c) => ['~', c]), ...e.added.map((c) => ['+', c]), ...e.removed.map((c) => ['-', c])];
      for (const [mark, c] of rows.slice(0, 30)) out(`    ${mark} ${c.name} [${shortId(c.id)}]`);
      if (rows.length > 30) out(`    …另有 ${rows.length - 30} 个`);
    }
    return EXIT.OK;
  },
};
```

`miaodong-kit/src/commands/index.mjs` 整体替换为：

```js
// 命令注册表：名字 → { summary, usage, run(args) }。每加一个命令在这里登记。
import { apply } from './apply.mjs';
import { auth } from './auth.mjs';
import { bots } from './bots.mjs';
import { check } from './check.mjs';
import { diff } from './diff.mjs';
import { node, refs, trace } from './inspect.mjs';
import { orgs } from './orgs.mjs';
import { pull } from './pull.mjs';
import { push } from './push.mjs';
import { rebase } from './rebase.mjs';
import { restore } from './restore.mjs';
import { log, status } from './status.mjs';
import { versions } from './versions.mjs';

export const COMMANDS = { auth, orgs, bots, versions, pull, node, trace, refs, apply, diff, check, push, rebase, restore, status, log };
```

- [ ] **Step 4：运行，确认通过**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/status.test.mjs`
Expected：2 个测试全部 PASS

Run: `npm run check:md`
Expected：全部 PASS

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/src/commands miaodong-kit/test/status.test.mjs
git commit -m "feat(md): md status / log——未推送改动、推送记录，--remote 发现被旧编辑页覆盖"
```

---

### Task 17：skill 说明书、安装、文档，以及 Node 18 全流程验证

**Files:**
- Create: `miaodong-kit/skill/SKILL.md`、`miaodong-kit/skill/references/transforms.md`、`miaodong-kit/skill/references/push.md`、`miaodong-kit/install.mjs`、`miaodong-kit/test/install.test.mjs`
- Modify: `miaodong-kit/test/bundle.test.mjs`（加全流程用例）、`package.json`（`md:install`）、`CLAUDE.md`、`AGENTS.md`、`miaodong-kit/PLAYBOOK.md`

**Interfaces:**
- Consumes：`buildBundle`
- Produces：
  - `install({ skillDir?, codexSkillsDir?, binDir?, exportDir? }) → { tag, logs }`：环境变量 `MD_SKILL_DIR` / `MD_CODEX_SKILLS_DIR` / `MD_BIN_DIR` / `MD_EXPORT_DIR` 可覆盖默认路径；`exportDir` 默认 `~/Desktop/miaodong`（桌面副本，用户要求），设为空串则不放；目标目录已有别人的东西时拒绝覆盖
  - skill 目录结构：`SKILL.md`、`references/*.md`、`scripts/md.mjs`、`.md-cli-skill`（标记文件，内容是构建号）

- [ ] **Step 1：写失败的测试**

`miaodong-kit/test/install.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { install } from '../install.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';

function dirs() {
  const root = tempHome();
  // exportDir 必须指向临时目录：测试绝不能碰真实桌面
  return { skillDir: join(root, 'claude', 'skills', 'miaodong'), codexSkillsDir: join(root, 'codex', 'skills'), binDir: join(root, 'bin'), exportDir: join(root, 'desktop', 'miaodong') };
}

test('安装：skill 真身 + codex 软链 + bin 软链 + 桌面副本，装完能跑；重复安装不出错', async () => {
  const d = dirs();
  mkdirSync(join(d.codexSkillsDir, '..'), { recursive: true });
  await install(d);
  assert.ok(existsSync(join(d.skillDir, 'SKILL.md')));
  assert.ok(existsSync(join(d.skillDir, 'references', 'transforms.md')));
  assert.ok(statSync(join(d.skillDir, 'scripts', 'md.mjs')).mode & 0o100);
  assert.equal(readlinkSync(join(d.codexSkillsDir, 'miaodong')), d.skillDir);
  assert.equal(readlinkSync(join(d.binDir, 'md')), join(d.skillDir, 'scripts', 'md.mjs'));
  assert.ok(existsSync(join(d.exportDir, 'SKILL.md')), '桌面副本要有 SKILL.md');
  assert.ok(existsSync(join(d.exportDir, 'scripts', 'md.mjs')), '桌面副本要带可执行的 md');
  const r = await runCli(['--version'], { home: tempHome(), bundle: join(d.binDir, 'md') });
  assert.equal(r.code, 0, r.stderr);
  await install(d);
});

test('目标目录已有别人的东西时拒绝覆盖', async () => {
  const d = dirs();
  mkdirSync(d.skillDir, { recursive: true });
  writeFileSync(join(d.skillDir, 'SKILL.md'), '别人的 skill');
  await assert.rejects(install(d), /不是 md 装的/);
});

test('SKILL.md 头部合规：name 为 miaodong，description 不超过 1024 字', () => {
  const text = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf-8');
  const match = text.match(/^---\nname: miaodong\ndescription: (.+)\n---\n/);
  assert.ok(match, 'frontmatter 格式不对');
  assert.ok(match[1].length <= 1024);
});
```

在 `miaodong-kit/test/bundle.test.mjs` 顶部的 import 区追加：

```js
import { writeFileSync as writeFile } from 'node:fs';
import { encodeAuthBlob } from './helpers/seed.mjs';
import { PROMPT_FIX, planCodeOf, startBotServer } from './helpers/bot-server.mjs';
```

再在文件末尾追加全流程用例（与 `MD_E2E_NODE` 配合，验证 Node 18 下真实可用）：

```js
test('产物全流程：取身份 → 找智能体 → 拉 → 改 → diff → check → 推 → log', async () => {
  const bot = await startBotServer();
  try {
    const home = tempHome();
    const run = (args, input) => runCli(args, { home, bundle, input });
    const blob = encodeAuthBlob({ origin: bot.server.origin, token: 't', user: { id: 'u', name: '胡同学' }, currentOrg: { id: 'org-1', name: '兴趣岛平台' }, orgs: [{ id: 'org-1', name: '兴趣岛平台' }] });
    assert.equal((await run(['auth', 'import', '--stdin'], blob)).code, 0);
    assert.match((await run(['bots', '太极'])).stdout, /太极2\.0重构/);
    assert.equal((await run(['pull', '--bot', '太极2.0重构'])).code, 0);
    const script = join(home, 'fix.mjs');
    writeFile(script, PROMPT_FIX);
    assert.equal((await run(['apply', script])).code, 0);
    assert.match((await run(['diff'])).stdout, /\+ 发热≠发烧。/);
    assert.equal((await run(['check'])).code, 0);
    const dry = await run(['push']);
    assert.equal(dry.code, 0, dry.stderr);
    const done = await run(['push', '--confirm', planCodeOf(dry.stdout)]);
    assert.equal(done.code, 0, done.stderr);
    assert.doesNotMatch(`${dry.stderr}${done.stderr}`, /ExperimentalWarning/);
    assert.match((await run(['log'])).stdout, /~ 回答生成 \[00000002\]/);
  } finally {
    await bot.server.close();
  }
});
```

- [ ] **Step 2：运行，确认失败**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/install.test.mjs`
Expected：FAIL（找不到 `../install.mjs`）

- [ ] **Step 3：写实现**

`miaodong-kit/install.mjs`：

```js
// 构建并安装：~/.claude/skills/miaodong（真身）、~/.codex/skills/miaodong（软链）、~/.local/bin/md（软链），
// 另在桌面放一份完整副本 ~/Desktop/miaodong（用户要求：方便查看、直接转给同事；每次安装刷新，改它不会生效）。
// 复制而不是软链到仓库：切到没有 miaodong-kit 的分支时，md 不能跟着消失。
// 不用 npm link：它会把 md 装进当前 nvm 版本目录，切 Node 版本就找不到了。
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle } from './build.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));
const MARKER = '.md-cli-skill';

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkTo(linkPath, targetPath, logs) {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (isSymlink(linkPath)) {
    if (readlinkSync(linkPath) === targetPath) {
      logs.push(`已存在：${linkPath}`);
      return;
    }
    rmSync(linkPath);
  } else if (existsSync(linkPath)) {
    logs.push(`⚠️ 跳过 ${linkPath}：那里已有别的文件，没动它`);
    return;
  }
  symlinkSync(targetPath, linkPath);
  logs.push(`已链接：${linkPath} → ${targetPath}`);
}

export async function install({
  skillDir = process.env.MD_SKILL_DIR ?? join(homedir(), '.claude', 'skills', 'miaodong'),
  codexSkillsDir = process.env.MD_CODEX_SKILLS_DIR ?? join(homedir(), '.codex', 'skills'),
  binDir = process.env.MD_BIN_DIR ?? join(homedir(), '.local', 'bin'),
  exportDir = process.env.MD_EXPORT_DIR ?? join(homedir(), 'Desktop', 'miaodong'),
} = {}) {
  const logs = [];
  for (const dir of [skillDir, exportDir].filter(Boolean)) {
    if (existsSync(dir) && !existsSync(join(dir, MARKER))) throw new Error(`${dir} 已存在且不是 md 装的，没敢覆盖`);
  }
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  cpSync(join(KIT, 'skill'), skillDir, { recursive: true });
  const { tag } = await buildBundle({ outfile: join(skillDir, 'scripts', 'md.mjs') });
  writeFileSync(join(skillDir, MARKER), `${tag}\n`);
  logs.push(`已安装 skill：${skillDir}（${tag}）`);
  if (existsSync(dirname(codexSkillsDir))) linkTo(join(codexSkillsDir, 'miaodong'), skillDir, logs);
  else logs.push(`（没有 ${dirname(codexSkillsDir)}，跳过 Codex）`);
  linkTo(join(binDir, 'md'), join(skillDir, 'scripts', 'md.mjs'), logs);
  // MD_EXPORT_DIR='' 时不放桌面副本
  if (exportDir) {
    rmSync(exportDir, { recursive: true, force: true });
    cpSync(skillDir, exportDir, { recursive: true });
    logs.push(`已放一份到 ${exportDir}（给你看、转给同事用；真正生效的是 ${skillDir}，改桌面这份不会生效）`);
  }
  return { tag, logs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { logs } = await install();
  for (const line of logs) console.log(line);
  console.log('验证：新开一个终端运行 md --version');
}
```

`package.json` 的 scripts 加：

```json
"md:install": "node ./miaodong-kit/install.mjs",
```

`miaodong-kit/skill/SKILL.md`：

````markdown
---
name: miaodong
description: 用 md 命令读写句子秒懂平台的智能体画布：按区取身份、按名字找智能体和版本、拉草稿或历史版本、看节点 / 上下游 / 引用、用改动脚本批量改 prompt 或模型、自检、合并推送到草稿、回滚、查推送记录。用户提到秒懂、智能体、画布、节点、prompt、版本号（如 v1.0.400）、推到秒懂、回滚时使用。测试中心的用例导入仍用 miaodong-test-case-import。
---

# 秒懂（md）

`md` 是装在 `~/.local/bin` 的命令。用法以 `md <命令> --help` 为准，下面只写流程和规矩。

## 开场

- 用户只说「用项目的工具解决问题」、没给智能体和任务时，只回一句：「好的，请告诉我智能体和要解决的问题」。先别去探索。
- 每条 md 输出的第一行都是 `区 / 企业 / 智能体 (id) / 版本`。同时涉及多个智能体时，每次回复都要点名是哪一个。

## 身份（第一次用某个区，或命令退出码为 3 时）

1. 问用户要秒懂控制台的域名。
2. 运行 `md auth snippet <域名>`，把输出**原样**转给用户，不要改写。
3. 等用户说「好了」，再运行 `md auth import`。
- 身份只能这样取。**不要**读 `~/.miaodong/md/identities.json`，**不要**自己运行 `pbpaste`，不要在回复里出现 token；**禁止**从老懂数据库、`.env`、kit 凭据文件或任何别处找密码。

## 修 bot 的标准流程

1. `md versions --bot <智能体>`：用户说了版本号时，确认是哪一版、是否在线上。
2. `md pull --bot <智能体> [--version v1.0.400]`：看输出里「草稿与版本是否不同」。
3. 用 `md node` / `md trace` / `md refs`，以及 jq 查 `<工作副本>/index/*.jsonl` 来定位问题。
4. 把改动写成脚本（写法见 `references/transforms.md`），然后 `md apply <脚本>`。同一套改动要用到别的版本或别的智能体时，在那边 pull 之后 apply 同一个脚本。
5. `md diff` 看改动，`md check` 自检（退出码 1 表示有新问题，要先修）。
6. `md push` 预演，把「你的改动」清单和计划码交给用户。
7. **用户明确同意这次推送后**，再运行 `md push --ws … --confirm <计划码>`。
8. 按下面的格式回执。需要时用 `md status --remote` 核对推送是否被旧编辑页覆盖。

## 规矩

- 秒懂的活不开子 agent，也不起 workflow，除非用户明确要求。
- 先用几行回答用户字面上的问题，再问要不要展开；不要自己扩大范围。
- 花钱、外发的范围就是用户说的范围，条数、轮数、版本都不能自己加。
- 不能替用户确认推送；计划码对不上（退出码 5）时重新预演，把新清单给用户看。
- md 不做发布和启用，上线要用户自己在秒懂里点「发布」。
- 用户明确要做的改动，风险最多提醒一次，然后照做。

## 每次写操作后的回执

- 区 / 智能体 / id
- 状态：仅本地改动，或已推到草稿（未发布）
- 改了哪些节点（数量 + 名字 [id 前 8 位]），以及考虑过但没改的节点和原因
- 在秒懂里怎么看：刷新编辑页，搜哪个关键词
- 「仓库代码没有改动」（如果确实没改）

## 领域常识

- 主对话的回复在「延时回复」事件触发的那条执行记录里；转人工可能落在事件触发的另一条执行里。
- 单节点试跑、测试中心跑的都是**草稿**，不是版本。
- 测试中心运行是沙箱，不会真发消息。
- 跨智能体导入的用例，断言来自源智能体，通过率没有意义，要看实际回答。
- regression-test 要求回归集至少 50 条，而且不能指定测试集。
- 推送后要刷新编辑页；没刷新的旧标签页会自动保存，把推送覆盖掉。

## 退出码

| 码 | 意思 | 怎么办 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 错误，或自检有新问题 | 看 ❌ 那几行，修脚本 |
| 2 | 用法错误 | `md <命令> --help` |
| 3 | 需要取身份 | 走上面「身份」三步 |
| 4 | 智能体、版本或节点找不到，或有歧义 | 按输出里的候选问用户，或用 id |
| 5 | 推送被拦（冲突、计划码不符、草稿与版本不同、回读不一致） | 按提示走：rebase / 重新预演 / 让用户在 `--onto-draft` 和 `--replace-draft` 之间选 |
````

`miaodong-kit/skill/references/transforms.md`：

````markdown
# 改动脚本

脚本是一个 `.mjs` 文件，默认导出一个函数，在 `ctx.canvas`（秒懂画布数组）上直接改：

```js
export default ({ canvas, h }) => {
  // …
};
```

守卫一律「宁可报错也不猜」：命中次数不对、路径不存在、数量不符都会让整个脚本失败，工作副本保持不变。

## helper

| 写法 | 作用 |
|---|---|
| `h.select(n => …)` | 按条件选业务节点（不含连线和便签） |
| `h.node('前缀'或'唯一名字')` | 取一个节点，有歧义就报错 |
| `h.expectCount(list, n)` | 数量必须等于 n |
| `h.get(node, 'data.nodePayload.inputs[0].name')` / `h.set(...)` | 读 / 写字段；`a[0].b` 与 `a.0.b` 都行；只有最后一段可以新建 |
| `h.replaceOnce(node, path, 查找, 替换)` | 文本里「查找」必须恰好出现 1 次 |
| `h.insertAfter(node, path, 锚点, 新内容)` / `h.insertBefore` | 基于 replaceOnce |
| `h.replaceAll(node, path, 查找, 替换, { expect })` | 全部替换，可要求次数 |
| `h.retargetRefs({ from, to, fromDataPath?, toDataPath?, expect })` | 把所有引用 from 的地方改成引用 to |
| `h.cloneNode(query, { name })` | 复制节点（新 id、新端口 id） |
| `h.portOf(node, 'left'或'right', i)` | 取端口 id |
| `h.addEdge(from, fromPort, to, toPort)` | 加连线（样式照抄画布里已有的连线） |
| `h.removeEdges(e => …, { expect })` / `h.removeNode(query)` | 删连线；删节点时连带删掉它的连线 |
| `h.log('说明')` | 往 apply 的输出里加一行说明 |

## 例 1：给所有「回答生成」节点在锚点后插一段

```js
export default ({ h }) => {
  const nodes = h.expectCount(h.select((n) => n.data?.name === '回答生成'), 16, '回答生成节点');
  for (const n of nodes) {
    h.insertAfter(n, 'data.nodePayload.systemPrompt', '## 回复要求', '\n- 用户说「发热」时先确认是运动出汗还是发烧，不要默认是生病。');
  }
};
```

各节点的锚点写法不一致时，按写法分组，每组用各自的锚点，并各自 `expectCount`。

## 例 2：把 gemini 系列换成 luna（智能标签节点除外）

```js
export default ({ h }) => {
  const nodes = h.select((n) => /gemini/i.test(n.data?.nodePayload?.modelType ?? '') && n.data?.type !== 'smart-tag');
  h.log(`命中 ${nodes.length} 个节点`);
  for (const n of nodes) h.set(n, 'data.nodePayload.modelType', 'gpt-5.6-luna');
};
```

## 例 3：把「上下文重写」挪到某个节点后面

```js
export default ({ h }) => {
  const anchor = h.node('cb398f11');
  const rewrite = h.node('002369db');
  // 下游原来引用 anchor.text 的地方，改为引用重写节点的 message
  h.retargetRefs({ from: anchor.id, fromDataPath: 'text', to: rewrite.id, toDataPath: 'message', expect: 123 });
  h.removeEdges((e) => e.target.cell === rewrite.id, { expect: 1 });
  h.addEdge(anchor, h.portOf(anchor, 'right'), rewrite, h.portOf(rewrite, 'left'));
};
```

## 同一套改动用到别的版本或别的智能体

```bash
md pull --bot 太极2.0重构 --version v1.0.401
md apply ~/fixes/fare-fix.mjs     # 同一个脚本；锚点或数量不对会直接报错，不会悄悄漏改
```
````

`miaodong-kit/skill/references/push.md`：

````markdown
# 推送、冲突与回滚

- **推送写的是编辑器草稿，不会上线。** md 只调 `canvas/save`，不导入事件或会话变量，不发布，不启用。
- **合并规则**：用 `merge(拉取时的基线, 你的改后, 当前草稿)`。
  - 节点按 id 对齐：只有你改的，用你的内容，位置沿用草稿；只有别人改的，保留别人的；双方都改了同一个节点就是冲突。
  - 连线按「源节点#端口→目标节点#端口」对齐。
  - 挪位置不算改动。
- **冲突（退出码 5）**：运行 `md rebase`，在最新草稿上按顺序重跑改动脚本。锚点在新草稿里失效时脚本会报错：改好脚本后 `md apply --reset`，再逐个 `md apply`。
- **计划码**：由「当前草稿 + 要写的内容」算出。预演之后草稿又变了（比如编辑页自动保存），确认就会被拦，这时重新预演即可。
- **基于版本改的**：如果草稿和那一版不同，必须让用户选：
  - `--onto-draft`：把改动合进当前草稿，草稿里别的修改保留；
  - `--replace-draft`：草稿变成「那一版 + 改动」，草稿里别的修改丢掉。
- **回读核对**：推送后会立刻读回来比对。你改的节点、节点集合、连线集合必须一致；其他节点的细微差异只提示，因为服务端会归一化个别字段。
- **回滚**：`md restore` 默认用最近一次推送前的备份，同样先预演，再用计划码确认；回滚前的草稿另存一份。
- **被旧编辑页覆盖**：`md status --remote` 核对最近一次推送的节点是否还在。
````

在 `CLAUDE.md` 的 `### miaodong-kit（秒懂直连 CLI）` 小节**之前**插入下面这节（`AGENTS.md` 在 `### miaodong-kit（秒懂直连 CLI）` 之前插入同样内容）：

````markdown
### md（秒懂 CLI，装成 skill 给 Claude Code / Codex 用）

源码 `miaodong-kit/src/`，打包 `miaodong-kit/build.mjs`（esbuild 单文件，Node 18 直接跑），安装 `npm run md:install`：
装到 `~/.claude/skills/miaodong/`，并软链到 `~/.codex/skills/miaodong`、`~/.local/bin/md`。设计见
[docs/superpowers/specs/2026-09-23-miaodong-cli-design.md](docs/superpowers/specs/2026-09-23-miaodong-cli-design.md)。

```bash
npm run check:md          # 全部离线测试（假秒懂 server），Node 22
MD_E2E_NODE=~/.nvm/versions/node/v18.20.8/bin/node npm run check:md   # 同时验证产物在 Node 18 上可用
npm run md:build          # 只构建 miaodong-kit/dist/md.mjs
npm run md:install        # 构建 + 安装
```

改之前必读：
1. **身份只从浏览器控制台取**（`md auth snippet` → 剪贴板 → `md auth import`），不存密码，token 不进对话、不进报错；按区存在 `~/.miaodong/md/identities.json`（0600）。
2. **写秒懂只调 `canvas/save`**，默认预演，`--confirm <计划码>` 才写；推送是元素级三方合并（`src/merge.mjs`），不是全量覆盖。
3. 只 import 老懂**不依赖数据库**的纯函数；`canvas-sync.ts` / `client.ts` 这类会带起 SQLite 的模块一律不碰（打包测试会检查）。
4. 旧的 `npm run md:*`（kit bin）保留到第 2 步 `md exec` 落地，新工作优先用 md。
````

在 `miaodong-kit/PLAYBOOK.md` 的第一个标题下加一行：

```markdown
> 新做法：`md` 命令（skill 名 `miaodong`，见仓库 CLAUDE.md 的「md」一节）。本手册描述的是旧的 `npm run md:*` 命令，第 2 步之后下线。
```

- [ ] **Step 4：运行，确认通过（Node 22 与 Node 18 各跑一次）**

Run: `node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/install.test.mjs miaodong-kit/test/bundle.test.mjs`
Expected：全部 PASS

Run: `MD_E2E_NODE="$HOME/.nvm/versions/node/v18.20.8/bin/node" npm run check:md`
Expected：全部 PASS，其中打包产物全流程在 Node 18 上跑通

- [ ] **Step 5：提交**

```bash
git add miaodong-kit/skill miaodong-kit/install.mjs miaodong-kit/test/install.test.mjs miaodong-kit/test/bundle.test.mjs package.json CLAUDE.md AGENTS.md miaodong-kit/PLAYBOOK.md
git commit -m "feat(md): skill 说明书与安装（claude / codex / ~/.local/bin），文档更新，Node 18 全流程验证"
```

---

### Task 18：全量验证与真机验收（主会话与用户一起做）

**Files:** 无新增；发现问题时按 TDD 回到对应模块修

- [ ] **Step 1：离线全量**

```bash
npm run check:md
MD_E2E_NODE="$HOME/.nvm/versions/node/v18.20.8/bin/node" npm run check:md
npm run check:miaodong-kit && npm run check:miaodong-kit-e2e
npm run build --workspace @juzi/api
```
Expected：全部通过（最后一条是 api 的类型检查，确认没碰坏老懂）

- [ ] **Step 2：安装到本机**

安装会写 `~/.claude/skills/miaodong`（真身，Claude Code 从这里发现）、`~/.codex/skills/miaodong`（软链）、`~/.local/bin/md`（软链），并在桌面放一份 `~/Desktop/miaodong`（用户 09-23 要求）。动手前把这几个位置告诉用户，拿到同意再装。

```bash
npm run md:install
```

然后**新开一个终端**（默认 Node 18、任意目录）跑 `md --version`，Expected：`md <提交号>@<日期>`。再在 CC 里确认 skill 列表出现 `miaodong`。

- [ ] **Step 3：真机只读回归**

按 Task 9 的步骤，用安装好的 `md` 再跑一遍 versions / pull / trace / refs / node。

- [ ] **Step 4：真机写验收（每一步都要用户同意）**

请用户指定一个测试用的智能体（例如「【测试测试测试】太极2.0 测试专用版」）。在它上面走一遍：

1. `md pull`
2. 写一个只改一处 prompt 的脚本，`md apply`
3. `md diff`，然后 `md check`
4. `md push` 预演，把清单交给用户
5. 用户同意后 `md push --confirm <码>`
6. 用户刷新编辑页，确认能看到改动
7. `md status --remote`
8. `md restore` 预演，用户同意后确认
9. 用户确认改动已消失
10. `md log`

每个结果都如实记录。

- [ ] **Step 5：收尾**

按 superpowers:finishing-a-development-branch 处理分支。更新记忆 `miaodong-cli-plan.md`：写明第 1 步已完成、第 2 步的范围（`md exec`、单节点试跑、测试中心、花费闸门）。
