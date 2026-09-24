# 秒懂 CLI 第 2 步 2b：批准闸门 + md spend + md trial Implementation Plan

> **2026-09-25 执行中变更**：用户决定去掉弹窗，批准闸门改成确认码（spec §7 已改写）；终审的修复也改了试跑的花费判断（逐次止损、花费未知不当 ¥0、判断和记账加锁）。下文的 approve.mjs / 弹窗相关步骤是当时的计划，已不再代表代码现状，以 spec 和 ledger 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 md 加三样东西：
- 单节点试跑 `md trial`：用执行记录里的原始输入复现，推草稿后复验。
- 「用户本人批准」闸门：花钱超门槛、估不出花费、会真的调插件时，弹 macOS 系统对话框，只有用户本人点「同意」才会跑。
- 花费账本 `md spend`。

**Architecture:**
- 新增纯逻辑模块：
  - `approve.mjs`：弹窗 / 终端批准，可以注入依赖，便于测试；
  - `spend.mjs`：门槛、只追加的账本、今天已花多少、要不要批准；
  - `trial.mjs`：节点门禁、输入拼装、本地改动有没有推。
- 新增执行模块 `trial-run.mjs`：POST 一次，轮询到结束，POST 结果不明时绝不重发。
- 新增两条命令：`commands/spend.mjs`、`commands/trial.mjs`。
- 复用老懂的 `apps/api/lib/miaodong/trial-core.ts`（`startNodeTrialRun / getNodeTrialRun`，无 import，不依赖数据库），通过一个 requester 适配 md 的 `http.request`。
- 顺手把 2a 的 `locateExec` 搬进 `exec-locate.mjs`，把 `listWorkspaces` 搬进 `workspace.mjs`，给 trial 复用。

**Tech Stack:** Node ESM（源码在 Node 22 + strip-types 下测试，esbuild 单文件产物在 Node 18 可跑）、`node:test`、假秒懂 HTTP server、`/usr/bin/osascript`。

**Spec:** `docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md`（§2.2、§3、§5、§7、§8 中与试跑和花费有关的部分，§9 第 5、7 条）。2a 的计划 `docs/superpowers/plans/2026-09-24-miaodong-cli-step2a.md` 已执行完。

## Global Constraints

- 所有命令都在 worktree 根目录 `/Users/hukui/Desktop/workspace/Agentflow/.worktrees/miaodong-cli` 下运行。不要 `cd` 出去：会话的工作目录会被重置到主仓库。
- 测试一律用 Node 22 的绝对路径：
  - 单个文件：`$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/<文件>.test.mjs`
  - 全部：把文件换成 `miaodong-kit/test/*.test.mjs`
  - 产物要在 Node 18 上跑：前面加 `MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node`
- 只能 import 老懂里不依赖数据库的纯模块。`trial-core.ts` 没有 import，可以用；打包测试会检查产物里没有 `better-sqlite3|drizzle-orm`。
- 批准闸门的硬性要求（spec §7）：
  - **没有任何参数或环境变量能「放行」**。唯一的环境变量 `MD_NO_DIALOG=1` 只会让它直接拒绝（测试用，只能更严）。
  - macOS 用绝对路径 `/usr/bin/osascript`。弹窗文字经 argv 传进去，不拼进 AppleScript 源码。
  - 非 macOS 只在有 TTY 时询问；没有 TTY 一律拒绝。
  - 没拿到批准：退出码 5，什么都不跑，账本不记。
- 默认门槛：单次 ¥2、每日 ¥10（spec §7）。只能通过 `md spend limit` 修改，而且修改本身也要批准。
- 单节点试跑：
  - 只跑草稿，主画布 canvasId 取自 `canvas/get`。
  - **不提供 `--version`**。spec §9 第 5 条的核对因此不做，见下面的 Ruling。
  - POST 失败时，只有明确被拒（业务错误或 HTTP 4xx）才报「没启动」；网络错误、超时、5xx、缺 execId 一律报「有没有启动不确定」，**绝不重发**。
- 测试里不许真的弹窗：`test/helpers/run-cli.mjs` 默认给子进程带 `MD_NO_DIALOG=1`、`MD_POLL_MS=5`。批准通过的分支只在单元测试里注入假的批准函数来覆盖。
- 输出约定：stdout 放结果，stderr 放过程；第一行是目标行；长内容截断，全文写文件。
- 本地数据只写 `$MD_HOME`：`trials/…`、`spend.jsonl`、`config.json`。
- 不打印 token。中文注释、中文文案、英文标识符；不新增 npm 依赖。
- **Ruling（写计划时定的，执行者照抄进 ledger）**：2b 不提供 `md trial --version`，spec §9 第 5 条的小额核对也不做。
  - 理由：常用流程是「推草稿再试跑」，按版本试跑很少用到；不做这项核对，还省掉一次要用户授权的花费。
  - 若错：用户要按版本试跑时，再补一个小功能，外加一次核对。

## Review Focus

1. **POST 超时或 5xx 之后绝不重发**：秒懂没有取消接口，也没有能列出节点执行的接口，重发可能跑两遍（多花钱，插件节点还会多调一次外部系统）。见 Task 7。
2. **估不出花费时**：先跑 1 次，用实际花费推算其余几次；推算超门槛就停下来要批准。已经跑的那次要记进账本。见 Task 8。
3. **本地改了还没推就去试跑**：必须醒目提示「跑的是草稿上的旧版本」。见 Task 8。
4. **同一个参数给了多次**：`--input` 收成数组；`--bot / --limit` 这类只该给一次的报用法错误，不再悄悄取最后一个。见 Task 1。
5. **弹窗文字里有引号、`&`、AppleScript 关键字**：不能注入脚本，也不能让弹窗失败。见 Task 2。

---

### Task 1: 参数可以给多次（--input）

**Files:**
- Modify: `miaodong-kit/src/args.mjs`
- Test: `miaodong-kit/test/args.test.mjs`（新建）

**Interfaces:**
- Produces:
  - `parseArgs` 遇到同一个 key 多次时收成数组；
  - `strArg / intArg` 遇到数组时报「只能给一次」；
  - 新增 `listArg(args, key) → string[]`。

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/args.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { intArg, listArg, parseArgs, strArg } from '../src/args.mjs';

test('同一个参数给多次：收成数组，listArg 取全部', () => {
  const args = parseArgs(['--input', 'a=1', '--input', 'b=2', '--input=c=3']);
  assert.deepEqual(args.input, ['a=1', 'b=2', 'c=3']);
  assert.deepEqual(listArg(args, 'input'), ['a=1', 'b=2', 'c=3']);
  assert.deepEqual(listArg(parseArgs(['--input', 'x=1']), 'input'), ['x=1']);
  assert.deepEqual(listArg(parseArgs([]), 'input'), []);
});

test('只该给一次的参数给了多次：报用法错误，不悄悄取最后一个', () => {
  const args = parseArgs(['--bot', '甲', '--bot', '乙', '--limit', '1', '--limit', '2']);
  assert.throws(() => strArg(args, 'bot'), (e) => e.exitCode === 2 && /只能给一次/.test(e.message));
  assert.throws(() => intArg(args, 'limit', 10), (e) => e.exitCode === 2 && /只能给一次/.test(e.message));
});

test('listArg：漏了值报用法错误', () => {
  assert.throws(() => listArg(parseArgs(['--input', '--times', '2']), 'input'), (e) => e.exitCode === 2);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/args.test.mjs`
Expected: FAIL，报 `does not provide an export named 'listArg'`。

- [ ] **Step 3: 实现**

在 `miaodong-kit/src/args.mjs` 里：

1. 在 `FALSY_WORDS` 下面加：

```js
// 同一个参数给了多次就收成数组：--input 这类要给多个；只该给一次的（--bot / --limit …）由 strArg / intArg 报错。
// 以前是悄悄取最后一个——`--bot 甲 --bot 乙` 会静默落到乙上
function assign(out, key, value) {
  if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  else if (Array.isArray(out[key])) out[key].push(value);
  else out[key] = [out[key], value];
}
```

2. 把 `parseArgs` 里三处 `out[key] = …` 换成 `assign(out, key, …)`。`--no-key` 那一处保持直接赋值 `out[a.slice(5)] = false;`：

```js
    if (eq >= 0) {
      const v = key.slice(eq + 1);
      key = key.slice(0, eq);
      assign(out, key, FALSY_WORDS.has(v.toLowerCase()) ? false : v);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      assign(out, key, true);
    } else {
      assign(out, key, FALSY_WORDS.has(next.toLowerCase()) ? false : next);
      i++;
    }
```

3. `strArg` 和 `intArg` 在 `const v = args[key];` 之后都加一行：

```js
  if (Array.isArray(v)) throw usage(`--${key} 只能给一次`);
```

4. 文件末尾加：

```js
/** 可以给多次的参数（--input a=1 --input b=2）。没给返回空数组；给了但漏了值报用法错误。 */
export function listArg(args, key) {
  const v = args[key];
  if (v === undefined || v === false) return [];
  const list = Array.isArray(v) ? v : [v];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) throw usage(`--${key} 需要一个值，比如 --${key} <值>`);
  }
  return list.map((item) => item.trim());
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 3 条 PASS。再跑全部测试，确认没人依赖「重复参数取最后一个」：`# fail 0`。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/args.mjs miaodong-kit/test/args.test.mjs
git commit -m "feat(md): 参数可以给多次（--input），只该给一次的重复给报错"
```

---

### Task 2: 用户本人批准（approve.mjs）

**Files:**
- Create: `miaodong-kit/src/approve.mjs`
- Modify: `miaodong-kit/test/helpers/run-cli.mjs`：子进程默认带 `MD_NO_DIALOG=1`、`MD_POLL_MS=5`。
- Test: `miaodong-kit/test/approve.test.mjs`（新建）

**Interfaces:**
- Produces:
  - `requestApproval({ title, lines }, deps?) → Promise<{ ok: boolean, via: 'dialog'|'tty'|'none', reason?: string }>`
    - `deps` 可以注入：`{ platform, env, runOsascript(text, title), isTTY, promptTty(text) }`。
  - `osascriptArgs(text, title) → string[]`，传给 `/usr/bin/osascript` 的参数。

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/approve.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { osascriptArgs, requestApproval } from '../src/approve.mjs';

const REQ = { title: 'md 花费确认', lines: ['智能体：太极2.0 质检革新版', '预计 ¥3.00'] };

test('macOS：弹系统对话框，只有点「同意」才算批准', async () => {
  const seen = [];
  const yes = await requestApproval(REQ, { platform: 'darwin', env: {}, runOsascript: async (text, title) => { seen.push({ text, title }); return { ok: true }; } });
  assert.deepEqual(yes, { ok: true, via: 'dialog' });
  assert.equal(seen[0].text, '智能体：太极2.0 质检革新版\n预计 ¥3.00');
  assert.equal(seen[0].title, 'md 花费确认');
  const no = await requestApproval(REQ, { platform: 'darwin', env: {}, runOsascript: async () => ({ ok: false, reason: '用户点了拒绝' }) });
  assert.deepEqual(no, { ok: false, reason: '用户点了拒绝', via: 'dialog' });
});

test('MD_NO_DIALOG=1 只会让它直接拒绝，不弹窗', async () => {
  let called = 0;
  const r = await requestApproval(REQ, { platform: 'darwin', env: { MD_NO_DIALOG: '1' }, runOsascript: async () => { called++; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(called, 0);
});

test('不是 macOS：有终端才问（要输入「同意」）；AI 调用（没有终端）一律拒绝', async () => {
  const noTty = await requestApproval(REQ, { platform: 'linux', env: {}, isTTY: false });
  assert.equal(noTty.ok, false);
  assert.match(noTty.reason, /自己的终端/);
  const tty = await requestApproval(REQ, { platform: 'linux', env: {}, isTTY: true, promptTty: async (text) => { assert.match(text, /预计 ¥3\.00/); return { ok: true }; } });
  assert.deepEqual(tty, { ok: true, via: 'tty' });
});

test('弹窗文字走 argv，不拼进 AppleScript 源码（防引号出错和注入）', () => {
  const text = '他说"你好" & do shell script "rm -rf ~"';
  const args = osascriptArgs(text, '标题');
  assert.deepEqual(args.slice(-2), [text, '标题']);
  const script = args.slice(0, -2);
  assert.ok(script.every((a) => !a.includes('rm -rf')));
  assert.equal(script.filter((a) => a === '-e').length, script.length / 2);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/approve.test.mjs`
Expected: FAIL，报 Cannot find module `../src/approve.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/approve.mjs`

```js
// 需要用户本人批准的操作（花费超门槛、估不出花费、会真的调插件、改门槛）都走这里。
// 为什么不用 --confirm：AI 能执行任意命令，计划码只能证明它做过预演。
// 为什么不用「在终端里输入确认」：md 分不清终端里的字是人敲的还是 AI 敲的。系统弹窗只有人能点。
// 没有任何参数或环境变量能「放行」；MD_NO_DIALOG=1 只会让它直接拒绝（测试用，只能更严）。

import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

const OSASCRIPT = '/usr/bin/osascript';
const TIMEOUT_S = 90;

// 文字经 argv 传进 AppleScript，不拼进脚本源码：避免引号转义出错，也避免内容被当成脚本执行
const SCRIPT = [
  'on run argv',
  `set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"拒绝", "同意"} default button "拒绝" cancel button "拒绝" with icon caution giving up after ${TIMEOUT_S}`,
  'if gave up of r then return "timeout"',
  'return button returned of r',
  'end run',
];

export function osascriptArgs(text, title) {
  return [...SCRIPT.flatMap((line) => ['-e', line]), text, title];
}

function runOsascript(text, title) {
  return new Promise((resolve) => {
    execFile(OSASCRIPT, osascriptArgs(text, title), { timeout: (TIMEOUT_S + 15) * 1000 }, (error, stdout) => {
      const answer = String(stdout ?? '').trim();
      if (error) resolve({ ok: false, reason: /-128/.test(String(error.message)) ? '用户点了拒绝' : `弹窗失败：${String(error.message).slice(0, 120)}` });
      else if (answer === '同意') resolve({ ok: true });
      else if (answer === 'timeout') resolve({ ok: false, reason: `${TIMEOUT_S} 秒内没有人点` });
      else resolve({ ok: false, reason: `用户选了「${answer}」` });
    });
  });
}

function promptTty(text) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${text}\n\n确认请输入「同意」：`, (answer) => {
      rl.close();
      resolve(answer.trim() === '同意' ? { ok: true } : { ok: false, reason: '没有输入「同意」' });
    });
  });
}

export async function requestApproval({ title, lines }, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const text = lines.join('\n');
  if (env.MD_NO_DIALOG === '1') return { ok: false, via: 'none', reason: '这台机器关掉了确认弹窗（MD_NO_DIALOG=1）' };
  if (platform === 'darwin') {
    const r = await (deps.runOsascript ?? runOsascript)(text, title);
    return { ...r, via: 'dialog' };
  }
  const tty = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (tty) {
    const r = await (deps.promptTty ?? promptTty)(`${title}\n${text}`);
    return { ...r, via: 'tty' };
  }
  return { ok: false, via: 'none', reason: '这台机器弹不出确认框：请用户在自己的终端里运行同一条命令' };
}
```

改 `miaodong-kit/test/helpers/run-cli.mjs`：spawn 的 env 改成

```js
      env: { PATH: process.env.PATH ?? '', HOME: home, MD_HOME: join(home, 'md'), MD_NO_DIALOG: '1', MD_POLL_MS: '5', ...env },
```

并把文件头注释补一句：「测试里绝不真弹窗：默认 MD_NO_DIALOG=1（只会让批准直接失败）；轮询间隔压到 5ms。」

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 4 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/approve.mjs miaodong-kit/test/approve.test.mjs miaodong-kit/test/helpers/run-cli.mjs
git commit -m "feat(md): 用户本人批准——macOS 系统弹窗，其他系统仅终端，AI 调用一律拒绝"
```

---

### Task 3: 花费门槛与账本（spend.mjs）

**Files:**
- Create: `miaodong-kit/src/spend.mjs`
- Test: `miaodong-kit/test/spend.test.mjs`（新建）

**Interfaces:**
- Consumes: `ensureDir, mdHome, readJson, writeJson`（`src/home.mjs`）
- Produces:
  - `DEFAULT_LIMITS = { perCommand: 2, perDay: 10 }`
  - 门槛：`loadLimits() → { perCommand, perDay }`、`saveLimits(limits)`
  - 账本：
    - `recordSpend(entry) → id`：追加一行，字段有 `id, at, actual: null` 加 `entry`；
    - `updateSpend(id, patch)`：追加一行 `{ id, ...patch }`；
    - `readSpends() → rows`：按 id 合并。
  - 统计与判断：
    - `amountOf(row) → number`：有实际用实际，没有用预估，都没有就是 0；
    - `spentOn(rows, when = Date.now()) → number`：按本地日期求和；
    - `spendDecision({ estimate: number|null, externalCalls?: string[] }, { limits, today }) → { needApproval, reasons: string[] }`

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/spend.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MD_HOME = mkdtempSync(join(tmpdir(), 'md-spend-'));
const { DEFAULT_LIMITS, loadLimits, readSpends, recordSpend, saveLimits, spendDecision, spentOn, updateSpend } = await import('../src/spend.mjs');

test('门槛：没配过用默认 ¥2 / ¥10；配过的读配置；坏值回退默认', () => {
  assert.deepEqual(loadLimits(), DEFAULT_LIMITS);
  saveLimits({ perCommand: 5, perDay: 30 });
  assert.deepEqual(loadLimits(), { perCommand: 5, perDay: 30 });
  writeFileSync(join(process.env.MD_HOME, 'config.json'), JSON.stringify({ spend: { perCommand: -1, perDay: 'x' } }));
  assert.deepEqual(loadLimits(), DEFAULT_LIMITS);
});

test('账本：先记预估，跑完追加实际；读的时候按 id 合并', () => {
  const id = recordSpend({ kind: 'trial', botId: 'b1', what: '回答生成', estimate: 0.03 });
  updateSpend(id, { actual: 0.031 });
  const row = readSpends().find((r) => r.id === id);
  assert.equal(row.estimate, 0.03);
  assert.equal(row.actual, 0.031);
  assert.equal(row.what, '回答生成');
});

test('今天已花：有实际用实际，没有用预估；不算昨天的', () => {
  const now = new Date(2026, 8, 24, 12).getTime();
  const rows = [
    { id: 'a', at: new Date(2026, 8, 24, 9).toISOString(), estimate: 1, actual: 0.5 },
    { id: 'b', at: new Date(2026, 8, 24, 10).toISOString(), estimate: 0.3, actual: null },
    { id: 'c', at: new Date(2026, 8, 23, 23).toISOString(), estimate: 5, actual: 5 },
  ];
  assert.equal(spentOn(rows, now), 0.8);
});

test('要不要本人批准：超单次、超每日、估不出、今天已到上限、会调外部系统', () => {
  const limits = { perCommand: 2, perDay: 10 };
  assert.deepEqual(spendDecision({ estimate: 1 }, { limits, today: 0 }), { needApproval: false, reasons: [] });
  assert.match(spendDecision({ estimate: 3 }, { limits, today: 0 }).reasons.join(), /超过单次门槛 ¥2/);
  assert.match(spendDecision({ estimate: 1 }, { limits, today: 9.5 }).reasons.join(), /超过每日上限 ¥10/);
  assert.match(spendDecision({ estimate: null }, { limits, today: 0 }).reasons.join(), /估不出花费/);
  assert.match(spendDecision({ estimate: null }, { limits, today: 10 }).reasons.join(), /今天已到每日上限/);
  assert.match(spendDecision({ estimate: 0.01, externalCalls: ['兴趣岛用户详情'] }, { limits, today: 0 }).reasons.join(), /会真的调用外部系统：兴趣岛用户详情/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/spend.test.mjs`
Expected: FAIL，报 Cannot find module `../src/spend.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/spend.mjs`

```js
// 花费：门槛（单次、每日）和账本。
// 账本只追加：开跑前记预估，跑完再追加一行实际花费（同一个 id），读的时候按 id 合并。
// 「今天已花」按本地日期算，有实际用实际，没有用预估——跑到一半中断的也不会漏算。

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ensureDir, mdHome, readJson, writeJson } from './home.mjs';

export const DEFAULT_LIMITS = Object.freeze({ perCommand: 2, perDay: 10 });

const configPath = () => join(mdHome(), 'config.json');
const spendPath = () => join(mdHome(), 'spend.jsonl');

export function loadLimits() {
  const spend = readJson(configPath(), {})?.spend ?? {};
  const pick = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  return { perCommand: pick(spend.perCommand, DEFAULT_LIMITS.perCommand), perDay: pick(spend.perDay, DEFAULT_LIMITS.perDay) };
}

export function saveLimits({ perCommand, perDay }) {
  const config = readJson(configPath(), {});
  writeJson(configPath(), { ...config, spend: { perCommand, perDay } });
}

export function recordSpend(entry) {
  const row = { id: randomUUID(), at: new Date().toISOString(), actual: null, ...entry };
  ensureDir(mdHome());
  appendFileSync(spendPath(), `${JSON.stringify(row)}\n`);
  return row.id;
}

export function updateSpend(id, patch) {
  ensureDir(mdHome());
  appendFileSync(spendPath(), `${JSON.stringify({ id, ...patch })}\n`);
}

export function readSpends() {
  if (!existsSync(spendPath())) return [];
  const byId = new Map();
  for (const line of readFileSync(spendPath(), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row?.id) continue;
    byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row });
  }
  return [...byId.values()];
}

export const amountOf = (row) => (typeof row.actual === 'number' ? row.actual : typeof row.estimate === 'number' ? row.estimate : 0);

const dayKey = (value) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function spentOn(rows, when = Date.now()) {
  const key = dayKey(when);
  return rows.filter((r) => dayKey(r.at) === key).reduce((sum, r) => sum + amountOf(r), 0);
}

// 要不要用户本人批准。estimate 为 null = 估不出花费
export function spendDecision({ estimate, externalCalls = [] }, { limits, today }) {
  const reasons = [];
  if (externalCalls.length) reasons.push(`会真的调用外部系统：${externalCalls.join('、')}`);
  if (estimate === null) {
    reasons.push('估不出花费');
    if (today >= limits.perDay) reasons.push(`今天已到每日上限 ¥${limits.perDay}`);
  } else {
    if (estimate > limits.perCommand) reasons.push(`预计 ¥${estimate.toFixed(2)}，超过单次门槛 ¥${limits.perCommand}`);
    if (today + estimate > limits.perDay) reasons.push(`今天已花 ¥${today.toFixed(2)}，加上这次超过每日上限 ¥${limits.perDay}`);
  }
  return { needApproval: reasons.length > 0, reasons };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 4 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/spend.mjs miaodong-kit/test/spend.test.mjs
git commit -m "feat(md): 花费门槛与只追加的花费账本"
```

---

### Task 4: `md spend`（看花费、改门槛）

**Files:**
- Create: `miaodong-kit/src/commands/spend.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`（登记 `spend`）
- Test: `miaodong-kit/test/spend-cmd.test.mjs`（新建）

**Interfaces:**
- Consumes：
  - Task 3 的 `loadLimits, saveLimits, readSpends, spentOn`；
  - Task 2 的 `requestApproval`；
  - `formatCost`（`src/execs.mjs`）。
- Produces：
  - `COMMANDS.spend`；
  - `changeLimits(args, { approve = requestApproval }) → Promise<exitCode>`：导出给单元测试注入批准函数用。

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/spend-cmd.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';

function seedSpends(home, rows) {
  mkdirSync(join(home, 'md'), { recursive: true });
  writeFileSync(join(home, 'md', 'spend.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('md spend：今天已花、门槛、最近几笔（有实际用实际）', async () => {
  const home = tempHome();
  const now = new Date().toISOString();
  seedSpends(home, [
    { id: 'a', at: now, kind: 'trial', regionLabel: '兴趣岛', botName: '质检革新版', what: '回答生成', count: 3, estimate: 0.03, actual: null, approved: 'auto' },
    { id: 'a', actual: 0.031 },
  ]);
  const r = await runCli(['spend'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /今天已花 ¥0\.031 \/ 每日上限 ¥10\.00（单次门槛 ¥2\.00）/);
  assert.match(r.stdout, /试跑 兴趣岛 \/ 质检革新版「回答生成」×3 预估 ¥0\.030 实际 ¥0\.031（自动）/);
});

test('md spend：没有记录时说清楚', async () => {
  const r = await runCli(['spend'], { home: tempHome() });
  assert.match(r.stdout, /今天已花 ¥0 \/ 每日上限 ¥10\.00/);
  assert.match(r.stdout, /最近 7 天：没有花费/);
});

test('md spend limit：没拿到本人批准就不改（测试里 MD_NO_DIALOG=1），退出码 5', async () => {
  const home = tempHome();
  const r = await runCli(['spend', 'limit', '--per-command', '5', '--per-day', '20'], { home });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /门槛没改/);
  assert.equal(existsSync(join(home, 'md', 'config.json')), false);
});

test('changeLimits：批准了才写配置；金额要是非负数', async () => {
  const home = tempHome();
  process.env.MD_HOME = join(home, 'md');
  const { changeLimits } = await import('../src/commands/spend.mjs');
  const { parseArgs } = await import('../src/args.mjs');
  const seen = [];
  await changeLimits(parseArgs(['limit', '--per-command', '5']), { approve: async (req) => { seen.push(req); return { ok: true, via: 'dialog' }; } });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'md', 'config.json'), 'utf-8')).spend, { perCommand: 5, perDay: 10 });
  assert.match(seen[0].lines.join('\n'), /单次门槛：¥2\.00 → ¥5\.00/);
  await assert.rejects(changeLimits(parseArgs(['limit', '--per-day', '-1']), { approve: async () => ({ ok: true }) }), (e) => e.exitCode === 2);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/spend-cmd.test.mjs`
Expected: 4 条 FAIL。前 3 条报「未知命令：spend」，第 4 条报找不到 `../src/commands/spend.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/commands/spend.mjs`

```js
// md spend：看花费（今天、最近几天、每一笔），改门槛。改门槛本身也要用户本人批准——否则 AI 被拦下后可以自己把门槛调高。

import { intArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { formatTime, out } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { loadLimits, readSpends, saveLimits, spentOn } from '../spend.mjs';
import { requestApproval } from '../approve.mjs';

const KIND = { trial: '试跑', test: '测试' };
const APPROVED = { auto: '自动', dialog: '弹窗同意', tty: '终端同意' };

function moneyArg(args, key) {
  const v = strArg(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw usage(`--${key} 要写金额（元），收到「${v}」`);
  return n;
}

export async function changeLimits(args, { approve = requestApproval } = {}) {
  const perCommand = moneyArg(args, 'per-command');
  const perDay = moneyArg(args, 'per-day');
  if (perCommand === undefined && perDay === undefined) throw usage('要给 --per-command 和 / 或 --per-day（单位：元）');
  const before = loadLimits();
  const next = { perCommand: perCommand ?? before.perCommand, perDay: perDay ?? before.perDay };
  const approval = await approve({
    title: 'md：改花费门槛',
    lines: [
      `单次门槛：${formatCost(before.perCommand)} → ${formatCost(next.perCommand)}`,
      `每日上限：${formatCost(before.perDay)} → ${formatCost(next.perDay)}`,
      '',
      '由 AI 发起；只有你本人能点「同意」。',
    ],
  });
  if (!approval.ok) throw new MdError('not_approved', `门槛没改：${approval.reason}`, { exitCode: EXIT.BLOCKED });
  saveLimits(next);
  out(`花费门槛已改：单次 ${formatCost(next.perCommand)}，每日 ${formatCost(next.perDay)}`);
  return EXIT.OK;
}

function showSpend(args) {
  const limits = loadLimits();
  const rows = readSpends().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const days = intArg(args, 'days', 7, 90);
  out(`今天已花 ${formatCost(spentOn(rows))} / 每日上限 ${formatCost(limits.perDay)}（单次门槛 ${formatCost(limits.perCommand)}）`);
  const perDay = [];
  for (let i = 0; i < days; i++) {
    const when = Date.now() - i * 86_400_000;
    const sum = spentOn(rows, when);
    if (sum > 0) perDay.push(`${formatTime(when).slice(5, 10)} ${formatCost(sum)}`);
  }
  out(`最近 ${days} 天：${perDay.length ? perDay.join(' · ') : '没有花费'}`);
  const recent = rows.slice(-intArg(args, 'limit', 10, 200)).reverse();
  if (recent.length) out('最近几笔：');
  for (const r of recent) {
    const estimate = typeof r.estimate === 'number' ? formatCost(r.estimate) : '估不出';
    const actual = typeof r.actual === 'number' ? formatCost(r.actual) : '还没有';
    out(`  ${formatTime(r.at)} ${KIND[r.kind] ?? r.kind} ${r.regionLabel ?? '-'} / ${r.botName ?? '-'}「${r.what ?? '-'}」×${r.count ?? 1} 预估 ${estimate} 实际 ${actual}（${APPROVED[r.approved] ?? r.approved ?? '-'}）`);
  }
  return EXIT.OK;
}

export const spend = {
  summary: '花费：今天花了多少、最近几天、每一笔；spend limit 改门槛（要用户本人在弹窗里同意）',
  usage: [
    'md spend [--days 7] [--limit 10]',
    'md spend limit --per-command <元> --per-day <元>     改门槛：要用户本人在弹窗里点同意',
  ].join('\n'),
  async run(args) {
    if (args._[0] === 'limit') return changeLimits(args);
    if (args._[0]) throw usage(`不认识「${args._[0]}」`, '用 md spend 或 md spend limit');
    return showSpend(args);
  },
};
```

在 `miaodong-kit/src/commands/index.mjs` 里登记：`import { spend } from './spend.mjs';`，并把 `spend` 加到 `COMMANDS` 对象的末尾。

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 4 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/commands/spend.mjs miaodong-kit/src/commands/index.mjs miaodong-kit/test/spend-cmd.test.mjs
git commit -m "feat(md): md spend 看花费、改门槛（改门槛也要本人批准）"
```

---

### Task 5: 复用前的两处搬家（exec-locate.mjs、listWorkspaces）

**Files:**
- Create: `miaodong-kit/src/exec-locate.mjs`
- Modify: `miaodong-kit/src/commands/exec.mjs`（删掉 `EXEC_ID` 和 `locateExec`，改为 import）
- Modify: `miaodong-kit/src/workspace.mjs`（新增 `listWorkspaces`、`latestWorkspaceFor`）
- Modify: `miaodong-kit/src/commands/status.mjs`（改用 workspace.mjs 的 `listWorkspaces`）
- Test: `miaodong-kit/test/workspace-latest.test.mjs`（新建）

**Interfaces:**
- Produces:
  - `exec-locate.mjs`：
    - `EXEC_ID`：正则；
    - `locateExec(args, execId) → { target, dir, detail, fresh? }`：行为与 2a 完全相同。
  - `workspace.mjs`：
    - `listWorkspaces() → [{ dir, meta, hasAfter }]`：按拉取时间从新到旧；
    - `latestWorkspaceFor(botId) → loadWorkspace 的结果 | null`。

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/workspace-latest.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { SEED_BOT, seedWorkspace } from './helpers/seed.mjs';
import { sampleCanvas } from './helpers/fixtures.mjs';

test('latestWorkspaceFor：取这个智能体最近拉的工作副本；别的智能体没有就是 null', async () => {
  const home = tempHome();
  const older = await seedWorkspace(home, { canvas: sampleCanvas(), meta: { pulledAt: '2026-09-20T00:00:00.000Z' } });
  const newer = await seedWorkspace(home, { canvas: sampleCanvas(), meta: { pulledAt: '2026-09-24T00:00:00.000Z' } });
  const { latestWorkspaceFor, listWorkspaces } = await import('../src/workspace.mjs');
  assert.equal(listWorkspaces()[0].dir, newer);
  assert.equal(latestWorkspaceFor(SEED_BOT).dir, newer);
  assert.notEqual(latestWorkspaceFor(SEED_BOT).dir, older);
  assert.equal(latestWorkspaceFor('00000000-no-such-bot'), null);
  assert.equal((await runCli(['status'], { home })).code, 0);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/workspace-latest.test.mjs`
Expected: FAIL，报 `does not provide an export named 'latestWorkspaceFor'`。

- [ ] **Step 3: 实现**

1. `workspace.mjs` 顶部的 fs import 补上 `readdirSync`（已有就跳过），文件末尾加：

```js
export function listWorkspaces() {
  const root = workRoot();
  if (!existsSync(root)) return [];
  const subdirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
  const dirs = [];
  for (const region of subdirs(root)) {
    for (const bot of subdirs(region)) {
      for (const ws of subdirs(bot)) if (existsSync(join(ws, 'meta.json'))) dirs.push(ws);
    }
  }
  return dirs
    .map((dir) => ({ dir, meta: readJson(join(dir, 'meta.json')), hasAfter: existsSync(join(dir, 'after.json')) }))
    .sort((a, b) => String(b.meta.pulledAt).localeCompare(String(a.meta.pulledAt)));
}

// 试跑前要知道「本地改了还没推」：看这个智能体最近拉的那个工作副本
export function latestWorkspaceFor(botId) {
  const hit = listWorkspaces().find((w) => w.meta.botId === botId);
  return hit ? loadWorkspace({ ws: hit.dir }) : null;
}
```

2. `commands/status.mjs`：
   - 删掉本地的 `listWorkspaces` 函数；
   - 改为从 `../workspace.mjs` import `listWorkspaces`；
   - 删掉因此不再用到的 import（`existsSync, readdirSync`，以及 `join` 如果不再使用）。

3. 新建 `src/exec-locate.mjs`：
   - 把 `commands/exec.mjs` 里的 `const EXEC_ID = …` 和整个 `async function locateExec(…) {…}` **原样**搬过来，包括 2a 审查修复后的改动，并改成 `export`。
   - 文件头注释：`// 找到一条执行属于哪个区 / 企业 / 智能体，并取详情（带缓存）。md exec 和 md trial --from-exec 共用。`
   - import 这段代码用到的：`strArg`（`./args.mjs`）、`EXIT, MdError`（`./errors.mjs`）、`loadIdentities, requireIdentities`（`./identity.mjs`）、`loadBotDirectory, resolveBot, targetArgs`（`./target.mjs`）、`note, shortId`（`./output.mjs`）、`getExecDetail`（`./execs.mjs`）、`execDir, findCachedExec, loadCachedDetail, saveDetail`（`./exec-store.mjs`）。

4. `commands/exec.mjs`：
   - 删掉这两段，改为 `import { EXEC_ID, locateExec } from '../exec-locate.mjs';`；
   - 删掉因此不再用到的 import。

- [ ] **Step 4: 运行，确认通过**

Run: 先跑 Step 2 的命令，Expected：1 条 PASS。再跑全部测试，Expected：`# fail 0`（exec、status 的原有测试都还绿，说明搬家没改行为）。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/exec-locate.mjs miaodong-kit/src/commands/exec.mjs miaodong-kit/src/workspace.mjs miaodong-kit/src/commands/status.mjs miaodong-kit/test/workspace-latest.test.mjs
git commit -m "refactor(md): locateExec 与 listWorkspaces 搬到公共模块，给试跑复用"
```

---

### Task 6: 试跑的纯逻辑（trial.mjs）

**Files:**
- Create: `miaodong-kit/src/trial.mjs`
- Test: `miaodong-kit/test/trial.test.mjs`（新建）

**Interfaces:**
- Consumes: `asArray`（`src/api.mjs`）、`contentKey, nodeMap`（`src/canvas.mjs`）、`usage`（`src/errors.mjs`）
- Produces:
  - 常量：`TRIAL_ALLOWED: Set<string>`
  - 节点门禁：`classifyTrialNode(cell) → { kind: 'allowed'|'plugin'|'denied', type, plugins: string[] }`
  - 输入：
    - `inputDefs(cell) → [{ name, platform: boolean }]`
    - `parseInputPairs(pairs: string[]) → object`
    - `buildTrialInputs(defs, { fromExec, fromFile, overrides, keepPlatform }) → { inputs, dropped, missing, extra }`
  - 本地改动：`draftVsLocal(nodeId, draftCanvas, ws|null) → { status: 'no-workspace'|'unpushed'|'draft-changed'|'same', dir? }`

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/trial.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { node } from './helpers/fixtures.mjs';
import { buildTrialInputs, classifyTrialNode, draftVsLocal, inputDefs, parseInputPairs } from '../src/trial.mjs';

const llm = node(2, { name: '回答生成', payload: { inputs: [{ name: 'text', referenceNodeId: 'x' }, { name: '质检规则', operationAttrId: 'op-1' }] } });

test('classifyTrialNode：计算类能跑；插件类要 --allow-plugin；动作、触发、未知一律不跑', () => {
  assert.equal(classifyTrialNode(llm).kind, 'allowed');
  assert.equal(classifyTrialNode(node(3, { type: 'rule-center' })).kind, 'allowed');
  assert.deepEqual(classifyTrialNode(node(7, { name: '兴趣岛用户详情', type: 'plugin-calculation' })), { kind: 'plugin', type: 'plugin-calculation', plugins: ['兴趣岛用户详情'] });
  const withTool = node(8, { payload: { tools: [{ toolType: 'query_kb' }, { toolType: 'plugin', name: '写多维表' }] } });
  assert.deepEqual(classifyTrialNode(withTool).plugins, ['写多维表']);
  for (const type of ['send-text-message', 'handover', 'canvas-event-action', 'update-data', 'tag-user', 'plugin-action', 'receive-text-message', 'loop', 'write-content-router', 'whatever-new']) {
    assert.equal(classifyTrialNode(node(9, { type })).kind, 'denied', type);
  }
});

test('inputDefs：标出平台参数；没有 inputs 时用 query；web-search 要 count；语音按 mediaUrl 类型', () => {
  assert.deepEqual(inputDefs(llm), [{ name: 'text', platform: false }, { name: '质检规则', platform: true }]);
  assert.deepEqual(inputDefs(node(4, { type: 'query-knowledge-base', payload: { query: { name: 'query' } } })), [{ name: 'query', platform: false }]);
  assert.ok(inputDefs(node(5, { type: 'web-search', payload: { inputs: [{ name: 'q' }] } })).some((d) => d.name === 'count'));
  assert.ok(inputDefs(node(6, { type: 'speech-to-text', payload: { mediaUrl: { type: { type: 'audio' } } } })).some((d) => d.name === 'audioUrl'));
});

test('parseInputPairs：键=值；值里可以再有等号；没有等号报用法错误', () => {
  assert.deepEqual(parseInputPairs(['text=你好', 'expr=a=b']), { text: '你好', expr: 'a=b' });
  assert.throws(() => parseInputPairs(['text']), (e) => e.exitCode === 2);
});

test('buildTrialInputs：执行里带的平台参数默认去掉；文件和 --input 覆盖；列出缺的和多的', () => {
  const defs = inputDefs(llm);
  const fromExec = { text: '我想退款', 质检规则: '旧规则', extra1: 'x' };
  const a = buildTrialInputs(defs, { fromExec });
  assert.deepEqual(a.inputs, { text: '我想退款', extra1: 'x' });
  assert.deepEqual(a.dropped, ['质检规则']);
  assert.deepEqual(a.extra, ['extra1']);
  assert.deepEqual(buildTrialInputs(defs, { fromExec, keepPlatform: true }).inputs.质检规则, '旧规则');
  const b = buildTrialInputs(defs, { fromExec, fromFile: { text: '文件里的' }, overrides: { text: '参数里的' } });
  assert.equal(b.inputs.text, '参数里的');
  assert.deepEqual(buildTrialInputs(defs, {}).missing, ['text']);
});

test('draftVsLocal：本地改了没推 / 草稿在拉取后被改过 / 一致 / 没有工作副本', () => {
  const draft = [llm];
  const changed = { ...llm, data: { ...llm.data, nodePayload: { ...llm.data.nodePayload, systemPrompt: '新' } } };
  assert.equal(draftVsLocal(llm.id, draft, null).status, 'no-workspace');
  assert.equal(draftVsLocal(llm.id, draft, { dir: '/w', base: { canvas: [llm] }, after: { canvas: [changed] } }).status, 'unpushed');
  assert.equal(draftVsLocal(llm.id, draft, { dir: '/w', base: { canvas: [changed] }, after: null }).status, 'draft-changed');
  assert.equal(draftVsLocal(llm.id, draft, { dir: '/w', base: { canvas: [llm] }, after: null }).status, 'same');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/trial.test.mjs`
Expected: FAIL，报 Cannot find module `../src/trial.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/trial.mjs`

```js
// 单节点试跑的纯逻辑：哪些节点能跑、输入怎么拼、本地改动推没推。
// 能跑的只有计算类节点，和秒懂页面一致（页面只给计算类节点「测试该节点」按钮）；未知类型一律不跑。
// 插件计算节点、挂了插件工具的大模型会真的调外部系统：要 --allow-plugin，并且要用户本人批准。

import { asArray } from './api.mjs';
import { contentKey, nodeMap } from './canvas.mjs';
import { usage } from './errors.mjs';

export const TRIAL_ALLOWED = new Set([
  'llm-completion', 'javascript-code', 'rule-center', 'query-knowledge-base', 'query-knowledge-child', 'query-sql-db',
  'calculator', 'quality-check', 'speech-to-text', 'web-search', 'chat-search', 'image-generation',
]);

export function classifyTrialNode(cell) {
  const data = cell?.data ?? {};
  const type = String(data.type ?? cell?.shape ?? '');
  if (type === 'plugin-calculation') return { kind: 'plugin', type, plugins: [String(data.name ?? type)] };
  const pluginTools = asArray(data.nodePayload?.tools).filter((t) => t?.toolType === 'plugin');
  if (type === 'llm-completion' && pluginTools.length) {
    return { kind: 'plugin', type, plugins: pluginTools.map((t) => String(t?.name ?? t?.toolName ?? t?.pluginName ?? '插件工具')) };
  }
  if (TRIAL_ALLOWED.has(type)) return { kind: 'allowed', type, plugins: [] };
  return { kind: 'denied', type, plugins: [] };
}

// 节点要哪些输入：nodePayload.inputs[].name。来源是 operationAttrId 的是平台参数（如「质检规则」），不传时秒懂自动填最新值
export function inputDefs(cell) {
  const payload = cell?.data?.nodePayload ?? {};
  const defs = asArray(payload.inputs)
    .filter((i) => i && typeof i.name === 'string' && i.name.trim())
    .map((i) => ({ name: i.name.trim(), platform: Boolean(i.operationAttrId) }));
  if (!defs.length && typeof payload.query?.name === 'string' && payload.query.name.trim()) defs.push({ name: payload.query.name.trim(), platform: false });
  if (cell?.data?.type === 'web-search' && !defs.some((d) => d.name === 'count')) defs.push({ name: 'count', platform: false });
  const media = payload.mediaUrl?.type?.type;
  if (media === 'audio') defs.push({ name: 'audioUrl', platform: false });
  if (media === 'video') defs.push({ name: 'videoUrl', platform: false });
  return defs;
}

export function parseInputPairs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw usage(`--input 要写成 键=值，收到「${pair}」`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

// 执行记录里的输入带着执行当时解析出的平台参数，原样回灌会把它钉成旧值（09-22 会话里因此手工删过「质检规则」）
export function buildTrialInputs(defs, { fromExec = null, fromFile = null, overrides = {}, keepPlatform = false } = {}) {
  const base = { ...(fromExec ?? {}) };
  const dropped = [];
  if (!keepPlatform) {
    for (const d of defs) {
      if (d.platform && Object.prototype.hasOwnProperty.call(base, d.name)) {
        delete base[d.name];
        dropped.push(d.name);
      }
    }
  }
  const inputs = { ...base, ...(fromFile ?? {}), ...overrides };
  const names = new Set(defs.map((d) => d.name));
  const missing = defs.filter((d) => !d.platform && !Object.prototype.hasOwnProperty.call(inputs, d.name)).map((d) => d.name);
  const extra = Object.keys(inputs).filter((k) => !names.has(k));
  return { inputs, dropped, missing, extra };
}

// 试跑跑的是秒懂上的草稿：本地改了还没推，跑出来的就是旧版本
export function draftVsLocal(nodeId, draftCanvas, ws) {
  if (!ws) return { status: 'no-workspace' };
  const draftNode = nodeMap(draftCanvas).get(nodeId);
  const local = ws.after ? nodeMap(ws.after.canvas).get(nodeId) : null;
  const base = nodeMap(ws.base.canvas).get(nodeId);
  if (local && draftNode && contentKey(local) !== contentKey(draftNode)) return { status: 'unpushed', dir: ws.dir };
  if (base && draftNode && contentKey(base) !== contentKey(draftNode)) return { status: 'draft-changed', dir: ws.dir };
  return { status: 'same', dir: ws.dir };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 5 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/trial.mjs miaodong-kit/test/trial.test.mjs
git commit -m "feat(md): 试跑的节点门禁、输入拼装、本地改动检查"
```

---

### Task 7: 跑一次单节点试跑（trial-run.mjs）+ 带试跑接口的假秒懂

**Files:**
- Create: `miaodong-kit/src/trial-run.mjs`
- Create: `miaodong-kit/test/helpers/trial-server.mjs`
- Test: `miaodong-kit/test/trial-run.test.mjs`（新建）

**Interfaces:**
- Consumes：
  - 老懂的 `startNodeTrialRun, getNodeTrialRun`（`apps/api/lib/miaodong/trial-core.ts`）。它们的签名是：
    - `startNodeTrialRun(requester, { orgId, canvasId, nodeId, nodeInputs }) → { execId }`
    - `getNodeTrialRun(requester, { orgId, nodeExecId, canvasId, nodeId, nodeName?, nodeType?, nodeCategory?, nodeInputs? }) → NormalizedTrialRun`
    - 返回值里 `.isTerminal`、`.status`、`.duration` 在顶层，`.cost.cny` 也在顶层，`.nodeResults[0]` 带 `{ output, error, outputBranchId, metadata: { prompt, reasoning, cost } }`。
  - `request`（`src/http.mjs`）、`MdError`（`src/errors.mjs`）。
- Produces：
  - `runNodeOnce({ identity, orgId, canvasId, node: { id, name, type, category }, inputs }, { sleep?, now?, pollMs?, timeoutMs? }) → Promise<{ execId, run, timedOut }>`
  - 错误码：`trial_not_started`（明确被拒）、`trial_start_unknown`（不确定是否启动，不重发）、`trial_poll_failed`（连续 3 次查不到）；原样透传 `auth_expired`、`points_exhausted`。
  - 测试辅助 `startTrialServer({ cost, startStatus, runningPolls, pollStatus }) → { server, state }`；`trialDraft()`。

- [ ] **Step 1: 写假秒懂** `miaodong-kit/test/helpers/trial-server.mjs`

```js
// 带单节点试跑接口的假秒懂。state 在测试里可改：startStatus（POST 返回的 HTTP 状态）、runningPolls（先回几次 running）、
// pollStatus（GET 返回的 HTTP 状态）、cost（每次试跑的花费）。POST 请求体都记在 state.posts 里。
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { U, node } from './fixtures.mjs';
import { EXEC_BOT, X, delayDetail, execSnapshot } from './exec-fixtures.mjs';

// 在 2a 的快照上：回答生成多一个平台参数输入；再加一个插件计算节点和一个挂了插件工具的大模型
export function trialDraft() {
  return [
    ...execSnapshot().map((c) => (c.id === U(2)
      ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, inputs: [...c.data.nodePayload.inputs, { name: '质检规则', operationAttrId: 'op-1', valueType: 'reference', type: { type: 'string' } }] } } }
      : c)),
    node(7, { name: '兴趣岛用户详情', type: 'plugin-calculation' }),
    node(8, { name: '带插件的大模型', payload: { modelType: 'gemini-3.5-flash', inputs: [{ name: 'text' }], tools: [{ toolType: 'plugin', name: '写多维表' }] } }),
  ];
}

export async function startTrialServer({ cost = 0.0123, startStatus = 201, runningPolls = 1, pollStatus = 200 } = {}) {
  const state = { posts: [], polls: new Map(), cost, startStatus, runningPolls, pollStatus };
  const server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: EXEC_BOT, name: '太极2.0 质检革新版' }] : []),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: trialDraft(), version: 'v1.0.403', updatedAt: '2026-09-24T01:00:00.000Z' }),
    'GET /api/canvas/history/details': ({ query }) => (query.execId === X(2) ? ok(delayDetail()) : { status: 201, body: { code: -1, message: 'CANVAS_EXEC_NOT_FOUND' } }),
    'POST /api/canvas/node/exec': ({ body }) => {
      state.posts.push(body);
      if (state.startStatus >= 400) return { status: state.startStatus, body: { statusCode: state.startStatus, message: state.startStatus >= 500 ? 'Bad Gateway' : 'Bad Request' } };
      return { status: 201, body: { code: 0, data: { execId: `ne-${state.posts.length}` } } };
    },
    'GET /api/canvas/node/exec': ({ query }) => {
      if (state.pollStatus >= 400) return { status: state.pollStatus, body: { message: 'Internal Server Error' } };
      const n = (state.polls.get(query.nodeExecId) ?? 0) + 1;
      state.polls.set(query.nodeExecId, n);
      const body = state.posts[Number(query.nodeExecId.slice(3)) - 1];
      if (n <= state.runningPolls) return ok({ execId: query.nodeExecId, nodeId: body.nodeId, status: 'running' });
      const text = String(body.inputs.inputData.text ?? '');
      return ok({
        execId: query.nodeExecId, nodeId: body.nodeId, status: 'success', processDuration: 1200,
        output: { message: `回复：${text}` },
        metadata: {
          prompt: [{ role: 'system', content: '你是客服。' }, { role: 'user', content: text }],
          reasoningMessage: '想了想',
          tokenUsage: { prompt: 100, completion: 10, costInCny: state.cost },
        },
      });
    },
  });
  return { server, state };
}
```

- [ ] **Step 2: 写失败的测试** `miaodong-kit/test/trial-run.test.mjs`

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeOnce } from '../src/trial-run.mjs';
import { startTrialServer } from './helpers/trial-server.mjs';
import { U } from './helpers/fixtures.mjs';

let fake;
before(async () => { fake = await startTrialServer(); });
after(() => fake.server.close());
const identity = () => ({ key: 'k1', label: '测试区', origin: fake.server.origin, token: 't' });
const NODE = { id: U(2), name: '回答生成', type: 'llm-completion', category: 'calculation' };
const job = () => ({ identity: identity(), orgId: 'org-1', canvasId: 'main-1', node: NODE, inputs: { text: '你好' } });
const noWait = { sleep: async () => {} };
const reset = (patch = {}) => { Object.assign(fake.state, { posts: [], polls: new Map(), startStatus: 201, runningPolls: 1, pollStatus: 200, cost: 0.0123, ...patch }); };

test('POST 一次，查到跑完为止；结果里有输出、推理、花费', async () => {
  reset();
  const { execId, run, timedOut } = await runNodeOnce(job(), noWait);
  assert.equal(execId, 'ne-1');
  assert.equal(timedOut, false);
  assert.equal(fake.state.posts.length, 1);
  assert.deepEqual(fake.state.posts[0], { canvasId: 'main-1', nodeId: U(2), inputs: { inputData: { text: '你好' } } });
  assert.equal(fake.state.polls.get('ne-1'), 2);
  assert.equal(run.nodeResults[0].output.message, '回复：你好');
  assert.equal(run.cost.cny, 0.0123);
});

test('POST 5xx：报「有没有启动不确定」，绝不重发', async () => {
  reset({ startStatus: 502 });
  await assert.rejects(runNodeOnce(job(), noWait), (e) => e.code === 'trial_start_unknown' && /不要重试/.test(e.hint));
  assert.equal(fake.state.posts.length, 1);
});

test('POST 4xx：明确没启动', async () => {
  reset({ startStatus: 400 });
  await assert.rejects(runNodeOnce(job(), noWait), (e) => e.code === 'trial_not_started');
});

test('查结果出错会再查，连续 3 次才放弃，并带上 execId', async () => {
  reset({ pollStatus: 500 });
  await assert.rejects(runNodeOnce(job(), noWait), (e) => e.code === 'trial_poll_failed' && /ne-1/.test(e.message));
  assert.equal(fake.state.posts.length, 1);
});

test('超过时限还没跑完：带回 timedOut，不再等', async () => {
  reset({ runningPolls: 1000 });
  let t = 0;
  const r = await runNodeOnce(job(), { sleep: async () => { t += 60_000; }, now: () => t, timeoutMs: 300_000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.run.status, 'running');
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/trial-run.test.mjs`
Expected: FAIL，报 Cannot find module `../src/trial-run.mjs`。

- [ ] **Step 4: 实现** `miaodong-kit/src/trial-run.mjs`

```js
// 跑一次单节点试跑：POST 一次，每 2 秒查一次，最长 5 分钟。
// POST 结果不明时绝不重发：秒懂没有取消接口，也没有能列出节点执行的接口，重发可能跑两遍（多花钱，插件节点还会多调一次外部系统）。

import { getNodeTrialRun, startNodeTrialRun } from '../../apps/api/lib/miaodong/trial-core.ts';
import { request } from './http.mjs';
import { MdError } from './errors.mjs';

export const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_POLL_ERRORS = 3;
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultPollMs = () => (Number(process.env.MD_POLL_MS) > 0 ? Number(process.env.MD_POLL_MS) : 2000);

function requesterFor(identity) {
  return (path, { method = 'GET', body, query } = {}) => request(identity, path, { method, body, query, timeoutMs: 60_000 });
}

function startFailure(error) {
  if (error instanceof MdError && (error.code === 'auth_expired' || error.code === 'points_exhausted')) return error;
  // 明确被拒（业务错误、HTTP 4xx）= 没启动；网络错误、超时、5xx、缺 execId = 不知道启动没有
  const refused = error instanceof MdError && (error.code === 'business' || (error.code === 'upstream' && / HTTP 4\d\d/.test(error.message)));
  if (refused) return new MdError('trial_not_started', `试跑没有启动：${error.message}`);
  return new MdError('trial_start_unknown', `试跑有没有启动不确定：${error?.message ?? error}`, {
    hint: '不要重试（可能已经在跑）：去秒懂画布页看这个节点的运行结果',
  });
}

export async function runNodeOnce({ identity, orgId, canvasId, node, inputs }, { sleep = sleepMs, now = Date.now, pollMs = defaultPollMs(), timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const requester = requesterFor(identity);
  let execId;
  try {
    ({ execId } = await startNodeTrialRun(requester, { orgId, canvasId, nodeId: node.id, nodeInputs: inputs }));
  } catch (error) {
    throw startFailure(error);
  }
  const started = now();
  let errors = 0;
  for (;;) {
    let run;
    try {
      run = await getNodeTrialRun(requester, {
        orgId, nodeExecId: execId, canvasId, nodeId: node.id,
        nodeName: node.name, nodeType: node.type, nodeCategory: node.category, nodeInputs: inputs,
      });
      errors = 0;
    } catch (error) {
      if (error instanceof MdError && error.code === 'auth_expired') throw error;
      errors++;
      if (errors >= MAX_POLL_ERRORS) {
        throw new MdError('trial_poll_failed', `试跑已启动（${execId}），但连续 ${errors} 次查不到结果：${error?.message ?? error}`, {
          hint: '去秒懂画布页看这个节点的运行结果；不要重跑',
        });
      }
      await sleep(pollMs);
      continue;
    }
    if (run.isTerminal) return { execId, run, timedOut: false };
    if (now() - started >= timeoutMs) return { execId, run, timedOut: true };
    await sleep(pollMs);
  }
}
```

- [ ] **Step 5: 运行，确认通过**

Run: 同 Step 3。
Expected: 5 条 PASS。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/trial-run.mjs miaodong-kit/test/trial-run.test.mjs miaodong-kit/test/helpers/trial-server.mjs
git commit -m "feat(md): 单节点试跑执行——POST 一次、轮询到结束、结果不明绝不重发"
```

---

### Task 8: `md trial` 命令

**Files:**
- Create: `miaodong-kit/src/commands/trial.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`（登记 `trial`）
- Test: `miaodong-kit/test/trial-cli.test.mjs`（新建）

**Interfaces:**
- Consumes：Task 1–7 的全部导出；`resolveNode`（`src/graph.mjs`）、`getCanvas`（`src/api.mjs`）、`resolveBot, targetArgs`（`src/target.mjs`）、`loadWorkspace, targetFromMeta, stamp, latestWorkspaceFor`（`src/workspace.mjs`）、`normalizeDetail, promptText`（`src/exec-detail.mjs`）、`clip, formatCost`（`src/execs.mjs`），以及老懂的 `buildBranchNameIndex`。
- Produces：`COMMANDS.trial`。

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/trial-cli.test.mjs`

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity, seedWorkspace } from './helpers/seed.mjs';
import { startTrialServer, trialDraft } from './helpers/trial-server.mjs';
import { ASK, EXEC_BOT, X } from './helpers/exec-fixtures.mjs';
import { U } from './helpers/fixtures.mjs';

let fake;
before(async () => { fake = await startTrialServer(); });
after(() => fake.server.close());
const reset = (patch = {}) => { Object.assign(fake.state, { posts: [], polls: new Map(), startStatus: 201, runningPolls: 1, pollStatus: 200, cost: 0.0123, ...patch }); };

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const spends = (h) => {
  const file = join(h, 'md', 'spend.jsonl');
  if (!existsSync(file)) return [];
  const byId = new Map();
  for (const line of readFileSync(file, 'utf-8').trim().split('\n')) { const row = JSON.parse(line); byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row }); }
  return [...byId.values()];
};
const limits = (h, spend) => { mkdirSync(join(h, 'md'), { recursive: true }); writeFileSync(join(h, 'md', 'config.json'), JSON.stringify({ spend })); };

test('--from-exec：用那次执行里这个节点的输入，去掉平台参数；记账本；结果和 prompt 落盘', async () => {
  reset();
  const h = home();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.state.posts[0].inputs.inputData, { text: ASK });
  assert.match(r.stdout, /去掉平台参数：质检规则/);
  assert.match(r.stdout, /#1 ✅ success 1\.2s ¥0\.012/);
  assert.match(r.stdout, /输出：回复：我想退款/);
  const [row] = spends(h);
  assert.deepEqual([row.kind, row.estimate, row.actual, row.approved, row.nodeId], ['trial', 0.0102, 0.0123, 'auto', U(2)]);
  const dir = r.stdout.match(/结果和 prompt 在 (\S+)/)[1];
  assert.deepEqual(readdirSync(dir).sort(), ['prompt-1.txt', 'run-1.json']);
});

test('--keep-platform-params 保留；--input 覆盖；--times 2 跑两次并汇总', async () => {
  reset();
  await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2), '--keep-platform-params']);
  assert.equal(fake.state.posts[0].inputs.inputData.质检规则, '旧规则');
  reset();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2), '--input', 'text=你好', '--times', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.posts.length, 2);
  assert.ok(fake.state.posts.every((p) => p.inputs.inputData.text === '你好'));
  assert.match(r.stdout, /2 次里 1 种不同输出/);
});

test('动作类节点不跑；插件节点没有 --allow-plugin 不跑；有了也要本人批准（测试里批准必失败）', async () => {
  reset();
  const action = await md(['trial', '触发发送', '--bot', '147bd600']);
  assert.equal(action.code, 5);
  assert.match(action.stderr, /不做单节点试跑/);
  const plugin = await md(['trial', '兴趣岛用户详情', '--bot', '147bd600', '--input', 'x=1']);
  assert.equal(plugin.code, 5);
  assert.match(plugin.stderr, /--allow-plugin/);
  const tool = await md(['trial', '带插件的大模型', '--bot', '147bd600', '--input', 'text=1', '--allow-plugin']);
  assert.equal(tool.code, 5);
  assert.match(tool.stderr, /没有得到用户本人批准.*会真的调用外部系统：写多维表/);
  assert.equal(fake.state.posts.length, 0);
});

test('预估超单次门槛：要本人批准，没批准就什么都不跑、不记账', async () => {
  reset();
  const h = home();
  limits(h, { perCommand: 0.001, perDay: 10 });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)], h);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /超过单次门槛/);
  assert.equal(fake.state.posts.length, 0);
  assert.deepEqual(spends(h), []);
});

test('估不出花费：先跑 1 次，用实际推算其余；推算超门槛就停下要批准，已跑的记账', async () => {
  reset();
  const h = home();
  limits(h, { perCommand: 0.02, perDay: 10 });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好', '--times', '3'], h);
  assert.equal(r.code, 5);
  assert.equal(fake.state.posts.length, 1);
  assert.match(r.stdout, /估不出，先跑 1 次看实际/);
  assert.match(r.stderr, /超过单次门槛/);
  const [row] = spends(h);
  assert.deepEqual([row.estimate, row.actual, row.runs], [null, 0.0123, 1]);
});

test('本地改了还没推：醒目提示跑的是草稿上的旧版本', async () => {
  reset();
  const h = home();
  const dir = await seedWorkspace(h, { canvas: trialDraft(), meta: { botId: EXEC_BOT, botName: '太极2.0 质检革新版' } });
  const { saveAfter } = await import('../src/workspace.mjs');
  const changed = trialDraft().map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '本地新 prompt' } } } : c));
  saveAfter(dir, { canvas: changed, sessions: [], events: [] });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /⚠️ 本地改动还没推：这次跑的是草稿上的旧版本/);
});

test('POST 5xx：报不确定、不重发，退出码 1', async () => {
  reset({ startStatus: 502 });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好', '--times', '3']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /有没有启动不确定/);
  assert.equal(fake.state.posts.length, 1);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/trial-cli.test.mjs`
Expected: 7 条全部 FAIL（「未知命令：trial」）。

- [ ] **Step 3: 实现** `miaodong-kit/src/commands/trial.mjs`

```js
// md trial：单节点试跑。跑的是秒懂上的草稿（推送后立即生效）；花钱和调插件要过「用户本人批准」闸门（spec §7）。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { intArg, listArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { getCanvas } from '../api.mjs';
import { resolveBot, targetArgs } from '../target.mjs';
import { latestWorkspaceFor, loadWorkspace, stamp, targetFromMeta } from '../workspace.mjs';
import { resolveNode } from '../graph.mjs';
import { ensureDir, mdHome } from '../home.mjs';
import { formatTime, note, out, shortId, targetLine } from '../output.mjs';
import { clip, formatCost } from '../execs.mjs';
import { locateExec } from '../exec-locate.mjs';
import { normalizeDetail, promptText } from '../exec-detail.mjs';
import { buildTrialInputs, classifyTrialNode, draftVsLocal, inputDefs, parseInputPairs } from '../trial.mjs';
import { runNodeOnce } from '../trial-run.mjs';
import { loadLimits, readSpends, recordSpend, spendDecision, spentOn, updateSpend } from '../spend.mjs';
import { requestApproval } from '../approve.mjs';
import { buildBranchNameIndex } from '../../../apps/api/lib/miaodong/badcase-normalize.ts';

const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');

async function trialTarget(args) {
  if (strArg(args, 'ws')) {
    const ws = loadWorkspace(args);
    return { target: targetFromMeta(ws.meta), ws };
  }
  const target = await resolveBot(targetArgs(args));
  return { target, ws: latestWorkspaceFor(target.botId) };
}

function lastPerRun(botId, nodeId) {
  const hit = readSpends().filter((r) => r.kind === 'trial' && r.botId === botId && r.nodeId === nodeId && typeof r.actualPerRun === 'number').at(-1);
  return hit ? hit.actualPerRun : null;
}

function readInputsFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw usage(`--inputs 读不了：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw usage('--inputs 的文件要是一个 JSON 对象：{"键": 值}');
  return parsed;
}

async function approveOrStop({ target, node, times, estimate, basis, reasons, today, limits }) {
  const lines = [
    `智能体：${target.regionLabel} / ${target.botName}`,
    `操作：单节点试跑「${node.name}」× ${times}（跑的是草稿）`,
    `预计：${estimate === null ? '估不出（参考：豆包约 ¥0.01/次，Gemini 约 ¥0.3–0.7/次）' : `${formatCost(estimate)}${basis ? `（${basis}）` : ''}`}`,
    `今天已花：${formatCost(today)} / 每日上限 ${formatCost(limits.perDay)}`,
    `原因：${reasons.join('；')}`,
    '',
    '由 AI 发起；只有你本人能点「同意」。',
  ];
  const approval = await requestApproval({ title: 'md：花费 / 外部调用确认', lines });
  if (!approval.ok) {
    throw new MdError('not_approved', `没有得到用户本人批准：${approval.reason}（${reasons.join('；')}）`, {
      exitCode: EXIT.BLOCKED,
      hint: '把预估和原因告诉用户；用户同意后再运行同一条命令，弹窗会再出现',
    });
  }
  return approval.via;
}

export const trial = {
  summary: '单节点试跑：用执行记录里的原始输入复现、推草稿后复验（跑的是草稿；花钱和调插件要用户本人批准）',
  usage: [
    'md trial <节点> (--bot <智能体> | --ws <工作副本>) [--from-exec <执行id>] [--input 键=值 …] [--inputs <文件.json>]',
    '        [--times 1] [--keep-platform-params] [--allow-plugin]',
    '跑的是秒懂上的草稿：本地改动要先 md push 才会生效。只跑计算类节点；发消息、打标签、转人工、事件这类动作节点一律不跑。',
    '预估超单次门槛、今天累计超每日上限、估不出花费、或会真的调用插件时，要用户本人在弹窗里点同意（md spend 看门槛）。',
  ].join('\n'),
  async run(args) {
    const query = args._[0];
    if (!query) throw usage('缺节点：md trial <节点 id / id 前缀 / 名字> --bot <智能体>');
    const times = intArg(args, 'times', 1, 10);
    const { target, ws } = await trialTarget(args);
    const draft = await getCanvas(target.identity, target.orgId, target.botId);
    const cell = resolveNode(draft.rawCanvas, query);
    const node = { id: cell.id, name: String(cell.data?.name ?? cell.id), type: String(cell.data?.type ?? cell.shape ?? ''), category: String(cell.data?.category ?? '') };
    const cls = classifyTrialNode(cell);
    if (cls.kind === 'denied') {
      throw new MdError('trial_denied', `「${node.name}」是 ${cls.type || '未知类型'}，这类节点不做单节点试跑（只跑大模型、代码、规则、知识库查询这类计算节点；秒懂页面也不给别的节点试跑按钮）`, { exitCode: EXIT.BLOCKED });
    }
    if (cls.kind === 'plugin' && args['allow-plugin'] !== true) {
      throw new MdError('trial_plugin', `「${node.name}」会真的调用外部系统（${cls.plugins.join('、')}）`, { exitCode: EXIT.BLOCKED, hint: '确认要跑：加 --allow-plugin，并由用户本人在弹窗里同意' });
    }

    // 输入与单次花费
    let fromExec = null;
    let perRun = null;
    let basis = '';
    const execId = strArg(args, 'from-exec');
    if (execId) {
      const located = await locateExec({}, execId);
      const executed = normalizeDetail(located.detail).nodes.find((n) => n.id === node.id);
      if (!executed) {
        throw new MdError('node_not_in_exec', `执行 ${shortId(execId)} 没有跑到「${node.name}」[${shortId(node.id)}]`, { exitCode: EXIT.TARGET, hint: 'md exec <执行id> 看那次跑了哪些节点' });
      }
      fromExec = executed.inputs && typeof executed.inputs === 'object' ? executed.inputs : {};
      if (typeof executed.cost === 'number') {
        perRun = executed.cost;
        basis = `执行 ${shortId(execId)} 里这个节点花了 ${formatCost(executed.cost)}/次`;
      }
      if (located.target.botId !== target.botId) note(`（输入取自另一个智能体「${located.target.botName}」的执行）`);
    }
    if (perRun === null) {
      const last = lastPerRun(target.botId, node.id);
      if (last !== null) {
        perRun = last;
        basis = `上次试跑这个节点花了 ${formatCost(last)}/次`;
      }
    }
    const file = strArg(args, 'inputs');
    const built = buildTrialInputs(inputDefs(cell), {
      fromExec,
      fromFile: file ? readInputsFile(file) : null,
      overrides: parseInputPairs(listArg(args, 'input')),
      keepPlatform: args['keep-platform-params'] === true,
    });

    // 批准：估不出花费、不调插件、今天没到上限时，先跑 1 次拿到真实花费再决定其余几次
    const limits = loadLimits();
    const today = spentOn(readSpends());
    const estimate = perRun === null ? null : perRun * times;
    const external = cls.kind === 'plugin' ? cls.plugins : [];
    const probeFirst = estimate === null && !external.length && today < limits.perDay;
    let approved = 'auto';
    const decision = spendDecision({ estimate, externalCalls: external }, { limits, today });
    if (decision.needApproval && !probeFirst) {
      approved = await approveOrStop({ target, node, times, estimate, basis, reasons: decision.reasons, today, limits });
    }

    const fresh = draftVsLocal(node.id, draft.rawCanvas, ws);
    out(targetLine({ ...target, versionLabel: '草稿' }));
    out(`试跑「${node.name}」[${shortId(node.id)}] ${node.type} × ${times} · 草稿最后保存 ${formatTime(draft.updatedAt)}`);
    if (fresh.status === 'unpushed') out(`⚠️ 本地改动还没推：这次跑的是草稿上的旧版本（工作副本 ${fresh.dir}）；要试新改的先 md push`);
    if (fresh.status === 'draft-changed') out('（草稿里这个节点在你拉取之后被改过；跑的是草稿现在的内容）');
    out(`输入：${Object.keys(built.inputs).join('、') || '（无）'}${execId ? `（取自执行 ${shortId(execId)}）` : ''}`);
    if (built.dropped.length) out(`去掉平台参数：${built.dropped.join('、')}（让秒懂填最新值；要保留加 --keep-platform-params）`);
    if (built.missing.length) out(`⚠️ 缺输入：${built.missing.join('、')}（会按空值跑，结果可能失真）`);
    if (built.extra.length) out(`（多出来的键：${built.extra.join('、')}）`);
    out(`花费：预计 ${estimate === null ? '估不出，先跑 1 次看实际' : `${formatCost(estimate)}${basis ? `（${basis}）` : ''}`} · 今天已花 ${formatCost(today)} / 上限 ${formatCost(limits.perDay)}${approved === 'auto' ? '' : ' · 用户已批准'}`);

    const dir = ensureDir(join(mdHome(), 'trials', safe(target.identityKey), safe(target.botId.slice(0, 8)), `${stamp()}-${safe(shortId(node.id))}`));
    const spendId = recordSpend({
      kind: 'trial', regionLabel: target.regionLabel, botId: target.botId, botName: target.botName,
      what: node.name, nodeId: node.id, count: times, estimate, basis: basis || (estimate === null ? '估不出' : ''), approved,
    });
    const branches = buildBranchNameIndex(draft.rawCanvas);
    const outputs = new Set();
    let actual = 0;
    let done = 0;
    try {
      for (let i = 1; i <= times; i++) {
        if (i === 2 && probeFirst) {
          const rest = (actual / done) * (times - 1);
          const next = spendDecision({ estimate: rest }, { limits, today: today + actual });
          if (next.needApproval) {
            approved = await approveOrStop({ target, node, times: times - 1, estimate: rest, basis: `按第 1 次实际 ${formatCost(actual)} 推算`, reasons: next.reasons, today: today + actual, limits });
          }
        }
        const { execId: nodeExecId, run, timedOut } = await runNodeOnce({ identity: target.identity, orgId: target.orgId, canvasId: draft.canvasId, node, inputs: built.inputs });
        done++;
        const result = run.nodeResults[0] ?? {};
        const cost = typeof run.cost.cny === 'number' ? run.cost.cny : null;
        actual += cost ?? 0;
        writeFileSync(join(dir, `run-${i}.json`), JSON.stringify({ nodeExecId, inputs: built.inputs, run }, null, 2));
        const prompt = promptText({ prompt: result.metadata?.prompt });
        if (prompt) writeFileSync(join(dir, `prompt-${i}.txt`), prompt);
        const icon = timedOut ? '⏳' : run.status === 'success' ? '✅' : '❌';
        const branch = result.outputBranchId ? ` → 分支「${branches.get(result.outputBranchId) ?? shortId(result.outputBranchId)}」` : '';
        out(`#${i} ${icon} ${timedOut ? `5 分钟没跑完（${nodeExecId}）` : run.status} ${(run.duration / 1000).toFixed(1)}s ${formatCost(cost)}${branch}`);
        if (result.error) out(`   报错：${clip(typeof result.error === 'string' ? result.error : JSON.stringify(result.error), 300)}`);
        const text = typeof result.output?.message === 'string' ? result.output.message : JSON.stringify(result.output ?? null);
        out(`   输出：${clip(text, 1500)}`);
        const reasoning = result.metadata?.reasoning;
        if (typeof reasoning === 'string' && reasoning.trim()) out(`   推理：${clip(reasoning, 300)}`);
        outputs.add(JSON.stringify(result.output ?? null));
      }
    } finally {
      updateSpend(spendId, { actual, actualPerRun: done ? actual / done : null, runs: done, approved });
    }
    out(`${done} 次里 ${outputs.size} 种不同输出 · 共 ${formatCost(actual)} · 结果和 prompt 在 ${dir}`);
    return EXIT.OK;
  },
};
```

在 `miaodong-kit/src/commands/index.mjs` 里登记：`import { trial } from './trial.mjs';`，并把 `trial` 加到 `COMMANDS` 末尾。

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 7 条 PASS。然后跑全部测试，Expected：`# fail 0`。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/commands/trial.mjs miaodong-kit/src/commands/index.mjs miaodong-kit/test/trial-cli.test.mjs
git commit -m "feat(md): md trial 单节点试跑——节点门禁、原始输入、本地改动提醒、花费闸门、账本"
```

---

### Task 9: 打包产物也能试跑

**Files:**
- Test: `miaodong-kit/test/bundle.test.mjs`（追加）

- [ ] **Step 1: 写测试**。在顶部 import 里补 `import { startTrialServer } from './helpers/trial-server.mjs';`；`X` 已经 import 过就不用再补。然后在末尾追加：

```js
test('产物能试跑（把老懂的试跑纯函数一起打进去，且不带数据库依赖）', async () => {
  const { server } = await startTrialServer();
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const r = await runCli(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)], { home, bundle });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /#1 ✅ success/);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: 运行（Node 22 跑源码测试，Node 18 跑产物）**

Run: `MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node $HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/bundle.test.mjs`
Expected: 全部 PASS，其中「产物里没有老懂数据库依赖」「产物不带源码注释和源码路径」依旧通过。

这一步预期直接通过：功能在 Task 8 已经实现，这里只验证打包。如果失败，按 superpowers:systematic-debugging 查原因，不许改测试凑绿。

- [ ] **Step 3: 提交**

```bash
git add miaodong-kit/test/bundle.test.mjs
git commit -m "test(md): 打包产物跑 md trial（Node 18）"
```

---

### Task 10: skill、仓库文档与 spec

**Files:**
- Modify: `miaodong-kit/skill/SKILL.md`
- Create: `miaodong-kit/skill/references/trial.md`
- Modify: `miaodong-kit/skill/README.md`
- Modify: `CLAUDE.md`、`AGENTS.md`（md 小节）
- Modify: `docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md`（§9 第 5 条）

- [ ] **Step 1: 改 `SKILL.md`**

1. `description` 整行换成：

```
description: 用 md 命令读写句子秒懂（JZ Insight，控制台域名形如 *-insight.juzibot.com）上智能体 / bot 的画布和执行记录：按区取身份、按名字找智能体和版本、拉草稿或历史版本、看节点 / 上下游 / 引用、用改动脚本批量改 prompt 或模型、自检、合并推送到草稿、回滚、查推送记录；查调优中心的执行记录（badcase、执行 id）：按条件搜、看节点轨迹和事件链、找出某句话是哪个节点产生的；单节点试跑（用执行记录的原始输入复现、推草稿后复验，花钱和调插件要用户本人在弹窗里批准）；看花费。任务涉及秒懂某个智能体（bot、机器人、workflow、话术、版本号如 v1.0.400、执行 id、badcase、试跑、推到秒懂）时使用；只提到 prompt、节点、画布、回滚而没有秒懂上下文时不要用。测试中心的用例导入与回归暂时仍由 miaodong-test-case-import 负责。
```

2. `## 查 badcase（执行记录）` 第 6 条换成：

```
6. 要改就走下面的标准流程。改之前先复现：`md trial <节点> --bot <智能体> --from-exec <执行id> --times 3`；推到草稿后用同一条命令复验（试跑跑的是草稿，本地改动要先推）。
```

3. `## 修 bot 的标准流程`：把现在的第 8 条（「8. 按下面的格式回执。…」）改成第 9 条，在它前面插入新的第 8 条：

```
8. 推送后用 `md trial <节点> --bot <智能体> --from-exec <执行id>` 复验，对照输出里的 prompt 文件确认跑的是新版。
```

4. `## 规矩` 末尾加：

```
- 花钱前先说预估：`md trial` 会自己估。超单次门槛、今天累计超上限、估不出花费、或会真的调插件时，它会在用户屏幕上弹窗，只有用户本人点「同意」才会跑——跑之前先告诉用户会弹窗、要花多少。
- 不许绕过批准：不许改 `~/.miaodong/md/` 里的 `config.json`、`spend.jsonl`，不许直接调秒懂接口，不许用任何办法替用户点弹窗。被拦下（退出码 5）就把原因告诉用户。
- 插件节点试跑（`--allow-plugin`）会真的调外部系统，要用户明确同意。
```

5. `## 领域常识` 里「单节点试跑、测试中心 md 还不支持…」那一段改成：

```
测试中心 md 还不支持，要在秒懂页面上操作。注意：
- 测试中心跑哪一版由任务决定，可以是草稿，也可以是某个版本。
- 测试中心里「发送」会执行并记成动作，用户经验是不会真的发到客户手里；插件和 HTTP 调用是真的。
- 跨智能体导入的用例，断言来自源智能体，通过率没有意义，要看实际回答。
- regression-test 要求回归集至少 50 条，而且不能指定测试集。
```

   并在上面的常识列表里加一条：

```
- 单节点试跑跑的是**草稿**。每次花费：豆包约 ¥0.01，Gemini 约 ¥0.3–0.7（贵在模型本身，不挂工具也这么贵）。
```

- [ ] **Step 2: 新建 `miaodong-kit/skill/references/trial.md`**

````markdown
# 单节点试跑（md trial）与花费（md spend）

## 什么时候用

- 改前复现：`md trial <节点> --bot <智能体> --from-exec <执行id> --times 3`，用那次执行里这个节点的原始输入跑。
- 改后复验：先 `md push` 到草稿，再跑同一条命令。试跑跑的是**草稿**，本地没推的改动不算，md 会提醒。

## 输入

- `--from-exec`：取那次执行里这个节点的输入。执行当时的平台参数（如「质检规则」）默认去掉，让秒懂填最新值；要保留加 `--keep-platform-params`。
- `--input 键=值`：覆盖单个输入，可以给多次。复杂值（数组、对象）用 `--inputs 文件.json`。
- 缺的输入会醒目提示：秒懂不校验缺键，缺了照样跑，只是结果可能失真。

## 哪些节点能跑

- 能跑：大模型、代码、规则、知识库 / SQL 查询、计算器、质检、语音转文字、联网搜索等计算类节点。
- 插件计算节点、挂了插件工具的大模型：会真的调外部系统，要 `--allow-plugin`，并且要用户本人在弹窗里同意。
- 不跑：发消息、打标签、转人工、事件、写数据、插件动作等动作类节点，以及触发器、循环类节点。

## 花费与批准

- 每次试跑的实际花费都记在本机账本里；`md spend` 看今天、最近几天和每一笔。
- 预估依据按顺序取：`--from-exec` 那次这个节点的花费；上次试跑这个节点的实际花费；都没有就估不出，先跑 1 次，按实际推算其余几次。
- 下面几种情况要用户本人批准：
  - 超单次门槛（默认 ¥2）；
  - 今天累计超每日上限（默认 ¥10）；
  - 估不出花费并且今天已到上限；
  - 会调插件。
- macOS 上会弹系统对话框，90 秒没点算拒绝。Linux / WSL 要用户在自己的终端里运行同一条命令，并输入「同意」。
- 没批准就什么都不跑，退出码 5。
- 改门槛：`md spend limit --per-command <元> --per-day <元>`，同样要本人批准。

## 结果

- 每次一行：状态、耗时、花费、分支；再附上输出正文和推理的开头。
- 完整结果（`run-N.json`）和渲染后的 prompt（`prompt-N.txt`）在 `~/.miaodong/md/trials/<区>/<智能体 id 前 8 位>/<时间>-<节点>/`。可以 grep prompt 文件，确认跑的是不是新版。
- POST 失败时，如果报「有没有启动不确定」，**不要重试**：可能已经在跑。去秒懂画布页看这个节点的运行结果。
````

- [ ] **Step 3: 改 `miaodong-kit/skill/README.md`**

1. 功能列表里「查执行记录」下面加一行：

```
- 单节点试跑：用执行记录的原始输入复现、推草稿后复验；花钱超门槛或会调插件时弹窗让你本人确认
```

2. 在「## 它怎么保证不出事」列表末尾加一条：

```
- **花钱要你本人点头**：试跑超过单次门槛（默认 ¥2）、当天累计超过上限（默认 ¥10）、估不出花费、或会调用插件时，你的屏幕上会弹出系统对话框，只有你点「同意」才会跑。AI 替你点不了；Linux / WSL 上要你在自己的终端里运行那条命令。`md spend` 看花了多少。
```

- [ ] **Step 4: 改 `CLAUDE.md`、`AGENTS.md` 的 md 小节**（两个文件做同样的修改）

在「改之前必读」列表末尾加一条：

```
5. **花钱和调插件要用户本人批准**（`src/approve.mjs`）：macOS 弹系统对话框，其他系统只在有 TTY 时问；没有任何参数或环境变量能放行，`MD_NO_DIALOG=1` 只会让它直接拒绝（测试默认开着）。不要为了方便加「跳过批准」的开关。
```

- [ ] **Step 5: 改 spec §9 第 5 条**

把「5. 单节点试跑传版本的 canvasId：能跑就提供 `md trial --version`，否则不提供。」换成：

```
5. ~~单节点试跑传版本的 canvasId~~：2b 决定不做。试跑只跑草稿、不提供 `--version`，常用流程是「推草稿再试跑」；也省掉一次要用户授权的花费。
```

- [ ] **Step 6: 核对**

Run: `grep -n "单节点试跑 md 还不支持\|单节点试跑、测试中心 md 还不支持" miaodong-kit/skill/SKILL.md; grep -c "approve.mjs" CLAUDE.md AGENTS.md; test -s miaodong-kit/skill/references/trial.md && echo trial-doc-ok`
Expected：第一个 grep 没有输出；两个文件各输出 `1`；最后打印 `trial-doc-ok`。

- [ ] **Step 7: 提交**

```bash
git add miaodong-kit/skill/SKILL.md miaodong-kit/skill/references/trial.md miaodong-kit/skill/README.md CLAUDE.md AGENTS.md docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md
git commit -m "docs(md): skill 与仓库文档加上 md trial / md spend 与批准闸门"
```

---

### Task 11: 全量验证、安装、弹窗真机核对、真机试跑、整支审查后发布

**Files:** 无新增。只有核对中发现问题时才改代码，并且先写复现测试。

- [ ] **Step 1: 全量离线测试（源码 Node 22 + 产物 Node 18）**

Run: `MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node $HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/*.test.mjs > .superpowers/sdd/2026-09-24-miaodong-cli-step2b/full.log 2>&1; tail -8 .superpowers/sdd/2026-09-24-miaodong-cli-step2b/full.log`
Expected: `# fail 0`。

- [ ] **Step 2: 安装**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run md:install && ~/.local/bin/md --version && ~/.local/bin/md trial --help | head -2 && ~/.local/bin/md spend`
Expected：版本号是当前 HEAD；help 以 `md trial <节点>` 开头；`md spend` 输出「今天已花 ¥0 / 每日上限 ¥10.00（单次门槛 ¥2.00）」。

- [ ] **Step 3: 弹窗真机核对（不花钱，要用户在场）**

1. 先用一句话告诉用户：马上会弹一个「改花费门槛」的窗口，请点**拒绝**。
2. 运行 `~/.local/bin/md spend limit --per-command 2 --per-day 10`。
3. 期望：用户屏幕上出现系统对话框，文字是门槛变化，按钮是「拒绝 / 同意」。用户点「拒绝」后，md 退出码 5，stderr 有「门槛没改：用户点了拒绝」。
4. 再告诉用户：这次请点**同意**，然后重跑同一条命令。门槛值不变，改了也无害。期望退出码 0，输出「花费门槛已改」。
5. 如果窗口没出现、或者出现在别的窗口后面：记下现象，按 superpowers:systematic-debugging 处理（例如在脚本里先 `activate`），先写能复现的测试再修。

- [ ] **Step 4: 真机试跑（要用户事先授权；花费 ≤ ¥0.05）**

- 在「太极2.0 质检革新版」（147bd600）上挑一个**豆包模型**的大模型节点，约 ¥0.01/次。先用 `md exec` 找一条近 3 小时内跑过这个节点的执行，再运行：

  `~/.local/bin/md trial <节点id前缀> --bot 147bd600 --from-exec <执行id>`

- 期望：
  - 输出里有「去掉平台参数」（如果这个节点有平台参数）；
  - `#1 ✅ success … ¥0.0xx`；
  - `md spend` 里多了这一笔，预估和实际都有。
- 只跑 1 次。不跑插件节点，不跑 Gemini 节点。

- [ ] **Step 5: 更新记忆**

在 `/Users/hukui/.claude/projects/-Users-hukui-Desktop-workspace-Agentflow/memory/miaodong-cli-plan.md` 的第 2 步条目下补一行：2b 完成的日期、提交区间、弹窗核对的结论、真机试跑的花费。发布这一步放到整支审查修完之后（沿用 2a 的 Ruling：没审过的代码不推到同事会拉的仓库），做法同 2a 计划 Task 11 Step 4。
