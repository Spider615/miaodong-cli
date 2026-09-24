# 秒懂 CLI 第 2 步 2a：md exec（查执行记录）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 md 加上 `md exec`：按条件搜调优中心执行记录；看一条执行的节点轨迹、本条动作和整条事件链；用 `--node / --find / --vs-draft` 定位问题。只读，零花费。

**Architecture:**
- 新增三个纯逻辑模块：
  - `execs.mjs`：列表接口、行摘要、搜索条件；
  - `exec-detail.mjs`：详情加工，包括节点排序、定位文字、和草稿比对；
  - `exec-chain.mjs`：事件链。
- 新增一个存储模块 `exec-store.mjs`，以及一条命令 `commands/exec.mjs`。
- 复用老懂的无依赖纯函数 `apps/api/lib/miaodong/badcase-normalize.ts`：事件链配对、节点名和分支名反查、触发文本提取。
- 大数据落盘到 `$MD_HOME/execs/`，stdout 只出摘要。

**Tech Stack:** Node ESM（源码在 Node 22 + strip-types 下测试，产物由 esbuild 打成单文件，Node 18 可跑）、`node:test`、假秒懂 HTTP server。

**Spec:** `docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md`（§2.1、§3、§4、§8 中与执行记录有关的部分）。第 1 步 spec 是 `docs/superpowers/specs/2026-09-23-miaodong-cli-design.md`。

## Global Constraints

- 所有命令都在 worktree 根目录 `/Users/hukui/Desktop/workspace/Agentflow/.worktrees/miaodong-cli` 下运行。
- 测试必须用 Node 22：每条测试命令前面都加 `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`（本机默认 Node 18 跑不了 strip-types）。**不要把命令存进 shell 变量再展开**（zsh 不会按空格拆开，上次因此 rc=127）。
- 单个测试文件：`PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/<文件>.test.mjs`
- 全部测试：`PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run check:md`
- 只能 import 老懂里**不依赖数据库**的纯模块。`badcase-query.ts / badcase-process.ts / badcase-classify.ts / client.ts` 会带起 SQLite，一律不碰；打包测试检查产物里没有 `better-sqlite3|drizzle-orm`。
- 输出约定：
  - stdout 只放结果，stderr 放过程提示；
  - 针对某个智能体的输出，第一行是 `区 / 企业 / 智能体 (id8) / 版本`；
  - 长内容截断，全文写文件，并打印文件路径。
- 本地数据只写 `$MD_HOME`（默认 `~/.miaodong/md`），不写仓库、不写 cwd；唯一例外是用户用 `--save <文件>` 指定的路径。
- 不打印 token，不读写身份文件以外的凭据。
- 退出码：0 成功 · 1 一般错误 · 2 用法错误 · 3 需要取身份 · 4 目标找不到或有歧义 · 5 被拦。
- 中文注释、中文文案、英文标识符；不新增 npm 依赖。
- 2a 只调用读接口：`bot/list`、`canvas/get`、`canvas/list-version`、`canvas/history/list`、`canvas/history/details`。
- 分页的取舍：spec §3 写的是「统一一个分页 helper」，但 2a 里两处翻页的停止条件不同。
  - 搜索：本地筛够数就停，扫到页数上限也停；
  - 事件链：按会话最多翻 5 页。
  - 所以各写各的；两处都必须如实说明有没有截断。2c 测试中心的列表接口再抽出公共 helper。
  - 执行者要在 ledger 里记一条 Ruling。

## Review Focus

1. **执行过的节点不在快照里**（循环子节点、被删的节点）：照样列出，名字显示「(快照里没有这个节点)」，不崩。见 Task 4。
2. **事件的上游在时间窗外**（延迟接近 1 小时的事件）：链上标「? 上游不在时间窗内」，绝不接一条错的上游。见 Task 5。
3. **会话在时间窗内的执行超过 500 条**：链上标「可能不全」，不假装完整。见 Task 5。
4. **列表行字段缺失或为 null**（`outputActions / triggerContent / totalCostInCny / canvasVersion / createdAt`）：摘要照常输出，缺的字段显示 `-`。见 Task 3。
5. **超长 prompt 或输出**（2 万字）：`--node` 的 stdout 被截断在几千字以内，全文在文件里。见 Task 4。

---

### Task 1: http 报错带上 userMessage / errorMessage / errorCode，积分不足单独报

**Files:**
- Modify: `miaodong-kit/src/http.mjs`
- Test: `miaodong-kit/test/http.test.mjs`

**Interfaces:**
- Produces:
  - `request()` 的错误消息里依次带上 `userMessage`、`message`、`errorMessage`，最后附 `[errorCode]`。
  - 遇到 `errorCode: 'AI_INTEGRAL_POINTS_EXHAUSTED'` 时抛 `MdError('points_exhausted')`。

- [ ] **Step 1: 写失败的测试**（追加到 `miaodong-kit/test/http.test.mjs` 末尾）

```js
test('积分不足：单独报出来，带上秒懂给的提示', async () => {
  server.routes['POST /api/canvas/node/exec'] = () => ({ status: 400, body: { statusCode: 400, errorCode: 'AI_INTEGRAL_POINTS_EXHAUSTED', userMessage: '积分不足，请充值后重试' } });
  await assert.rejects(request(identity, '/api/canvas/node/exec', { method: 'POST', body: {} }), (e) =>
    e.code === 'points_exhausted' && /积分不足，请充值后重试/.test(e.message));
});

test('报错带上 errorMessage 与 errorCode（exec 类接口只给这两个）', async () => {
  server.routes['POST /api/w'] = () => ({ status: 201, body: { code: 3, errorMessage: '画布中引用的 AI SOP 已被删除', errorCode: 'SOP_DELETED' } });
  await assert.rejects(request(identity, '/api/w', { method: 'POST', body: {} }), (e) =>
    e.code === 'business' && /AI SOP 已被删除/.test(e.message) && /\[SOP_DELETED\]/.test(e.message));
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/http.test.mjs`
Expected: 新加的 2 条 FAIL（第一条的 code 是 `upstream`，第二条的消息里没有 errorMessage），原有 6 条 PASS。

- [ ] **Step 3: 实现**

把 `miaodong-kit/src/http.mjs` 里的 `messageOf` 整个换成：

```js
// 秒懂的报错字段不统一：页面优先展示 userMessage，exec 类接口只给 errorMessage + errorCode，校验失败时 message 是数组
function messageOf(payload) {
  const parts = [];
  for (const key of ['userMessage', 'message', 'errorMessage']) {
    const m = payload?.[key];
    const text = Array.isArray(m) ? m.join('；') : typeof m === 'string' ? m : '';
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (typeof payload?.errorCode === 'string' && payload.errorCode) parts.push(`[${payload.errorCode}]`);
  return parts.join(' ');
}

const POINTS_EXHAUSTED = 'AI_INTEGRAL_POINTS_EXHAUSTED';
```

在 `request()` 里，解析完 `payload` 之后、`if (res.status === 401 ...` 之前插入：

```js
  const businessFailed = payload && typeof payload === 'object' && !Array.isArray(payload) && 'code' in payload && Number(payload.code) !== 0;
  if ((!res.ok || businessFailed) && payload?.errorCode === POINTS_EXHAUSTED) {
    throw new MdError('points_exhausted', `${identity.label} 的秒懂积分不足：${payload.userMessage || '请充值后重试'}`, {
      hint: '让用户去秒懂充值；md 不会自动重试',
    });
  }
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2
Expected: 8 条全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/http.mjs miaodong-kit/test/http.test.mjs
git commit -m "feat(md): 报错带上 userMessage/errorMessage/errorCode，积分不足单独报"
```

---

### Task 2: 时间参数（--since / --from / --to）

**Files:**
- Create: `miaodong-kit/src/timewin.mjs`
- Test: `miaodong-kit/test/timewin.test.mjs`

**Interfaces:**
- Consumes: `strArg(args, key)`（`src/args.mjs`）、`usage()`（`src/errors.mjs`）、`formatTime()`（`src/output.mjs`）
- Produces:
  - `parseDuration(text: string): number`，单位毫秒；
  - `parseTime(text: string): number`，返回毫秒时间戳，按本地时间理解；
  - `timeWindow(args, { defaultSince = '24h', now = Date.now() }): { start: number, end: number, label: string }`

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/timewin.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseTime, timeWindow } from '../src/timewin.mjs';

const span = (w) => [w.start, w.end];

test('parseDuration：分钟、小时、天', () => {
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('7d'), 604_800_000);
  assert.throws(() => parseDuration('1w'), (e) => e.exitCode === 2);
  assert.throws(() => parseDuration('0h'), (e) => e.exitCode === 2);
});

test('parseTime：日期和时分按本地时间理解，也认 ISO', () => {
  assert.equal(parseTime('2026-09-23 10:00'), new Date(2026, 8, 23, 10, 0, 0).getTime());
  assert.equal(parseTime('2026-09-23T10:00:30'), new Date(2026, 8, 23, 10, 0, 30).getTime());
  assert.equal(parseTime('2026-09-23'), new Date(2026, 8, 23).getTime());
  assert.equal(parseTime('2026-09-23T02:00:00.000Z'), Date.UTC(2026, 8, 23, 2));
  assert.throws(() => parseTime('昨天'), (e) => e.exitCode === 2);
});

test('timeWindow：默认最近 24 小时；--since / --from / --to；互斥与先后校验', () => {
  const now = new Date(2026, 8, 24, 12, 0).getTime();
  assert.deepEqual(span(timeWindow({}, { now })), [now - 86_400_000, now]);
  assert.deepEqual(span(timeWindow({ since: '6h' }, { now })), [now - 21_600_000, now]);
  const w = timeWindow({ from: '2026-09-23 10:00', to: '2026-09-23 12:00' }, { now });
  assert.deepEqual(span(w), [new Date(2026, 8, 23, 10).getTime(), new Date(2026, 8, 23, 12).getTime()]);
  assert.equal(w.label, '2026-09-23 10:00 ~ 2026-09-23 12:00');
  assert.throws(() => timeWindow({ since: '1h', from: '2026-09-23' }, { now }), (e) => e.exitCode === 2);
  assert.throws(() => timeWindow({ from: '2026-09-24 13:00' }, { now }), (e) => e.exitCode === 2);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/timewin.test.mjs`
Expected: FAIL，报 Cannot find module `../src/timewin.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/timewin.mjs`

```js
// 时间参数：--since 30m|6h|24h|7d，或 --from / --to。
// 秒懂的执行列表按毫秒时间戳查，起止时间必传；7 天窗口光首页就要 17–22 秒（实测），所以默认只看最近 24 小时。

import { strArg } from './args.mjs';
import { usage } from './errors.mjs';
import { formatTime } from './output.mjs';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text) {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) <= 0) throw usage(`时间长度写成 30m、6h、24h、7d 这样，收到「${text}」`);
  return Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
}

// 2026-09-23、2026-09-23 10:00、2026-09-23T10:00:30 按本地时间理解；其余交给 Date.parse（ISO）
export function parseTime(text) {
  const s = String(text ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = m;
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)).getTime();
    if (Number.isFinite(t)) return t;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw usage(`看不懂的时间「${text}」`, '写成 2026-09-23 10:00（中间有空格就加引号）或 ISO 时间');
  return t;
}

export function timeWindow(args, { defaultSince = '24h', now = Date.now() } = {}) {
  const since = strArg(args, 'since');
  const from = strArg(args, 'from');
  const to = strArg(args, 'to');
  if (since && (from || to)) throw usage('--since 和 --from / --to 只能二选一');
  const end = to ? parseTime(to) : now;
  const start = from ? parseTime(from) : end - parseDuration(since ?? defaultSince);
  if (!(start < end)) throw usage(`时间窗不对：开始 ${formatTime(start)} 不早于结束 ${formatTime(end)}`);
  return { start, end, label: `${formatTime(start)} ~ ${formatTime(end)}` };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2
Expected: 3 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/timewin.mjs miaodong-kit/test/timewin.test.mjs
git commit -m "feat(md): 时间参数 --since/--from/--to"
```

---

### Task 3: 执行列表接口、行摘要与搜索（execs.mjs），外加执行记录测试数据

**Files:**
- Create: `miaodong-kit/src/execs.mjs`
- Create: `miaodong-kit/test/helpers/exec-fixtures.mjs`
- Test: `miaodong-kit/test/execs.test.mjs`

**Interfaces:**
- Consumes:
  - `request()`（`src/http.mjs`）、`asArray()`（`src/api.mjs`）、`MdError / usage`（`src/errors.mjs`）、`formatTime()`（`src/output.mjs`）；
  - 老懂的 `extractTriggerTextFromSnapshot(canvasExec)`，来自 `apps/api/lib/miaodong/badcase-normalize.ts`。
- Produces（后续任务都用这些名字）：
  - 常量：`PAGE_SIZE = 100`；`TRIGGER_ALIASES`、`ACTION_ALIASES`（简写 → 完整类型名）；`TRIGGER_LABEL`（触发类型 → 中文）。
  - 接口：
    - `listExecutions(identity, orgId, body) → Promise<{ rows: object[], total: number|null }>`
    - `getExecDetail(identity, orgId, execId, botId?) → Promise<object|null>`：返回 `data`，找不到时返回 null。
  - 摘要与格式化：
    - `resolveAlias(aliases, value, flag) → string|undefined`
    - `clip(value, max) → string`：把空白压成单个空格，超长时截断并加「…」。
    - `formatCost(cost|null) → string`：`¥29.35`、`¥0.170`、`¥0.010`、`¥0.0060`、`¥0`、`¥-`。
    - `actionTexts(outputActions) → Array<{ kind: 'reply'|'handover'|'event'|'other', text: string }>`
    - `summarizeRow(row) → { execId, at, status, triggerType, trigger, eventName, triggerText, actions, version, canary, cost, feedback }`
    - `formatRow(summary) → string`
  - 搜索：
    - `buildSearchBody(filters) → object`，filters 字段为 `botId, start, end, keyword, session, down, up, event, trigger, action, versionCanvasId, canary, failed`。
    - `searchExecutions(identity, orgId, body, { eventName, limit, scanPages, onPage }) → Promise<{ matches, total, scanned, pages, exhausted, namesSeen: Map<string, number> }>`
- 测试数据 `exec-fixtures.mjs` 导出：`EXEC_BOT, SESSION, X(n), at(seconds), ASK, REPLY, execSnapshot(), chainRows(), detailOf(row, opts), delayNodeResults(rows), delayDetail(), draftCanvas()`。

- [ ] **Step 1: 写测试数据** `miaodong-kit/test/helpers/exec-fixtures.mjs`

```js
// 一条「用户消息 → 延时回复 → 发送」事件链，外加一条载荷对不上的干扰项和一条标签事件。
// 时间相对测试启动时刻（两小时前），保证落在默认的 24 小时窗口里。
//   X(1) 10:00:00 用户消息「我想退款」 → 发出「延时回复」{text, contactId}
//   X(6) +5s  标签事件（同会话噪声）
//   X(2) +41s 「延时回复」（载荷与 X(1) 一致）→ 写 1 个字段、发出「发送」{text: 回复}
//   X(4) +50s 「延时回复」（载荷对不上：text 不同）← 干扰项，点踩
//   X(3) +104s 「发送」（载荷与 X(2) 一致）→ 发文本「回复」，灰度 v1.0.403
import { U, edge, node } from './fixtures.mjs';

export const EXEC_BOT = '147bd600-0000-4000-8000-000000000000';
export const SESSION = '66f0000000000000000000a1';
export const X = (n) => `e${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
export const ASK = '我想退款';
export const REPLY = '已为您登记退款';
const T0 = Date.now() - 2 * 3_600_000;
export const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

const eventEntry = (n, name, eventId) => ({ ...node(n, { name, type: 'canvas-event-trigger', category: 'trigger', payload: { eventId } }), shape: eventId });

export function execSnapshot() {
  return [
    node(1, { name: '收到文本', type: 'receive-text-message', category: 'trigger' }),
    eventEntry(5, '延时回复入口', 'ev-delay'),
    node(2, { name: '回答生成', payload: { modelType: 'doubao-seed-2.0-lite', systemPrompt: '你是客服。固定话术：欢迎来到兴趣岛', inputs: [{ name: 'text', referenceNodeId: U(5), dataPath: 'text' }] } }),
    node(3, { name: '规则中心', type: 'rule-center', payload: { branches: [{ branchId: 'br-l3', name: 'L3' }], defaultBranchId: 'br-default' } }),
    node(4, { name: '触发发送', type: 'canvas-event-action', category: 'action', payload: { eventId: 'ev-send' } }),
    edge(101, 1, 2), edge(102, 5, 2), edge(103, 2, 3), edge(104, 3, 4),
  ];
}

// 草稿相对执行时的快照：回答生成改了 prompt，规则中心被删了
export function draftCanvas() {
  return execSnapshot()
    .filter((c) => c.id !== U(3))
    .map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '你是客服。退款先安抚。' } } } : c));
}

const textTrigger = (text) => ({
  triggerContent: { triggerType: 'receive-text-message', content: { text } },
  rawTrigger: { triggerType: 'receive-text-message', sessionId: SESSION, triggerSource: 'mh', receiveTextMessage: { text, contactId: 'c1' } },
});
const eventTrigger = (eventId, eventName, data) => ({
  triggerContent: { triggerType: 'canvas-event-trigger', content: { eventId, eventName, data, executionId: `foreign-${eventId}` } },
  rawTrigger: { triggerType: 'canvas-event-trigger', sessionId: SESSION, triggerSource: 'mh', canvasEvent: { eventId, data, executionId: `foreign-${eventId}` } },
});
const emit = (eventId, eventName, params) => ({ type: 'canvas-event-action', payload: { eventId, eventName, params } });
const row = (n, seconds, trigger, outputActions, extra = {}) => ({
  execId: X(n), sessionId: SESSION, createdAt: at(seconds), status: 'success', processDuration: 1000,
  canvasVersion: 'v1.0.402', canvasName: '402', isCanary: false, tokenCount: {}, totalCostInCny: 0, feedbackStatus: 'none',
  sessionMemorySnapshot: { 'sess-1': 'x'.repeat(2000) }, outputActions, ...trigger, ...extra,
});

export function chainRows() {
  return [
    row(1, 0, textTrigger(ASK), [emit('ev-delay', '延时回复', { text: ASK, contactId: 'c1' })], { totalCostInCny: 0.006 }),
    row(6, 5, { triggerContent: { triggerType: 'tag-event', content: { operation: 'ADD', tagId: 't1', tagName: '意向' } }, rawTrigger: { triggerType: 'tag-event', sessionId: SESSION, tagEvent: { tagId: 't1', operation: 'ADD' } } }, []),
    row(2, 41, eventTrigger('ev-delay', '延时回复', { text: ASK, contactId: 'c1' }), [
      { type: 'update-data', payload: { operations: [{ fieldId: 'f1', fieldName: '意向', updateOperation: 'set', value: '退款' }] } },
      emit('ev-send', '发送', { text: REPLY, contactId: 'c1' }),
    ], { totalCostInCny: 0.17 }),
    row(4, 50, eventTrigger('ev-delay', '延时回复', { text: '别的问题', contactId: 'c1' }), [], { feedbackStatus: 'thumb-down' }),
    row(3, 104, eventTrigger('ev-send', '发送', { text: REPLY, contactId: 'c1' }), [{ type: 'send-text-message', payload: { text: REPLY } }], { isCanary: true, canvasVersion: 'v1.0.403' }),
  ];
}

export function detailOf(execRow, { snapshot = execSnapshot(), nodeResults = [], version = 'v1.0.402', testRun = false } = {}) {
  return {
    canvasExec: {
      execId: execRow.execId, botId: EXEC_BOT, orgId: 'org-1', sessionId: execRow.sessionId, canvasId: 'ver-402',
      status: 'success', triggerType: execRow.triggerContent.triggerType, eventSnapshot: execRow.rawTrigger,
      outputActions: execRow.outputActions, processDuration: 12345, totalCostInCny: execRow.totalCostInCny,
      testRun, isCanary: execRow.isCanary, createdAt: execRow.createdAt, rawCanvas: snapshot,
    },
    canvas: { canvasId: 'ver-402', rootCanvasId: 'main-1', version, name: version.replace(/^v1\.0\./, ''), rawCanvas: snapshot },
    nodeResults,
  };
}

// 「延时回复」那条的节点结果，故意打乱顺序：真实响应就不是执行顺序
export function delayNodeResults(rows = chainRows()) {
  const delay = rows.find((r) => r.execId === X(2));
  return [
    { nodeId: U(3), status: 'success', inputs: { inputData: { output: REPLY } }, output: { result: true }, outputBranchId: 'br-l3', processDuration: 3, actions: [] },
    { nodeId: U(5), status: 'success', inputs: { inputData: {} }, output: { text: ASK, contactId: 'c1' }, processDuration: 1, actions: [] },
    { nodeId: U(4), status: 'success', inputs: { inputData: { text: REPLY } }, output: {}, processDuration: 2, actions: [delay.outputActions[1]] },
    {
      nodeId: U(2), status: 'success', inputs: { inputData: { text: ASK, 质检规则: '旧规则' } }, output: { message: REPLY }, processDuration: 12000,
      metadata: {
        prompt: [{ role: 'system', content: '你是客服。固定话术：欢迎来到兴趣岛' }, { role: 'user', content: ASK }],
        reasoningMessage: '用户要退款，先登记',
        tokenUsage: { prompt: 1500, completion: 20, reasoning: 5, costInCny: 0.0102 },
        toolCallResults: [{ name: 'q_kb_1', toolType: 'query_kb', toolCallArguments: { query: '退款政策' }, toolResult: { success: true, result: [{}, {}] } }],
      },
      actions: [],
    },
  ];
}

export function delayDetail() {
  const rows = chainRows();
  return detailOf(rows.find((r) => r.execId === X(2)), { nodeResults: delayNodeResults(rows) });
}
```

- [ ] **Step 2: 写失败的测试** `miaodong-kit/test/execs.test.mjs`

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_ALIASES, TRIGGER_ALIASES, actionTexts, buildSearchBody, clip, formatCost, formatRow, resolveAlias, searchExecutions, summarizeRow } from '../src/execs.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { ASK, REPLY, X, chainRows } from './helpers/exec-fixtures.mjs';

test('actionTexts：发文本、组合消息、转人工、发出事件、写字段、打标签都说人话', () => {
  const texts = actionTexts([
    { type: 'send-text-message', payload: { text: '你好' } },
    { type: 'send-combination-message', payload: { messages: [{ type: 'text', content: '第一句' }, { type: 'image', content: 'https://x/a.png' }] } },
    { type: 'handover', payload: { handoverMessage: '需要人工' } },
    { type: 'canvas-event-action', payload: { eventId: 'ev-send', eventName: '发送', params: { text: '回复' } } },
    { type: 'update-data', payload: { operations: [{}, {}] } },
    { type: 'tag-user', payload: { operation: 'ADD', tags: [{ tagName: '意向' }] } },
    { type: 'send-material', payload: {} },
  ]);
  assert.deepEqual(texts.map((t) => t.text), [
    '发文本「你好」', '发组合消息「第一句 / https://x/a.png」', '转人工「需要人工」', '发出事件「发送」：回复', '写 2 个字段', '打标签 意向', 'send-material',
  ]);
  assert.deepEqual(texts.map((t) => t.kind), ['reply', 'reply', 'handover', 'event', 'other', 'other', 'other']);
});

test('summarizeRow / formatRow：事件名、触发文本、动作、版本、灰度、花费、点踩', () => {
  const rows = chainRows();
  const delay = summarizeRow(rows.find((r) => r.execId === X(2)));
  assert.equal(delay.trigger, '事件「延时回复」');
  assert.equal(delay.triggerText, ASK);
  assert.match(delay.actions, /发出事件「发送」：已为您登记退款/);
  const line = formatRow(summarizeRow(rows.find((r) => r.execId === X(3))));
  assert.match(line, new RegExp(`${X(3)} 事件「发送」 ｜ ${REPLY} ｜ 发文本「${REPLY}」 ｜ v1\\.0\\.403（灰度） ¥0$`));
  assert.match(formatRow(summarizeRow(rows.find((r) => r.execId === X(4)))), / 👎$/);
});

test('字段缺失或为 null 时摘要照常输出，不崩', () => {
  const s = summarizeRow({ execId: X(7), outputActions: null, triggerContent: null, totalCostInCny: null, canvasVersion: null, createdAt: null });
  assert.equal(formatRow(s), `- ${X(7)} - ｜ - ｜ 无动作 ｜ - ¥-`);
});

test('formatCost / clip', () => {
  assert.equal(formatCost(29.35138), '¥29.35');
  assert.equal(formatCost(0.17), '¥0.170');
  assert.equal(formatCost(0.0102), '¥0.010');
  assert.equal(formatCost(0.006), '¥0.0060');
  assert.equal(formatCost(0), '¥0');
  assert.equal(formatCost(null), '¥-');
  assert.equal(clip('a\n  b', 10), 'a b');
  assert.equal(clip('一二三四五', 3), '一二三…');
});

test('resolveAlias：简写、完整类型名；不认识的报用法错误', () => {
  assert.equal(resolveAlias(TRIGGER_ALIASES, 'text', 'trigger'), 'receive-text-message');
  assert.equal(resolveAlias(ACTION_ALIASES, 'send', 'action'), 'send-text-message');
  assert.equal(resolveAlias(ACTION_ALIASES, 'smart-tag', 'action'), 'smart-tag');
  assert.equal(resolveAlias(TRIGGER_ALIASES, undefined, 'trigger'), undefined);
  assert.throws(() => resolveAlias(TRIGGER_ALIASES, 'xx', 'trigger'), (e) => e.exitCode === 2 && /text/.test(e.hint));
});

test('buildSearchBody：条件全部进请求，--event 自带事件触发类型；冲突报用法错误', () => {
  const body = buildSearchBody({ botId: 'b', start: 1, end: 2, keyword: '退款', session: 's', down: true, action: 'send-text-message', versionCanvasId: 'ver-402', canary: false, failed: true, event: '延时回复' });
  assert.deepEqual(body, { botId: 'b', startTimestamp: 1, endTimestamp: 2, keyword: '退款', sessionId: 's', feedbackStatus: 'thumb-down', triggerType: 'canvas-event-trigger', actionType: 'send-text-message', canvasId: 'ver-402', isCanary: false, allNodesSuccess: false });
  assert.throws(() => buildSearchBody({ botId: 'b', start: 1, end: 2, event: '延时回复', trigger: 'receive-text-message' }), (e) => e.exitCode === 2);
  assert.throws(() => buildSearchBody({ botId: 'b', start: 1, end: 2, down: true, up: true }), (e) => e.exitCode === 2);
});

let server;
const pages = [];
before(async () => {
  // 250 条：每 3 条里有 1 条是「延时回复」
  const rows = Array.from({ length: 250 }, (_, i) => ({
    execId: `r${i}`,
    triggerContent: { triggerType: 'canvas-event-trigger', content: { eventName: i % 3 === 0 ? '延时回复' : '发送' } },
  }));
  server = await startFakeMiaodong({
    'POST /api/canvas/history/list': ({ body }) => {
      pages.push(body.current);
      const from = (body.current - 1) * body.pageSize;
      return ok(rows.slice(from, from + body.pageSize), { page: { total: rows.length } });
    },
  });
});
after(() => server.close());
const identity = () => ({ key: 'k', label: '测试区', origin: server.origin, token: 't' });

test('searchExecutions：按事件名本地筛，够数就停，没扫完如实返回', async () => {
  pages.length = 0;
  const r = await searchExecutions(identity(), 'org-1', { botId: 'b' }, { eventName: '延时回复', limit: 5, scanPages: 3 });
  assert.equal(r.matches.length, 5);
  assert.deepEqual(pages, [1]);
  assert.equal(r.scanned, 100);
  assert.equal(r.total, 250);
  assert.equal(r.exhausted, false);
  assert.ok(r.namesSeen.get('发送') > 0);
});

test('searchExecutions：扫到页数上限就停；扫完时标 exhausted', async () => {
  pages.length = 0;
  const capped = await searchExecutions(identity(), 'org-1', { botId: 'b' }, { eventName: '没有这个事件', limit: 5, scanPages: 2 });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(capped.matches.length, 0);
  assert.equal(capped.exhausted, false);
  const all = await searchExecutions(identity(), 'org-1', { botId: 'b' }, { eventName: '没有这个事件', limit: 5, scanPages: 5 });
  assert.equal(all.scanned, 250);
  assert.equal(all.exhausted, true);
});

test('searchExecutions：不用本地筛时按 --limit 取页', async () => {
  pages.length = 0;
  const r = await searchExecutions(identity(), 'org-1', { botId: 'b' }, { limit: 150 });
  assert.equal(r.matches.length, 150);
  assert.deepEqual(pages, [1, 2]);
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/execs.test.mjs`
Expected: FAIL，报 Cannot find module `../src/execs.mjs`。

- [ ] **Step 4: 实现** `miaodong-kit/src/execs.mjs`

```js
// 执行记录（调优中心）的接口与纯函数。
// 列表每条约 25KB（八成是会话变量快照），高流量 bot 一天九十万条执行：能让秒懂筛的条件全部放进请求
// （09-24 核对：triggerType / actionType / canvasId / isCanary / allNodesSuccess / execId 都生效），
// 只有「事件名」服务端筛不了，要拉回来本地比，而且有页数上限，扫了多少如实说。

import { request } from './http.mjs';
import { asArray } from './api.mjs';
import { MdError, usage } from './errors.mjs';
import { formatTime } from './output.mjs';
import { extractTriggerTextFromSnapshot } from '../../apps/api/lib/miaodong/badcase-normalize.ts';

export const PAGE_SIZE = 100;

export const TRIGGER_ALIASES = {
  text: 'receive-text-message', image: 'receive-image-message', audio: 'receive-audio-message', video: 'receive-video-message',
  file: 'receive-file-message', other: 'receive-other-message', event: 'canvas-event-trigger', tag: 'tag-event', friend: 'new-friend',
};
export const ACTION_ALIASES = {
  send: 'send-text-message', combo: 'send-combination-message', handover: 'handover', event: 'canvas-event-action',
  update: 'update-data', tag: 'tag-user', material: 'send-material', plugin: 'plugin-action',
};
export const TRIGGER_LABEL = {
  'receive-text-message': '文本', 'receive-image-message': '图片', 'receive-audio-message': '语音', 'receive-video-message': '视频',
  'receive-file-message': '文件', 'receive-other-message': '其他消息', 'tag-event': '标签', 'new-friend': '新好友', 'canvas-event-trigger': '事件',
};

const str = (v) => (typeof v === 'string' ? v : '');

export async function listExecutions(identity, orgId, body) {
  const payload = await request(identity, '/api/canvas/history/list', { method: 'POST', query: { orgId }, body, timeoutMs: 90_000 });
  const total = Number(payload?.page?.total);
  return { rows: asArray(payload?.data), total: Number.isFinite(total) ? total : null };
}

// 找不到时秒懂回业务错误 CANVAS_EXEC_NOT_FOUND；这里统一成 null，由调用方决定报什么
export async function getExecDetail(identity, orgId, execId, botId) {
  let payload;
  try {
    payload = await request(identity, '/api/canvas/history/details', { query: { execId, botId, orgId }, timeoutMs: 120_000 });
  } catch (error) {
    if (error instanceof MdError && error.code !== 'auth_expired' && /NOT_FOUND|不存在/i.test(error.message)) return null;
    throw error;
  }
  const data = payload?.data;
  return data?.canvasExec ? data : null;
}

export function resolveAlias(aliases, value, flag) {
  if (value === undefined) return undefined;
  if (value.includes('-')) return value;
  const full = aliases[value];
  if (!full) throw usage(`--${flag} 不认识「${value}」`, `写完整类型名，或用简写：${Object.keys(aliases).join('、')}`);
  return full;
}

export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatCost(cost) {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return '¥-';
  if (cost === 0) return '¥0';
  return `¥${cost >= 1 ? cost.toFixed(2) : cost >= 0.01 ? cost.toFixed(3) : cost.toFixed(4)}`;
}

// 回复不止 send-text：组合消息的内容在 payload.messages[].content，转人工话术在 handoverMessage（老懂的 extractBotReply 只认 text/content）
export function actionTexts(outputActions) {
  return asArray(outputActions).map((action) => {
    const p = action?.payload ?? {};
    switch (action?.type) {
      case 'send-text-message':
        return { kind: 'reply', text: `发文本「${str(p.text)}」` };
      case 'send-combination-message':
        return { kind: 'reply', text: `发组合消息「${asArray(p.messages).map((m) => str(m?.content)).filter(Boolean).join(' / ')}」` };
      case 'handover':
        return { kind: 'handover', text: `转人工${str(p.handoverMessage) ? `「${p.handoverMessage}」` : ''}` };
      case 'canvas-event-action': {
        const text = str(p.params?.text);
        return { kind: 'event', text: `发出事件「${str(p.eventName) || String(p.eventId ?? '').slice(0, 8)}」${text ? `：${text}` : ''}` };
      }
      case 'update-data':
        return { kind: 'other', text: `写 ${asArray(p.operations).length} 个字段` };
      case 'tag-user':
      case 'smart-tag': {
        const names = asArray(p.tags).map((t) => str(t?.tagName)).filter(Boolean);
        return { kind: 'other', text: `${p.operation === 'REMOVE' ? '去标签' : '打标签'}${names.length ? ` ${names.join('、')}` : ''}` };
      }
      default:
        return { kind: 'other', text: String(action?.type ?? '未知动作') };
    }
  });
}

export function summarizeRow(row) {
  const tc = row?.triggerContent ?? {};
  const triggerType = str(tc.triggerType) || str(row?.rawTrigger?.triggerType);
  const eventName = str(tc.content?.eventName);
  const cost = typeof row?.totalCostInCny === 'number' ? row.totalCostInCny : Number.parseFloat(row?.totalCostInCny);
  return {
    execId: String(row?.execId ?? ''),
    at: row?.createdAt ?? null,
    status: str(row?.status),
    triggerType,
    trigger: eventName ? `事件「${eventName}」` : TRIGGER_LABEL[triggerType] ?? (triggerType || '-'),
    eventName,
    triggerText: extractTriggerTextFromSnapshot({ triggerContent: row?.triggerContent, eventSnapshot: row?.rawTrigger }),
    actions: actionTexts(row?.outputActions).map((a) => a.text).join('；'),
    version: str(row?.canvasVersion),
    canary: row?.isCanary === true,
    cost: Number.isFinite(cost) ? cost : null,
    feedback: str(row?.feedbackStatus),
  };
}

export function formatRow(s) {
  const feedback = s.feedback === 'thumb-down' ? ' 👎' : s.feedback === 'thumb-up' ? ' 👍' : '';
  const status = s.status && s.status !== 'success' ? `（${s.status}）` : '';
  return `${formatTime(s.at)} ${s.execId} ${s.trigger}${status} ｜ ${clip(s.triggerText, 40) || '-'} ｜ ${clip(s.actions, 60) || '无动作'} ｜ ${s.version || '-'}${s.canary ? '（灰度）' : ''} ${formatCost(s.cost)}${feedback}`;
}

export function buildSearchBody(f) {
  if (f.event && f.trigger && f.trigger !== 'canvas-event-trigger') throw usage('--event 只能配事件触发，不能和别的 --trigger 一起用');
  if (f.down && f.up) throw usage('--down 和 --up 只能选一个');
  const body = { botId: f.botId, startTimestamp: f.start, endTimestamp: f.end };
  if (f.keyword) body.keyword = f.keyword;
  if (f.session) body.sessionId = f.session;
  if (f.down) body.feedbackStatus = 'thumb-down';
  if (f.up) body.feedbackStatus = 'thumb-up';
  const trigger = f.event ? 'canvas-event-trigger' : f.trigger;
  if (trigger) body.triggerType = trigger;
  if (f.action) body.actionType = f.action;
  if (f.versionCanvasId) body.canvasId = f.versionCanvasId;
  if (typeof f.canary === 'boolean') body.isCanary = f.canary;
  if (f.failed) body.allNodesSuccess = false;
  return body;
}

export async function searchExecutions(identity, orgId, body, { eventName = '', limit = 20, scanPages = 5, onPage = () => {} } = {}) {
  const local = Boolean(eventName);
  const pageSize = local ? PAGE_SIZE : Math.min(PAGE_SIZE, limit);
  const maxPages = local ? scanPages : Math.ceil(limit / pageSize);
  const matches = [];
  const namesSeen = new Map();
  let total = null;
  let scanned = 0;
  let pages = 0;
  let exhausted = false;
  for (let page = 1; page <= maxPages && matches.length < limit; page++) {
    const res = await listExecutions(identity, orgId, { ...body, current: page, pageSize });
    if (res.total !== null) total = res.total;
    pages = page;
    scanned += res.rows.length;
    for (const row of res.rows) {
      if (local) {
        const name = str(row?.triggerContent?.content?.eventName);
        if (name) namesSeen.set(name, (namesSeen.get(name) ?? 0) + 1);
        if (name !== eventName) continue;
      }
      matches.push(row);
      if (matches.length >= limit) break;
    }
    onPage({ page, scanned, matched: matches.length, total });
    if (res.rows.length < pageSize) {
      exhausted = true;
      break;
    }
  }
  if (total !== null && scanned >= total) exhausted = true;
  return { matches, total, scanned, pages, exhausted, namesSeen };
}
```

- [ ] **Step 5: 运行，确认通过**

Run: 同 Step 3
Expected: 9 条 PASS。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/execs.mjs miaodong-kit/test/execs.test.mjs miaodong-kit/test/helpers/exec-fixtures.mjs
git commit -m "feat(md): 执行列表接口、行摘要与按条件搜索"
```

---

### Task 4: 执行详情加工与本地存储（exec-detail.mjs、exec-store.mjs）

**Files:**
- Create: `miaodong-kit/src/exec-detail.mjs`
- Create: `miaodong-kit/src/exec-store.mjs`
- Test: `miaodong-kit/test/exec-detail.test.mjs`

**Interfaces:**
- Consumes:
  - `isEdgeCell, contentKey, nodeMap, stripLayout`（`src/canvas.mjs`）、`fieldChanges`（`src/diff.mjs`）、`asArray`（`src/api.mjs`）；
  - `EXIT, MdError, usage`（`src/errors.mjs`）、`shortId`（`src/output.mjs`）；
  - `actionTexts, clip, formatCost`（Task 3）；
  - 老懂的 `buildBranchNameIndex, buildNodeMetaIndex, extractEventTrigger, extractTriggerTextFromSnapshot`；
  - `ensureDir, mdHome, readJson, writeJson`（`src/home.mjs`）、`stamp`（`src/workspace.mjs`）。
- Produces（`exec-detail.mjs`）：
  - `orderExecuted(nodeIds: string[], snapshot: object[]) → string[]`
  - `normalizeDetail(detail) → { exec, version, snapshot, nodes }`
    - `exec` 的字段：`execId, botId, sessionId, status, triggerType, createdAt, ms, cost, testRun, isCanary, outputActions, triggerText, event`。
    - `nodes[]` 的字段：`order, id, name, type, category, status, ms, branch, model, cost, error, inputs, output, actions, metadata`。
  - `NODE_LINE_LIMIT = 150`、`nodeLine(node) → string`
  - `findExecNode(norm, query) → node`：query 可以是 id、id 前缀、名字，或 `#序号`。
  - `promptText(metadata) → string`
  - `renderNodeDetail(node, { nodeFile, promptFile }) → string[]`
  - `locateText(norm, needle) → { rows, verdict: { kind: 'hardcoded'|'generated'|'trigger'|'external'|'none', node } }`
  - `verdictLine(verdict) → string`
  - `driftAgainst(norm, draftCanvas) → { changed: [{ node, paths }], removed: node[] }`
- Produces（`exec-store.mjs`）：
  - `TERMINAL_STATUSES`
  - 路径：`execRoot(target)`、`execDir(target, execId)`
  - 搜索结果：`saveSearch(target, meta, rows, file?) → path`
  - 详情缓存：`loadCachedDetail(dir) → detail|null`、`saveDetail(dir, target, detail) → slim`、`findCachedExec(execId) → { dir, detail, target }|null`
  - 节点列表：`saveNodes(dir, nodes)`

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/exec-detail.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { U } from './helpers/fixtures.mjs';
import { ASK, REPLY, X, delayDetail, draftCanvas, execSnapshot } from './helpers/exec-fixtures.mjs';
import { driftAgainst, findExecNode, locateText, nodeLine, normalizeDetail, orderExecuted, renderNodeDetail, verdictLine } from '../src/exec-detail.mjs';

test('orderExecuted：按快照连线拓扑排序；环里剩下的按原顺序补在后面', () => {
  assert.deepEqual(orderExecuted([U(3), U(5), U(4), U(2)], execSnapshot()), [U(5), U(2), U(3), U(4)]);
  const loop = [
    { id: 'e1', shape: 'custom-curve-edge', source: { cell: 'a' }, target: { cell: 'b' } },
    { id: 'e2', shape: 'custom-curve-edge', source: { cell: 'b' }, target: { cell: 'a' } },
  ];
  assert.deepEqual(orderExecuted(['a', 'b', 'c'], loop), ['c', 'a', 'b']);
});

test('normalizeDetail：名字、类型、分支名、模型、花费；快照里没有的节点照样列出', () => {
  const detail = delayDetail();
  detail.nodeResults.push({ nodeId: U(99), status: 'error', errorMessage: '循环子节点报错', inputs: {}, output: null });
  const norm = normalizeDetail(detail);
  assert.deepEqual(norm.nodes.map((n) => n.name), ['延时回复入口', '回答生成', '规则中心', '触发发送', '(快照里没有这个节点)']);
  assert.equal(norm.nodes[1].model, 'doubao-seed-2.0-lite');
  assert.equal(norm.nodes[1].cost, 0.0102);
  assert.equal(norm.nodes[2].branch, 'L3');
  assert.equal(norm.version, 'v1.0.402');
  assert.equal(norm.exec.triggerText, ASK);
  assert.equal(norm.exec.event.eventId, 'ev-delay');
  assert.match(nodeLine(norm.nodes[2]), /规则中心 \[rule-center\] → 分支「L3」/);
  assert.match(nodeLine(norm.nodes[4]), /❌ \(快照里没有这个节点\) \[\?\] ：循环子节点报错/);
});

test('findExecNode：按名字、#序号、id 前缀找；这次没跑到的节点说清楚', () => {
  const norm = normalizeDetail(delayDetail());
  assert.equal(findExecNode(norm, '回答生成').id, U(2));
  assert.equal(findExecNode(norm, '#3').name, '规则中心');
  assert.equal(findExecNode(norm, U(4).slice(0, 8)).name, '触发发送');
  assert.throws(() => findExecNode(norm, '收到文本'), (e) => e.code === 'node_not_found' && /这次执行没有跑到/.test(e.message));
  assert.throws(() => findExecNode(norm, '不存在'), (e) => e.code === 'node_not_found' && /画布里没有节点/.test(e.message));
});

test('renderNodeDetail：输入逐键、prompt 长度与文件、推理、工具调用、token；超长内容截断', () => {
  const detail = delayDetail();
  const llm = detail.nodeResults.find((r) => r.nodeId === U(2));
  llm.metadata.prompt[0].content = '长'.repeat(20000);
  llm.output = { message: '答'.repeat(20000) };
  const n = normalizeDetail(detail).nodes[1];
  const text = renderNodeDetail(n, { nodeFile: '/tmp/n.json', promptFile: '/tmp/p.txt' }).join('\n');
  assert.match(text, /text: 我想退款/);
  assert.match(text, /质检规则: 旧规则/);
  assert.match(text, /Prompt：system 20000 字 · user 4 字 → \/tmp\/p\.txt/);
  assert.match(text, /推理：用户要退款，先登记/);
  assert.match(text, /工具：query_kb「退款政策」 → 返回 2 条/);
  assert.match(text, /token：prompt 1500 · completion 20 · reasoning 5 · ¥0\.010/);
  assert.ok(text.length < 6000, `输出应当截断，实际 ${text.length} 字`);
});

test('locateText：写死在配置里 / 由节点生成 / 来自触发内容 / 没找到', () => {
  const norm = normalizeDetail(delayDetail());
  assert.equal(locateText(norm, '欢迎来到兴趣岛').verdict.kind, 'hardcoded');
  const generated = locateText(norm, REPLY);
  assert.equal(generated.verdict.kind, 'generated');
  assert.equal(generated.verdict.node.name, '回答生成');
  assert.match(verdictLine(generated.verdict), /最早由 #2「回答生成」/);
  assert.equal(locateText(norm, ASK).verdict.kind, 'trigger');
  assert.equal(locateText(norm, 'zzz').verdict.kind, 'none');
  assert.throws(() => locateText(norm, '  '), (e) => e.exitCode === 2);
});

test('driftAgainst：跑过的节点里哪些在草稿里改了、删了', () => {
  const { changed, removed } = driftAgainst(normalizeDetail(delayDetail()), draftCanvas());
  assert.deepEqual(changed.map((c) => c.node.name), ['回答生成']);
  assert.deepEqual(changed[0].paths, ['data.nodePayload.systemPrompt']);
  assert.deepEqual(removed.map((n) => n.name), ['规则中心']);
});

test('exec-store：详情只存一份画布；缓存按 id 能找回；未结束的执行不当缓存', async () => {
  process.env.MD_HOME = mkdtempSync(join(tmpdir(), 'md-store-'));
  const { execDir, findCachedExec, loadCachedDetail, saveDetail } = await import('../src/exec-store.mjs');
  const target = { identityKey: 'k1', regionLabel: '测试区', orgId: 'org-1', orgName: '兴趣岛平台', botId: '147bd600-0000-4000-8000-000000000000', botName: '质检革新版', identity: { token: 'SECRET' } };
  const dir = execDir(target, X(2));
  saveDetail(dir, target, delayDetail());
  const saved = JSON.parse(readFileSync(join(dir, 'detail.json'), 'utf-8'));
  assert.equal(saved.canvasExec.rawCanvas, undefined);
  assert.equal(saved.canvas.rawCanvas.length, execSnapshot().length);
  assert.doesNotMatch(readFileSync(join(dir, 'target.json'), 'utf-8'), /SECRET/);
  assert.equal(findCachedExec(X(2)).target.botName, '质检革新版');
  const running = delayDetail();
  running.canvasExec.status = 'running';
  saveDetail(dir, target, running);
  assert.equal(loadCachedDetail(dir), null);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/exec-detail.test.mjs`
Expected: FAIL，报 Cannot find module `../src/exec-detail.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/exec-detail.mjs`

```js
// 执行详情的加工。nodeResults 没有节点名、没有时间戳，数组顺序也不是执行顺序（实测），
// 所以名字从执行当时的画布快照反查，顺序按快照连线对执行过的节点做拓扑排序（cdf0baa1 会话里 59/59 还原）。

import { contentKey, isEdgeCell, nodeMap, stripLayout } from './canvas.mjs';
import { fieldChanges } from './diff.mjs';
import { asArray } from './api.mjs';
import { EXIT, MdError, usage } from './errors.mjs';
import { shortId } from './output.mjs';
import { actionTexts, clip, formatCost } from './execs.mjs';
import { buildBranchNameIndex, buildNodeMetaIndex, extractEventTrigger, extractTriggerTextFromSnapshot } from '../../apps/api/lib/miaodong/badcase-normalize.ts';

export const NODE_LINE_LIMIT = 150;

export function orderExecuted(nodeIds, snapshot) {
  const ids = [...new Set(nodeIds)];
  const set = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, []]));
  for (const cell of asArray(snapshot)) {
    if (!cell || typeof cell !== 'object' || !isEdgeCell(cell)) continue;
    const from = cell.source?.cell;
    const to = cell.target?.cell;
    if (!set.has(from) || !set.has(to) || from === to) continue;
    next.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order = [];
  const done = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (done.has(id)) continue;
    done.add(id);
    order.push(id);
    for (const to of next.get(id)) {
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  // 环（循环节点）里剩下的，按秒懂返回的原顺序补在后面
  for (const id of ids) if (!done.has(id)) order.push(id);
  return order;
}

export function normalizeDetail(detail) {
  const ce = detail?.canvasExec ?? {};
  const snapshot = asArray(detail?.canvas?.rawCanvas).length ? detail.canvas.rawCanvas : asArray(ce.rawCanvas);
  const meta = buildNodeMetaIndex(snapshot);
  const branches = buildBranchNameIndex(snapshot);
  const cells = new Map(snapshot.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
  const results = asArray(detail?.nodeResults);
  const byId = new Map(results.map((r) => [r?.nodeId, r]));
  const nodes = orderExecuted(results.map((r) => r?.nodeId).filter(Boolean), snapshot).map((id, i) => {
    const r = byId.get(id) ?? {};
    const m = meta.get(id);
    const usageInfo = r.metadata?.tokenUsage;
    return {
      order: i + 1,
      id,
      name: m?.name || '(快照里没有这个节点)',
      type: m?.type || '?',
      category: m?.category || '',
      status: String(r.status ?? ''),
      ms: Number(r.processDuration) || 0,
      branch: r.outputBranchId ? branches.get(r.outputBranchId) ?? shortId(r.outputBranchId) : null,
      model: cells.get(id)?.data?.nodePayload?.modelType ?? null,
      cost: typeof usageInfo?.costInCny === 'number' ? usageInfo.costInCny : null,
      error: r.errorMessage ? String(r.errorMessage) : null,
      inputs: r.inputs?.inputData ?? r.inputs ?? null,
      output: r.output ?? null,
      actions: asArray(r.actions),
      metadata: r.metadata ?? null,
    };
  });
  const cost = typeof ce.totalCostInCny === 'number' ? ce.totalCostInCny : Number.parseFloat(ce.totalCostInCny);
  return {
    exec: {
      execId: String(ce.execId ?? ''),
      botId: String(ce.botId ?? ''),
      sessionId: String(ce.sessionId ?? ''),
      status: String(ce.status ?? ''),
      triggerType: String(ce.triggerType ?? ''),
      createdAt: ce.createdAt ?? null,
      ms: Number(ce.processDuration) || 0,
      cost: Number.isFinite(cost) ? cost : null,
      testRun: ce.testRun === true,
      isCanary: ce.isCanary === true,
      outputActions: asArray(ce.outputActions),
      triggerText: extractTriggerTextFromSnapshot(ce),
      event: extractEventTrigger(ce),
    },
    version: String(detail?.canvas?.version ?? ''),
    snapshot,
    nodes,
  };
}

const ICON = { success: '✅', error: '❌', running: '⏳', pending: '⏳' };

export function nodeLine(n) {
  const parts = [`${String(n.order).padStart(3)} ${ICON[n.status] ?? `⚪${n.status}`} ${n.name} [${[n.type, n.model].filter(Boolean).join(' · ')}]`];
  if (n.branch) parts.push(`→ 分支「${n.branch}」`);
  if (n.cost !== null) parts.push(formatCost(n.cost));
  if (n.ms) parts.push(`${(n.ms / 1000).toFixed(1)}s`);
  if (n.error) parts.push(`：${clip(n.error, 120)}`);
  return parts.join(' ');
}

export function findExecNode(norm, query) {
  const q = String(query ?? '').trim();
  const byOrder = /^#(\d+)$/.exec(q);
  let hits = byOrder ? norm.nodes.filter((n) => n.order === Number(byOrder[1])) : norm.nodes.filter((n) => n.id === q);
  if (!hits.length && !byOrder) hits = norm.nodes.filter((n) => n.id.startsWith(q));
  if (!hits.length && !byOrder) hits = norm.nodes.filter((n) => n.name === q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const lines = hits.slice(0, 20).map((n) => `  - #${n.order} ${shortId(n.id)} ${n.name}`).join('\n');
    throw new MdError('node_ambiguous', `「${q}」在这次执行里匹配到 ${hits.length} 个节点：\n${lines}`, { exitCode: EXIT.TARGET, hint: '用 #序号 或 id 前缀指定' });
  }
  const inSnapshot = norm.snapshot.some((c) => typeof c?.id === 'string' && (c.id === q || c.id.startsWith(q) || c?.data?.name === q));
  throw new MdError('node_not_found', inSnapshot ? `这次执行没有跑到「${q}」` : `这次执行的画布里没有节点「${q}」`, { exitCode: EXIT.TARGET });
}

const contentText = (content) => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

export function promptText(metadata) {
  return asArray(metadata?.prompt).map((m) => `## ${m?.role ?? '?'}\n${contentText(m?.content)}`).join('\n\n');
}

export function renderNodeDetail(n, { nodeFile, promptFile }) {
  const lines = [];
  const head = [`节点 #${n.order} ${n.name} [${[n.type, n.model].filter(Boolean).join(' · ')}] ${n.status}`];
  if (n.ms) head.push(`${(n.ms / 1000).toFixed(1)}s`);
  if (n.cost !== null) head.push(formatCost(n.cost));
  if (n.branch) head.push(`→ 分支「${n.branch}」`);
  lines.push(head.join(' '));
  if (n.error) lines.push(`报错：${clip(n.error, 500)}`);
  lines.push('输入：');
  const inputs = n.inputs && typeof n.inputs === 'object' ? Object.entries(n.inputs) : [];
  if (!inputs.length) lines.push('  （无）');
  for (const [key, value] of inputs) lines.push(`  ${key}: ${clip(typeof value === 'string' ? value : JSON.stringify(value), 300)}`);
  const msgs = asArray(n.metadata?.prompt);
  if (msgs.length) {
    lines.push(`Prompt：${msgs.map((m) => `${m?.role ?? '?'} ${contentText(m?.content).length} 字`).join(' · ')} → ${promptFile}`);
    const sys = msgs.find((m) => m?.role === 'system');
    if (sys) lines.push(`  system 开头：${clip(contentText(sys.content), 200)}`);
  }
  const reasoning = n.metadata?.reasoningMessage;
  if (typeof reasoning === 'string' && reasoning.trim()) lines.push(`推理：${clip(reasoning, 500)}`);
  lines.push(`输出：${clip(typeof n.output === 'string' ? n.output : JSON.stringify(n.output), 3000) || '（空）'}`);
  for (const t of asArray(n.metadata?.toolCallResults)) {
    const query = t?.toolCallArguments?.query;
    const result = t?.toolResult ? ` → ${t.toolResult.success === false ? '失败' : `返回 ${asArray(t.toolResult.result).length} 条`}` : '';
    lines.push(`工具：${t?.toolType ?? t?.name ?? '?'}${query ? `「${clip(query, 60)}」` : ''}${result}`);
  }
  const acts = actionTexts(n.actions);
  if (acts.length) lines.push(`动作：${clip(acts.map((a) => a.text).join('；'), 500)}`);
  const u = n.metadata?.tokenUsage;
  if (u && typeof u === 'object') {
    lines.push(`token：prompt ${u.prompt ?? '-'} · completion ${u.completion ?? '-'} · reasoning ${u.reasoning ?? '-'} · ${formatCost(typeof u.costInCny === 'number' ? u.costInCny : null)}`);
  }
  lines.push(`完整内容：${nodeFile}`);
  return lines;
}

// 一段文字是谁产生的。优先级：写死在配置里 > 某节点生成（输入里没有、输出里有）> 从执行外面传进来。
// 配置排第一：写死的话术最容易被误判成「模型想出来的」，然后去调温度、加约束，完全白费
export function locateText(norm, needle) {
  const target = String(needle ?? '').trim();
  if (!target) throw usage('--find 需要一段文字');
  const text = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const cells = new Map(norm.snapshot.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
  const rows = norm.nodes.map((node) => ({
    node,
    inConfig: text(cells.get(node.id)?.data).includes(target),
    inInput: text(node.inputs).includes(target),
    inPrompt: text(node.metadata?.prompt).includes(target),
    inOutput: text(node.output).includes(target) || text(node.actions).includes(target),
  }));
  const hardcoded = rows.find((r) => r.inConfig && !r.inInput);
  const generated = rows.find((r) => r.inOutput && !r.inInput && !r.inConfig);
  const external = rows.find((r) => r.inInput);
  let verdict = { kind: 'none', node: null };
  if (hardcoded) verdict = { kind: 'hardcoded', node: hardcoded.node };
  else if (generated) verdict = { kind: generated.node.category === 'trigger' ? 'trigger' : 'generated', node: generated.node };
  else if (external) verdict = { kind: 'external', node: external.node };
  return { rows: rows.filter((r) => r.inConfig || r.inInput || r.inPrompt || r.inOutput), verdict };
}

export function verdictLine(v) {
  if (v.kind === 'none') return '结论：这次执行的节点里都没有这段文字（可能在事件链上别的执行里：先 md exec <执行id> 看事件链）';
  const who = `#${v.node.order}「${v.node.name}」[${shortId(v.node.id)}]`;
  const texts = {
    hardcoded: `结论：写死在 ${who} 的配置里（该改的是这段配置，而不是调模型）`,
    trigger: `结论：来自触发内容 ${who}（用户消息或事件载荷）`,
    generated: `结论：最早由 ${who} 生成（它的输入里没有、输出里有）`,
    external: `结论：从这条执行外面传进来，最早出现在 ${who} 的输入里（上游执行、会话变量或用户消息）`,
  };
  return texts[v.kind];
}

// 执行时的快照 vs 现在的草稿：只看这次跑过的节点；坐标、尺寸这类纯渲染字段不算改动
export function driftAgainst(norm, draftCanvas) {
  const draft = nodeMap(draftCanvas);
  const snap = nodeMap(norm.snapshot);
  const changed = [];
  const removed = [];
  for (const node of norm.nodes) {
    const before = snap.get(node.id);
    if (!before) continue;
    const now = draft.get(node.id);
    if (!now) {
      removed.push(node);
      continue;
    }
    if (contentKey(before) === contentKey(now)) continue;
    changed.push({ node, paths: fieldChanges(stripLayout(before), stripLayout(now)).map((c) => c.path) });
  }
  return { changed, removed };
}
```

- [ ] **Step 4: 实现** `miaodong-kit/src/exec-store.mjs`

```js
// 执行记录的本地落盘：$MD_HOME/execs/<区>/<智能体 id 前 8 位>/。
// 一条详情约 20MB（执行时的画布出现了两份），只存一份；已经结束的执行不会再变，第二次直接读缓存。

import { existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { asArray } from './api.mjs';
import { ensureDir, mdHome, readJson, writeJson } from './home.mjs';
import { stamp } from './workspace.mjs';

export const TERMINAL_STATUSES = new Set(['success', 'error', 'cancelled', 'interrupted', 'merged_skipped', 'terminated', 'continued']);
const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');

export function execRoot(target) {
  return join(mdHome(), 'execs', safe(target.identityKey), safe(String(target.botId).slice(0, 8)));
}

export function execDir(target, execId) {
  return join(execRoot(target), safe(execId));
}

function writeCompact(file, value) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

export function saveSearch(target, meta, rows, file) {
  const path = file ? resolve(file) : join(execRoot(target), `search-${stamp()}.jsonl`);
  ensureDir(dirname(path));
  // 会话变量快照占每条的八成，搜索结果里用不到，不存
  const lines = [JSON.stringify({ kind: 'md-exec-search', ...meta }), ...rows.map(({ sessionMemorySnapshot, ...rest }) => JSON.stringify(rest))];
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

export function loadCachedDetail(dir) {
  const detail = readJson(join(dir, 'detail.json'), null);
  return detail && TERMINAL_STATUSES.has(String(detail.canvasExec?.status)) ? detail : null;
}

export function saveDetail(dir, target, detail) {
  const { rawCanvas, ...canvasExec } = detail.canvasExec ?? {};
  const slim = { ...detail, canvasExec };
  if (!Array.isArray(slim.canvas?.rawCanvas) && Array.isArray(rawCanvas)) slim.canvas = { ...(slim.canvas ?? {}), rawCanvas };
  writeCompact(join(dir, 'detail.json'), slim);
  const { identity, ...where } = target;
  writeJson(join(dir, 'target.json'), where);
  return slim;
}

export function findCachedExec(execId) {
  const root = join(mdHome(), 'execs');
  if (!existsSync(root)) return null;
  const subdirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
  for (const region of subdirs(root)) {
    for (const bot of subdirs(region)) {
      const dir = join(bot, safe(execId));
      const detail = loadCachedDetail(dir);
      const target = readJson(join(dir, 'target.json'), null);
      if (detail && target) return { dir, detail, target };
    }
  }
  return null;
}

export function saveNodes(dir, nodes) {
  const lines = nodes.map(({ metadata, ...node }) => JSON.stringify({
    ...node,
    reasoning: metadata?.reasoningMessage ?? null,
    tokenUsage: metadata?.tokenUsage ?? null,
    promptChars: asArray(metadata?.prompt).reduce((sum, m) => sum + String(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')).length, 0),
    toolCalls: asArray(metadata?.toolCallResults).length,
  }));
  writeFileSync(join(ensureDir(dir), 'nodes.jsonl'), `${lines.join('\n')}\n`);
}
```

- [ ] **Step 5: 运行，确认通过**

Run: 同 Step 2
Expected: 7 条 PASS。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/exec-detail.mjs miaodong-kit/src/exec-store.mjs miaodong-kit/test/exec-detail.test.mjs
git commit -m "feat(md): 执行详情加工（节点顺序、定位文字、和草稿比）与本地缓存"
```

---

### Task 5: 事件链（exec-chain.mjs）

**Files:**
- Create: `miaodong-kit/src/exec-chain.mjs`
- Test: `miaodong-kit/test/exec-chain.test.mjs`

**Interfaces:**
- Consumes:
  - 老懂的 `buildExecutionChain, compareEventPayload, extractEmittedEvents, toChainExec`（`badcase-normalize.ts`）；
  - `TRIGGER_LABEL, actionTexts, clip, formatCost, listExecutions, PAGE_SIZE`（Task 3）；
  - `formatTime, shortId`（`src/output.mjs`）；
  - `normalizeDetail` 的 `norm` 结构（Task 4）。
- Produces：
  - 常量：`DEFAULT_CHAIN_WINDOW_MS = 65 * 60_000`、`MAX_POOL_PAGES = 5`
  - `extractEmittedEvents`：从老懂模块原样转导出，给 Task 7 用。
  - `fetchSessionPool(identity, orgId, botId, sessionId, centerMs, windowMs) → Promise<{ rows, truncated }>`
  - `chainExecFromDetail(norm) → ChainExec`：本条不在列表里时（测试执行）用它补进池子。
  - `downstreamOf(start, pool, maxHops = 8) → hop[]`：每一跳是 `{ ...ChainExec, from, via, link: 'exact'|'ambiguous', otherCandidates, depth }`，或 `{ missing: true, from, eventId, eventName, depth }`。
  - `chainOf(targetId, rows, fallbackTarget?) → { target, upstream: hop[], targetHop, downstream: hop[] } | null`
  - `renderChain(chain, rowsById: Map<execId,row>, { windowLabel, truncated }) → string[]`

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/exec-chain.test.mjs`

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chainExecFromDetail, chainOf, fetchSessionPool, renderChain } from '../src/exec-chain.mjs';
import { normalizeDetail } from '../src/exec-detail.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { REPLY, SESSION, X, chainRows, delayDetail } from './helpers/exec-fixtures.mjs';

const byId = (rows) => new Map(rows.map((r) => [r.execId, r]));
const OPTS = { windowLabel: '±65 分钟', truncated: false };

test('chainOf：上游按载荷配对，下游跟到「发送」，载荷对不上的干扰项不接', () => {
  const rows = chainRows();
  const chain = chainOf(X(2), rows);
  assert.deepEqual(chain.upstream.map((h) => h.execId), [X(1)]);
  assert.equal(chain.targetHop.link, 'exact');
  assert.deepEqual(chain.downstream.map((h) => h.execId), [X(3)]);
  const text = renderChain(chain, byId(rows), OPTS).join('\n');
  assert.match(text, /← e0000001 .*文本「我想退款」/);
  assert.match(text, /● e0000002 .*事件「延时回复」.*← 本条/);
  assert.match(text, /→ e0000003 .*事件「发送」 → 发文本「已为您登记退款」/);
  assert.match(text, new RegExp(`整条链最终：发文本「${REPLY}」`));
  assert.doesNotMatch(text, /e0000004/);
});

test('上游不在时间窗内：标出来，不接一条错的上游', () => {
  const rows = chainRows().filter((r) => r.execId !== X(1));
  const text = renderChain(chainOf(X(2), rows), byId(rows), OPTS).join('\n');
  assert.match(text, /\? 上游不在时间窗内（事件「延时回复」/);
  assert.doesNotMatch(text, /^ {2}← /m);
});

test('下游没找到、同载荷多个候选、会话执行太多，都如实标出', () => {
  const base = chainRows();
  const noSend = base.filter((r) => r.execId !== X(3));
  assert.match(renderChain(chainOf(X(2), noSend), byId(noSend), OPTS).join('\n'), /→ 事件「发送」的执行没找到/);
  const send = base.find((r) => r.execId === X(3));
  const twins = [...base, { ...send, execId: X(8), createdAt: new Date(Date.parse(send.createdAt) + 6000).toISOString() }];
  const chain = chainOf(X(2), twins);
  assert.equal(chain.downstream[0].execId, X(3));
  const text = renderChain(chain, byId(twins), { windowLabel: '±65 分钟', truncated: true }).join('\n');
  assert.match(text, /同载荷候选还有 1 个，按时间取了最近的/);
  assert.match(text, /超过 500 条，链可能不全/);
});

test('本条不在列表里（测试执行）：用详情补进池子', () => {
  const rows = chainRows().filter((r) => r.execId !== X(2));
  const chain = chainOf(X(2), rows, chainExecFromDetail(normalizeDetail(delayDetail())));
  assert.deepEqual(chain.upstream.map((h) => h.execId), [X(1)]);
  assert.deepEqual(chain.downstream.map((h) => h.execId), [X(3)]);
});

let server;
before(async () => {
  server = await startFakeMiaodong({
    'POST /api/canvas/history/list': ({ body }) => ok(Array.from({ length: 100 }, (_, i) => ({ execId: `p${body.current}-${i}` })), { page: { total: 800 } }),
  });
});
after(() => server.close());

test('fetchSessionPool：按会话 ± 时间窗查，最多翻 5 页，超了标截断', async () => {
  const identity = { key: 'k', label: '测试区', origin: server.origin, token: 't' };
  const pool = await fetchSessionPool(identity, 'org-1', 'bot-1', SESSION, 1_000_000, 60_000);
  assert.equal(pool.rows.length, 500);
  assert.equal(pool.truncated, true);
  const first = server.requests[0].body;
  assert.deepEqual([first.sessionId, first.startTimestamp, first.endTimestamp, first.pageSize], [SESSION, 940_000, 1_060_000, 100]);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/exec-chain.test.mjs`
Expected: FAIL，报 Cannot find module `../src/exec-chain.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/exec-chain.mjs`

```js
// 事件链：一条用户消息常被拆成几条执行（消息 → 延时回复 → 发送），回复在最后那条里。
// 配对靠「上游发出的事件参数 == 下游收到的事件数据」（复算 189/189）；同会话同事件的候选很常见（32/221），必须比载荷。
// 一次「同会话 ± 时间窗」的列表查询就拿到了整条链要的数据，不用逐条查详情。

import { buildExecutionChain, compareEventPayload, extractEmittedEvents, toChainExec } from '../../apps/api/lib/miaodong/badcase-normalize.ts';
import { PAGE_SIZE, TRIGGER_LABEL, actionTexts, clip, formatCost, listExecutions } from './execs.mjs';
import { formatTime, shortId } from './output.mjs';

export { extractEmittedEvents };

export const DEFAULT_CHAIN_WINDOW_MS = 65 * 60_000;
export const MAX_POOL_PAGES = 5;

export async function fetchSessionPool(identity, orgId, botId, sessionId, centerMs, windowMs) {
  const rows = [];
  let total = null;
  for (let page = 1; page <= MAX_POOL_PAGES; page++) {
    const res = await listExecutions(identity, orgId, {
      botId, sessionId, startTimestamp: centerMs - windowMs, endTimestamp: centerMs + windowMs, current: page, pageSize: PAGE_SIZE,
    });
    if (res.total !== null) total = res.total;
    rows.push(...res.rows);
    if (res.rows.length < PAGE_SIZE) break;
  }
  return { rows, truncated: total !== null && rows.length < total };
}

export function chainExecFromDetail(norm) {
  const e = norm.exec;
  return {
    execId: e.execId,
    timestamp: Date.parse(e.createdAt ?? '') || 0,
    triggerType: e.triggerType,
    triggerText: e.triggerText,
    triggeredBy: e.event ? { eventId: e.event.eventId, eventName: '', payload: e.event.payload } : null,
    emits: extractEmittedEvents(e.outputActions),
    actionTypes: [...new Set(e.outputActions.map((a) => a?.type).filter((t) => t && t !== 'canvas-event-action'))],
  };
}

// 顺着本条发出的事件往下找：同 eventId、时间不早于本条、载荷对得上的最早一条
export function downstreamOf(start, pool, maxHops = 8) {
  const sorted = [...pool].sort((a, b) => a.timestamp - b.timestamp);
  const hops = [];
  const visited = new Set([start.execId]);
  let frontier = [{ exec: start, depth: 0 }];
  while (frontier.length) {
    const nextFrontier = [];
    for (const { exec, depth } of frontier) {
      if (depth >= maxHops) continue;
      for (const emitted of exec.emits) {
        const candidates = sorted.filter((e) => !visited.has(e.execId) && e.timestamp >= exec.timestamp && e.triggeredBy?.eventId === emitted.eventId);
        const verdicts = candidates.map((e) => ({ e, v: compareEventPayload(emitted.params, e.triggeredBy.payload) }));
        const matched = verdicts.filter((x) => x.v === 'match').map((x) => x.e);
        const undecided = verdicts.filter((x) => x.v === 'unknown').map((x) => x.e);
        const picks = matched.length ? matched : undecided;
        if (!picks.length) {
          hops.push({ missing: true, from: exec.execId, eventId: emitted.eventId, eventName: emitted.eventName, depth: depth + 1 });
          continue;
        }
        const pick = picks[0];
        visited.add(pick.execId);
        hops.push({ ...pick, from: exec.execId, via: emitted.eventName, link: matched.length === 1 ? 'exact' : 'ambiguous', otherCandidates: picks.slice(1).map((e) => e.execId), depth: depth + 1 });
        nextFrontier.push({ exec: pick, depth: depth + 1 });
      }
    }
    frontier = nextFrontier;
  }
  return hops;
}

export function chainOf(targetId, rows, fallbackTarget) {
  const pool = rows.map(toChainExec).filter(Boolean);
  if (!pool.some((e) => e.execId === targetId) && fallbackTarget) pool.push(fallbackTarget);
  const target = pool.find((e) => e.execId === targetId);
  if (!target) return null;
  // buildExecutionChain 返回正序（源头在前），最后一跳就是本条；本条上的 link 描述它和上游之间的那条边
  const up = buildExecutionChain(targetId, pool, 8);
  return { target, upstream: up.slice(0, -1), targetHop: up.at(-1), downstream: downstreamOf(target, pool, 8) };
}

export function renderChain(chain, rowsById, { windowLabel, truncated }) {
  const lines = [`事件链（同会话，${windowLabel}）：`];
  const actionsOf = (hop) => actionTexts(rowsById.get(hop.execId)?.outputActions);
  const describe = (hop) => {
    const row = rowsById.get(hop.execId);
    const acts = row ? actionsOf(hop).map((a) => a.text).join('；') : hop.actionTypes.join('、');
    const trigger = hop.triggeredBy
      ? `事件「${hop.triggeredBy.eventName || shortId(hop.triggeredBy.eventId)}」`
      : `${TRIGGER_LABEL[hop.triggerType] ?? hop.triggerType}「${clip(hop.triggerText, 30)}」`;
    const raw = row?.totalCostInCny;
    const cost = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    return `${shortId(hop.execId)} ${formatTime(hop.timestamp)} ${trigger} → ${clip(acts, 80) || '无动作'} ${formatCost(Number.isFinite(cost) ? cost : null)}`;
  };
  const note = (hop) => (hop?.link === 'ambiguous' ? `（同载荷候选还有 ${hop.otherCandidates.length} 个，按时间取了最近的）` : '');
  const source = chain.upstream[0] ?? chain.targetHop;
  if (source?.triggeredBy && source.link === 'root') {
    lines.push(`  ? 上游不在时间窗内（事件「${source.triggeredBy.eventName || shortId(source.triggeredBy.eventId)}」；可加 --chain-window 3h 再找）`);
  }
  for (const hop of chain.upstream) lines.push(`  ← ${describe(hop)}${note(hop)}`);
  lines.push(`  ● ${describe(chain.targetHop)}${note(chain.targetHop)}  ← 本条`);
  for (const hop of chain.downstream) {
    const pad = '  '.repeat(hop.depth);
    lines.push(hop.missing
      ? `  ${pad}→ 事件「${hop.eventName || shortId(hop.eventId)}」的执行没找到（可能还没跑，或超出时间窗；可加 --chain-window 3h 再找）`
      : `  ${pad}→ ${describe(hop)}${note(hop)}`);
  }
  // 整条链最终做了什么：只看发文本、组合消息、转人工
  const hops = [...chain.upstream, chain.targetHop, ...chain.downstream.filter((h) => !h.missing)];
  const finals = hops.flatMap((h) => actionsOf(h).filter((a) => a.kind === 'reply' || a.kind === 'handover').map((a) => a.text));
  lines.push(`  整条链最终：${finals.length ? clip(finals.join('；'), 300) : '没有发消息，也没有转人工'}`);
  if (truncated) lines.push('  （这个会话在时间窗内的执行超过 500 条，链可能不全）');
  return lines;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2
Expected: 5 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/exec-chain.mjs miaodong-kit/test/exec-chain.test.mjs
git commit -m "feat(md): 事件链——按载荷配对上下游，标出断链、多候选与截断"
```

---

### Task 6: `md exec` 搜索模式 + 带执行记录的假秒懂

**Files:**
- Create: `miaodong-kit/src/commands/exec.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`
- Create: `miaodong-kit/test/helpers/exec-server.mjs`
- Test: `miaodong-kit/test/exec.test.mjs`

**Interfaces:**
- Consumes：
  - Task 2 的 `timeWindow`；
  - Task 3 的 `buildSearchBody, searchExecutions, summarizeRow, formatRow, resolveAlias, TRIGGER_ALIASES, ACTION_ALIASES`；
  - Task 4 的 `saveSearch`；
  - `resolveBot, resolveVersion, targetArgs`（`src/target.mjs`）、`getCanvas, listVersions`（`src/api.mjs`）。
- Produces：
  - `COMMANDS.exec`，带 `summary` 和 `usage`。
  - `run(args)`：`args._[0]` 存在时走「看一条」（Task 7 实现），否则走「搜」。
  - 测试辅助 `startExecServer({ rows?, details?, extraDetails? })`，返回假秒懂 server，带 `origin`、`requests`、`routes`、`close`。

- [ ] **Step 1: 写假秒懂** `miaodong-kit/test/helpers/exec-server.mjs`

```js
// 带执行记录的假秒懂：列表按请求体筛选、分页、新到旧排；详情按 execId 取，没有就回 CANVAS_EXEC_NOT_FOUND。
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { EXEC_BOT, X, chainRows, delayDetail, draftCanvas } from './exec-fixtures.mjs';

export async function startExecServer({ rows = chainRows(), details = { [X(2)]: delayDetail() }, extraDetails = {} } = {}) {
  const all = { ...details, ...extraDetails };
  return startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: EXEC_BOT, name: '太极2.0 质检革新版' }] : []),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: draftCanvas(), version: 'v1.0.403', updatedAt: '2026-09-24T01:00:00.000Z' }),
    'GET /api/canvas/list-version': () => ok([{ canvasId: 'ver-402', version: 'v1.0.402', name: '402', versionType: 'online' }]),
    'POST /api/canvas/history/list': ({ body }) => {
      let list = rows.filter((r) => {
        const t = Date.parse(r.createdAt);
        return t >= body.startTimestamp && t <= body.endTimestamp;
      });
      if (body.sessionId) list = list.filter((r) => r.sessionId === body.sessionId);
      if (body.triggerType) list = list.filter((r) => r.triggerContent?.triggerType === body.triggerType);
      if (body.actionType) list = list.filter((r) => (r.outputActions ?? []).some((a) => a.type === body.actionType));
      if (body.keyword) list = list.filter((r) => JSON.stringify([r.triggerContent?.content?.text, r.outputActions]).includes(body.keyword));
      if (body.canvasId) list = list.filter((r) => body.canvasId === 'ver-402' && r.canvasVersion === 'v1.0.402');
      if (typeof body.isCanary === 'boolean') list = list.filter((r) => r.isCanary === body.isCanary);
      if (body.feedbackStatus) list = list.filter((r) => r.feedbackStatus === body.feedbackStatus);
      list = [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const from = (body.current - 1) * body.pageSize;
      return ok(list.slice(from, from + body.pageSize), { page: { current: body.current, pageSize: body.pageSize, total: list.length } });
    },
    'GET /api/canvas/history/details': ({ query }) => (all[query.execId]
      ? ok(all[query.execId])
      : { status: 201, body: { code: -1, message: 'CANVAS_EXEC_NOT_FOUND' } }),
  });
}
```

- [ ] **Step 2: 写失败的测试** `miaodong-kit/test/exec.test.mjs`

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startExecServer } from './helpers/exec-server.mjs';
import { EXEC_BOT, REPLY, X, chainRows, detailOf } from './helpers/exec-fixtures.mjs';

let server;
before(async () => {
  const testRow = { ...chainRows().find((r) => r.execId === X(3)), execId: X(9) };
  server = await startExecServer({ extraDetails: { [X(9)]: detailOf(testRow, { testRun: true }) } });
});
after(() => server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const lastList = () => server.requests.filter((q) => q.path === '/api/canvas/history/list').at(-1).body;
const count = (path) => server.requests.filter((q) => q.path === path).length;

test('md exec --bot：默认最近 24 小时、新到旧；存 JSONL，不带会话变量快照', async () => {
  const r = await md(['exec', '--bot', '太极2.0 质检革新版']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0 质检革新版 \(147bd600\)/);
  assert.match(r.stdout, /共 5 条，显示 5 条/);
  const ids = [...r.stdout.matchAll(/ (e0000\d{3})-0000-/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['e0000003', 'e0000004', 'e0000002', 'e0000006', 'e0000001']);
  const body = lastList();
  assert.ok(Math.abs(body.endTimestamp - body.startTimestamp - 86_400_000) < 5000);
  const file = r.stdout.match(/已存：(\S+\.jsonl)/)[1];
  const saved = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(saved[0].kind, 'md-exec-search');
  assert.equal(saved[0].botId, EXEC_BOT);
  assert.equal(saved.length, 6);
  assert.ok(saved.slice(1).every((row) => !('sessionMemorySnapshot' in row)));
});

test('md exec --event：请求里带事件触发类型，事件名在本地比，说清扫了多少', async () => {
  const r = await md(['exec', '--bot', '147bd600', '--event', '延时回复']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastList().triggerType, 'canvas-event-trigger');
  assert.match(r.stdout, /条件：事件「延时回复」/);
  assert.match(r.stdout, /扫了 3 条，命中 2 条（已扫完）/);
});

test('md exec：版本、触发、动作、点踩、灰度、报错、关键词都进请求体', async () => {
  const r = await md(['exec', '--bot', '147bd600', '--version', 'v1.0.402', '--trigger', 'text', '--action', 'event', '--down', '--no-canary', '--failed', '--keyword', '退款']);
  assert.equal(r.code, 0, r.stderr);
  const body = lastList();
  assert.deepEqual(
    [body.canvasId, body.triggerType, body.actionType, body.feedbackStatus, body.isCanary, body.allNodesSuccess, body.keyword],
    ['ver-402', 'receive-text-message', 'canvas-event-action', 'thumb-down', false, false, '退款'],
  );
});

test('md exec：用法错误退出码 2，并说清错在哪', async () => {
  const conflict = await md(['exec', '--bot', '147bd600', '--event', '延时回复', '--trigger', 'text']);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /--event 只能配事件触发/);
  const since = await md(['exec', '--bot', '147bd600', '--since', '3w']);
  assert.equal(since.code, 2);
  assert.match(since.stderr, /时间长度写成/);
  const bare = await md(['exec']);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /缺 --bot/);
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/exec.test.mjs`
Expected: 4 条全部 FAIL，stderr 是「未知命令：exec」。第 4 条也会失败：退出码虽然碰巧是 2，但 stderr 里没有它断言的那几句。

- [ ] **Step 4: 实现** `miaodong-kit/src/commands/exec.mjs`（本任务只实现「搜」，`viewExec` 先占位抛用法错误，Task 7 替换）

```js
// md exec：查执行记录。不给执行 id 是「搜」，给了是「看一条」。
// 看一条时自动串事件链：一条用户消息常被拆成几条执行，回复在后面那条里（会话里两天各重新发现过一次）。

import { intArg, strArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { getCanvas, listVersions } from '../api.mjs';
import { resolveBot, resolveVersion, targetArgs } from '../target.mjs';
import { note, out, targetLine } from '../output.mjs';
import { timeWindow } from '../timewin.mjs';
import { ACTION_ALIASES, TRIGGER_ALIASES, buildSearchBody, formatRow, resolveAlias, searchExecutions, summarizeRow } from '../execs.mjs';
import { saveSearch } from '../exec-store.mjs';

const SHOW_LIMIT = 50;

function describeFilters(f) {
  return [
    f.keyword && `关键词「${f.keyword}」`, f.session && `会话 ${f.session}`, f.down && '点踩', f.up && '点赞',
    f.event && `事件「${f.event}」`, f.trigger && `触发 ${f.trigger}`, f.action && `动作 ${f.action}`, f.version && `版本 ${f.version}`,
    f.canary === true && '只看灰度', f.canary === false && '不看灰度', f.failed && '有节点报错',
  ].filter(Boolean).join('、');
}

async function searchExecs(args) {
  const target = await resolveBot(targetArgs(args));
  const { identity, orgId, botId } = target;
  const window = timeWindow(args);
  const limit = intArg(args, 'limit', 20, 1000);
  const scanPages = intArg(args, 'scan', 5, 50);
  const version = strArg(args, 'version');
  let versionCanvasId;
  if (version) {
    const draft = await getCanvas(identity, orgId, botId);
    versionCanvasId = resolveVersion(await listVersions(identity, orgId, draft.canvasId), version).canvasId;
  }
  const filters = {
    keyword: strArg(args, 'keyword'),
    session: strArg(args, 'session'),
    down: args.down === true,
    up: args.up === true,
    event: strArg(args, 'event'),
    trigger: resolveAlias(TRIGGER_ALIASES, strArg(args, 'trigger'), 'trigger'),
    action: resolveAlias(ACTION_ALIASES, strArg(args, 'action'), 'action'),
    version,
    canary: typeof args.canary === 'boolean' ? args.canary : undefined,
    failed: args.failed === true,
  };
  const body = buildSearchBody({ botId, start: window.start, end: window.end, versionCanvasId, ...filters });
  const res = await searchExecutions(identity, orgId, body, {
    eventName: filters.event,
    limit,
    scanPages,
    onPage: ({ page, scanned, matched }) => {
      if (filters.event) note(`（第 ${page} 页：已扫 ${scanned} 条，命中 ${matched} 条）`);
    },
  });
  const cond = describeFilters(filters);
  out(targetLine(target));
  out(`时间 ${window.label}${cond ? ` · 条件：${cond}` : ''}`);
  if (filters.event) {
    const more = res.exhausted ? '（已扫完）' : `（没扫完：加 --scan ${Math.min(scanPages * 2, 50)} 接着扫，或缩小时间窗）`;
    out(`窗口内共 ${res.total ?? '?'} 条事件执行；扫了 ${res.scanned} 条，命中 ${res.matches.length} 条${more}`);
    if (!res.matches.length && res.namesSeen.size) {
      out(`扫到的事件名：${[...res.namesSeen].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => `${name}(${n})`).join('、')}`);
    }
  } else {
    out(`共 ${res.total ?? '?'} 条，显示 ${Math.min(res.matches.length, SHOW_LIMIT)} 条${res.total !== null && res.total > res.matches.length ? '（--limit 调整）' : ''}`);
  }
  if (!res.matches.length && filters.keyword) out('（关键词按词匹配用户消息和回复：换成完整的词或更短的词试试；找事件用 --event）');
  for (const row of res.matches.slice(0, SHOW_LIMIT)) out(formatRow(summarizeRow(row)));
  if (res.matches.length > SHOW_LIMIT) out(`（只显示前 ${SHOW_LIMIT} 条，全部 ${res.matches.length} 条在下面的文件里）`);
  const file = saveSearch(target, {
    regionLabel: target.regionLabel, identityKey: target.identityKey, orgId, orgName: target.orgName, botId, botName: target.botName,
    window: { start: window.start, end: window.end }, filters, total: res.total, scanned: res.scanned,
  }, res.matches, strArg(args, 'save'));
  out(`已存：${file}（JSONL，第一行是查询条件）`);
  if (res.matches.length) out('看一条：md exec <执行id>');
  return EXIT.OK;
}

async function viewExec() {
  throw usage('看单条执行还没实现');
}

export const exec = {
  summary: '查执行记录：按条件搜，或看一条的节点轨迹、回复和事件链',
  usage: [
    'md exec --bot <智能体> [--since 24h | --from <时间> --to <时间>] [--keyword 词] [--session <会话id>]',
    '        [--down|--up] [--event <事件名>] [--trigger text|image|audio|event|tag|friend|…]',
    '        [--action send|combo|handover|event|update|tag|…] [--version vX] [--canary|--no-canary] [--failed]',
    '        [--limit 20] [--scan 5] [--save <文件>]                          搜执行记录',
    'md exec <执行id> [--bot <智能体>] [--chain-window 65m]                    看一条：节点顺序、本条动作、事件链',
    'md exec <执行id> --node <节点|#序号>                                      这个节点当时的输入、prompt、推理、输出',
    'md exec <执行id> --find "<文字>"                                          这段文字最早是哪个节点产生的',
    'md exec <执行id> --vs-draft                                               执行时的版本和现在的草稿比，跑过的节点改了哪些',
  ].join('\n'),
  async run(args) {
    return args._[0] ? viewExec(args) : searchExecs(args);
  },
};
```

在 `miaodong-kit/src/commands/index.mjs` 里登记：

```js
import { exec } from './exec.mjs';
// ……
export const COMMANDS = { auth, orgs, bots, versions, pull, node, trace, refs, apply, diff, check, push, rebase, restore, status, log, exec };
```

- [ ] **Step 5: 运行，确认通过**

Run: 同 Step 3
Expected: 4 条 PASS。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/commands/exec.mjs miaodong-kit/src/commands/index.mjs miaodong-kit/test/helpers/exec-server.mjs miaodong-kit/test/exec.test.mjs
git commit -m "feat(md): md exec 按条件搜执行记录"
```

---

### Task 7: `md exec <执行id>` 看一条（定位、缓存、事件链、节点顺序）

**Files:**
- Modify: `miaodong-kit/src/commands/exec.mjs`
- Test: `miaodong-kit/test/exec.test.mjs`（追加）

**Interfaces:**
- Consumes：
  - Task 3 的 `getExecDetail, actionTexts, clip, formatCost`；
  - Task 4 的 `normalizeDetail, nodeLine, NODE_LINE_LIMIT, execDir, loadCachedDetail, saveDetail, findCachedExec, saveNodes`；
  - Task 5 的 `fetchSessionPool, chainOf, chainExecFromDetail, renderChain, DEFAULT_CHAIN_WINDOW_MS, extractEmittedEvents`；
  - `loadBotDirectory`（`src/target.mjs`）、`loadIdentities, requireIdentities`（`src/identity.mjs`）、`parseDuration`（Task 2）。
- Produces：
  - `viewExec(args)` 完整实现；
  - `locateExec(args, execId) → { target, dir, detail, fresh? }`；
  - 以及 `showNode / showFind / showDrift / showExec` 的分派位置。Task 8 会把前三个换成真实实现。

- [ ] **Step 1: 写失败的测试**（追加到 `miaodong-kit/test/exec.test.mjs`）

```js
test('md exec <id>：不给 --bot 也能找到；事件链、节点按执行顺序、详情缓存', async () => {
  const h = home();
  const r = await md(['exec', X(2)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0 质检革新版 \(147bd600\) \/ v1\.0\.402/);
  assert.match(r.stdout, /事件「延时回复」 · success · 节点 4 个/);
  assert.match(r.stdout, /← e0000001/);
  assert.match(r.stdout, /→ e0000003 .*发文本「已为您登记退款」/);
  assert.match(r.stdout, new RegExp(`整条链最终：发文本「${REPLY}」`));
  assert.doesNotMatch(r.stdout, /e0000004/);
  const order = [...r.stdout.matchAll(/^\s+\d+ ✅ (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['延时回复入口', '回答生成', '规则中心', '触发发送']);
  const detailFile = r.stdout.match(/详情：(\S+detail\.json)/)[1];
  const saved = JSON.parse(readFileSync(detailFile, 'utf-8'));
  assert.equal(saved.canvasExec.rawCanvas, undefined);
  assert.ok(Array.isArray(saved.canvas.rawCanvas));
  const fetched = count('/api/canvas/history/details');
  assert.equal((await md(['exec', X(2)], h)).code, 0);
  assert.equal(count('/api/canvas/history/details'), fetched, '第二次应当读缓存，不再请求详情');
});

test('md exec <id> --bot 走指定智能体；找不到退出码 4；id 不完整退出码 2', async () => {
  assert.equal((await md(['exec', X(2), '--bot', '147bd600'])).code, 0);
  const missing = await md(['exec', X(5)]);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /找不到执行/);
  assert.equal((await md(['exec', 'e0000002'])).code, 2);
});

test('测试执行：说明没有事件链，不去查列表', async () => {
  const lists = count('/api/canvas/history/list');
  const r = await md(['exec', X(9)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /测试执行/);
  assert.match(r.stdout, /不在执行列表里，没有事件链/);
  assert.equal(count('/api/canvas/history/list'), lists);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/exec.test.mjs`
Expected: 新加的 3 条 FAIL（「看单条执行还没实现」，退出码 2），前 4 条 PASS。

- [ ] **Step 3: 实现**

在 `miaodong-kit/src/commands/exec.mjs` 顶部把 import 换成：

```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { intArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { getCanvas, listVersions } from '../api.mjs';
import { loadIdentities, requireIdentities } from '../identity.mjs';
import { loadBotDirectory, resolveBot, resolveVersion, targetArgs } from '../target.mjs';
import { formatTime, note, out, shortId, targetLine } from '../output.mjs';
import { parseDuration, timeWindow } from '../timewin.mjs';
import { ACTION_ALIASES, TRIGGER_ALIASES, actionTexts, buildSearchBody, clip, formatCost, formatRow, getExecDetail, resolveAlias, searchExecutions, summarizeRow } from '../execs.mjs';
import { execDir, findCachedExec, loadCachedDetail, saveDetail, saveNodes, saveSearch } from '../exec-store.mjs';
import { NODE_LINE_LIMIT, nodeLine, normalizeDetail } from '../exec-detail.mjs';
import { DEFAULT_CHAIN_WINDOW_MS, chainExecFromDetail, chainOf, extractEmittedEvents, fetchSessionPool, renderChain } from '../exec-chain.mjs';
```

把占位的 `viewExec` 换成下面这些：

```js
const EXEC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 找到这条执行属于哪个区 / 企业 / 智能体。查详情不需要 botId（09-24 核对），所以没给 --bot 时逐个企业试
async function locateExec(args, execId) {
  if (strArg(args, 'bot')) {
    const target = await resolveBot(targetArgs(args));
    const dir = execDir(target, execId);
    const cached = loadCachedDetail(dir);
    if (cached) return { target, dir, detail: cached };
    const detail = await getExecDetail(target.identity, target.orgId, execId, target.botId);
    if (!detail) {
      throw new MdError('exec_not_found', `${target.botName} 下找不到执行 ${execId}`, { exitCode: EXIT.TARGET, hint: '去掉 --bot，md 会在所有已取身份的企业里找' });
    }
    const owner = String(detail.canvasExec.botId ?? '');
    if (owner && owner !== target.botId) {
      throw new MdError('exec_other_bot', `执行 ${execId} 属于另一个智能体（${shortId(owner)}）`, { exitCode: EXIT.TARGET, hint: '去掉 --bot，md 会自己找到它属于哪个智能体' });
    }
    return { target, dir, detail: saveDetail(dir, target, detail), fresh: true };
  }
  const cached = findCachedExec(execId);
  if (cached) {
    const identity = loadIdentities()[cached.target.identityKey];
    if (!identity) {
      throw new MdError('no_identity', `这条执行属于「${cached.target.regionLabel}」，本机没有这个区的身份`, { exitCode: EXIT.AUTH, hint: '先取这个区的身份：md auth snippet <域名>' });
    }
    return { target: { ...cached.target, identity }, dir: cached.dir, detail: cached.detail };
  }
  for (const identity of requireIdentities()) {
    for (const org of identity.orgs) {
      let detail;
      try {
        detail = await getExecDetail(identity, org.id, execId);
      } catch (error) {
        if (error instanceof MdError && error.code === 'auth_expired') throw error;
        note(`（跳过 ${identity.label} / ${org.name}：${error.message}）`);
        continue;
      }
      if (!detail) continue;
      const botId = String(detail.canvasExec.botId ?? '');
      const entry = (await loadBotDirectory()).find((e) => e.botId === botId);
      const target = entry
        ? { ...entry, identity: loadIdentities()[entry.identityKey] ?? identity }
        : { identityKey: identity.key, regionLabel: identity.label, orgId: org.id, orgName: org.name, botId, botName: `智能体 ${shortId(botId)}`, identity };
      const dir = execDir(target, execId);
      return { target, dir, detail: saveDetail(dir, target, detail), fresh: true };
    }
  }
  throw new MdError('exec_not_found', `在已取身份的企业里都找不到执行 ${execId}`, { exitCode: EXIT.TARGET, hint: '执行 id 抄全了吗？如果是别的区的执行，先取那个区的身份' });
}

async function showExec(args, target, norm, dir) {
  const e = norm.exec;
  let chainLines;
  let eventName = '';
  if (e.testRun) {
    chainLines = ['事件链：测试 / 试跑执行不在执行列表里，没有事件链'];
  } else if (!e.event && !extractEmittedEvents(e.outputActions).length) {
    chainLines = ['事件链：无（这条没有收发事件）'];
  } else {
    const windowMs = args['chain-window'] !== undefined ? parseDuration(strArg(args, 'chain-window')) : DEFAULT_CHAIN_WINDOW_MS;
    const center = Date.parse(e.createdAt ?? '') || Date.now();
    const pool = await fetchSessionPool(target.identity, target.orgId, target.botId, e.sessionId, center, windowMs);
    const rowsById = new Map(pool.rows.map((r) => [r.execId, r]));
    if (!rowsById.has(e.execId)) rowsById.set(e.execId, { outputActions: e.outputActions, totalCostInCny: e.cost });
    const chain = chainOf(e.execId, pool.rows, chainExecFromDetail(norm));
    eventName = chain?.target?.triggeredBy?.eventName ?? '';
    chainLines = chain
      ? renderChain(chain, rowsById, { windowLabel: `执行时间前后 ${Math.round(windowMs / 60_000)} 分钟`, truncated: pool.truncated })
      : ['事件链：取不到'];
  }
  const trigger = e.event ? `事件「${eventName || shortId(e.event.eventId)}」` : e.triggerType || '-';
  out(targetLine(target));
  out(`执行 ${e.execId} · ${formatTime(e.createdAt)} · ${trigger} · ${e.status} · 节点 ${norm.nodes.length} 个 · ${(e.ms / 1000).toFixed(1)}s · ${formatCost(e.cost)}${e.testRun ? ' · 测试执行' : ''}`);
  out(`触发：${clip(e.triggerText, 200) || '-'}`);
  out(`本条动作：${clip(actionTexts(e.outputActions).map((a) => a.text).join('；'), 300) || '无'}`);
  for (const line of chainLines) out(line);
  out('节点（按执行顺序）：');
  for (const n of norm.nodes.slice(0, NODE_LINE_LIMIT)) out(nodeLine(n));
  if (norm.nodes.length > NODE_LINE_LIMIT) out(`  …另有 ${norm.nodes.length - NODE_LINE_LIMIT} 个节点，见 ${join(dir, 'nodes.jsonl')}`);
  out(`详情：${join(dir, 'detail.json')} · 节点：${join(dir, 'nodes.jsonl')}`);
  out(`下一步：md exec ${e.execId} --node <节点|#序号>；--find "<文字>"；--vs-draft`);
  return EXIT.OK;
}

// Task 8 替换这三个
async function showNode() {
  throw usage('--node 还没实现');
}
async function showFind() {
  throw usage('--find 还没实现');
}
async function showDrift() {
  throw usage('--vs-draft 还没实现');
}

async function viewExec(args) {
  const execId = String(args._[0]).trim();
  if (!EXEC_ID.test(execId)) throw usage(`执行 id 要写完整的 36 位，收到「${execId}」`);
  const { target, dir, detail, fresh } = await locateExec(args, execId);
  const norm = normalizeDetail(detail);
  if (fresh || !existsSync(join(dir, 'nodes.jsonl'))) saveNodes(dir, norm.nodes);
  const shown = { ...target, versionLabel: `${norm.version || '版本未知'}${norm.exec.isCanary ? '（灰度）' : ''}` };
  if (args.node !== undefined) return showNode(args, shown, norm, dir);
  if (args.find !== undefined) return showFind(args, shown, norm);
  if (args['vs-draft']) return showDrift(shown, norm);
  return showExec(args, shown, norm, dir);
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2
Expected: 7 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/commands/exec.mjs miaodong-kit/test/exec.test.mjs
git commit -m "feat(md): md exec <执行id> 看一条：自动找归属、缓存、事件链、节点顺序"
```

---

### Task 8: `--node / --find / --vs-draft`

**Files:**
- Modify: `miaodong-kit/src/commands/exec.mjs`
- Test: `miaodong-kit/test/exec.test.mjs`（追加）

**Interfaces:**
- Consumes：Task 4 的 `findExecNode, promptText, renderNodeDetail, locateText, verdictLine, driftAgainst`；`getCanvas`（`src/api.mjs`）。
- Produces：`showNode / showFind / showDrift` 的真实实现。

- [ ] **Step 1: 写失败的测试**（追加到 `miaodong-kit/test/exec.test.mjs`）

```js
test('md exec <id> --node：输入、prompt 全文文件、工具调用', async () => {
  const r = await md(['exec', X(2), '--node', '回答生成']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /节点 #2 回答生成 \[llm-completion · doubao-seed-2\.0-lite\]/);
  assert.match(r.stdout, /质检规则: 旧规则/);
  const promptFile = r.stdout.match(/→ (\S+\.prompt\.txt)/)[1];
  assert.match(readFileSync(promptFile, 'utf-8'), /## system\n你是客服。固定话术：欢迎来到兴趣岛/);
  assert.match(r.stdout, /工具：query_kb「退款政策」 → 返回 2 条/);
});

test('md exec <id> --find：逐节点标出现位置并给结论', async () => {
  const hard = await md(['exec', X(2), '--find', '欢迎来到兴趣岛']);
  assert.match(hard.stdout, /结论：写死在 #2「回答生成」/);
  const gen = await md(['exec', X(2), '--find', REPLY]);
  assert.match(gen.stdout, /结论：最早由 #2「回答生成」/);
  assert.match(gen.stdout, /#3 规则中心 \[00000003\] 配置· 输入✓ prompt· 输出·/);
});

test('md exec <id> --vs-draft：跑过的节点在草稿里改了哪些、删了哪些', async () => {
  const r = await md(['exec', X(2), '--vs-draft']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /执行时 v1\.0\.402 → 现在的草稿/);
  assert.match(r.stdout, /1 个改过、1 个在草稿里已删除/);
  assert.match(r.stdout, /~ #2 回答生成 \[00000002\]：data\.nodePayload\.systemPrompt/);
  assert.match(r.stdout, /- #3 规则中心 \[00000003\]/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/exec.test.mjs`
Expected: 新加的 3 条 FAIL（「… 还没实现」），前 7 条 PASS。

- [ ] **Step 3: 实现**

在 `miaodong-kit/src/commands/exec.mjs` 顶部加 import：

```js
import { writeFileSync } from 'node:fs';
import { driftAgainst, findExecNode, locateText, promptText, renderNodeDetail, verdictLine } from '../exec-detail.mjs';
```

把 Task 7 里占位的 `showNode / showFind / showDrift` 换成：

```js
function showNode(args, target, norm, dir) {
  const n = findExecNode(norm, strArg(args, 'node'));
  const base = join(dir, `node-${String(n.order).padStart(3, '0')}-${shortId(n.id)}`);
  writeFileSync(`${base}.json`, JSON.stringify(n, null, 2));
  const prompt = promptText(n.metadata);
  if (prompt) writeFileSync(`${base}.prompt.txt`, prompt);
  out(targetLine(target));
  out(`执行 ${norm.exec.execId}`);
  for (const line of renderNodeDetail(n, { nodeFile: `${base}.json`, promptFile: prompt ? `${base}.prompt.txt` : '（无）' })) out(line);
  return EXIT.OK;
}

function showFind(args, target, norm) {
  const needle = strArg(args, 'find');
  const { rows, verdict } = locateText(norm, needle);
  out(targetLine(target));
  out(`执行 ${norm.exec.execId} · 找「${clip(needle, 40)}」：${rows.length} 个节点碰到`);
  const mark = (hit) => (hit ? '✓' : '·');
  for (const r of rows) out(`  #${r.node.order} ${r.node.name} [${shortId(r.node.id)}] 配置${mark(r.inConfig)} 输入${mark(r.inInput)} prompt${mark(r.inPrompt)} 输出${mark(r.inOutput)}`);
  out(verdictLine(verdict));
  return EXIT.OK;
}

async function showDrift(target, norm) {
  const draft = await getCanvas(target.identity, target.orgId, target.botId);
  const { changed, removed } = driftAgainst(norm, draft.rawCanvas);
  out(targetLine(target));
  out(`执行时 ${norm.version || '版本未知'} → 现在的草稿（最后保存 ${formatTime(draft.updatedAt)}）`);
  out(`这次执行跑过的 ${norm.nodes.length} 个节点里：${changed.length} 个改过、${removed.length} 个在草稿里已删除`);
  for (const c of changed.slice(0, 50)) {
    out(`  ~ #${c.node.order} ${c.node.name} [${shortId(c.node.id)}]：${c.paths.slice(0, 5).join('、')}${c.paths.length > 5 ? ` 等 ${c.paths.length} 处` : ''}`);
  }
  if (changed.length > 50) out(`  …另有 ${changed.length - 50} 个改过的节点`);
  for (const n of removed) out(`  - #${n.order} ${n.name} [${shortId(n.id)}]`);
  if (!changed.length && !removed.length) out('  这次跑过的节点在草稿里都没改过。');
  return EXIT.OK;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2
Expected: 10 条 PASS。

- [ ] **Step 5: 跑全部测试，确认没有破坏别的**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run check:md > /tmp/md-check.log 2>&1; tail -15 /tmp/md-check.log`
Expected: `# fail 0`。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/commands/exec.mjs miaodong-kit/test/exec.test.mjs
git commit -m "feat(md): md exec --node / --find / --vs-draft"
```

---

### Task 9: 打包产物也能查执行记录

**Files:**
- Test: `miaodong-kit/test/bundle.test.mjs`（追加）

**Interfaces:**
- Consumes：`startExecServer`（Task 6）、`seedIdentity`（`test/helpers/seed.mjs`）、`X`（`exec-fixtures.mjs`）。

- [ ] **Step 1: 写测试**（在 `miaodong-kit/test/bundle.test.mjs` 顶部补 import，末尾追加 test）

```js
import { seedIdentity } from './helpers/seed.mjs';
import { startExecServer } from './helpers/exec-server.mjs';
import { X } from './helpers/exec-fixtures.mjs';
```

```js
test('产物能查执行记录（把老懂的执行记录纯函数一起打进去，且不带数据库依赖）', async () => {
  const server = await startExecServer();
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const r = await runCli(['exec', X(2)], { home, bundle });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /整条链最终：发文本/);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: 运行（Node 22 源码产物 + Node 18 跑产物）**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" MD_E2E_NODE="$HOME/.nvm/versions/node/v18.20.8/bin/node" node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/bundle.test.mjs`
Expected: 5 条 PASS，其中「产物里没有老懂数据库依赖」「产物不带源码注释和源码路径」依旧通过。

这一步测试预期直接通过：功能在前几个任务已经实现，这里只验证打包。如果失败，按 superpowers:systematic-debugging 查原因，不许改测试凑绿。

- [ ] **Step 3: 提交**

```bash
git add miaodong-kit/test/bundle.test.mjs
git commit -m "test(md): 打包产物跑 md exec（Node 18）"
```

---

### Task 10: skill 与仓库文档

**Files:**
- Modify: `miaodong-kit/skill/SKILL.md`
- Create: `miaodong-kit/skill/references/exec.md`
- Modify: `miaodong-kit/skill/README.md`
- Modify: `CLAUDE.md`、`AGENTS.md`（md 小节）

**Interfaces:** 无代码接口。验收：`npm run md:build` 之后 `md exec --help` 的输出和这里写的用法一致；各文档里不再出现「md 不查执行记录」一类过时说法。

- [ ] **Step 1: 改 `miaodong-kit/skill/SKILL.md`**

1. frontmatter 的 `description` 整行换成：

```
description: 用 md 命令读写句子秒懂（JZ Insight，控制台域名形如 *-insight.juzibot.com）上智能体 / bot 的画布和执行记录：按区取身份、按名字找智能体和版本、拉草稿或历史版本、看节点 / 上下游 / 引用、用改动脚本批量改 prompt 或模型、自检、合并推送到草稿、回滚、查推送记录；查调优中心的执行记录（badcase、执行 id）：按条件搜、看节点轨迹和事件链、找出某句话是哪个节点产生的。任务涉及秒懂某个智能体（bot、机器人、workflow、话术、版本号如 v1.0.400、执行 id、badcase、推到秒懂）时使用；只提到 prompt、节点、画布、回滚而没有秒懂上下文时不要用。测试中心的用例导入与回归暂时仍由 miaodong-test-case-import 负责。
```

2. 在 `## 修 bot 的标准流程` 之前插入新的一节：

```markdown
## 查 badcase（执行记录）

1. 用户给了执行 id：`md exec <执行id>`，不用 `--bot`，md 会自己找到它属于哪个智能体。
2. 没给 id：`md exec --bot <智能体> [--since 24h] [--keyword 词] [--down] [--event 延时回复] [--action send] …` 搜，再挑一条看。
3. 看输出里的「事件链」：一条用户消息常被拆成几条执行，回复在后面那条里；以「整条链最终」为准。
4. `md exec <id> --find "那句话"` 看它最早是哪个节点产生的；`md exec <id> --node <节点或 #序号>` 看这个节点当时的输入、prompt、推理和输出。
5. `md exec <id> --vs-draft`：拿执行时的版本和现在的草稿比，看跑过的节点哪些已经改过，判断是不是已经修过。
6. 要改就走下面的标准流程。单节点试跑 md 还不支持，要在秒懂页面上做。
```

3. `## 领域常识` 整节（从标题到 `## 退出码` 之前）换成：

```markdown
## 领域常识

- 一条用户消息常被拆成几条执行：消息 →「延时回复」→「发送」。真正发出去的回复在最后那条，转人工也常在另一条事件执行里。`md exec <执行id>` 会顺着事件自动串起来。
- `--keyword` 按词匹配用户消息和回复，截一半的词可能搜不到；按事件找用 `--event`。
- 测试中心和单节点试跑产生的执行不在执行列表里，但 `md exec <执行id>` 能按 id 查看。
- 推送后要刷新编辑页；没刷新的旧标签页会自动保存，把推送覆盖掉。

单节点试跑、测试中心 md 还不支持，要在秒懂页面上操作。注意：
- 单节点试跑跑的是**草稿**；测试中心跑哪一版由任务决定，可以是草稿，也可以是某个版本。
- 测试中心里「发送」会执行并记成动作，用户经验是不会真的发到客户手里；插件和 HTTP 调用是真的。
- 跨智能体导入的用例，断言来自源智能体，通过率没有意义，要看实际回答。
- regression-test 要求回归集至少 50 条，而且不能指定测试集。
```

- [ ] **Step 2: 新建 `miaodong-kit/skill/references/exec.md`**

````markdown
# 执行记录（md exec）

## 搜

- 默认看最近 24 小时。也可以用 `--since 30m|6h|24h|7d`，或 `--from "2026-09-23 10:00" --to "…"`（中间有空格要加引号）。7 天窗口光首页就要 20 秒左右，能缩小就缩小。
- 秒懂直接筛的条件：`--keyword --session --down/--up --trigger --action --version --canary/--no-canary --failed`。
- `--keyword` 按词匹配用户消息和回复：整句、开头几个字都能搜到；从中间截出的半个词可能搜不到；事件名和事件载荷搜不到。
- `--event <事件名>` 要把结果拉回本地比：每页 100 条，最多扫 `--scan` 页（默认 5）。输出会说扫了多少条、有没有扫完。
- 命中的行另存成 JSONL，第一行是查询条件，路径在输出最后，可以用 jq 进一步筛。

## 看一条

- 第一行：区 / 企业 / 智能体 / 执行时的版本（灰度会标出）。
- 事件链：查同一会话、执行时间前后 65 分钟内的执行（`--chain-window` 可放宽），按事件 id 和载荷配对。
  - `←` 是上游，`●` 是本条，`→` 是下游。「整条链最终」= 链上所有的发文本、组合消息和转人工。
  - 出现「上游不在时间窗内」或「执行没找到」：多半是延迟很长的事件，加 `--chain-window 3h` 再找。
  - 出现「同载荷候选还有 N 个」：按时间取了最近的一条，结论要打折扣。
- 节点按执行顺序排列（用快照里的连线做拓扑排序），每行带分支名、模型、花费、耗时和报错。

## --node / --find / --vs-draft

- `--node <节点|#序号|id 前缀>`：这个节点当时的输入（逐键）、实际发给模型的 prompt（全文写进文件）、推理、输出、工具调用和 token。
- `--find "<文字>"`：逐个节点标出这段文字出现在配置、输入、prompt、输出的哪里，并给结论：
  - 写死在某节点配置里：该改配置，调模型没用；
  - 最早由某节点生成；
  - 来自触发内容；
  - 从执行外面传进来。
- `--vs-draft`：拿执行时的快照和现在的草稿比，只比这次跑过的节点。

## 本地文件

`~/.miaodong/md/execs/<区>/<智能体 id 前 8 位>/<执行id>/`：

- `detail.json`：秒懂返回的详情，去掉了重复的一份画布。`canvas.rawCanvas` 就是执行当时的画布。
- `nodes.jsonl`：按执行顺序的节点，一行一个。字段有 `order, id, name, type, status, ms, branch, model, cost, error, inputs, output, actions, reasoning, tokenUsage, promptChars`。
- `node-<序号>-<id8>.json`、`.prompt.txt`：`--node` 写出的完整内容。

例：`jq -r 'select(.cost != null) | "\(.order) \(.name) \(.cost)"' nodes.jsonl`
````

- [ ] **Step 3: 改 `miaodong-kit/skill/README.md`**

1. 功能列表里，在「- 按名字找智能体和版本」下面加一行：

```
- 查执行记录：按条件搜 badcase，看节点轨迹和事件链，找出某句话是哪个节点产生的
```

2. 把 `有 badcase 时，把那段对话贴给 AI；md 目前不查执行记录。` 换成：

```
有 badcase 时，把执行 id 发给 AI（在秒懂调优中心复制），它会自己查。
```

- [ ] **Step 4: 改 `CLAUDE.md` 和 `AGENTS.md` 的 md 小节**（两个文件做同样的修改）

1. 把 `设计见\n[docs/superpowers/specs/2026-09-23-miaodong-cli-design.md](docs/superpowers/specs/2026-09-23-miaodong-cli-design.md)。` 换成：

```
设计见
[docs/superpowers/specs/2026-09-23-miaodong-cli-design.md](docs/superpowers/specs/2026-09-23-miaodong-cli-design.md)（第 1 步）与
[docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md](docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md)（第 2 步：执行记录、试跑、测试中心）。
```

2. 把 `4. 旧的 \`npm run md:*\`（kit bin）保留到第 2 步 \`md exec\` 落地，新工作优先用 md。` 换成：

```
4. 查执行记录用 `md exec`（已替代 `md:badcase`）；旧的 `npm run md:*`（kit bin）等第 2 步全部完成后下线，新工作优先用 md。
```

- [ ] **Step 5: 核对**

Run: `grep -n "不查执行记录\|不负责测试中心用例导入与执行记录查询" miaodong-kit/skill/SKILL.md miaodong-kit/skill/README.md; grep -c "2026-09-24-miaodong-cli-step2-design" CLAUDE.md AGENTS.md`
Expected: 第一个 grep 没有输出；第二个 grep 两个文件各输出 `1`。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/skill/SKILL.md miaodong-kit/skill/references/exec.md miaodong-kit/skill/README.md CLAUDE.md AGENTS.md
git commit -m "docs(md): skill 与仓库文档加上 md exec（查执行记录）"
```

---

### Task 11: 全量验证、安装、真机只读核对、发布

**Files:** 无新增。只有核对中发现问题时才改代码，并且先写复现测试。

- [ ] **Step 1: 全量离线测试（源码 Node 22 + 产物 Node 18）**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" MD_E2E_NODE="$HOME/.nvm/versions/node/v18.20.8/bin/node" npm run check:md > /tmp/md-check.log 2>&1; tail -15 /tmp/md-check.log`
Expected: `# fail 0`。

- [ ] **Step 2: 安装**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run md:install && ~/.local/bin/md --version && ~/.local/bin/md exec --help | head -3`
Expected: 版本号是当前 HEAD 的短哈希加日期；help 第一行以 `md exec --bot <智能体>` 开头。

- [ ] **Step 3: 真机只读核对**（兴趣岛，「太极2.0 质检革新版」147bd600；只调读接口，不花钱）

依次运行，逐条对照期望。输出里的用户对话只用来核对，不要贴进给用户的总结：

```bash
~/.local/bin/md exec --bot 147bd600 --since 1h --limit 5
~/.local/bin/md exec --bot 147bd600 --since 3h --event 延时回复 --action send --limit 3
~/.local/bin/md exec <上一条命令输出里的一个执行id>
~/.local/bin/md exec <同一个 id> --node 回答生成
~/.local/bin/md exec <同一个 id> --find "<这条执行回复里连续的 6 个字>"
~/.local/bin/md exec <同一个 id> --vs-draft
```

Expected：
- 前两条：目标行正确，有命中行，打印了 JSONL 路径；第二条写明扫了多少条、有没有扫完；每条命令 30 秒内返回。
- 第三条：事件链里有 `←`（用户消息那条）和 `→`（「发送」那条），「整条链最终」是一句发文本；节点顺序从事件入口开始；有花费。
- `--node`：有输入、Prompt 长度和文件；`--find`：结论指向回答生成类节点，或指向触发内容；`--vs-draft`：能跑完。重点看改过的字段里有没有 `view`、`ports` 这类纯噪声。
- 如果 `--vs-draft` 把大量没改过的节点也报成改过：先写一条复现测试（造一个只有噪声字段不同的快照 / 草稿对），再按 superpowers:systematic-debugging 修 `driftAgainst`，比如把确认是噪声的字段加进忽略列表。修完重跑 Step 1。

- [ ] **Step 4: 发布到 magic-skills/miaodong**（spec §10 已约定每一步都发布）

```bash
rm -rf /private/tmp/claude-501/-Users-hukui-Desktop/4071539a-e7c2-476b-8faa-0db65b849d07/scratchpad/miaodong-repo
git clone https://github.com/magic-skills/miaodong.git /private/tmp/claude-501/-Users-hukui-Desktop/4071539a-e7c2-476b-8faa-0db65b849d07/scratchpad/miaodong-repo
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run md:publish -- /private/tmp/claude-501/-Users-hukui-Desktop/4071539a-e7c2-476b-8faa-0db65b849d07/scratchpad/miaodong-repo
git -C /private/tmp/claude-501/-Users-hukui-Desktop/4071539a-e7c2-476b-8faa-0db65b849d07/scratchpad/miaodong-repo status --short
git -C /private/tmp/claude-501/-Users-hukui-Desktop/4071539a-e7c2-476b-8faa-0db65b849d07/scratchpad/miaodong-repo diff --stat
```

Expected：变更只涉及 `SKILL.md`、`README.md`、`references/exec.md`（新增）和 `scripts/md.mjs`。确认没有意外文件后提交并推送：

```bash
git -C /private/tmp/claude-501/-Users-hukui-Desktop/4071539a-e7c2-476b-8faa-0db65b849d07/scratchpad/miaodong-repo add -A
git -C /private/tmp/claude-501/-Users-hukui-Desktop/4071539a-e7c2-476b-8faa-0db65b849d07/scratchpad/miaodong-repo commit -m "feat: md exec 查执行记录（搜、看一条、事件链、--node/--find/--vs-draft）"
git -C /private/tmp/claude-501/-Users-hukui-Desktop/4071539a-e7c2-476b-8faa-0db65b849d07/scratchpad/miaodong-repo push
```

提交信息末尾要带当前会话规定的 Co-Authored-By 行。

- [ ] **Step 5: 更新记忆**

在 `/Users/hukui/.claude/projects/-Users-hukui-Desktop-workspace-Agentflow/memory/miaodong-cli-plan.md` 的第 2 步条目下补一行：2a 完成的日期、提交区间、发布的提交号，以及真机核对的结论（包括 `--vs-draft` 有没有噪声）。
