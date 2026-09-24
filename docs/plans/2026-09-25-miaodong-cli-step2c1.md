# 秒懂 CLI 第 2c-1 步：测试中心回归闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 md 加上 `md test`：
- 看测试集、用例、场景树；
- 从执行记录导入用例，跨智能体时自动按名字换 id；
- 跑回归：跑前检查、确认码、盯着跑时止损；
- 看进度；
- 出报告：jsonl / csv / xlsx，多个任务按用例对齐；
- 暂停任务、删测试集。

**Architecture:**
- 接口层 `src/testcenter.mjs`：只管请求和翻页。
- 纯逻辑：
  - `src/testcases.mjs`：汇总、换 id、跑前检查；
  - `src/testresults.mjs`：逐条整理、对齐、csv；
  - `src/xlsx.mjs`：最小 xlsx 写入器。
- 公共部分 `src/test-common.mjs`：目标智能体、测试集解析、本机文件。
- 子命令放在 `src/commands/test-*.mjs`，由 `src/commands/test.mjs` 分发。
- 花钱沿用 2b 的确认码、账本和文件锁。

**Tech Stack:** 产物跑在 Node 18+ ESM，源码测试用 Node 22；测试框架 node:test，esbuild 打成单文件；不新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md`，重点 §2.3、§6、§7。§6.3 的外部用例和 §6.4 的批量改放在 2c-2。

## Global Constraints

- 所有命令都在 worktree 根目录 `/Users/hukui/Desktop/workspace/Agentflow/.worktrees/miaodong-cli` 下运行。不要 `cd` 出去：会话的工作目录会被重置到主仓库。
- 测试一律用 Node 22 的绝对路径（这台机器默认的 node 是 18）：
  - 单个文件：`$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/<文件>.test.mjs`
  - 全部：`PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm run check:md`
  - 产物要在 Node 18 上跑：前面加 `MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node`
- 只能 import 老懂里不依赖数据库的纯模块；打包测试会检查产物里没有 `better-sqlite3|drizzle-orm`。
- 测试中心的每个请求，query 都带 `orgId` 和 `botId`（spec §2.3）。路径前缀是 `/api/test-center/`。
- 写操作（建集、导入、改用例、删用例、删集、建任务、暂停）只作用在 `--bot` 指定的那个智能体上，输出第一行是目标行。
- 花钱只有 `md test run`，它走 2b 的确认码闸门（spec §7）：
  - 估不出花费时**一律**要确认；
  - 会真调插件时要确认；
  - 超门槛时要确认；
  - 判断和记一笔在 `withSpendLock` 里做，开跑前先记预留。
- `md test drop` 走计划码：默认预演，`--confirm <计划码>` 才删；删之前先备份到本机。
- 测试里绝不连真实秒懂；假秒懂用 `test/helpers/testcenter-server.mjs`。
- 输出约定：stdout 放结果，stderr 放过程；第一行是目标行；长内容截断，全文写文件。
- 本机数据只写 `$MD_HOME/tests/<区>/<智能体 id 前 8 位>/…`、`spend.jsonl`。
- 中文注释、中文文案、英文标识符；不打印 token。
- 实测事实以 spec §2.3（09-25 核对 6 与只读探查）为准：
  - 未审核的用例照样会跑；
  - 空跑时 `triggerExists` 仍是 true，只能靠 `canvasExecAvailable=false` 认出；
  - 逐条花费跑完那一条才有；
  - 建任务必填 `testSetId / canvasId / name / testRound`。

## Review Focus

1. **静默空跑**：跨智能体没换 id、事件在要跑的画布上没入口、会话变量不存在的用例，秒懂会显示「成功」，但其实什么都没执行。
   - `md test run` 的跑前检查必须拦下这些用例（退出码 5）；
   - `md test results` 必须把 `canvasExecAvailable=false` 的条目标成「空跑」；
   - 只给了执行 id、没说源智能体时，`md test import` 必须撤回这次导进来的用例。
2. **撤回只能删这次新增的**：`--into` 导进已有测试集时，撤回按导入前后的差集删，不能碰集里原来的用例（哪怕名字相同，比如重复导了同一条执行）。
3. **测试的花费**：
   - 估不出一律要确认码；
   - `status --wait` 按已完成条目的平均花费推算整个任务，超过额度就暂停；
   - 跑完只记一次实际花费；
   - 建任务结果不明（5xx / 超时）时保留预留，并提示不要重跑。
4. **删测试集**：计划码绑定预演时的用例；先备份，再按「先删用例、后删测试集」的顺序删，最后回读确认。
5. **翻页**：测试集、用例、逐条结果超过一页时要读全（以 `page.total` 为准）；`--deep` 只对拿不到回复的条目取详情。

---

### Task 1: 测试中心接口层 + 假秒懂

**Files:**
- Create: `miaodong-kit/src/testcenter.mjs`
- Create: `miaodong-kit/test/helpers/testcenter-fixtures.mjs`
- Create: `miaodong-kit/test/helpers/testcenter-server.mjs`
- Test: `miaodong-kit/test/testcenter.test.mjs`（新建）

**Interfaces:**
- Consumes：`request`（`src/http.mjs`，4xx/5xx 抛 `MdError('upstream', …, { status })`）、`asArray`（`src/api.mjs`）、`MdError`；测试辅助 `ok, startFakeMiaodong`（`test/helpers/fake-miaodong.mjs`）、`U, edge, node`（`test/helpers/fixtures.mjs`）、`EXEC_BOT, X`（`test/helpers/exec-fixtures.mjs`）。
- Produces（`t` 是 `resolveBot` 的结果：`{ identity, orgId, botId, … }`）：
  - `listTestSets(t) → rows`、`listCases(t, testSetId) → rows`、`taskItems(t, testTaskId) → rows`：都翻到底。
  - `recentTasks(t, { testSetId?, limit=50 }) → rows`：新的在前。
  - `taskDetail(t, testTaskId) → detail | null`
  - `scenarioTree(t) → { tree, unclassified } | null`：404 时返回 null。
  - `createTestSet(t, name) → testSetId`、`deleteTestSet(t, testSetId)`
  - `importExecs(t, testSetId, execIds) → { imported, failed, skippedNodeTypes }`：每批 20 条。
  - `WRITABLE_FIELDS`、`updateCase(t, testCase)`：只传可写字段，值为 null / undefined 的不传。
  - `deleteCases(t, ids)`：每批 100 条。
  - `createTask(t, { testSetId, canvasId, name, rounds, concurrency }) → testTaskId`、`pauseTask(t, testTaskId)`
  - 测试辅助：
    - `testcenter-fixtures.mjs`：`TARGET_BOT, SOURCE_BOT, SAME_EXEC, CROSS_EXEC, LOST_EXEC, botEvents, botVars, targetCanvas(), pluginCanvas(), importable, execSearchLines()`
    - `testcenter-server.mjs`：`startTestCenterServer({ itemCost, perPoll, tree }) → { server, state }`。state 里有 `sets / cases / tasks / items / posts / log / canvas / perPoll / itemCost / tree`。

- [ ] **Step 1: 写测试数据** `miaodong-kit/test/helpers/testcenter-fixtures.mjs`

```js
// 测试中心的测试数据：目标智能体（测试专用版）和源智能体（质检革新版）各一套事件和会话变量；
// 三条执行导入后会变成什么样的用例：同一个 bot 的、跨 bot 能换 id 的、跨 bot 有事件换不了的（形状照 spec §2.3 实测）。
import { U, edge, node } from './fixtures.mjs';
import { EXEC_BOT, X } from './exec-fixtures.mjs';

export const TARGET_BOT = '179cd443-0000-4000-8000-000000000000';
export const SOURCE_BOT = EXEC_BOT;
export const SAME_EXEC = X(11);
export const CROSS_EXEC = X(12);
export const LOST_EXEC = X(13);

export const botEvents = {
  [TARGET_BOT]: [{ eventId: 'tev-delay', name: '延时回复' }, { eventId: 'tev-send', name: '发送4.0' }],
  [SOURCE_BOT]: [{ eventId: 'sev-delay', name: '延时回复' }, { eventId: 'sev-send', name: '发送4.0' }, { eventId: 'sev-only', name: '只在源里有' }],
};
export const botVars = {
  [TARGET_BOT]: [{ id: 'tv-hist', name: '消息历史', isDefault: true }, { id: 'tv-flag', name: '已发优惠', isDefault: false }],
  [SOURCE_BOT]: [{ id: 'sv-hist', name: '消息历史', isDefault: true }, { id: 'sv-flag', name: '已发优惠', isDefault: false }],
};

// 目标智能体的草稿：延时回复的事件入口 → 回答生成（大模型）→ 发送
export function targetCanvas() {
  return [
    { ...node(21, { name: '延时回复入口', type: 'canvas-event-trigger', category: 'trigger', payload: { eventId: 'tev-delay' } }), shape: 'tev-delay' },
    node(22, { name: '回答生成', payload: { modelType: 'doubao-seed-2.0-lite', inputs: [{ name: 'text' }] } }),
    node(24, { name: '发送', type: 'send-text-message', category: 'action' }),
    edge(121, 21, 22), edge(122, 22, 24),
  ];
}

// 同上，再挂一个会真调外部系统的插件计算节点
export function pluginCanvas() {
  return [...targetCanvas(), node(23, { name: '查用户详情', type: 'plugin-calculation' }), edge(123, 22, 23)];
}

function importedCase(execId, { eventId, sendEventId, hist, flag, text }) {
  const update = { type: 'update-data', operations: [{ fieldId: flag, updateOperation: 'set', value: true }] };
  const send = { type: 'canvas-event-action', eventId: sendEventId, params: { text: { verifyType: 'similarity', value: '已为您登记', threshold: 0.75 } } };
  const both = ({ type, ...payload }) => ({ verifyPayload: { type, ...payload }, actionContent: { type, payload } });
  return {
    name: `调优中心导入(${execId})`,
    dimension: null,
    dimensionDetail: '',
    scenarioNodeId: null,
    triggerType: 'canvas-event-trigger',
    triggerInputs: { eventId, executionId: execId, data: { text } },
    sessionMemoryCustomData: { [hist]: [{ role: 'user', content: text }], [flag]: true },
    pluginMockOutputs: [],
    sqlDbMockOutputs: [],
    testNodeOutputAssertions: [],
    canvasActionOutputAssertions: [both(update), both(send)],
    status: 'ready',
    isReviewed: false,
    isStrictVerify: false,
  };
}

// test-case/import 会把这些执行变成什么用例；不在这里的执行 id 算导入失败
export const importable = {
  [SAME_EXEC]: importedCase(SAME_EXEC, { eventId: 'tev-delay', sendEventId: 'tev-send', hist: 'tv-hist', flag: 'tv-flag', text: '我想退款' }),
  [CROSS_EXEC]: importedCase(CROSS_EXEC, { eventId: 'sev-delay', sendEventId: 'sev-send', hist: 'sv-hist', flag: 'sv-flag', text: '课程怎么退' }),
  [LOST_EXEC]: importedCase(LOST_EXEC, { eventId: 'sev-only', sendEventId: 'sev-send', hist: 'sv-hist', flag: 'sv-flag', text: '只在源里有的事件' }),
};

// md exec 保存的搜索文件：第一行是查询条件（带源智能体），后面每行一条执行
export function execSearchLines({ botId = SOURCE_BOT, botName = '太极2.0 质检革新版', identityKey = 'k1', ids = [CROSS_EXEC] } = {}) {
  const header = { kind: 'md-exec-search', regionLabel: '测试区', identityKey, orgId: 'org-1', orgName: '兴趣岛平台', botId, botName };
  const rows = ids.map((execId, i) => ({
    execId,
    createdAt: `2026-09-24T0${i}:00:00.000Z`,
    status: 'success',
    totalCostInCny: 0.04,
    triggerContent: { triggerType: 'canvas-event-trigger', content: { eventName: '延时回复', data: { text: importable[execId]?.triggerInputs.data.text ?? '' } } },
    outputActions: [{ type: 'canvas-event-action', payload: { eventName: '发送4.0', params: { text: `线上回复 ${i + 1}` } } }],
  }));
  return `${[header, ...rows].map((r) => JSON.stringify(r)).join('\n')}\n`;
}
```

- [ ] **Step 2: 写假秒懂** `miaodong-kit/test/helpers/testcenter-server.mjs`

```js
// 带测试中心的假秒懂。测试里可以直接读改 state：
//   sets / cases / tasks / items —— 服务端数据；posts —— 每个写接口收到的请求体；log —— 写接口的先后顺序
//   canvas —— canvas/get 返回的画布（默认 targetCanvas()）；itemCost —— 每条跑完的花费
//   perPoll —— 每查一次 detail 跑完几条（默认全部）；tree —— null 表示老一代（scenario/tree 返回 404）
// 事件在目标智能体里不存在的用例会「空跑」：status success、passed false、没有执行、花费为空（spec §2.3 核对 6）
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { SOURCE_BOT, TARGET_BOT, botEvents, botVars, importable, targetCanvas } from './testcenter-fixtures.mjs';

const id = (prefix, n) => `${prefix}${String(n).padStart(8 - prefix.length, '0')}-0000-4000-8000-000000000000`;
const page = (rows, query) => {
  const size = Number(query.pageSize) || 20;
  const current = Number(query.current) || 1;
  return ok(rows.slice((current - 1) * size, current * size), { page: { current, pageSize: size, total: rows.length } });
};
const bad = (message) => ({ status: 400, body: { statusCode: 400, message, error: 'Bad Request' } });
const WRITABLE = ['name', 'dimension', 'triggerType', 'triggerInputs', 'sessionMemoryCustomData', 'pluginMockOutputs', 'sqlDbMockOutputs', 'testNodeOutputAssertions', 'canvasActionOutputAssertions', 'isStrictVerify'];

export async function startTestCenterServer({ itemCost = 0.02, perPoll = Infinity, tree = [] } = {}) {
  const state = { sets: [], cases: [], tasks: [], items: new Map(), posts: {}, log: [], canvas: null, itemCost, perPoll, tree, n: 0 };
  const record = (key, body) => {
    (state.posts[key] ??= []).push(body);
    state.log.push(key);
  };

  function finishItem(task, item) {
    const c = state.cases.find((x) => x.testCaseId === item.testCaseId);
    const known = new Set((botEvents[task.botId] ?? []).map((e) => e.eventId));
    const noop = c?.triggerType === 'canvas-event-trigger' && !known.has(c.triggerInputs?.eventId);
    Object.assign(item, noop
      ? { status: 'success', passed: false, costInCny: null, processDuration: null, canvasExecAvailable: false, executedActions: [], canvasActionOutputAssertionResult: [] }
      : {
        status: 'success',
        passed: true,
        costInCny: state.itemCost,
        processDuration: 1200,
        canvasExecAvailable: true,
        canvasExecId: id('d', ++state.n),
        executedActions: [{ type: 'send-text-message', nodeId: 'n-send', nodeName: '发送', summary: `回复：${c?.triggerInputs?.data?.text ?? ''}` }],
        canvasActionOutputAssertionResult: [{ type: 'send-text-message', passed: true, assertionDetailedInfo: '发送 - 文本', expectedValue: '已为您登记', actualValue: '已为您登记退款' }],
      });
  }

  // 查一次 detail 往前走一步：排队的任务前面没有在跑的了就开始跑；跑完 perPoll 条；全跑完就 finished，
  // 给出总花费和平均花费（平均按跑过的条数，含空跑的）
  function advance(task) {
    if (task.status === 'pending' && !state.tasks.some((x) => x.botId === task.botId && x.status === 'processing')) task.status = 'processing';
    if (task.status !== 'processing') return;
    const items = state.items.get(task.testTaskId);
    const pending = items.filter((i) => i.status !== 'success');
    for (const item of pending.slice(0, state.perPoll)) finishItem(task, item);
    const done = items.filter((i) => i.status === 'success');
    task.processedTestCaseCount = done.length;
    task.passedTestCaseCount = done.filter((i) => i.passed).length;
    if (done.length === items.length) {
      const total = done.reduce((sum, i) => sum + (i.costInCny ?? 0), 0);
      Object.assign(task, { status: 'finished', totalCostInCny: total, averageCostInCny: items.length ? total / items.length : null, taskDuration: 45000 });
    }
  }

  const server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: TARGET_BOT, name: '【测试测试测试】太极2.0 测试专用版' }, { id: SOURCE_BOT, name: '太极2.0 质检革新版' }] : []),
    'GET /api/canvas/get': ({ query }) => ok({ canvasId: query.canvasId || `main-${String(query.botId).slice(0, 4)}`, rawCanvas: state.canvas ?? targetCanvas(), version: 'v1.0.216', updatedAt: '2026-09-23T10:22:45.361Z' }),
    'GET /api/canvas/list-version': () => ok([{ canvasId: 'ver-215', version: 'v1.0.215', name: '215', versionType: 'normal', createdAt: '2026-09-22T00:00:00.000Z' }]),
    'GET /api/canvas/event/list': ({ query }) => ok(botEvents[query.botId] ?? []),
    'GET /api/session-memory/list': ({ query }) => ok(botVars[query.botId] ?? []),
    'GET /api/canvas/history/details': ({ query }) => (String(query.execId).startsWith('d')
      ? ok({ canvasExec: { execId: query.execId, botId: query.botId, status: 'success', outputActions: [{ type: 'canvas-event-action', payload: { eventName: '发送4.0', params: { text: '详情里的回复' } } }] }, canvas: { rawCanvas: [] }, nodeResults: [] })
      : { status: 201, body: { code: -1, message: 'CANVAS_EXEC_NOT_FOUND' } }),

    'GET /api/test-center/test-set/list': ({ query }) => page(state.sets.filter((s) => s.botId === query.botId).map((s) => ({ ...s, testCaseCount: state.cases.filter((c) => c.testSetId === s.testSetId).length })), query),
    'POST /api/test-center/test-set/create': ({ body }) => {
      record('setCreate', body);
      const set = { testSetId: id('5', ++state.n), name: body.name, botId: body.botId, testNodes: [], createdAt: '2026-09-25T01:00:00.000Z', updatedAt: '2026-09-25T01:00:00.000Z' };
      state.sets.push(set);
      return ok({ ...set, testCaseCount: 0 });
    },
    'POST /api/test-center/test-set/delete': ({ body }) => {
      record('setDelete', body);
      state.sets = state.sets.filter((s) => s.testSetId !== body.testSetId);
      return ok(null);
    },
    'GET /api/test-center/test-case/list': ({ query }) => page(state.cases.filter((c) => c.testSetId === query.testSetId), query),
    'POST /api/test-center/test-case/import': ({ body }) => {
      record('import', body);
      if (!Array.isArray(body.canvasExecIds) || !body.canvasExecIds.length || typeof body.includeSessionMemory !== 'boolean') {
        return bad('canvasExecIds must contain at least 1 elements；includeSessionMemory must be a boolean value');
      }
      let imported = 0;
      let failed = 0;
      for (const execId of body.canvasExecIds) {
        const template = importable[execId];
        if (!template) {
          failed++;
          continue;
        }
        state.cases.push({ ...structuredClone(template), testCaseId: id('c', ++state.n), testSetId: body.testSetId });
        imported++;
      }
      return { status: 201, body: { code: 0, imported, failed, skippedNodeTypes: [] } };
    },
    'POST /api/test-center/test-case/update': ({ body }) => {
      record('update', body);
      const c = state.cases.find((x) => x.testCaseId === body.testCaseId);
      if (!c) return bad('test case not found');
      // 全量覆盖：没传的可写字段清空（spec §2.3）
      for (const key of WRITABLE) c[key] = body[key] ?? (key === 'name' ? '' : null);
      return ok(null);
    },
    'POST /api/test-center/test-case/batch-delete': ({ body }) => {
      record('batchDelete', body);
      state.cases = state.cases.filter((c) => !body.testCaseIds.includes(c.testCaseId));
      return ok(null);
    },
    'GET /api/test-center/scenario/tree': () => (state.tree === null
      ? { status: 404, body: { statusCode: 404, message: 'Cannot GET /api/test-center/scenario/tree' } }
      : ok({ tree: state.tree, unclassifiedCount: 0, classifiedCount: 0 })),

    'POST /api/test-center/test-task/create': ({ body, query }) => {
      record('taskCreate', body);
      if (typeof body.testSetId !== 'string' || typeof body.canvasId !== 'string' || typeof body.name !== 'string' || typeof body.testRound !== 'number') {
        return bad('testSetId must be a string；canvasId must be a string；name must be a string；testRound must be a number conforming to the specified constraints');
      }
      const cases = state.cases.filter((c) => c.testSetId === body.testSetId);
      const testTaskId = id('7', ++state.n);
      const busy = state.tasks.some((x) => x.botId === query.botId && x.status === 'processing');
      state.tasks.push({
        testTaskId, botId: query.botId, testSetId: body.testSetId, name: body.name, canvasId: body.canvasId,
        canvasVersion: body.canvasId.startsWith('ver-') ? 'v1.0.215' : 'v1.0.216', repeatTimes: body.testRound, concurrency: body.concurrency ?? 1,
        status: busy ? 'pending' : 'processing', totalTestCaseCount: cases.length, processedTestCaseCount: 0, passedTestCaseCount: 0,
        totalCostInCny: null, averageCostInCny: null, selectedTestCaseIds: cases.map((c) => c.testCaseId), createdAt: `2026-09-25T02:${String(state.n % 60).padStart(2, '0')}:00.000Z`,
      });
      state.items.set(testTaskId, cases.flatMap((c) => Array.from({ length: body.testRound }, () => ({
        testTaskItemId: id('9', ++state.n), testTaskId, testCaseId: c.testCaseId, testCaseName: c.name, scenarioPath: '',
        status: 'pending', passed: null, costInCny: null, processDuration: null, canvasExecId: null, canvasExecAvailable: false, triggerExists: true,
        executedActions: [], canvasActionOutputAssertionResult: [],
        triggerContent: { triggerType: c.triggerType, content: { eventName: '延时回复', data: c.triggerInputs?.data ?? {} } },
      }))));
      return { status: 201, body: { code: 0, data: { testTaskId } } };
    },
    'GET /api/test-center/test-task/list': ({ query }) => page(state.tasks.filter((x) => x.botId === query.botId && (!query.testSetId || x.testSetId === query.testSetId)).slice().reverse(), query),
    'GET /api/test-center/test-task/detail': ({ query }) => {
      const task = state.tasks.find((x) => x.testTaskId === query.testTaskId);
      if (task) advance(task);
      return ok(task ?? null);
    },
    'GET /api/test-center/test-task-item/list': ({ query }) => page(state.items.get(query.testTaskId) ?? [], query),
    'POST /api/test-center/test-task/pause': ({ body }) => {
      record('pause', body);
      const task = state.tasks.find((x) => x.testTaskId === body.testTaskId);
      if (task && task.status !== 'finished') task.status = 'paused';
      return ok(null);
    },
  });
  return { server, state };
}
```

- [ ] **Step 3: 写失败的测试** `miaodong-kit/test/testcenter.test.mjs`

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestCenterServer } from './helpers/testcenter-server.mjs';
import { CROSS_EXEC, SAME_EXEC, TARGET_BOT } from './helpers/testcenter-fixtures.mjs';
import {
  createTask, createTestSet, deleteCases, deleteTestSet, importExecs, listCases, listTestSets,
  pauseTask, recentTasks, scenarioTree, taskDetail, taskItems, updateCase,
} from '../src/testcenter.mjs';

let fake;
before(async () => { fake = await startTestCenterServer(); });
after(() => fake.server.close());
const t = () => ({ identity: { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't' }, orgId: 'org-1', botId: TARGET_BOT });
const unknownExec = (i) => `f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;

test('建集、导入（每批 20 条，计数在 data 外面）、读回、全量更新只传可写字段', async () => {
  const id = await createTestSet(t(), '回归-退款');
  const sum = await importExecs(t(), id, [SAME_EXEC, CROSS_EXEC, ...Array.from({ length: 21 }, (_, i) => unknownExec(i))]);
  assert.deepEqual(sum, { imported: 2, failed: 21, skippedNodeTypes: [] });
  assert.equal(fake.state.posts.import.length, 2);
  assert.equal(fake.state.posts.import[0].canvasExecIds.length, 20);
  assert.equal(fake.state.posts.import[0].includeSessionMemory, true);
  const cases = await listCases(t(), id);
  assert.equal(cases.length, 2);
  await updateCase(t(), { ...cases[0], name: '改过的名字' });
  const body = fake.state.posts.update[0];
  assert.equal(body.testCaseId, cases[0].testCaseId);
  assert.equal(body.name, '改过的名字');
  for (const key of ['status', 'isReviewed', 'testSetId', 'dimension']) assert.equal(key in body, false, key);
  for (const key of ['triggerInputs', 'sessionMemoryCustomData', 'canvasActionOutputAssertions', 'isStrictVerify']) assert.ok(key in body, key);
});

test('列表翻到底：超过一页（100 条）也读全', async () => {
  for (let i = 0; i < 105; i++) await createTestSet(t(), `集${i}`);
  assert.ok((await listTestSets(t())).length >= 105);
});

test('建任务（testRound 必填）、查详情往前走、逐条结果、最近的任务新的在前、暂停', async () => {
  const set = await createTestSet(t(), '跑一下');
  await importExecs(t(), set, [SAME_EXEC]);
  const task = await createTask(t(), { testSetId: set, canvasId: 'main-179c', name: '跑一下-草稿', rounds: 2, concurrency: 5 });
  assert.deepEqual(fake.state.posts.taskCreate.at(-1), { testSetId: set, canvasId: 'main-179c', name: '跑一下-草稿', testRound: 2, concurrency: 5, botId: TARGET_BOT });
  assert.equal((await taskDetail(t(), task)).status, 'finished');
  assert.equal((await taskItems(t(), task)).length, 2);
  assert.equal((await recentTasks(t(), { testSetId: set }))[0].testTaskId, task);
  await pauseTask(t(), task);
  assert.deepEqual(fake.state.posts.pause.at(-1), { testTaskId: task });
});

test('场景树：老一代 404 返回 null；删用例再删集', async () => {
  fake.state.tree = null;
  assert.equal(await scenarioTree(t()), null);
  fake.state.tree = [{ id: 'sc-1', name: '退款', ownCaseCount: 0, totalCaseCount: 0, children: [] }];
  assert.equal((await scenarioTree(t())).tree[0].name, '退款');
  const set = await createTestSet(t(), '要删的');
  await importExecs(t(), set, [SAME_EXEC]);
  await deleteCases(t(), (await listCases(t(), set)).map((c) => c.testCaseId));
  await deleteTestSet(t(), set);
  assert.equal((await listCases(t(), set)).length, 0);
  assert.ok(!(await listTestSets(t())).some((s) => s.testSetId === set));
});
```

- [ ] **Step 4: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/testcenter.test.mjs`
Expected: FAIL，报 Cannot find module `../src/testcenter.mjs`。

- [ ] **Step 5: 实现** `miaodong-kit/src/testcenter.mjs`

```js
// 测试中心接口（/api/test-center/*）。只管发请求和翻页，不做判断；字段形状见 spec §2.3（09-25 实测）。
// query 一律带 orgId、botId：测试中心按智能体隔离。t 是 resolveBot 得到的目标：{ identity, orgId, botId, … }

import { request } from './http.mjs';
import { asArray } from './api.mjs';
import { MdError } from './errors.mjs';

const TC = '/api/test-center';
const MAX_PAGES = 200;
const q = (t, extra = {}) => ({ orgId: t.orgId, botId: t.botId, ...extra });
const post = (t, path, body) => request(t.identity, `${TC}${path}`, { method: 'POST', query: q(t), body, timeoutMs: 90_000 });

// 翻到底：以 page.total 为准，没有 total 时看这一页满没满
async function paged(t, path, extra, pageSize) {
  const rows = [];
  for (let current = 1; current <= MAX_PAGES; current++) {
    const payload = await request(t.identity, `${TC}${path}`, { query: q(t, { ...extra, current, pageSize }), timeoutMs: 90_000 });
    const page = asArray(payload?.data);
    rows.push(...page);
    const total = Number(payload?.page?.total);
    if (page.length < pageSize || (Number.isFinite(total) && rows.length >= total)) break;
  }
  return rows;
}

export const listTestSets = (t) => paged(t, '/test-set/list', {}, 100);
export const listCases = (t, testSetId) => paged(t, '/test-case/list', { testSetId }, 200);
export const taskItems = (t, testTaskId) => paged(t, '/test-task-item/list', { testTaskId }, 200);

// 最近的任务，新的在前。给了 testSetId 只看这个集的（服务端筛选生效，spec §2.3）
export async function recentTasks(t, { testSetId, limit = 50 } = {}) {
  const payload = await request(t.identity, `${TC}/test-task/list`, { query: q(t, { ...(testSetId ? { testSetId } : {}), current: 1, pageSize: limit }), timeoutMs: 90_000 });
  return asArray(payload?.data).sort((a, b) => String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')));
}

export async function taskDetail(t, testTaskId) {
  const payload = await request(t.identity, `${TC}/test-task/detail`, { query: q(t, { testTaskId }), timeoutMs: 60_000 });
  return payload?.data ?? null;
}

// 老一代的区没有场景树：404 返回 null，别的错误照常抛
export async function scenarioTree(t) {
  try {
    const payload = await request(t.identity, `${TC}/scenario/tree`, { query: q(t), timeoutMs: 60_000 });
    return { tree: asArray(payload?.data?.tree), unclassified: Number(payload?.data?.unclassifiedCount) || 0 };
  } catch (error) {
    if (error instanceof MdError && error.status === 404) return null;
    throw error;
  }
}

export async function createTestSet(t, name) {
  const payload = await post(t, '/test-set/create', { botId: t.botId, name });
  const id = payload?.data?.testSetId;
  if (!id) throw new MdError('upstream', `建测试集「${name}」没有返回 testSetId`);
  return id;
}

export const deleteTestSet = (t, testSetId) => post(t, '/test-set/delete', { testSetId });

// 从执行记录导入：每批 20 条；计数在 data 外面（spec §2.3）
export async function importExecs(t, testSetId, execIds, { batch = 20 } = {}) {
  const sum = { imported: 0, failed: 0, skippedNodeTypes: [] };
  for (let i = 0; i < execIds.length; i += batch) {
    const payload = await post(t, '/test-case/import', { testSetId, canvasExecIds: execIds.slice(i, i + batch), includeSessionMemory: true });
    sum.imported += Number(payload?.imported) || 0;
    sum.failed += Number(payload?.failed) || 0;
    for (const type of asArray(payload?.skippedNodeTypes)) if (!sum.skippedNodeTypes.includes(type)) sum.skippedNodeTypes.push(type);
  }
  return sum;
}

// update 是全量覆盖：漏传的可写字段会被清空，所以可写字段要传全；只读字段不传。值是 null 的也不传（空着就是空着）
export const WRITABLE_FIELDS = ['name', 'dimension', 'triggerType', 'triggerInputs', 'sessionMemoryCustomData', 'pluginMockOutputs', 'sqlDbMockOutputs', 'testNodeOutputAssertions', 'canvasActionOutputAssertions', 'isStrictVerify'];

export function updateCase(t, testCase) {
  const body = { testCaseId: testCase.testCaseId };
  for (const key of WRITABLE_FIELDS) {
    if (testCase[key] !== undefined && testCase[key] !== null) body[key] = testCase[key];
  }
  return post(t, '/test-case/update', body);
}

export async function deleteCases(t, testCaseIds, { batch = 100 } = {}) {
  for (let i = 0; i < testCaseIds.length; i += batch) await post(t, '/test-case/batch-delete', { testCaseIds: testCaseIds.slice(i, i + batch) });
}

// 建任务：必填 testSetId、canvasId、name、testRound（spec §2.3，由空 body 的 400 校验列出）
export async function createTask(t, { testSetId, canvasId, name, rounds, concurrency }) {
  const payload = await post(t, '/test-task/create', { testSetId, canvasId, name, testRound: rounds, concurrency, botId: t.botId });
  const id = payload?.data?.testTaskId;
  if (!id) throw new MdError('upstream', '建任务没有返回 testTaskId');
  return id;
}

export const pauseTask = (t, testTaskId) => post(t, '/test-task/pause', { testTaskId });
```

- [ ] **Step 6: 运行，确认通过**

Run: 同 Step 4。
Expected: 4 条 PASS。

- [ ] **Step 7: 提交**

```bash
git add miaodong-kit/src/testcenter.mjs miaodong-kit/test/testcenter.test.mjs miaodong-kit/test/helpers/testcenter-fixtures.mjs miaodong-kit/test/helpers/testcenter-server.mjs
git commit -m "feat(md): 测试中心接口层与带测试中心的假秒懂"
```

---

### Task 2: 用例的纯逻辑——汇总、跨智能体换 id、跑前检查

**Files:**
- Create: `miaodong-kit/src/testcases.mjs`
- Test: `miaodong-kit/test/testcases.test.mjs`（新建）

**Interfaces:**
- Consumes：`asArray`（`src/api.mjs`）、`classifyTrialNode`（`src/trial.mjs`，认插件节点和挂了外部工具的大模型）；Task 1 的测试数据。
- Produces：
  - `IMPORT_NAME`；`execIdOfCase(name) → execId | null`：从「调优中心导入(<执行id>)」取执行 id。
  - `caseText(testCase) → string`：用户说了什么。
  - `summarizeCases(cases) → { total, byTrigger, unreviewed, attached }`
  - `buildIdMap({ sourceEvents, targetEvents, sourceVars, targetVars }) → { map: Map, unresolved: Map }`
  - `remapCase(testCase, { map, unresolved }) → { testCase, problems: string[] }`：不改原对象。
  - `leftoverIds(testCase, ids: Set) → string[]`
  - `idProblems(cases, { events, vars }) → [{ name, reason }]`：事件、会话变量在这个智能体里存不存在；列表是 null 时跳过那一项。
  - `preflight(cases, { canvas, events, vars }) → { errors, plugins, unreviewed }`
  - `UNKNOWN_CASE_COST = 0.3`：估不出时每条每轮按这个价预留（spec §7「参考：单条 ¥0–0.3」）。

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/testcases.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdMap, caseText, execIdOfCase, idProblems, leftoverIds, preflight, remapCase, summarizeCases } from '../src/testcases.mjs';
import { CROSS_EXEC, LOST_EXEC, SAME_EXEC, SOURCE_BOT, TARGET_BOT, botEvents, botVars, importable, pluginCanvas, targetCanvas } from './helpers/testcenter-fixtures.mjs';

const maps = () => buildIdMap({ sourceEvents: botEvents[SOURCE_BOT], targetEvents: botEvents[TARGET_BOT], sourceVars: botVars[SOURCE_BOT], targetVars: botVars[TARGET_BOT] });

test('execIdOfCase / caseText / summarizeCases', () => {
  assert.equal(execIdOfCase(`调优中心导入(${SAME_EXEC})`), SAME_EXEC);
  assert.equal(execIdOfCase('手写的用例'), null);
  assert.equal(caseText(importable[SAME_EXEC]), '我想退款');
  assert.equal(caseText({ triggerInputs: { text: '你好' } }), '你好');
  const s = summarizeCases([importable[SAME_EXEC], { ...importable[CROSS_EXEC], isReviewed: true, scenarioNodeId: 'sc-1' }, { triggerType: 'receive-text-message', isReviewed: true }]);
  assert.deepEqual(s, { total: 3, byTrigger: { 'canvas-event-trigger': 2, 'receive-text-message': 1 }, unreviewed: 1, attached: 1 });
});

test('跨智能体换 id：事件 id、会话变量的键和 fieldId、verifyPayload 与 actionContent 两份都换；换完不剩源 bot 的 id；原对象不改', () => {
  const { testCase, problems } = remapCase(importable[CROSS_EXEC], maps());
  assert.deepEqual(problems, []);
  assert.equal(testCase.triggerInputs.eventId, 'tev-delay');
  assert.deepEqual(Object.keys(testCase.sessionMemoryCustomData).sort(), ['tv-flag', 'tv-hist']);
  const [update, event] = testCase.canvasActionOutputAssertions;
  assert.equal(update.verifyPayload.operations[0].fieldId, 'tv-flag');
  assert.equal(update.actionContent.payload.operations[0].fieldId, 'tv-flag');
  assert.equal(event.verifyPayload.eventId, 'tev-send');
  assert.equal(event.actionContent.payload.eventId, 'tev-send');
  assert.deepEqual(leftoverIds(testCase, new Set(['sev-delay', 'sev-send', 'sv-hist', 'sv-flag'])), []);
  assert.equal(importable[CROSS_EXEC].triggerInputs.eventId, 'sev-delay');
});

test('名字在目标里没有、或者有重名：换不了，原因记下来', () => {
  assert.deepEqual(remapCase(importable[LOST_EXEC], maps()).problems, ['事件「只在源里有」在目标里没有']);
  const dup = buildIdMap({ sourceEvents: [{ eventId: 'a', name: '发送' }], targetEvents: [{ eventId: 'b', name: '发送' }, { eventId: 'c', name: '发送' }], sourceVars: [], targetVars: [] });
  assert.deepEqual(remapCase({ triggerInputs: { eventId: 'a' } }, dup).problems, ['事件「发送」在目标里有 2 个同名']);
});

test('idProblems：事件、会话变量在这个智能体里不存在就记下；列表取不到（null）时不查那一项', () => {
  const why = (rows, name) => rows.filter((e) => e.name === name).map((e) => e.reason).join('；');
  const rows = idProblems([importable[SAME_EXEC], importable[CROSS_EXEC]], { events: botEvents[TARGET_BOT], vars: botVars[TARGET_BOT] });
  assert.equal(why(rows, importable[SAME_EXEC].name), '');
  assert.match(why(rows, importable[CROSS_EXEC].name), /事件 sev-dela 在这个智能体里不存在/);
  assert.match(why(rows, importable[CROSS_EXEC].name), /2 个会话变量在这个智能体里不存在/);
  assert.deepEqual(idProblems([importable[CROSS_EXEC]], { events: null, vars: null }), []);
});

test('preflight：事件没入口、画布上没有这种触发器都拦下；列出会真调外部的插件；数未审核', () => {
  const why = (r, name) => r.errors.filter((e) => e.name === name).map((e) => e.reason).join('；');
  const noEntry = { ...importable[SAME_EXEC], name: '没入口', triggerInputs: { eventId: 'tev-send', data: {} } };
  const text = { name: '文本', triggerType: 'receive-text-message', isReviewed: true, sessionMemoryCustomData: {} };
  const r = preflight([importable[SAME_EXEC], importable[CROSS_EXEC], noEntry, text], { canvas: pluginCanvas(), events: botEvents[TARGET_BOT], vars: botVars[TARGET_BOT] });
  assert.equal(why(r, importable[SAME_EXEC].name), '');
  assert.match(why(r, importable[CROSS_EXEC].name), /事件 sev-dela 在这个智能体里不存在/);
  assert.match(why(r, '没入口'), /要跑的画布上没有事件 tev-send 的入口/);
  assert.match(why(r, '文本'), /要跑的画布上没有「receive-text-message」触发器/);
  assert.deepEqual(r.plugins, ['查用户详情']);
  assert.equal(r.unreviewed, 3);
  assert.deepEqual(preflight([importable[SAME_EXEC]], { canvas: targetCanvas(), events: botEvents[TARGET_BOT], vars: botVars[TARGET_BOT] }).plugins, []);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/testcases.test.mjs`
Expected: FAIL，报 Cannot find module `../src/testcases.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/testcases.mjs`

```js
// 测试用例的纯逻辑：汇总、跨智能体换 id、跑前检查。字段形状见 spec §2.3（09-25 实测）。

import { asArray } from './api.mjs';
import { classifyTrialNode } from './trial.mjs';

// 估不出花费时，每条每轮按这个价预留（spec §7：测试的参考单价 ¥0–0.3），宁可多算
export const UNKNOWN_CASE_COST = 0.3;

// 秒懂给「从执行记录导入」的用例起的名字，括号里是源执行 id
export const IMPORT_NAME = /^调优中心导入\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/i;
export const execIdOfCase = (name) => IMPORT_NAME.exec(String(name ?? ''))?.[1] ?? null;

// 这条用例里用户说了什么：文本触发取 text；事件触发取事件变量里的 text（延时回复这类事件把用户消息放在这里）
export function caseText(testCase) {
  const input = testCase?.triggerInputs ?? {};
  return String(input.text ?? input.data?.text ?? input.data?.userOriginalText ?? '');
}

export function summarizeCases(cases) {
  const byTrigger = {};
  for (const c of cases) {
    const type = c?.triggerType ?? '?';
    byTrigger[type] = (byTrigger[type] ?? 0) + 1;
  }
  return {
    total: cases.length,
    byTrigger,
    unreviewed: cases.filter((c) => c?.isReviewed === false).length,
    attached: cases.filter((c) => c?.scenarioNodeId).length,
  };
}

// 源 bot 的事件 id、会话变量 id → 目标 bot 的，一律按名字对（spec §6.2）。名字在目标里没有、或者有重名，就记下原因
export function buildIdMap({ sourceEvents, targetEvents, sourceVars, targetVars }) {
  const map = new Map();
  const unresolved = new Map();
  const pair = (source, target, idKey, kind) => {
    const byName = new Map();
    for (const row of asArray(target)) {
      const name = String(row?.name ?? '');
      byName.set(name, [...(byName.get(name) ?? []), String(row?.[idKey] ?? '')]);
    }
    for (const row of asArray(source)) {
      const id = String(row?.[idKey] ?? '');
      if (!id) continue;
      const name = String(row?.name ?? '');
      const hits = byName.get(name) ?? [];
      if (hits.length === 1) map.set(id, hits[0]);
      else unresolved.set(id, `${kind}「${name}」${hits.length ? `在目标里有 ${hits.length} 个同名` : '在目标里没有'}`);
    }
  };
  pair(sourceEvents, targetEvents, 'eventId', '事件');
  pair(sourceVars, targetVars, 'id', '会话变量');
  return { map, unresolved };
}

// 整条用例（值和键）里，凡是等于源 bot 某个 id 的字符串都换成目标的。不挑字段：
// 事件 id 在 triggerInputs.eventId 和发事件断言的 eventId 里；会话变量 id 是 sessionMemoryCustomData 的键、也是写字段断言的 fieldId。
// 断言的 verifyPayload 和 actionContent 两份自然都换到；秒懂以后在别处也用这些 id，照样换得到。
export function remapCase(testCase, { map, unresolved }) {
  const problems = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (unresolved.has(value)) problems.add(unresolved.get(value));
      return map.get(value) ?? value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        if (unresolved.has(key)) problems.add(unresolved.get(key));
        out[map.get(key) ?? key] = walk(inner);
      }
      return out;
    }
    return value;
  };
  return { testCase: walk(testCase), problems: [...problems] };
}

// 回读核对：用例（值和键）里还剩哪些给定的 id
export function leftoverIds(testCase, ids) {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (ids.has(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (ids.has(key)) found.add(key);
        walk(inner);
      }
    }
  };
  walk(testCase);
  return [...found];
}

// 事件、会话变量在这个智能体里存不存在。events / vars 取不到（null）时不查那一项
export function idProblems(cases, { events, vars }) {
  const eventIds = events ? new Set(events.map((e) => String(e?.eventId ?? ''))) : null;
  const varIds = vars ? new Set(vars.map((v) => String(v?.id ?? ''))) : null;
  const rows = [];
  for (const c of cases) {
    const name = String(c?.name ?? c?.testCaseId ?? '?');
    const eventId = String(c?.triggerInputs?.eventId ?? '');
    if (eventIds && c?.triggerType === 'canvas-event-trigger' && !eventIds.has(eventId)) rows.push({ name, reason: `事件 ${eventId.slice(0, 8)} 在这个智能体里不存在` });
    if (varIds) {
      const missing = Object.keys(c?.sessionMemoryCustomData ?? {}).filter((key) => !varIds.has(key));
      if (missing.length) rows.push({ name, reason: `${missing.length} 个会话变量在这个智能体里不存在（${missing.slice(0, 3).map((k) => k.slice(0, 8)).join('、')}）` });
    }
  }
  return rows;
}

// 跑前检查（spec §6.5）。秒懂对触发器、事件、会话变量对不上的用例不报错：照样「成功」，但什么都没执行
// （spec §2.3 核对 6），只能在这里拦。canvas 是要跑的那张画布（草稿或某个版本）
export function preflight(cases, { canvas, events, vars }) {
  const cells = asArray(canvas).filter((c) => c && typeof c === 'object' && c.data);
  const entries = new Set(cells.filter((c) => c.data.type === 'canvas-event-trigger').flatMap((c) => [String(c.shape ?? ''), String(c.data.nodePayload?.eventId ?? '')]).filter(Boolean));
  const types = new Set(cells.map((c) => String(c.data.type ?? '')));
  const errors = idProblems(cases, { events, vars });
  const eventIds = events ? new Set(events.map((e) => String(e?.eventId ?? ''))) : null;
  for (const c of cases) {
    const name = String(c?.name ?? c?.testCaseId ?? '?');
    if (c?.triggerType === 'canvas-event-trigger') {
      const eventId = String(c?.triggerInputs?.eventId ?? '');
      // 事件本身不存在的已经记过了；存在但这张画布上没有入口的，单独记
      if ((!eventIds || eventIds.has(eventId)) && !entries.has(eventId)) errors.push({ name, reason: `要跑的画布上没有事件 ${eventId.slice(0, 8)} 的入口` });
    } else if (c?.triggerType && !types.has(c.triggerType)) {
      errors.push({ name, reason: `要跑的画布上没有「${c.triggerType}」触发器` });
    }
  }
  // 会真调外部系统的：插件计算节点、挂了外部工具的大模型（同 md trial 的认法），以及插件动作节点
  const plugins = [];
  for (const cell of cells) {
    const cls = classifyTrialNode(cell);
    if (cls.kind === 'plugin') plugins.push(...cls.plugins);
    else if (cell.data.type === 'plugin-action') plugins.push(String(cell.data.name ?? cell.data.type));
  }
  return { errors, plugins: [...new Set(plugins)], unreviewed: cases.filter((c) => c?.isReviewed === false).length };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 5 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/testcases.mjs miaodong-kit/test/testcases.test.mjs
git commit -m "feat(md): 测试用例的汇总、跨智能体换 id、跑前检查"
```

---

### Task 3: 公共部分 + `md test sets / cases / tree`

**Files:**
- Create: `miaodong-kit/src/test-common.mjs`
- Create: `miaodong-kit/src/commands/test-view.mjs`
- Create: `miaodong-kit/src/commands/test.mjs`
- Modify: `miaodong-kit/src/commands/index.mjs`（登记 `test`）
- Test: `miaodong-kit/test/test-cli.test.mjs`（新建）

**Interfaces:**
- Consumes：Task 1、2 的导出；`resolveBot, targetArgs`（`src/target.mjs`）、`listEvents`（`src/api.mjs`）、`ensureDir, mdHome, readJson, writeJson`（`src/home.mjs`）、`stamp`（`src/workspace.mjs`）、`clip`（`src/execs.mjs`）、`formatTime, out, shortId, targetLine`（`src/output.mjs`）。
- Produces：
  - `test-common.mjs`：
    - `testTarget(args)`
    - `testsDir(t, ...parts) → dir`
    - `resolveTestSet(t, query, sets?) → set`
    - `readSources(t, testSetId) → { [execId]: { at, text, reply, cost } }`、`mergeSources(t, testSetId, entries) → file`
    - `readTaskRecord(t, testTaskId) → record | null`、`writeTaskRecord(t, record)`
  - `commands/test.mjs`：`test`，里面的子命令表 `SUBS`，后面的任务往里加。
  - `commands/test-view.mjs`：`sets, cases, tree`。

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/test-cli.test.mjs`

```js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startTestCenterServer } from './helpers/testcenter-server.mjs';
import { CROSS_EXEC, LOST_EXEC, SAME_EXEC, SOURCE_BOT, TARGET_BOT, execSearchLines, importable, pluginCanvas } from './helpers/testcenter-fixtures.mjs';

let fake;
before(async () => { fake = await startTestCenterServer(); });
after(() => fake.server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home(), env = {}) => runCli(args, { home: h, env });
const reset = (patch = {}) => Object.assign(fake.state, { sets: [], cases: [], tasks: [], items: new Map(), posts: {}, log: [], canvas: null, itemCost: 0.02, perPoll: Infinity, tree: [], ...patch });

// 直接往假秒懂里放一个测试集和若干导入好的用例（前缀 4 / a，和假秒懂自己生成的 id 不撞）
function seedSet(name, execIds = [SAME_EXEC]) {
  const testSetId = `4${String(fake.state.sets.length + 1).padStart(7, '0')}-0000-4000-8000-000000000000`;
  fake.state.sets.push({ testSetId, name, botId: TARGET_BOT, testNodes: [], createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' });
  for (const execId of execIds) {
    fake.state.cases.push({ ...structuredClone(importable[execId]), testCaseId: `a${String(fake.state.cases.length + 1).padStart(7, '0')}-0000-4000-8000-000000000000`, testSetId });
  }
  return testSetId;
}

test('md test sets：列测试集、说明有没有场景树；老一代说清楚', async () => {
  reset();
  seedSet('回归-退款');
  const r = await md(['test', 'sets', '--bot', '179cd443']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /测试专用版/);
  assert.match(r.stdout, /场景树：0 个节点/);
  assert.match(r.stdout, /回归-退款 \(40000001\) · 1 条/);
  reset({ tree: null });
  assert.match((await md(['test', 'sets', '--bot', '179cd443'])).stdout, /场景树：这个区没有（老一代测试中心）/);
});

test('md test cases：汇总、事件名、完整用例存本机；--out 导出 JSONL；id 前缀也能找；名字找不到退出码 4', async () => {
  reset();
  const id = seedSet('回归-退款', [SAME_EXEC, CROSS_EXEC]);
  const h = home();
  const outFile = join(h, 'cases.jsonl');
  const r = await md(['test', 'cases', '回归-退款', '--bot', '179cd443', '--out', outFile], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 条 · canvas-event-trigger 2 · 未审核 2 · 挂了场景 0/);
  assert.match(r.stdout, /事件「延时回复」 · 我想退款/);
  assert.match(r.stdout, /事件「sev-dela（这个智能体里没有）」/);
  assert.equal(readFileSync(outFile, 'utf-8').trim().split('\n').length, 2);
  assert.equal((await md(['test', 'cases', id.slice(0, 8), '--bot', '179cd443'])).code, 0);
  const miss = await md(['test', 'cases', '没有这个集', '--bot', '179cd443']);
  assert.equal(miss.code, 4);
  assert.match(miss.stderr, /没有测试集「没有这个集」/);
});

test('md test tree：场景树逐层列出；空树、老一代各自说明', async () => {
  reset({ tree: [{ id: 'sc-1', name: '退款', ownCaseCount: 2, totalCaseCount: 3, children: [{ id: 'sc-2', name: '课程退款', ownCaseCount: 1, totalCaseCount: 1, children: [] }] }] });
  const r = await md(['test', 'tree', '--bot', '179cd443']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, / {2}退款 · 本节点 2 · 含子节点 3\n {4}课程退款 · 本节点 1/);
  reset({ tree: [] });
  assert.match((await md(['test', 'tree', '--bot', '179cd443'])).stdout, /场景树是空的/);
  reset({ tree: null });
  assert.match((await md(['test', 'tree', '--bot', '179cd443'])).stdout, /这个区没有场景树/);
});

test('md test 不认识的子命令：用法错误，列出可用的', async () => {
  const r = await md(['test', 'nope', '--bot', '179cd443']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /不认识「md test nope」/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/test-cli.test.mjs`
Expected: 4 条 FAIL（「未知命令：test」）。

- [ ] **Step 3: 实现** `miaodong-kit/src/test-common.mjs`

```js
// md test 各子命令共用：目标智能体、按名字 / id 找测试集、本机文件。
// 本机文件在 $MD_HOME/tests/<区>/<智能体 id 前 8 位>/ 下：
//   sources/<测试集 id>.json   从执行记录导入时记下的来源（时间、用户消息、线上回复、花费），结果报告的「线上回复」列用它
//   tasks/<任务 id>.json       md test run 建的任务：预估、账本那一笔的 id、止损额度
//   exports/ backups/ results/  导出的用例、删测试集前的备份、结果明细

import { join } from 'node:path';
import { EXIT, MdError, usage } from './errors.mjs';
import { ensureDir, mdHome, readJson, writeJson } from './home.mjs';
import { resolveBot, targetArgs } from './target.mjs';
import { shortId } from './output.mjs';
import { listTestSets } from './testcenter.mjs';

const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');

export const testTarget = (args) => resolveBot(targetArgs(args));

export function testsDir(t, ...parts) {
  return ensureDir(join(mdHome(), 'tests', safe(t.identityKey), safe(t.botId.slice(0, 8)), ...parts));
}

// 找测试集：完整 id → id 前缀（看起来像 id 才试）→ 名字完全相同
export async function resolveTestSet(t, query, sets = null) {
  const q = String(query ?? '').trim();
  if (!q) throw usage('缺测试集：md test <子命令> <测试集名字或 id> --bot <智能体>');
  const rows = sets ?? await listTestSets(t);
  const exact = rows.filter((s) => s.testSetId === q);
  const byPrefix = exact.length ? exact : /^[0-9a-f-]{4,}$/i.test(q) ? rows.filter((s) => String(s.testSetId).startsWith(q)) : [];
  const hits = byPrefix.length ? byPrefix : rows.filter((s) => s.name === q);
  if (hits.length === 1) return hits[0];
  if (!hits.length) {
    throw new MdError('testset_not_found', `${t.botName} 下没有测试集「${q}」`, { exitCode: EXIT.TARGET, hint: `md test sets --bot ${shortId(t.botId)} 看有哪些` });
  }
  throw new MdError('testset_ambiguous', `「${q}」匹配到 ${hits.length} 个测试集：${hits.slice(0, 10).map((s) => `${s.name}(${shortId(s.testSetId)})`).join('、')}`, { exitCode: EXIT.TARGET, hint: '用 id 前缀指定' });
}

const sourcesFile = (t, testSetId) => join(testsDir(t, 'sources'), `${testSetId}.json`);
export const readSources = (t, testSetId) => readJson(sourcesFile(t, testSetId), {});
export function mergeSources(t, testSetId, entries) {
  const file = sourcesFile(t, testSetId);
  writeJson(file, { ...readJson(file, {}), ...entries });
  return file;
}

const taskFile = (t, testTaskId) => join(testsDir(t, 'tasks'), `${testTaskId}.json`);
export const readTaskRecord = (t, testTaskId) => readJson(taskFile(t, testTaskId), null);
export const writeTaskRecord = (t, record) => writeJson(taskFile(t, record.testTaskId), record);
```

- [ ] **Step 4: 实现** `miaodong-kit/src/commands/test-view.mjs`

```js
// md test sets / cases / tree：只读

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { writeJson } from '../home.mjs';
import { formatTime, out, shortId, targetLine } from '../output.mjs';
import { clip } from '../execs.mjs';
import { stamp } from '../workspace.mjs';
import { listEvents } from '../api.mjs';
import { listCases, listTestSets, scenarioTree } from '../testcenter.mjs';
import { caseText, summarizeCases } from '../testcases.mjs';
import { resolveTestSet, testTarget, testsDir } from '../test-common.mjs';

const countNodes = (nodes) => nodes.reduce((sum, n) => sum + 1 + countNodes(n?.children ?? []), 0);

export async function sets(args) {
  const t = await testTarget(args);
  const [rows, tree] = await Promise.all([listTestSets(t), scenarioTree(t)]);
  out(targetLine(t));
  out(tree === null ? '场景树：这个区没有（老一代测试中心）' : `场景树：${countNodes(tree.tree)} 个节点`);
  if (!rows.length) out('还没有测试集');
  for (const s of rows.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
    out(`  ${s.name} (${shortId(s.testSetId)}) · ${s.testCaseCount ?? '?'} 条 · 更新 ${formatTime(s.updatedAt)}`);
  }
  return EXIT.OK;
}

export async function cases(args) {
  const t = await testTarget(args);
  const set = await resolveTestSet(t, args._[0]);
  const [rows, events] = await Promise.all([listCases(t, set.testSetId), listEvents(t.identity, t.orgId, t.botId)]);
  const eventName = new Map((events ?? []).map((e) => [e.eventId, e.name]));
  const s = summarizeCases(rows);
  out(targetLine(t));
  out(`测试集「${set.name}」(${shortId(set.testSetId)})：${s.total} 条 · ${Object.entries(s.byTrigger).map(([k, v]) => `${k} ${v}`).join('、') || '无'} · 未审核 ${s.unreviewed} · 挂了场景 ${s.attached}`);
  for (const c of rows.slice(0, 30)) {
    const eventId = String(c.triggerInputs?.eventId ?? '');
    const trigger = c.triggerType === 'canvas-event-trigger' ? `事件「${eventName.get(eventId) ?? `${eventId.slice(0, 8)}（这个智能体里没有）`}」` : c.triggerType;
    out(`  ${c.name} · ${trigger} · ${clip(caseText(c), 40) || '-'}`);
  }
  if (rows.length > 30) out(`  …另有 ${rows.length - 30} 条`);
  const file = join(testsDir(t, 'exports'), `${shortId(set.testSetId)}-${stamp()}.json`);
  writeJson(file, rows);
  const outFile = strArg(args, 'out');
  if (outFile) writeFileSync(outFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  out(`完整用例：${outFile ?? file}`);
  return EXIT.OK;
}

export async function tree(args) {
  const t = await testTarget(args);
  const got = await scenarioTree(t);
  out(targetLine(t));
  if (got === null) {
    out('这个区没有场景树（老一代测试中心，只有测试集和用例）');
    return EXIT.OK;
  }
  if (!got.tree.length) {
    out(`场景树是空的（未分类用例 ${got.unclassified} 条）`);
    return EXIT.OK;
  }
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      out(`${'  '.repeat(depth + 1)}${n.name} · 本节点 ${n.ownCaseCount ?? 0} · 含子节点 ${n.totalCaseCount ?? 0}`);
      walk(n.children ?? [], depth + 1);
    }
  };
  walk(got.tree, 0);
  out(`未分类：${got.unclassified} 条`);
  return EXIT.OK;
}
```

- [ ] **Step 5: 实现** `miaodong-kit/src/commands/test.mjs`，并在 `miaodong-kit/src/commands/index.mjs` 里登记（`import { test } from './test.mjs';`，`test` 加到 `COMMANDS` 末尾）

```js
// md test：测试中心（spec §6）。子命令分在 test-*.mjs 里，这里只分发

import { usage } from '../errors.mjs';
import { cases, sets, tree } from './test-view.mjs';

const SUBS = { sets, cases, tree };

const USAGE = [
  'md test sets --bot <智能体>                             测试集列表；这个区有没有场景树',
  'md test cases <集> --bot <智能体> [--out <文件.jsonl>]    用例汇总；完整用例存本机',
  'md test tree --bot <智能体>                             场景树和各节点的用例数',
];

export const test = {
  summary: '测试中心：看测试集 / 用例 / 场景树，从执行记录导入，跑回归（超门槛要用户确认），看进度和结果，暂停，删测试集',
  usage: USAGE.join('\n'),
  async run(args) {
    const sub = args._[0];
    const handler = SUBS[sub];
    if (!handler) throw usage(sub ? `不认识「md test ${sub}」` : '缺子命令', `可用：${Object.keys(SUBS).join('、')}`);
    return handler({ ...args, _: args._.slice(1) });
  },
};
```

- [ ] **Step 6: 运行，确认通过**

Run: 同 Step 2。
Expected: 4 条 PASS。然后跑全部测试，Expected：`# fail 0`。

- [ ] **Step 7: 提交**

```bash
git add miaodong-kit/src/test-common.mjs miaodong-kit/src/commands/test-view.mjs miaodong-kit/src/commands/test.mjs miaodong-kit/src/commands/index.mjs miaodong-kit/test/test-cli.test.mjs
git commit -m "feat(md): md test sets / cases / tree"
```

---
### Task 4: `md test import`——从执行记录导入，跨智能体按名字换 id

**Files:**
- Create: `miaodong-kit/src/commands/test-import.mjs`
- Modify: `miaodong-kit/src/commands/test.mjs`（`SUBS` 加 `import`，`USAGE` 加一行）
- Test: `miaodong-kit/test/test-cli.test.mjs`（追加）

**Interfaces:**
- Consumes：
  - Task 1–3 的导出；
  - `listEvents, listSessions`（`src/api.mjs`，取不到返回 null）；
  - `EXEC_ID`（`src/exec-locate.mjs`）；
  - `actionTexts`（`src/execs.mjs`）；
  - `resolveBot`（`src/target.mjs`）；
  - 老懂的 `extractTriggerTextFromSnapshot`。
- Produces：`importCmd(args)`、`readExecSource(value) → { header, ids, rows }`。

- [ ] **Step 1: 写失败的测试**，追加到 `miaodong-kit/test/test-cli.test.mjs` 末尾

```js
test('import：同一个智能体的执行 id → 新建测试集、导入、给下一步；已有同名集要 --into', async () => {
  reset();
  const h = home();
  const r = await md(['test', 'import', '回归-退款', '--bot', '179cd443', '--from-execs', SAME_EXEC], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /新建测试集「回归-退款」/);
  assert.match(r.stdout, /导入：成功 1 · 失败 0/);
  assert.match(r.stdout, /下一步：md test run 回归-退款 --bot 179cd443/);
  assert.equal(fake.state.posts.import[0].includeSessionMemory, true);
  const again = await md(['test', 'import', '回归-退款', '--bot', '179cd443', '--from-execs', SAME_EXEC], h);
  assert.equal(again.code, 5);
  assert.match(again.stderr, /已经有测试集「回归-退款」/);
  const into = await md(['test', 'import', '回归-退款', '--bot', '179cd443', '--from-execs', SAME_EXEC, '--into'], h);
  assert.equal(into.code, 0, into.stderr);
  assert.equal(fake.state.cases.length, 2);
});

test('import：只给了 id、其实是别的智能体的执行 → 撤回这次导进来的，集里原有的（哪怕同名）不动；新建的集也删掉（审查重点 1、2）', async () => {
  reset();
  const set = seedSet('已有的集', [SAME_EXEC]);
  const before = fake.state.cases.map((c) => c.testCaseId);
  const r = await md(['test', 'import', '已有的集', '--bot', '179cd443', '--from-execs', `${SAME_EXEC},${CROSS_EXEC}`, '--into']);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /1 条用例的事件或会话变量在「【测试测试测试】太极2\.0 测试专用版」里对不上/);
  assert.match(r.stderr, /--from-bot/);
  assert.deepEqual(fake.state.cases.map((c) => c.testCaseId), before);
  assert.ok(fake.state.sets.some((s) => s.testSetId === set));
  reset();
  const fresh = await md(['test', 'import', '新集', '--bot', '179cd443', '--from-execs', CROSS_EXEC]);
  assert.equal(fresh.code, 5);
  assert.equal(fake.state.sets.length, 0);
  assert.equal(fake.state.cases.length, 0);
});

test('import：从 md exec 保存的文件导入（来源是另一个智能体）→ 按名字换 id、全量回写不清掉名字、回读不剩源 id；换不了的列出来；记下线上回复', async () => {
  reset();
  const h = home();
  const file = join(h, 'search.jsonl');
  writeFileSync(file, execSearchLines({ ids: [CROSS_EXEC, LOST_EXEC] }));
  const r = await md(['test', 'import', '跨智能体回归', '--bot', '179cd443', '--from-execs', file], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /来自「太极2\.0 质检革新版」（跨智能体/);
  assert.match(r.stdout, /换 id：更新了 2 条/);
  assert.match(r.stdout, /事件「只在源里有」在目标里没有/);
  assert.match(r.stdout, /1 条用例对不上这个智能体，md test run 的跑前检查会拦下它们/);
  const cross = fake.state.cases.find((c) => c.name.includes(CROSS_EXEC));
  assert.equal(cross.name, `调优中心导入(${CROSS_EXEC})`);
  assert.equal(cross.triggerInputs.eventId, 'tev-delay');
  assert.deepEqual(Object.keys(cross.sessionMemoryCustomData).sort(), ['tv-flag', 'tv-hist']);
  assert.equal(cross.canvasActionOutputAssertions[1].actionContent.payload.eventId, 'tev-send');
  const sourcesFile = r.stdout.match(/结果报告里对照用：(\S+)/)[1];
  assert.match(JSON.parse(readFileSync(sourcesFile, 'utf-8'))[CROSS_EXEC].reply, /线上回复 1/);
});

test('import：给了 --from-bot 的跨智能体 id 列表，也按名字换 id', async () => {
  reset();
  const r = await md(['test', 'import', '跨智能体', '--bot', '179cd443', '--from-execs', CROSS_EXEC, '--from-bot', '147bd600']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.cases[0].triggerInputs.eventId, 'tev-delay');
});

test('import：--from-bot 和文件里的来源对不上、执行 id 不完整：用法错误', async () => {
  reset();
  const h = home();
  const file = join(h, 'search.jsonl');
  writeFileSync(file, execSearchLines({ ids: [CROSS_EXEC] }));
  const conflict = await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', file, '--from-bot', '179cd443'], h);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /--from-bot 是「【测试测试测试】太极2\.0 测试专用版」，但文件里的执行来自「太极2\.0 质检革新版」/);
  const short = await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', 'e0000011']);
  assert.equal(short.code, 2);
  assert.match(short.stderr, /不是完整的执行 id：e0000011/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/test-cli.test.mjs`
Expected: 新加的 5 条 FAIL（「不认识「md test import」」），前面 4 条 PASS。

- [ ] **Step 3: 实现** `miaodong-kit/src/commands/test-import.mjs`

```js
// md test import <集> --from-execs <文件 | 执行id…> [--from-bot <源智能体>] [--into]（spec §6.2）
// 秒懂的 test-case/import 把执行记录转成用例，断言按当时的动作自动生成。md 在前后补三件事：
// - 跨智能体时按名字换 id（事件 id、会话变量 id），全量回写，再回读核对；
// - 只给了执行 id、没说来源，结果事件或会话变量对不上：多半是别的智能体的执行。把这次导进来的撤回
//   （只删这次新增的），要求补 --from-bot——不留一堆会静默空跑的用例（spec §2.3 核对 6）；
// - 从 md exec 保存的文件导入时，记下每条执行的时间、用户消息、线上回复，结果报告里对照用。

import { existsSync, readFileSync } from 'node:fs';
import { boolArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { listEvents, listSessions } from '../api.mjs';
import { EXEC_ID } from '../exec-locate.mjs';
import { actionTexts } from '../execs.mjs';
import { resolveBot } from '../target.mjs';
import { createTestSet, deleteCases, deleteTestSet, importExecs, listCases, listTestSets, updateCase } from '../testcenter.mjs';
import { buildIdMap, execIdOfCase, idProblems, leftoverIds, remapCase } from '../testcases.mjs';
import { mergeSources, resolveTestSet, testTarget } from '../test-common.mjs';
import { extractTriggerTextFromSnapshot } from '../../../apps/api/lib/miaodong/badcase-normalize.ts';

// --from-execs：md exec 保存的 JSONL（第一行是查询条件，带着源智能体），或者逗号 / 空格隔开的执行 id
export function readExecSource(value) {
  if (existsSync(value)) {
    const lines = readFileSync(value, 'utf-8').split('\n').filter((line) => line.trim());
    let header = null;
    const rows = [];
    lines.forEach((line, i) => {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw usage(`--from-execs 的第 ${i + 1} 行不是 JSON：${value}`);
      }
      if (i === 0 && row?.kind === 'md-exec-search') header = row;
      else if (typeof row?.execId === 'string' && EXEC_ID.test(row.execId)) rows.push(row);
    });
    if (!rows.length) throw usage(`${value} 里没有执行记录`, '给 md exec --bot <智能体> … 搜出来的文件，或者执行 id');
    return { header, ids: [...new Set(rows.map((r) => r.execId))], rows };
  }
  const ids = [...new Set(String(value).split(/[\s,]+/).filter(Boolean))];
  const bad = ids.filter((id) => !EXEC_ID.test(id));
  if (!ids.length || bad.length) {
    throw usage(bad.length ? `不是完整的执行 id：${bad.slice(0, 5).join('、')}` : '--from-execs 要给文件或执行 id', '执行 id 要写完整的 36 位；或者给 md exec 保存的 .jsonl 文件');
  }
  return { header: null, ids, rows: [] };
}

// 源智能体：--from-bot > 文件里记的 > 只给了 id 时先当作目标自己的。stated 表示来源是明说的
async function sourceOf(t, header, fromBot) {
  let bot = null;
  if (fromBot) {
    bot = await resolveBot({ bot: fromBot });
    if (header && header.botId !== bot.botId) throw usage(`--from-bot 是「${bot.botName}」，但文件里的执行来自「${header.botName}」`);
  } else if (header) {
    bot = header.botId === t.botId ? t : await resolveBot({ bot: header.botId });
  }
  if (!bot) return { bot: t, stated: false };
  if (bot.identityKey !== t.identityKey) {
    throw new MdError('cross_region', `执行来自「${bot.regionLabel}」，目标智能体在「${t.regionLabel}」：不能跨区导入`, { exitCode: EXIT.BLOCKED });
  }
  return { bot, stated: true };
}

// 一条执行的来源：时间、用户消息、线上回复（回复 / 转人工优先，没有就取发出的事件里的文本）、花费
function sourceEntry(row) {
  const texts = actionTexts(row.outputActions);
  const pick = (kinds) => texts.filter((a) => kinds.includes(a.kind)).map((a) => a.text).join('；');
  const cost = typeof row.totalCostInCny === 'number' ? row.totalCostInCny : Number.parseFloat(row.totalCostInCny);
  return {
    at: row.createdAt ?? null,
    text: extractTriggerTextFromSnapshot({ triggerContent: row.triggerContent, eventSnapshot: row.rawTrigger }) || String(row.triggerContent?.content?.data?.text ?? ''),
    reply: pick(['reply', 'handover']) || pick(['event']),
    cost: Number.isFinite(cost) ? cost : null,
  };
}

// 跨智能体：按名字把事件 id、会话变量 id 从源换成目标的，全量回写，再回读核对不剩源 bot 的 id（spec §6.2）
async function remapInto(t, source, testSetId, cases, { targetEvents, targetVars }) {
  const [sourceEvents, sourceVars] = await Promise.all([
    listEvents(source.identity, source.orgId, source.botId),
    listSessions(source.identity, source.orgId, source.botId),
  ]);
  if (!sourceEvents || !sourceVars || !targetEvents || !targetVars) {
    throw new MdError('remap_unavailable', '取不到事件或会话变量列表，没法跨智能体换 id', { hint: '这个区的版本可能不支持；改用目标智能体自己的执行导入' });
  }
  const maps = buildIdMap({ sourceEvents, targetEvents, sourceVars, targetVars });
  let changed = 0;
  const problems = [];
  for (const c of cases) {
    const { testCase, problems: found } = remapCase(c, maps);
    if (found.length) problems.push({ name: c.name, reason: found.join('；') });
    if (JSON.stringify(testCase) !== JSON.stringify(c)) {
      await updateCase(t, testCase);
      changed++;
    }
  }
  const mappedEvents = sourceEvents.filter((e) => maps.map.has(e.eventId)).length;
  const mappedVars = sourceVars.filter((v) => maps.map.has(v.id)).length;
  out(`换 id：更新了 ${changed} 条（按名字对上：事件 ${mappedEvents} 个、会话变量 ${mappedVars} 个）`);
  for (const p of problems.slice(0, 20)) out(`  ⚠️ ${p.name}：${p.reason}`);
  // 回读：换得了的源 id 不该还在（换不了的已经在上面列了）
  const ids = new Set(cases.map((c) => c.testCaseId));
  const readback = (await listCases(t, testSetId)).filter((c) => ids.has(c.testCaseId));
  const shouldBeGone = new Set([...maps.map.entries()].filter(([from, to]) => from !== to).map(([from]) => from));
  const left = readback.filter((c) => leftoverIds(c, shouldBeGone).length);
  if (left.length) out(`⚠️ 回读发现 ${left.length} 条还带着源智能体的 id（更新没生效？）：${left.slice(0, 5).map((c) => c.name).join('、')}`);
  return readback;
}

export async function importCmd(args) {
  const t = await testTarget(args);
  const name = String(args._[0] ?? '').trim();
  if (!name) throw usage('缺测试集：md test import <集> --bot <智能体> --from-execs <文件或执行 id>');
  const from = strArg(args, 'from-execs');
  if (!from) throw usage('缺 --from-execs：给 md exec 保存的 .jsonl，或者执行 id（逗号隔开）');
  const into = boolArg(args, 'into');
  const src = readExecSource(from);
  const source = await sourceOf(t, src.header, strArg(args, 'from-bot'));
  const cross = source.bot.botId !== t.botId;

  const existing = await listTestSets(t);
  let set;
  let created = false;
  if (into) {
    set = await resolveTestSet(t, name, existing);
  } else {
    if (existing.some((s) => s.name === name)) {
      throw new MdError('testset_exists', `${t.botName} 下已经有测试集「${name}」`, { exitCode: EXIT.BLOCKED, hint: '导进这个已有的集加 --into；否则换个名字' });
    }
    set = { testSetId: await createTestSet(t, name), name };
    created = true;
  }
  out(targetLine(t));
  out(`${created ? '新建' : '导进已有的'}测试集「${set.name}」(${shortId(set.testSetId)})；${src.ids.length} 条执行${cross ? `，来自「${source.bot.botName}」（跨智能体，导完按名字换 id）` : ''}`);

  // 按导入前后的差集认「这次导进来的」：--into 时集里可能已经有同名用例（重复导了同一条执行），不能碰
  const before = new Set((await listCases(t, set.testSetId)).map((c) => c.testCaseId));
  const sum = await importExecs(t, set.testSetId, src.ids);
  let fresh = (await listCases(t, set.testSetId)).filter((c) => !before.has(c.testCaseId));
  out(`导入：成功 ${sum.imported} · 失败 ${sum.failed}${sum.skippedNodeTypes.length ? ` · 跳过的节点类型 ${sum.skippedNodeTypes.join('、')}` : ''}`);
  const missing = src.ids.filter((id) => !fresh.some((c) => execIdOfCase(c.name) === id));
  if (missing.length) out(`⚠️ 没导进来的执行 ${missing.length} 条：${missing.slice(0, 10).map(shortId).join('、')}${missing.length > 10 ? '…' : ''}`);

  const [targetEvents, targetVars] = await Promise.all([listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId)]);
  if (cross && fresh.length) fresh = await remapInto(t, source.bot, set.testSetId, fresh, { targetEvents, targetVars });
  const bad = idProblems(fresh, { events: targetEvents, vars: targetVars });
  const badNames = [...new Set(bad.map((b) => b.name))];
  if (badNames.length && !source.stated) {
    await deleteCases(t, fresh.map((c) => c.testCaseId));
    if (created) await deleteTestSet(t, set.testSetId);
    throw new MdError('source_mismatch', `${badNames.length} 条用例的事件或会话变量在「${t.botName}」里对不上，多半是别的智能体的执行；已撤回这次导进来的 ${fresh.length} 条${created ? '，也删了新建的测试集' : ''}`, {
      exitCode: EXIT.BLOCKED,
      hint: '补 --from-bot <源智能体> 再导：md 会按名字把 id 换成这个智能体的',
    });
  }
  if (badNames.length) {
    out(`⚠️ ${badNames.length} 条用例对不上这个智能体，md test run 的跑前检查会拦下它们：`);
    for (const b of bad.slice(0, 20)) out(`  - ${b.name}：${b.reason}`);
  }
  if (src.rows.length) {
    const file = mergeSources(t, set.testSetId, Object.fromEntries(src.rows.map((r) => [r.execId, sourceEntry(r)])));
    out(`已记下 ${src.rows.length} 条来源（时间、用户消息、线上回复），结果报告里对照用：${file}`);
  }
  out(`下一步：md test run ${set.name} --bot ${shortId(t.botId)}`);
  return EXIT.OK;
}
```

- [ ] **Step 4: 在 `miaodong-kit/src/commands/test.mjs` 登记**
  - 加 `import { importCmd } from './test-import.mjs';`
  - `SUBS` 改成 `{ sets, cases, tree, import: importCmd }`
  - `USAGE` 末尾加：`'md test import <集> --bot <智能体> --from-execs <.jsonl | 执行id,…> [--from-bot <源智能体>] [--into]   从执行记录导入；跨智能体按名字换 id'`

- [ ] **Step 5: 运行，确认通过**

Run: 同 Step 2。
Expected: 9 条 PASS。然后跑全部测试，Expected：`# fail 0`。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/commands/test-import.mjs miaodong-kit/src/commands/test.mjs miaodong-kit/test/test-cli.test.mjs
git commit -m "feat(md): md test import——从执行记录导入，跨智能体按名字换 id，来源不明对不上就撤回"
```

---

### Task 5: `md test run`——跑前检查、预估、确认码、建任务

**Files:**
- Modify: `miaodong-kit/src/confirm.mjs`：把 `commands/trial.mjs` 里的 `roundCost`、`stopForConfirm` 搬过来并导出。
- Modify: `miaodong-kit/src/commands/trial.mjs`：改成从 `confirm.mjs` 导入这两个。
- Create: `miaodong-kit/src/commands/test-run.mjs`（本任务只写 `run`；`status / stop / resolveTask` 在 Task 6 加）
- Modify: `miaodong-kit/src/commands/test.mjs`（登记 `run`）
- Test: `miaodong-kit/test/confirm.test.mjs`、`miaodong-kit/test/test-cli.test.mjs`（追加）

**Interfaces:**
- Consumes：
  - Task 1–4 的导出；
  - `getCanvas, listEvents, listSessions, listVersions`（`src/api.mjs`）、`resolveVersion`（`src/target.mjs`）、`hashOf`（`src/canvas.mjs`）；
  - 2b 的 `dayKey, loadLimits, readSpends, recordSpend, spendDecision, spentOn, updateSpend, withSpendLock`（`src/spend.mjs`）、`codeFor, givenCode`（`src/confirm.mjs`）。
- Produces：
  - `confirm.mjs`：`roundCost(value)`、`stopForConfirm({ code, previous, given, reasons, remaining? })`。
  - `test-run.mjs`：`run(args)`。
  - 本机任务记录 `{ testTaskId, testSetId, testSetName, name, canvasId, label, rounds, cases, estimate, spendId, allowance, createdAt }`。

- [ ] **Step 1: 写失败的测试**，追加到 `miaodong-kit/test/confirm.test.mjs`（第一行的 import 改成 `import { codeFor, confirmCode, givenCode, roundCost, stopForConfirm } from '../src/confirm.mjs';`）

```js
test('stopForConfirm：打出原因和码后抛退出码 5；没给码、给错码、给用过的码分开报；roundCost 取到 0.0001 元', () => {
  assert.throws(() => stopForConfirm({ code: 'c1', previous: null, given: null, reasons: ['估不出花费'] }), (e) => e.code === 'confirm_needed' && e.exitCode === 5 && /估不出花费/.test(e.message) && /--confirm c1/.test(e.hint));
  assert.throws(() => stopForConfirm({ code: 'c2', previous: 'c1', given: 'c1', reasons: ['x'] }), (e) => e.code === 'confirm_used');
  assert.throws(() => stopForConfirm({ code: 'c2', previous: 'c1', given: 'zz', reasons: ['x'] }), (e) => e.code === 'confirm_mismatch');
  assert.throws(() => stopForConfirm({ code: 'c3', previous: null, given: null, reasons: ['x'], remaining: 2 }), (e) => /其余 2 次/.test(e.message) && /--times 改成 2/.test(e.hint));
  assert.equal(roundCost(0.123456), 0.1235);
  assert.equal(roundCost(null), null);
});
```

再追加到 `miaodong-kit/test/test-cli.test.mjs` 末尾：

```js
function spendRows(h) {
  const file = join(h, 'md', 'spend.jsonl');
  if (!existsSync(file)) return [];
  const byId = new Map();
  for (const line of readFileSync(file, 'utf-8').trim().split('\n')) {
    const row = JSON.parse(line);
    byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row });
  }
  return [...byId.values()];
}
// 这个集上次跑完的任务：平均每条 avg 元（md test run 按它估花费）
const seedFinished = (testSetId, avg) => fake.state.tasks.push({ testTaskId: '70000099-0000-4000-8000-000000000000', botId: TARGET_BOT, testSetId, name: '上次', status: 'finished', averageCostInCny: avg, createdAt: '2026-09-24T00:00:00.000Z' });
const codeIn = (stdout) => stdout.match(/确认码：([0-9a-f]{8})/)?.[1];

test('run：跑前检查不过（跨智能体没换 id 的用例）→ 不建任务、不记账，退出码 5（审查重点 1）', async () => {
  reset();
  seedSet('集', [SAME_EXEC, CROSS_EXEC]);
  const h = home();
  const r = await md(['test', 'run', '集', '--bot', '179cd443'], h);
  assert.equal(r.code, 5);
  assert.match(r.stdout, /❌ 跑前检查：2 处对不上/);
  assert.match(r.stderr, /跑前检查有 2 处对不上，没有建任务/);
  assert.equal(fake.state.posts.taskCreate, undefined);
  assert.deepEqual(spendRows(h), []);
});

test('run：估不出花费一律要确认；带码才建任务（testRound、草稿的 canvasId、默认任务名）；账本记预留和码；本机记下任务', async () => {
  reset();
  seedSet('集', [SAME_EXEC]);
  const h = home();
  const first = await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '2'], h);
  assert.equal(first.code, 5);
  assert.match(first.stdout, /1 条 × 2 轮 = 2 次/);
  assert.match(first.stdout, /预计 估不出（参考：单条 ¥0–0\.3）/);
  assert.match(first.stderr, /估不出花费/);
  assert.equal(fake.state.posts.taskCreate, undefined);
  const code = codeIn(first.stdout);
  const r = await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '2', '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  const body = fake.state.posts.taskCreate[0];
  assert.deepEqual([body.testRound, body.canvasId, body.concurrency], [2, 'main-179c', 5]);
  assert.match(body.name, /^集-草稿-\d{4}-\d{4}$/);
  const [row] = spendRows(h);
  assert.deepEqual([row.kind, row.approved, row.code, row.reserve, row.count], ['test', 'confirm', code, 0.6, 2]);
  const taskId = fake.state.tasks[0].testTaskId;
  assert.match(r.stdout, new RegExp(`已建任务 .*（${taskId}）`));
  const rec = JSON.parse(readFileSync(join(h, 'md', 'tests', 'k1', '179cd443', 'tasks', `${taskId}.json`), 'utf-8'));
  assert.equal(rec.spendId, row.id);
});

test('run：这个集上次跑完的任务有平均花费 → 按它估；不超门槛、不调插件就直接建任务；有别的任务在跑会说排队', async () => {
  reset();
  const set = seedSet('集', [SAME_EXEC]);
  seedFinished(set, 0.02);
  fake.state.tasks.push({ testTaskId: '70000098-0000-4000-8000-000000000000', botId: TARGET_BOT, testSetId: set, name: '别人的任务', status: 'processing', createdAt: '2026-09-24T01:00:00.000Z' });
  const r = await md(['test', 'run', '集', '--bot', '179cd443']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /预计 ¥0\.020（上次跑完的任务「上次」平均每条 ¥0\.020）/);
  assert.match(r.stdout, /排队：这个智能体上还有 1 个任务没跑完/);
  assert.equal(fake.state.posts.taskCreate.length, 1);
});

test('run：画布上有插件就要确认，哪怕很便宜；--version 跑那个版本的 canvasId', async () => {
  reset({ canvas: pluginCanvas() });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  const first = await md(['test', 'run', '集', '--bot', '179cd443', '--version', 'v1.0.215'], h);
  assert.equal(first.code, 5);
  assert.match(first.stdout, /v1\.0\.215/);
  assert.match(first.stdout, /会真实调用的外部系统：查用户详情/);
  assert.match(first.stderr, /会真的调用外部系统：查用户详情/);
  const r = await md(['test', 'run', '集', '--bot', '179cd443', '--version', 'v1.0.215', '--confirm', codeIn(first.stdout)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.posts.taskCreate[0].canvasId, 'ver-215');
});

test('run：建任务明确被拒（4xx）→ 这一笔记 0；结果不明（5xx）→ 保留预留，提示别重跑（审查重点 3）', async () => {
  reset();
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const original = fake.server.routes['POST /api/test-center/test-task/create'];
  try {
    fake.server.routes['POST /api/test-center/test-task/create'] = () => ({ status: 400, body: { statusCode: 400, message: 'bad request' } });
    const h = home();
    assert.equal((await md(['test', 'run', '集', '--bot', '179cd443'], h)).code, 1);
    assert.deepEqual([spendRows(h)[0].actual, spendRows(h)[0].runs], [0, 0]);
    fake.server.routes['POST /api/test-center/test-task/create'] = () => ({ status: 502, body: { message: 'Bad Gateway' } });
    const h2 = home();
    const unknown = await md(['test', 'run', '集', '--bot', '179cd443'], h2);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /任务可能已经建了.*不要重跑/);
    assert.deepEqual([spendRows(h2)[0].actual, spendRows(h2)[0].reserve], [null, 0.02]);
  } finally {
    fake.server.routes['POST /api/test-center/test-task/create'] = original;
  }
});
```

- [ ] **Step 2: 运行，确认失败**

Run: 分别跑 `confirm.test.mjs` 和 `test-cli.test.mjs`（命令同 Task 1 Step 4，换文件名）。
Expected：
- `confirm.test.mjs` 报 confirm.mjs 没有导出 `roundCost / stopForConfirm`；
- `test-cli.test.mjs` 里新加的 5 条 FAIL，报「不认识「md test run」」。

- [ ] **Step 3: 把 `roundCost`、`stopForConfirm` 搬进 `miaodong-kit/src/confirm.mjs`**
  - 在 `confirm.mjs` 顶部加 `import { out } from './output.mjs';`，并把 `import { usage } from './errors.mjs';` 改成 `import { EXIT, MdError, usage } from './errors.mjs';`。
  - 在文件末尾加下面的代码。这两段是 `commands/trial.mjs` 里原来的定义，逐字搬过来，只加 `export`。
  - 从 `commands/trial.mjs` 里删掉原来的两段定义，改成 `import { codeFor, givenCode, roundCost, stopForConfirm } from '../confirm.mjs';`。

```js
// 估算金额进确认码前取到 0.0001 元：同一笔操作重算出来的浮点数，不会因为最后几位不同而对不上
export const roundCost = (value) => (value === null ? null : Math.round(value * 10000) / 10000);

// 需要用户确认：把原因和确认码打出来，什么都不跑（退出码 5）。remaining 有值时是「跑到一半停下，其余几次要确认」
export function stopForConfirm({ code, previous, given, reasons, remaining = null }) {
  const what = remaining ? `其余 ${remaining} 次` : '';
  out(`⛔ 要用户确认才能跑${what}：${reasons.join('；')}`);
  out(`确认码：${code}（只对这一笔有效：次数、输入、预估任何一样变了就作废，用过一次也作废）`);
  const hint = remaining
    ? `把已跑的实际花费和其余 ${remaining} 次的预估单独告诉用户（不要夹在别的问题里）；用户明确同意后，同一条命令把 --times 改成 ${remaining}，再加 --confirm ${code}`
    : `把上面的预估和原因单独告诉用户（不要夹在别的问题里）；用户明确同意这一笔后，同一条命令加 --confirm ${code}`;
  if (given !== null && given === previous) throw new MdError('confirm_used', `确认码 ${given} 已经用过了：每个码只能用一次`, { exitCode: EXIT.BLOCKED, hint });
  if (given !== null) throw new MdError('confirm_mismatch', `确认码对不上（给的是 ${given || '空'}，当前是 ${code}）：次数、输入或预估和上次不一样了`, { exitCode: EXIT.BLOCKED, hint });
  throw new MdError('confirm_needed', `需要用户确认${what}：${reasons.join('；')}`, { exitCode: EXIT.BLOCKED, hint });
}
```

- [ ] **Step 4: 实现** `miaodong-kit/src/commands/test-run.mjs`

```js
// md test run <集>（spec §6.5）：跑前检查 → 预估 → 用户确认（§7）→ 建任务。建完不等：用 md test status --wait 盯着跑。

import { boolArg, intArg, strArg } from '../args.mjs';
import { EXIT, MdError } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { getCanvas, listEvents, listSessions, listVersions } from '../api.mjs';
import { resolveVersion } from '../target.mjs';
import { hashOf } from '../canvas.mjs';
import { dayKey, loadLimits, readSpends, recordSpend, spendDecision, spentOn, updateSpend, withSpendLock } from '../spend.mjs';
import { codeFor, givenCode, roundCost, stopForConfirm } from '../confirm.mjs';
import { createTask, listCases, recentTasks } from '../testcenter.mjs';
import { UNKNOWN_CASE_COST, preflight } from '../testcases.mjs';
import { readSources, resolveTestSet, testTarget, writeTaskRecord } from '../test-common.mjs';

const QUEUED = new Set(['pending', 'processing', 'running']);
const pad2 = (n) => String(n).padStart(2, '0');
const nowLabel = () => {
  const d = new Date();
  return `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
};

// 每条每轮的单价（spec §6.5）：这个测试集上次跑完的任务的平均花费 → 导入来源里源执行的平均花费 → 估不出
async function unitCost(t, set) {
  const last = (await recentTasks(t, { testSetId: set.testSetId, limit: 20 })).find((x) => x.status === 'finished' && typeof x.averageCostInCny === 'number');
  if (last) return { unit: last.averageCostInCny, basis: `上次跑完的任务「${last.name}」平均每条 ${formatCost(last.averageCostInCny)}` };
  const costs = Object.values(readSources(t, set.testSetId)).map((s) => s?.cost).filter((c) => typeof c === 'number');
  if (costs.length) {
    const unit = costs.reduce((a, b) => a + b, 0) / costs.length;
    return { unit, basis: `导入来源的 ${costs.length} 条执行平均 ${formatCost(unit)}` };
  }
  return { unit: null, basis: '' };
}

export async function run(args) {
  const t = await testTarget(args);
  const rounds = intArg(args, 'rounds', 1, 20);
  const concurrency = intArg(args, 'concurrency', 5, 20);
  const allowErrors = boolArg(args, 'allow-preflight-errors');
  const given = givenCode(args);
  const set = await resolveTestSet(t, args._[0]);
  const cases = await listCases(t, set.testSetId);
  if (!cases.length) throw new MdError('empty_set', `测试集「${set.name}」里没有用例`, { exitCode: EXIT.BLOCKED });

  // 跑哪张画布：默认草稿；--version 用那个版本的 canvasId（spec §6.5）。跑前检查也对着这张画布做
  const draft = await getCanvas(t.identity, t.orgId, t.botId);
  let canvasId = draft.canvasId;
  let label = '草稿';
  let canvas = draft.rawCanvas;
  const versionQuery = strArg(args, 'version');
  if (versionQuery) {
    const v = resolveVersion(await listVersions(t.identity, t.orgId, draft.canvasId), versionQuery);
    canvasId = v.canvasId;
    label = v.version;
    canvas = (await getCanvas(t.identity, t.orgId, t.botId, v.canvasId)).rawCanvas;
  }
  const [events, vars, recent] = await Promise.all([listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId), recentTasks(t, { limit: 20 })]);
  const pre = preflight(cases, { canvas, events, vars });
  const busy = recent.filter((x) => QUEUED.has(String(x.status)));
  const { unit, basis } = await unitCost(t, set);
  const runsCount = cases.length * rounds;
  const estimate = unit === null ? null : unit * runsCount;

  out(targetLine({ ...t, versionLabel: label }));
  out(`测试集「${set.name}」(${shortId(set.testSetId)})：${cases.length} 条 × ${rounds} 轮 = ${runsCount} 次 · 并发 ${concurrency}${pre.unreviewed ? ` · 未审核 ${pre.unreviewed} 条（照样会跑）` : ''}`);
  if (!events || !vars) out('⚠️ 取不到事件或会话变量列表：没法核对用例会不会空跑');
  if (pre.errors.length) {
    out(`❌ 跑前检查：${pre.errors.length} 处对不上（这些用例会「成功」但什么都没执行）：`);
    for (const e of pre.errors.slice(0, 20)) out(`  - ${e.name}：${e.reason}`);
    if (pre.errors.length > 20) out(`  …另有 ${pre.errors.length - 20} 处`);
  }
  if (pre.plugins.length) out(`⚠️ 画布上会真实调用的外部系统：${pre.plugins.join('、')}（测试中心里也会真的调）`);
  if (busy.length) out(`排队：这个智能体上还有 ${busy.length} 个任务没跑完（${busy.slice(0, 3).map((x) => `${x.name} ${x.status}`).join('、')}），新任务排在后面`);
  out(`花费：预计 ${estimate === null ? '估不出（参考：单条 ¥0–0.3）' : `${formatCost(estimate)}（${basis}）`} · 今天已花 ${formatCost(spentOn(readSpends()))} / 上限 ${formatCost(loadLimits().perDay)}`);
  if (pre.errors.length && !allowErrors) {
    throw new MdError('preflight_failed', `跑前检查有 ${pre.errors.length} 处对不上，没有建任务`, {
      exitCode: EXIT.BLOCKED,
      hint: '跨智能体的用例用 md test import … --from-bot <源智能体> 重新导（会按名字换 id）；确认要照跑加 --allow-preflight-errors',
    });
  }

  // 确认 + 记一笔（同 md trial：锁里做，先记预留）。测试估不出花费时一律要确认（spec §7）
  const name = strArg(args, 'name') ?? `${set.name}-${label}-${nowLabel()}`;
  const operation = { kind: 'test-run', botId: t.botId, testSetId: set.testSetId, canvasId, cases: hashOf(cases.map((c) => c.testCaseId).sort()), rounds, estimate: roundCost(estimate), external: pre.plugins, day: dayKey() };
  const plan = await withSpendLock(() => {
    const rows = readSpends();
    const limits = loadLimits();
    const decision = spendDecision({ estimate, externalCalls: pre.plugins }, { limits, today: spentOn(rows) });
    const confirm = codeFor(operation, rows);
    const confirmed = decision.needApproval && given === confirm.code;
    if (decision.needApproval && !confirmed) stopForConfirm({ ...confirm, given, reasons: decision.reasons });
    const id = recordSpend({
      kind: 'test', regionLabel: t.regionLabel, botId: t.botId, botName: t.botName, what: set.name, testSetId: set.testSetId,
      count: runsCount, estimate, reserve: estimate ?? UNKNOWN_CASE_COST * runsCount, basis: basis || '估不出', approved: confirmed ? 'confirm' : 'auto',
      ...(confirmed ? { opKey: confirm.opKey, code: confirm.code } : {}),
    });
    return { id, confirmed, limits };
  });
  if (plan.confirmed) out('（用户已确认这一笔）');

  let testTaskId;
  try {
    testTaskId = await createTask(t, { testSetId: set.testSetId, canvasId, name, rounds, concurrency });
  } catch (error) {
    // 明确被拒（业务错误、4xx）就是没建成，这一笔记 0；结果不明（5xx、超时）的保留预留，让用户先看任务列表
    const refused = error instanceof MdError && (error.code === 'business' || (error.code === 'upstream' && error.status >= 400 && error.status < 500));
    if (refused) {
      updateSpend(plan.id, { actual: 0, runs: 0 });
      throw error;
    }
    throw new MdError(error?.code ?? 'upstream', String(error?.message ?? error), { hint: `任务可能已经建了：md test status --bot ${shortId(t.botId)} 看最近的任务，不要重跑` });
  }
  // 止损额度（md test status --wait 用）：自动放行的按单次门槛；用户确认过的按「确认的金额 + 一个单次门槛」；
  // 确认的是「估不出」的，按参考单价 × 次数 + 一个单次门槛
  const allowance = !plan.confirmed ? plan.limits.perCommand : (estimate ?? UNKNOWN_CASE_COST * runsCount) + plan.limits.perCommand;
  writeTaskRecord(t, { testTaskId, testSetId: set.testSetId, testSetName: set.name, name, canvasId, label, rounds, cases: cases.length, estimate, spendId: plan.id, allowance, createdAt: new Date().toISOString() });
  updateSpend(plan.id, { taskId: testTaskId });
  out(`已建任务 ${name}（${testTaskId}）：跑的是${label}，${cases.length} 条 × ${rounds} 轮`);
  out(`下一步：md test status ${shortId(testTaskId)} --bot ${shortId(t.botId)} --wait（每 15 秒看一次；按实际花费推算超出额度会自动暂停）`);
  return EXIT.OK;
}
```

- [ ] **Step 5: 在 `miaodong-kit/src/commands/test.mjs` 登记**
  - 加 `import { run } from './test-run.mjs';`
  - `SUBS` 加 `run`
  - `USAGE` 加：`'md test run <集> --bot <智能体> [--version vX] [--rounds 1] [--concurrency 5] [--name <任务名>] [--allow-preflight-errors] [--confirm <码>]   跑回归：先跑前检查和预估，超门槛或估不出要用户确认'`

- [ ] **Step 6: 运行，确认通过**

Run: 同 Step 2，另外跑一遍 `trial-cli.test.mjs`（`stopForConfirm` 搬家后它必须照样全过）。
Expected：
- `confirm.test.mjs` 新加的 1 条 PASS；
- `test-cli.test.mjs` 14 条全过；
- `trial-cli.test.mjs` 全过。

然后跑全部测试，Expected：`# fail 0`。

- [ ] **Step 7: 提交**

```bash
git add miaodong-kit/src/confirm.mjs miaodong-kit/src/commands/trial.mjs miaodong-kit/src/commands/test-run.mjs miaodong-kit/src/commands/test.mjs miaodong-kit/test/confirm.test.mjs miaodong-kit/test/test-cli.test.mjs
git commit -m "feat(md): md test run——跑前检查拦空跑、按上次任务估花费、确认码、建任务并记账"
```

---

### Task 6: `md test status` / `md test stop`——看进度、盯着跑时止损、跑完记账、暂停

**Files:**
- Modify: `miaodong-kit/src/commands/test-run.mjs`（加 `resolveTask`、`status`、`stop`）
- Modify: `miaodong-kit/src/commands/test.mjs`（登记 `status`、`stop`）
- Test: `miaodong-kit/test/test-cli.test.mjs`（追加）

**Interfaces:**
- Consumes：Task 1–5 的导出；`readTaskRecord, writeTaskRecord`（`test-common.mjs`）；`note, formatTime`（`src/output.mjs`）。
- Produces：
  - `resolveTask(t, query) → task`：认完整 id、id 前缀（至少 4 位）、任务名；不在最近 50 个里时，给完整 id 就直接查 detail。
  - `status(args)`、`stop(args)`。
  - 环境变量 `MD_TEST_POLL_MS`：只供测试调短轮询间隔（同 2b 的 `MD_POLL_MS`，只能让它更快结束等待，不影响花费判断）。

- [ ] **Step 1: 写失败的测试**，追加到 `miaodong-kit/test/test-cli.test.mjs` 末尾

```js
const taskOf = (name) => fake.state.tasks.find((x) => x.name.startsWith(name)).testTaskId;

test('status：不给任务时列最近的任务；--wait 跑完后记一次实际花费，再查不重复记（审查重点 3）', async () => {
  reset({ perPoll: 1 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '2'], h)).code, 0);
  const list = await md(['test', 'status', '--bot', '179cd443'], h);
  assert.match(list.stdout, /集-草稿-\d{4}-\d{4} · processing/);
  const task = taskOf('集-草稿');
  const r = await md(['test', 'status', task.slice(0, 8), '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /finished · 2\/2 · 通过 2 · ¥0\.040/);
  assert.match(r.stdout, /看结果：md test results/);
  assert.equal(spendRows(h).find((x) => x.kind === 'test').actual, 0.04);
  await md(['test', 'status', task.slice(0, 8), '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  const settles = readFileSync(join(h, 'md', 'spend.jsonl'), 'utf-8').trim().split('\n').filter((line) => line.includes('"actual":0.04'));
  assert.equal(settles.length, 1);
});

test('status --wait 止损：按已跑完的平均花费推算整个任务超过额度就暂停（审查重点 3）', async () => {
  reset({ perPoll: 1, itemCost: 1 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.001);
  const h = home();
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '3'], h)).code, 0);
  const task = taskOf('集-草稿');
  const r = await md(['test', 'status', task, '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /⛔ 按已跑完的 1 条平均 ¥1\.00 推算，整个任务要 ¥3\.00，超过额度 ¥2\.00，已暂停任务/);
  assert.deepEqual(fake.state.posts.pause.at(-1), { testTaskId: task });
});

test('status --wait 到时限还没跑完：说还没跑完、怎么接着等', async () => {
  reset({ perPoll: 0 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const r = await md(['test', 'status', taskOf('集-草稿'), '--bot', '179cd443', '--wait', '--timeout', '1'], h, { MD_TEST_POLL_MS: '200' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /还没跑完（等了 1 秒）；接着等：md test status/);
});

test('stop：暂停正在跑的任务；已经跑完的说不用暂停；找不到的任务退出码 4', async () => {
  reset({ perPoll: 0 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const task = taskOf('集-草稿');
  const r = await md(['test', 'stop', task.slice(0, 8), '--bot', '179cd443'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已暂停任务 .*paused/);
  assert.match((await md(['test', 'stop', '70000099', '--bot', '179cd443'], h)).stdout, /已经是 finished，不用暂停/);
  assert.equal((await md(['test', 'stop', 'ffffffff', '--bot', '179cd443'], h)).code, 4);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/test-cli.test.mjs`
Expected: 新加的 4 条 FAIL（「不认识「md test status」」）。

- [ ] **Step 3: 实现**：在 `miaodong-kit/src/commands/test-run.mjs` 末尾追加，并把文件头的 import 补全：
  - `import { note, formatTime, out, shortId, targetLine } from '../output.mjs';`
  - `import { pauseTask, taskDetail, taskItems } from '../testcenter.mjs';`（和已有的 `createTask, listCases, recentTasks` 合成一行）
  - `import { readTaskRecord } from '../test-common.mjs';`（同上，并进已有的那行）

```js
const TERMINAL = new Set(['finished', 'paused', 'failed', 'error', 'cancelled', 'canceled']);
const pollMs = () => (Number(process.env.MD_TEST_POLL_MS) > 0 ? Number(process.env.MD_TEST_POLL_MS) : 15_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 找任务：完整 id、id 前缀（至少 4 位）、任务名，在最近 50 个里找；给了完整 id 却不在里面，就直接查 detail
export async function resolveTask(t, query) {
  const q = String(query ?? '').trim();
  if (!q) throw new MdError('usage', '缺任务：给任务 id、id 前缀或任务名', { exitCode: EXIT.USAGE });
  const rows = await recentTasks(t, { limit: 50 });
  const hits = rows.filter((x) => x.testTaskId === q || (q.length >= 4 && String(x.testTaskId).startsWith(q)) || x.name === q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new MdError('task_ambiguous', `「${q}」匹配到 ${hits.length} 个任务：${hits.slice(0, 5).map((x) => `${x.name}(${shortId(x.testTaskId)})`).join('、')}`, { exitCode: EXIT.TARGET, hint: '用更长的 id 前缀' });
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
    const detail = await taskDetail(t, q);
    if (detail) return detail;
  }
  throw new MdError('task_not_found', `${t.botName} 最近的任务里没有「${q}」`, { exitCode: EXIT.TARGET, hint: `md test status --bot ${shortId(t.botId)} 看最近的任务` });
}

// 进度：跑完的条目数、通过、空跑（spec §2.3：没有执行、花费为空）、已完成条目的花费和平均
function progressOf(detail, items) {
  const done = items.filter((i) => i?.status && !['pending', 'processing'].includes(i.status));
  const costs = done.map((i) => i.costInCny).filter((c) => typeof c === 'number');
  const spent = costs.reduce((a, b) => a + b, 0);
  return {
    total: Math.max(items.length, (Number(detail?.totalTestCaseCount) || 0) * (Number(detail?.repeatTimes) || 1)),
    done: done.length,
    passed: done.filter((i) => i.passed === true).length,
    noop: done.filter((i) => i.canvasExecAvailable === false && (i.costInCny === null || i.costInCny === undefined)).length,
    spent,
    unit: costs.length ? spent / costs.length : null,
  };
}

function statusLine(detail, p) {
  const cost = typeof detail?.totalCostInCny === 'number' ? formatCost(detail.totalCostInCny) : `已完成的 ${formatCost(p.spent)}`;
  return `${detail?.name ?? ''} ${detail?.status} · ${p.done}/${p.total} · 通过 ${p.passed}${p.noop ? ` · 空跑 ${p.noop}` : ''} · ${cost}`;
}

// 止损（同 md trial 的逐次止损，审查 C1）：md 建的任务，按已完成条目的平均花费推算整个任务，超过额度就暂停
function stopLoss(t, detail, p) {
  const rec = readTaskRecord(t, detail?.testTaskId);
  if (!rec || p.unit === null) return null;
  const projected = p.unit * p.total;
  if (projected <= rec.allowance) return null;
  return `按已跑完的 ${p.done} 条平均 ${formatCost(p.unit)} 推算，整个任务要 ${formatCost(projected)}，超过额度 ${formatCost(rec.allowance)}`;
}

// 跑完记账：用秒懂给的总花费（没有就用逐条加起来的），只记一次（spec §6.6）。暂停的不记，账本保留预估
function settle(t, detail, p) {
  const rec = readTaskRecord(t, detail?.testTaskId);
  if (!rec?.spendId || rec.settled || detail?.status !== 'finished') return;
  updateSpend(rec.spendId, { actual: typeof detail.totalCostInCny === 'number' ? detail.totalCostInCny : p.spent, runs: p.total });
  writeTaskRecord(t, { ...rec, settled: true });
}

export async function status(args) {
  const t = await testTarget(args);
  if (!args._[0]) {
    const setQuery = strArg(args, 'set');
    const set = setQuery ? await resolveTestSet(t, setQuery) : null;
    const rows = await recentTasks(t, { testSetId: set?.testSetId, limit: 10 });
    out(targetLine(t));
    if (!rows.length) out('没有任务');
    for (const x of rows) {
      const total = (Number(x.totalTestCaseCount) || 0) * (Number(x.repeatTimes) || 1);
      out(`  ${formatTime(x.createdAt)} ${shortId(x.testTaskId)} ${x.name} · ${x.status} · ${x.processedTestCaseCount ?? 0}/${total} · 通过 ${x.passedTestCaseCount ?? 0} · ${typeof x.totalCostInCny === 'number' ? formatCost(x.totalCostInCny) : '花费跑完才有'}`);
    }
    return EXIT.OK;
  }
  const task = await resolveTask(t, args._[0]);
  const wait = boolArg(args, 'wait');
  const timeoutMs = intArg(args, 'timeout', 540, 3600) * 1000;
  const started = Date.now();
  out(targetLine(t));
  let detail = await taskDetail(t, task.testTaskId);
  let p = progressOf(detail, await taskItems(t, task.testTaskId));
  let last = '';
  while (wait && !TERMINAL.has(String(detail?.status)) && Date.now() - started < timeoutMs) {
    const line = statusLine(detail, p);
    if (line !== last) note(`${Math.round((Date.now() - started) / 1000)}s ${line}`);
    last = line;
    const guard = stopLoss(t, detail, p);
    if (guard) {
      await pauseTask(t, task.testTaskId);
      out(`⛔ ${guard}，已暂停任务（秒懂没有取消；要接着跑，把新的预估告诉用户，再重新 md test run）`);
      detail = await taskDetail(t, task.testTaskId);
      break;
    }
    await sleep(pollMs());
    detail = await taskDetail(t, task.testTaskId);
    p = progressOf(detail, await taskItems(t, task.testTaskId));
  }
  settle(t, detail, p);
  out(statusLine(detail, p));
  if (!TERMINAL.has(String(detail?.status))) {
    out(wait ? `还没跑完（等了 ${Math.round(timeoutMs / 1000)} 秒）；接着等：md test status ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} --wait` : '还没跑完；盯着跑加 --wait');
  } else {
    out(`看结果：md test results ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} --out <文件.xlsx>`);
  }
  return EXIT.OK;
}

export async function stop(args) {
  const t = await testTarget(args);
  const task = await resolveTask(t, args._[0]);
  out(targetLine(t));
  if (TERMINAL.has(String(task.status))) {
    out(`任务 ${task.name}（${shortId(task.testTaskId)}）已经是 ${task.status}，不用暂停`);
    return EXIT.OK;
  }
  await pauseTask(t, task.testTaskId);
  const detail = await taskDetail(t, task.testTaskId);
  out(`已暂停任务 ${detail?.name ?? task.name}（${shortId(task.testTaskId)}）：${detail?.status}。秒懂没有取消，只能暂停；暂停后秒懂不给任务花费，账本保留预估`);
  return EXIT.OK;
}
```

- [ ] **Step 4: 在 `miaodong-kit/src/commands/test.mjs` 登记**
  - import 改成 `import { run, status, stop } from './test-run.mjs';`
  - `SUBS` 加 `status, stop`
  - `USAGE` 加两行：
    - `'md test status [<任务>] --bot <智能体> [--set <集>] [--wait] [--timeout 540]   进度；--wait 盯着跑，超出额度自动暂停，跑完记账'`
    - `'md test stop <任务> --bot <智能体>                 暂停（秒懂没有取消）'`

- [ ] **Step 5: 运行，确认通过**

Run: 同 Step 2。
Expected: 18 条 PASS。然后跑全部测试，Expected：`# fail 0`。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/commands/test-run.mjs miaodong-kit/src/commands/test.mjs miaodong-kit/test/test-cli.test.mjs
git commit -m "feat(md): md test status / stop——盯着跑、超额度自动暂停、跑完只记一次账"
```

---
### Task 7: 结果的纯逻辑——逐条整理、空跑、多任务对齐、CSV

**Files:**
- Create: `miaodong-kit/src/testresults.mjs`
- Test: `miaodong-kit/test/testresults.test.mjs`（新建）

**Interfaces:**
- Consumes：`asArray`（`src/api.mjs`）、`clip`（`src/execs.mjs`）、`execIdOfCase`（`src/testcases.mjs`）。
- Produces：
  - `replyOfItem(item) → string`、`isNoop(item) → boolean`
  - `itemRow(item, sources) → row`，row 的字段：`name, caseId, execId, scenario, user, expect, passed, verdict, reply, actions, cost, ms, testExecId, noop, online`
  - `taskSummary(detail, rows) → { name, id, status, version, runs, passed, noop, rate, cost, durationMs }`
  - `alignTasks(tasks) → [{ base, per }]`、`alignedTable(tasks, aligned) → { head, rows }`
  - `ROW_HEAD`、`rowCells(row)`、`toCsv(head, rows)`

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/testresults.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROW_HEAD, alignTasks, alignedTable, itemRow, replyOfItem, rowCells, taskSummary, toCsv } from '../src/testresults.mjs';
import { CROSS_EXEC, SAME_EXEC } from './helpers/testcenter-fixtures.mjs';

const item = (patch = {}) => ({
  testCaseId: 'c1', testCaseName: `调优中心导入(${SAME_EXEC})`, scenarioPath: '退款', status: 'success', passed: true,
  costInCny: 0.02, processDuration: 1200, canvasExecId: 'd1', canvasExecAvailable: true, triggerExists: true,
  triggerContent: { triggerType: 'canvas-event-trigger', content: { eventName: '延时回复', data: { text: '我想退款' } } },
  executedActions: [{ type: 'send-text-message', summary: '已为您登记退款' }],
  canvasActionOutputAssertionResult: [{ type: 'send-text-message', passed: true, assertionDetailedInfo: '发送 - 文本', expectedValue: '已为您登记', actualValue: '已为您登记退款' }],
  ...patch,
});

test('replyOfItem：发送动作 → 转人工 → 断言里带出来的发出事件参数 → 空', () => {
  assert.equal(replyOfItem(item()), '已为您登记退款');
  assert.equal(replyOfItem(item({ executedActions: [{ type: 'handover', summary: '转给人工客服' }] })), '转人工：转给人工客服');
  const viaEvent = item({
    executedActions: [{ type: 'canvas-event-action', summary: '触发 发送4.0 事件' }],
    canvasActionOutputAssertionResult: [{ type: 'canvas-event-action', passed: false, actualOutput: { type: 'canvas-event-action', payload: { eventName: '发送4.0', params: { text: '事件里的回复' } } } }],
  });
  assert.equal(replyOfItem(viaEvent), '（事件「发送4.0」）事件里的回复');
  assert.equal(replyOfItem(item({ executedActions: [], canvasActionOutputAssertionResult: [] })), '');
});

test('itemRow：执行 id 从用例名取；用户消息、期望、没通过的断言结论；线上回复从来源取；空跑单独标出', () => {
  const failed = itemRow(item({ passed: false, canvasActionOutputAssertionResult: [{ type: 'update-data', passed: false, assertionDetailedInfo: '写字段 - 已发优惠', message: '字段值不一致' }] }), { [SAME_EXEC]: { reply: '线上回复 1' } });
  assert.deepEqual([failed.execId, failed.user, failed.expect, failed.verdict, failed.online, failed.passed], [SAME_EXEC, '我想退款', '写字段 - 已发优惠', '写字段 - 已发优惠：字段值不一致', '线上回复 1', false]);
  const diff = itemRow(item({ passed: false, canvasActionOutputAssertionResult: [{ type: 'send-text-message', passed: false, assertionDetailedInfo: '发送 - 文本', expectedValue: '期望的话', actualValue: '实际的话' }] }));
  assert.equal(diff.verdict, '发送 - 文本：期望「期望的话」实际「实际的话」');
  const noop = itemRow(item({ testCaseName: `调优中心导入(${CROSS_EXEC})`, passed: false, canvasExecAvailable: false, costInCny: null, processDuration: null, executedActions: [], canvasActionOutputAssertionResult: [] }));
  assert.equal(noop.noop, true);
  assert.match(noop.verdict, /没有真正执行/);
  assert.equal(rowCells(noop)[5], '空跑');
  assert.equal(ROW_HEAD.length, rowCells(noop).length);
});

test('taskSummary：通过数、通过率、空跑数、花费（跑完用总花费，没有就逐条加）', () => {
  const rows = [itemRow(item()), itemRow(item({ passed: false, canvasExecAvailable: false, costInCny: null }))];
  assert.deepEqual(
    taskSummary({ testTaskId: 't1', name: '任务', status: 'finished', canvasVersion: 'v1', totalCostInCny: 0.05, taskDuration: 45000 }, rows),
    { name: '任务', id: 't1', status: 'finished', version: 'v1', runs: 2, passed: 1, noop: 1, rate: 0.5, cost: 0.05, durationMs: 45000 },
  );
  assert.equal(taskSummary({ status: 'paused' }, rows).cost, 0.02);
});

test('alignTasks / alignedTable：多个任务按用例对齐，每个任务「通过 k/n」和第一条回复；没跑到的写 -', () => {
  const a = { summary: { name: '改前' }, rows: [itemRow(item({ passed: false })), itemRow(item({ testCaseId: 'c2', testCaseName: '另一条' }))] };
  const b = { summary: { name: '改后' }, rows: [itemRow(item()), itemRow(item())] };
  const table = alignedTable([a, b], alignTasks([a, b]));
  assert.deepEqual(table.head, ['用例名', '调优中心执行ID', '用户消息', '线上回复', '改前 通过', '改前 回复', '改后 通过', '改后 回复']);
  assert.deepEqual(table.rows[0].slice(4), ['0/1', '已为您登记退款', '2/2', '已为您登记退款']);
  assert.deepEqual(table.rows[1].slice(4), ['1/1', '已为您登记退款', '-', '']);
});

test('toCsv：带 BOM（Excel 才认中文）；含逗号、引号、换行的格子加引号', () => {
  const csv = toCsv(['a', 'b'], [['1,2', 'x"y'], ['多\n行', 3]]);
  assert.ok(csv.startsWith('﻿a,b\r\n'));
  assert.ok(csv.endsWith('"1,2","x""y"\r\n"多\n行",3\r\n'));
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/testresults.test.mjs`
Expected: FAIL，报 Cannot find module `../src/testresults.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/testresults.mjs`

```js
// 测试结果：逐条整理成报告的一行，多个任务按用例对齐（spec §6.6）。字段形状见 spec §2.3。

import { asArray } from './api.mjs';
import { clip } from './execs.mjs';
import { execIdOfCase } from './testcases.mjs';

// 实际回复：同一条链里的发送动作；没有就看转人工；再没有，看断言结果里带出来的发出事件参数
// （回复在下游事件链里时，测试项里没有发送，spec §2.3）。都没有返回空，由 --deep 去详情里取
export function replyOfItem(item) {
  const actions = asArray(item?.executedActions);
  const sends = actions.filter((a) => a?.type === 'send-text-message' || a?.type === 'send-combination-message').map((a) => String(a?.summary ?? '')).filter(Boolean);
  if (sends.length) return sends.join(' / ');
  const handover = actions.find((a) => a?.type === 'handover');
  if (handover) return `转人工${handover.summary ? `：${handover.summary}` : ''}`;
  for (const r of asArray(item?.canvasActionOutputAssertionResult)) {
    const payload = r?.actualOutput?.payload;
    const text = payload?.params?.text;
    if (typeof text === 'string' && text.trim()) return `（事件「${payload.eventName ?? ''}」）${text}`;
  }
  return '';
}

// 空跑：秒懂显示成功，但没有执行、花费为空（spec §2.3 核对 6）
export const isNoop = (item) => item?.canvasExecAvailable === false && (item?.costInCny === null || item?.costInCny === undefined);

export function itemRow(item, sources = {}) {
  const execId = execIdOfCase(item?.testCaseName) ?? '';
  const content = item?.triggerContent?.content ?? {};
  const results = asArray(item?.canvasActionOutputAssertionResult);
  const describe = (r) => String(r?.assertionDetailedInfo || r?.type || '');
  const noop = isNoop(item);
  return {
    name: String(item?.testCaseName ?? ''),
    caseId: String(item?.testCaseId ?? ''),
    execId,
    scenario: String(item?.scenarioPath ?? ''),
    user: String(content.text ?? content.data?.text ?? content.data?.userOriginalText ?? ''),
    expect: results.map(describe).filter(Boolean).join('；'),
    passed: item?.passed === true,
    verdict: noop
      ? '没有真正执行：触发器、事件或会话变量对不上（秒懂仍显示成功）'
      : results.filter((r) => r?.passed === false).map((r) => `${describe(r)}：${r?.message || `期望「${clip(r?.expectedValue ?? '', 80)}」实际「${clip(r?.actualValue ?? '', 80)}」`}`).join('；'),
    reply: replyOfItem(item),
    actions: asArray(item?.executedActions).map((a) => a?.summary || a?.type).filter(Boolean).join('；'),
    cost: typeof item?.costInCny === 'number' ? item.costInCny : null,
    ms: typeof item?.processDuration === 'number' ? item.processDuration : null,
    testExecId: String(item?.canvasExecId ?? ''),
    noop,
    online: execId && sources[execId] ? String(sources[execId].reply ?? '') : '',
  };
}

export function taskSummary(detail, rows) {
  const passed = rows.filter((r) => r.passed).length;
  return {
    name: String(detail?.name ?? ''),
    id: String(detail?.testTaskId ?? ''),
    status: String(detail?.status ?? ''),
    version: String(detail?.canvasVersion ?? ''),
    runs: rows.length,
    passed,
    noop: rows.filter((r) => r.noop).length,
    rate: rows.length ? passed / rows.length : null,
    cost: typeof detail?.totalCostInCny === 'number' ? detail.totalCostInCny : rows.reduce((sum, r) => sum + (r.cost ?? 0), 0),
    durationMs: typeof detail?.taskDuration === 'number' ? detail.taskDuration : null,
  };
}

// 多个任务按用例对齐：同一条用例（按用例 id，没有就按名字）一行；每个任务一组「通过 k/n」和第一条非空回复
export function alignTasks(tasks) {
  const keys = [];
  const byKey = new Map();
  tasks.forEach(({ rows }, i) => {
    for (const row of rows) {
      const key = row.caseId || row.name;
      if (!byKey.has(key)) {
        byKey.set(key, { base: row, per: [] });
        keys.push(key);
      }
      const slot = (byKey.get(key).per[i] ??= { runs: 0, passed: 0, reply: '' });
      slot.runs++;
      if (row.passed) slot.passed++;
      if (!slot.reply && row.reply) slot.reply = row.reply;
    }
  });
  return keys.map((key) => byKey.get(key));
}

export const ROW_HEAD = ['用例名', '调优中心执行ID', '场景', '用户消息', '期望', '是否通过', '断言结论', '实际回复', '实际动作', '花费', '耗时ms', '测试执行ID', '线上回复'];
export const rowCells = (r) => [r.name, r.execId, r.scenario, r.user, r.expect, r.noop ? '空跑' : r.passed ? '通过' : '不通过', r.verdict, r.reply, r.actions, r.cost ?? '', r.ms ?? '', r.testExecId, r.online];

export function alignedTable(tasks, aligned) {
  const head = ['用例名', '调优中心执行ID', '用户消息', '线上回复', ...tasks.flatMap(({ summary }) => [`${summary.name} 通过`, `${summary.name} 回复`])];
  const rows = aligned.map(({ base, per }) => [base.name, base.execId, base.user, base.online, ...tasks.flatMap((_, i) => (per[i] ? [`${per[i].passed}/${per[i].runs}`, per[i].reply] : ['-', '']))]);
  return { head, rows };
}

// CSV：带 BOM（Excel 才认得出 UTF-8 中文）；含逗号、引号、换行的格子加引号
export function toCsv(head, rows) {
  const cell = (value) => {
    const s = String(value ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 5 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/testresults.mjs miaodong-kit/test/testresults.test.mjs
git commit -m "feat(md): 测试结果的逐条整理、空跑标记、多任务对齐与 CSV"
```

---

### Task 8: 最小 xlsx 写入器

**Files:**
- Create: `miaodong-kit/src/xlsx.mjs`
- Test: `miaodong-kit/test/xlsx.test.mjs`（新建）

**Interfaces:**
- Consumes：`node:zlib` 的 `deflateRawSync`（测试里用 `inflateRawSync` 读回）。
- Produces：`crc32(buf)`、`zip(files)`、`colName(index)`、`xlsxBuffer(sheets) → Buffer`、`writeXlsx(path, sheets)`。
  - 其中 `sheets` 的每一项是 `{ name, head: string[], rows: any[][], rowStyle?: (i) => 'plain'|'pass'|'fail' }`。

- [ ] **Step 1: 写失败的测试** `miaodong-kit/test/xlsx.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { colName, crc32, xlsxBuffer } from '../src/xlsx.mjs';

// 读回 zip：从中央目录拿每个文件的位置，解压，并核对 CRC
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = inflateRawSync(buf.subarray(start, start + size));
    assert.equal(crc32(data), crc, `${name} 的 CRC`);
    files[name] = data.toString('utf-8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test('colName：A…Z、AA…', () => {
  assert.deepEqual([0, 25, 26, 701, 702].map(colName), ['A', 'Z', 'AA', 'ZZ', 'AAA']);
});

test('crc32：和标准值一致', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('xlsxBuffer：两张表；表头加粗、冻结首行；通过 / 不通过两种底色；数字写成数字；特殊字符转义、控制字符去掉', () => {
  const files = unzip(xlsxBuffer([
    { name: '汇总', head: ['任务', '花费'], rows: [['改后', 0.05]] },
    { name: '逐条', head: ['用例', '回复'], rows: [['a<b&c', '好'], ['坏\u0001', '"引号"']], rowStyle: (i) => (i === 0 ? 'pass' : 'fail') },
  ]));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) assert.ok(files[name], name);
  assert.match(files['xl/workbook.xml'], /<sheet name="汇总" sheetId="1" r:id="rId1"\/><sheet name="逐条" sheetId="2" r:id="rId2"\/>/);
  const s1 = files['xl/worksheets/sheet1.xml'];
  assert.match(s1, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(s1, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">任务<\/t><\/is><\/c>/);
  assert.match(s1, /<c r="B2"><v>0\.05<\/v><\/c>/);
  const s2 = files['xl/worksheets/sheet2.xml'];
  assert.match(s2, /<c r="A2" s="2" t="inlineStr"><is><t xml:space="preserve">a&lt;b&amp;c<\/t>/);
  assert.match(s2, /<c r="A3" s="3" t="inlineStr"><is><t xml:space="preserve">坏<\/t>/);
  assert.match(s2, /&quot;引号&quot;/);
  assert.match(files['xl/styles.xml'], /<cellXfs count="4">/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/xlsx.test.mjs`
Expected: FAIL，报 Cannot find module `../src/xlsx.mjs`。

- [ ] **Step 3: 实现** `miaodong-kit/src/xlsx.mjs`

```js
// 最小 xlsx 写入器（spec §6.6）：若干张表，表头加粗、冻结首行，行可以标成「通过」（绿底）/「不通过」（红底）。
// xlsx 就是一个 zip，里面是几份固定的 XML。不引依赖：zip 用 node:zlib 的 deflateRaw，CRC32 自己算。
// 字符串一律写成 inlineStr（不用共享字符串表）；单元格最多 32767 字；XML 不允许的控制字符去掉。

import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 最小 zip：每个文件 deflate 压缩，文件名按 UTF-8（通用位 0x0800），日期固定 1980-01-01；末尾中央目录。不支持 zip64
export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const body = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, body);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (value) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .slice(0, 32767)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const STYLE = { plain: 0, head: 1, pass: 2, fail: 3 };
const STYLES_XML = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFBE2E2"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/></cellXfs>'
  + '</styleSheet>';

function sheetXml({ head, rows, rowStyle = () => 'plain' }) {
  const line = (cells, r, style) => `<row r="${r}">${cells.map((value, c) => {
    const ref = `${colName(c)}${r}`;
    const s = STYLE[style] ? ` s="${STYLE[style]}"` : '';
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  }).join('')}</row>`;
  const body = [line(head, 1, 'head'), ...rows.map((cells, i) => line(cells, i + 2, rowStyle(i)))].join('');
  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols><col min="1" max="${Math.max(head.length, 1)}" width="24" customWidth="1"/></cols>`
    + `<sheetData>${body}</sheetData></worksheet>`;
}

// 表名最多 31 个字，不能有 []:*?/\
const sheetName = (name) => esc(String(name).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31));

export function xlsxBuffer(sheets) {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets.map((s, i) => `<sheet name="${sheetName(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf-8') })));
}

export function writeXlsx(path, sheets) {
  writeFileSync(path, xlsxBuffer(sheets));
}
```

- [ ] **Step 4: 运行，确认通过**

Run: 同 Step 2。
Expected: 3 条 PASS。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/xlsx.mjs miaodong-kit/test/xlsx.test.mjs
git commit -m "feat(md): 最小 xlsx 写入器（不引依赖）"
```

---

### Task 9: `md test results`——报告、多任务对齐、`--deep`、导出

**Files:**
- Create: `miaodong-kit/src/commands/test-results.mjs`
- Modify: `miaodong-kit/src/commands/test.mjs`（登记 `results`）
- Test: `miaodong-kit/test/test-cli.test.mjs`（追加）

**Interfaces:**
- Consumes：Task 1–8 的导出；`resolveTask`（`commands/test-run.mjs`）；`actionTexts, clip, formatCost, getExecDetail`（`src/execs.mjs`）；`DATA_NOTE, note, out, shortId, targetLine`（`src/output.mjs`）；`stamp`（`src/workspace.mjs`）；`readSources, testTarget, testsDir`（`test-common.mjs`）；`writeXlsx`（`src/xlsx.mjs`）。
- Produces：`results(args)`。
  - 逐条明细总是存一份 JSONL：`$MD_HOME/tests/…/results/<任务id前8位…>-<时间>.jsonl`。
  - `--out` 按扩展名决定格式，只接受 `.xlsx / .csv / .jsonl`，别的扩展名在联网之前就报用法错误。

- [ ] **Step 1: 写失败的测试**，追加到 `miaodong-kit/test/test-cli.test.mjs` 末尾

```js
const savedRows = (stdout) => readFileSync(stdout.match(/逐条明细：(\S+)/)[1], 'utf-8').trim().split('\n').map((line) => JSON.parse(line));

test('results：一个任务 → 汇总、没通过的（空跑单独说）、逐条明细存本机；线上回复从导入来源取；--out 出 xlsx / csv / jsonl，别的扩展名报错', async () => {
  reset();
  const h = home();
  const file = join(h, 'search.jsonl');
  writeFileSync(file, execSearchLines({ botId: TARGET_BOT, botName: '【测试测试测试】太极2.0 测试专用版', ids: [SAME_EXEC] }));
  assert.equal((await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', file], h)).code, 0);
  const set = fake.state.sets[0].testSetId;
  fake.state.cases.push({ ...structuredClone(importable[CROSS_EXEC]), testCaseId: 'b0000001-0000-4000-8000-000000000000', testSetId: set });
  seedFinished(set, 0.02);
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--allow-preflight-errors'], h)).code, 0);
  const task = taskOf('集-草稿');
  const xlsx = join(h, 'report.xlsx');
  const r = await md(['test', 'results', task.slice(0, 8), '--bot', '179cd443', '--out', xlsx], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /以下含真实用户对话/);
  assert.match(r.stdout, /finished · v1\.0\.216 · 2 次 · 通过 1（50%） · 空跑 1 · ¥0\.020/);
  assert.match(r.stdout, /没有真正执行/);
  const rows = savedRows(r.stdout);
  assert.equal(rows.find((x) => x.execId === SAME_EXEC).online, '发出事件「发送4.0」：线上回复 1');
  assert.ok(readFileSync(xlsx).subarray(0, 2).equals(Buffer.from('PK')));
  const csv = join(h, 'report.csv');
  await md(['test', 'results', task.slice(0, 8), '--bot', '179cd443', '--out', csv], h);
  assert.match(readFileSync(csv, 'utf-8'), /^﻿用例名,调优中心执行ID,场景,用户消息/);
  const jsonl = join(h, 'report.jsonl');
  await md(['test', 'results', task.slice(0, 8), '--bot', '179cd443', '--out', jsonl], h);
  assert.equal(readFileSync(jsonl, 'utf-8').trim().split('\n').length, 2);
  const bad = await md(['test', 'results', task.slice(0, 8), '--bot', '179cd443', '--out', join(h, 'r.txt')], h);
  assert.equal(bad.code, 2);
});

test('results --deep：测试项里没有回复（回复在下游事件里）的，按测试执行 id 取详情补上', async () => {
  reset();
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const task = taskOf('集-草稿');
  await md(['test', 'status', task, '--bot', '179cd443'], h);
  for (const i of fake.state.items.get(task)) Object.assign(i, { executedActions: [{ type: 'canvas-event-action', summary: '触发 发送4.0 事件' }], canvasActionOutputAssertionResult: [] });
  assert.equal(savedRows((await md(['test', 'results', task, '--bot', '179cd443'], h)).stdout)[0].reply, '');
  const deep = await md(['test', 'results', task, '--bot', '179cd443', '--deep'], h);
  assert.match(deep.stderr, /--deep：1 条要取执行详情/);
  assert.equal(savedRows(deep.stdout)[0].reply, '发出事件「发送4.0」：详情里的回复');
});

test('results 两个任务：按用例对齐，--out csv 每个任务一组「通过 / 回复」列', async () => {
  reset();
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443', '--name', '改前'], h);
  await md(['test', 'run', '集', '--bot', '179cd443', '--name', '改后'], h);
  const out = join(h, 'cmp.csv');
  const r = await md(['test', 'results', '改前', '改后', '--bot', '179cd443', '--out', out], h);
  assert.equal(r.code, 0, r.stderr);
  const csv = readFileSync(out, 'utf-8');
  assert.match(csv, /用例名,调优中心执行ID,用户消息,线上回复,改前 通过,改前 回复,改后 通过,改后 回复/);
  assert.match(csv, /1\/1,回复：我想退款,1\/1,回复：我想退款/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/test-cli.test.mjs`
Expected: 新加的 3 条 FAIL（「不认识「md test results」」）。

- [ ] **Step 3: 实现** `miaodong-kit/src/commands/test-results.mjs`

```js
// md test results <任务> [<任务2> …] [--out <文件.xlsx|.csv|.jsonl>] [--deep] [--limit 10]（spec §6.6）
// stdout 只出汇总和前几条没通过的；逐条明细总是存一份 JSONL 到本机（给 jq）；--out 按扩展名出报告。

import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { boolArg, intArg, strArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { DATA_NOTE, note, out, shortId, targetLine } from '../output.mjs';
import { actionTexts, clip, formatCost, getExecDetail } from '../execs.mjs';
import { stamp } from '../workspace.mjs';
import { taskDetail, taskItems } from '../testcenter.mjs';
import { ROW_HEAD, alignTasks, alignedTable, itemRow, rowCells, taskSummary, toCsv } from '../testresults.mjs';
import { writeXlsx } from '../xlsx.mjs';
import { readSources, testTarget, testsDir } from '../test-common.mjs';
import { resolveTask } from './test-run.mjs';

const FORMATS = new Set(['.xlsx', '.csv', '.jsonl']);

// --deep：测试项里拿不到回复（回复在下游事件链里）时，按测试执行 id 取详情，从发出的动作里取回复
async function deepen(t, rows) {
  const need = rows.filter((r) => !r.reply && r.testExecId);
  if (!need.length) return;
  note(`（--deep：${need.length} 条要取执行详情，每条约 2 秒）`);
  for (const r of need) {
    const detail = await getExecDetail(t.identity, t.orgId, r.testExecId, t.botId);
    const texts = actionTexts(detail?.canvasExec?.outputActions);
    const pick = (kinds) => texts.filter((a) => kinds.includes(a.kind)).map((a) => a.text).join('；');
    r.reply = pick(['reply', 'handover']) || pick(['event']);
  }
}

const jsonlOf = (tasks) => `${tasks.flatMap(({ summary, rows }) => rows.map((r) => JSON.stringify({ task: summary.id, taskName: summary.name, ...r }))).join('\n')}\n`;

function writeReport(file, tasks) {
  const ext = extname(file).toLowerCase();
  if (ext === '.jsonl') {
    writeFileSync(file, jsonlOf(tasks));
    return;
  }
  const single = tasks.length === 1 ? tasks[0].rows : null;
  const table = single ? { head: ROW_HEAD, rows: single.map(rowCells) } : alignedTable(tasks, alignTasks(tasks));
  if (ext === '.csv') {
    writeFileSync(file, toCsv(table.head, table.rows));
    return;
  }
  const summaryRows = tasks.map(({ summary: s }) => [s.name, s.id, s.status, s.version, s.runs, s.passed, s.rate === null ? '' : Math.round(s.rate * 1000) / 10, s.noop, Math.round(s.cost * 10000) / 10000, s.durationMs ? Math.round(s.durationMs / 1000) : '']);
  writeXlsx(file, [
    { name: '汇总', head: ['任务', '任务ID', '状态', '版本', '次数', '通过', '通过率%', '空跑', '花费', '耗时秒'], rows: summaryRows },
    { name: '逐条', head: table.head, rows: table.rows, rowStyle: (i) => (single ? (single[i].passed ? 'pass' : 'fail') : 'plain') },
  ]);
}

export async function results(args) {
  const outFile = strArg(args, 'out');
  if (outFile && !FORMATS.has(extname(outFile).toLowerCase())) throw usage(`--out 只支持 .xlsx / .csv / .jsonl，收到「${outFile}」`);
  if (!args._.length) throw usage('缺任务：md test results <任务> [<任务2> …] --bot <智能体>');
  const t = await testTarget(args);
  const deep = boolArg(args, 'deep');
  const limit = intArg(args, 'limit', 10, 200);
  const tasks = [];
  for (const query of args._) {
    const task = await resolveTask(t, query);
    const detail = await taskDetail(t, task.testTaskId);
    const sources = readSources(t, detail?.testSetId ?? task.testSetId);
    const rows = (await taskItems(t, task.testTaskId)).map((item) => itemRow(item, sources));
    if (deep) await deepen(t, rows);
    tasks.push({ summary: taskSummary(detail ?? task, rows), rows });
  }
  out(targetLine(t));
  out(DATA_NOTE);
  for (const { summary: s } of tasks) {
    out(`任务 ${s.name}（${shortId(s.id)}）${s.status} · ${s.version || '-'} · ${s.runs} 次 · 通过 ${s.passed}${s.rate === null ? '' : `（${Math.round(s.rate * 100)}%）`}${s.noop ? ` · 空跑 ${s.noop}` : ''} · ${formatCost(s.cost)}${s.durationMs ? ` · ${Math.round(s.durationMs / 1000)}s` : ''}`);
  }
  for (const { summary, rows } of tasks) {
    const bad = rows.filter((r) => !r.passed);
    if (!bad.length) continue;
    out(`${summary.name} 没通过的（前 ${Math.min(limit, bad.length)} / ${bad.length} 条）：`);
    for (const r of bad.slice(0, limit)) out(`  - ${r.name}：${clip(r.verdict, 160) || '-'} ｜ 回复：${clip(r.reply, 120) || '（测试项里没有，加 --deep 取）'}`);
  }
  const saved = join(testsDir(t, 'results'), `${tasks.map((x) => shortId(x.summary.id)).join('+')}-${stamp()}.jsonl`);
  writeFileSync(saved, jsonlOf(tasks));
  out(`逐条明细：${saved}`);
  if (outFile) {
    writeReport(outFile, tasks);
    out(`报告：${outFile}`);
  }
  return EXIT.OK;
}
```

- [ ] **Step 4: 在 `miaodong-kit/src/commands/test.mjs` 登记**
  - 加 `import { results } from './test-results.mjs';`
  - `SUBS` 加 `results`
  - `USAGE` 加：`'md test results <任务> [<任务2> …] --bot <智能体> [--out <文件.xlsx|.csv|.jsonl>] [--deep] [--limit 10]   报告；两个任务按用例对齐比改前改后'`

- [ ] **Step 5: 运行，确认通过**

Run: 同 Step 2。
Expected: 21 条 PASS。然后跑全部测试，Expected：`# fail 0`。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/commands/test-results.mjs miaodong-kit/src/commands/test.mjs miaodong-kit/test/test-cli.test.mjs
git commit -m "feat(md): md test results——汇总、空跑标记、线上回复对照、--deep、多任务对齐、导出 xlsx/csv/jsonl"
```

---

### Task 10: `md test drop`——删测试集（计划码、备份、先删用例后删集）

**Files:**
- Create: `miaodong-kit/src/commands/test-drop.mjs`
- Modify: `miaodong-kit/src/commands/test.mjs`（登记 `drop`）
- Test: `miaodong-kit/test/test-cli.test.mjs`（追加）

**Interfaces:**
- Consumes：
  - Task 1–3 的导出；
  - `confirmCode, givenCode`（`src/confirm.mjs`）、`hashOf`（`src/canvas.mjs`）；
  - `writeJson`（`src/home.mjs`）、`stamp`（`src/workspace.mjs`）。
- Produces：`drop(args)`。计划码绑定预演时这个集里的用例 id。

- [ ] **Step 1: 写失败的测试**，追加到 `miaodong-kit/test/test-cli.test.mjs` 末尾

```js
test('drop：先预演给计划码、什么都不删；码不对退出码 5；对了先备份，再先删用例后删集，回读确认（审查重点 4）', async () => {
  reset();
  seedSet('要删的集', [SAME_EXEC, CROSS_EXEC]);
  const h = home();
  const preview = await md(['test', 'drop', '要删的集', '--bot', '179cd443'], h);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /要删的测试集「要删的集」\(40000001\)：2 条用例/);
  const code = preview.stdout.match(/计划码：([0-9a-f]{8})/)[1];
  assert.deepEqual(fake.state.log, []);
  assert.equal((await md(['test', 'drop', '要删的集', '--bot', '179cd443', '--confirm', '00000000'], h)).code, 5);
  const r = await md(['test', 'drop', '要删的集', '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.state.log, ['batchDelete', 'setDelete']);
  assert.equal(fake.state.sets.length, 0);
  const backup = r.stdout.match(/备份：(\S+)/)[1];
  assert.equal(JSON.parse(readFileSync(backup, 'utf-8')).cases.length, 2);
});

test('drop：预演之后集里的用例变了，原来的计划码就对不上，什么都不删', async () => {
  reset();
  const set = seedSet('集', [SAME_EXEC]);
  const h = home();
  const code = (await md(['test', 'drop', '集', '--bot', '179cd443'], h)).stdout.match(/计划码：([0-9a-f]{8})/)[1];
  fake.state.cases.push({ ...structuredClone(importable[CROSS_EXEC]), testCaseId: 'b0000009-0000-4000-8000-000000000000', testSetId: set });
  const r = await md(['test', 'drop', '集', '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /计划码对不上/);
  assert.equal(fake.state.sets.length, 1);
  assert.deepEqual(fake.state.log, []);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/test-cli.test.mjs`
Expected: 新加的 2 条 FAIL（「不认识「md test drop」」）。

- [ ] **Step 3: 实现** `miaodong-kit/src/commands/test-drop.mjs`

```js
// md test drop <集> [--confirm <计划码>]（spec §6.6）：默认预演；确认后先把全部用例备份到本机，
// 再先删用例、后删测试集（反过来会在场景树上留下孤儿计数），最后回读确认。任务记录秒懂不删，会留着。

import { join } from 'node:path';
import { EXIT, MdError } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { writeJson } from '../home.mjs';
import { stamp } from '../workspace.mjs';
import { hashOf } from '../canvas.mjs';
import { confirmCode, givenCode } from '../confirm.mjs';
import { deleteCases, deleteTestSet, listCases, listTestSets, recentTasks } from '../testcenter.mjs';
import { resolveTestSet, testTarget, testsDir } from '../test-common.mjs';

export async function drop(args) {
  const t = await testTarget(args);
  const given = givenCode(args);
  const set = await resolveTestSet(t, args._[0]);
  const cases = await listCases(t, set.testSetId);
  const tasks = await recentTasks(t, { testSetId: set.testSetId, limit: 50 });
  // 计划码绑定预演时的用例：之后集里的用例变了，确认就对不上
  const code = confirmCode({ kind: 'drop', botId: t.botId, testSetId: set.testSetId, cases: hashOf(cases.map((c) => c.testCaseId).sort()) });
  out(targetLine(t));
  out(`要删的测试集「${set.name}」(${shortId(set.testSetId)})：${cases.length} 条用例 · 挂了场景 ${cases.filter((c) => c.scenarioNodeId).length} 条 · 跑过的任务 ${tasks.length} 个（任务记录会留着）`);
  if (given === null) {
    out(`这是预演，什么都没删。计划码：${code}`);
    out(`用户明确同意后执行：md test drop ${set.testSetId} --bot ${shortId(t.botId)} --confirm ${code}`);
    return EXIT.OK;
  }
  if (given !== code) {
    throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：测试集里的用例在预演之后变了，或计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
  }
  const backup = join(testsDir(t, 'backups'), `${shortId(set.testSetId)}-${stamp()}.json`);
  writeJson(backup, { testSet: set, cases });
  await deleteCases(t, cases.map((c) => c.testCaseId));
  await deleteTestSet(t, set.testSetId);
  if ((await listTestSets(t)).some((s) => s.testSetId === set.testSetId)) {
    throw new MdError('drop_incomplete', `测试集「${set.name}」删了，但回读还在`, { hint: `用例已备份：${backup}` });
  }
  out(`已删测试集「${set.name}」和 ${cases.length} 条用例；备份：${backup}`);
  return EXIT.OK;
}
```

- [ ] **Step 4: 在 `miaodong-kit/src/commands/test.mjs` 登记**
  - 加 `import { drop } from './test-drop.mjs';`
  - `SUBS` 加 `drop`
  - `USAGE` 加：`'md test drop <集> --bot <智能体> [--confirm <计划码>]   删测试集：默认预演；确认后先备份、先删用例后删集'`

- [ ] **Step 5: 运行，确认通过**

Run: 同 Step 2。
Expected: 23 条 PASS。然后跑全部测试，Expected：`# fail 0`。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/commands/test-drop.mjs miaodong-kit/src/commands/test.mjs miaodong-kit/test/test-cli.test.mjs
git commit -m "feat(md): md test drop——计划码、先备份、先删用例后删集、回读确认"
```

---

### Task 11: 打包产物也能跑 `md test`

**Files:**
- Test: `miaodong-kit/test/bundle.test.mjs`（追加）

- [ ] **Step 1: 写测试**。在顶部 import 里补下面两行，再在末尾追加测试：
  - `import { startTestCenterServer } from './helpers/testcenter-server.mjs';`
  - `import { SAME_EXEC } from './helpers/testcenter-fixtures.mjs';`

```js
test('产物能跑 md test（测试中心接口、换 id、xlsx 一起打进去，且不带数据库依赖）', async () => {
  const { server } = await startTestCenterServer();
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const imported = await runCli(['test', 'import', '回归', '--bot', '179cd443', '--from-execs', SAME_EXEC], { home, bundle });
    assert.equal(imported.code, 0, imported.stderr);
    const sets = await runCli(['test', 'sets', '--bot', '179cd443'], { home, bundle });
    assert.match(sets.stdout, /回归/);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: 运行（Node 22 跑源码测试，Node 18 跑产物）**

Run: `MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node $HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/bundle.test.mjs`
Expected: 全部 PASS，其中「产物里没有老懂数据库依赖」「产物不带源码注释和源码路径」依旧通过。
这一步预期直接通过；如果失败，按 superpowers:systematic-debugging 查原因，不许改测试凑绿。

- [ ] **Step 3: 提交**

```bash
git add miaodong-kit/test/bundle.test.mjs
git commit -m "test(md): 打包产物跑 md test（Node 18）"
```

---

### Task 12: skill、仓库文档与 spec

**Files:**
- Modify: `miaodong-kit/skill/SKILL.md`
- Create: `miaodong-kit/skill/references/test-center.md`
- Modify: `miaodong-kit/skill/README.md`
- Modify: `CLAUDE.md`、`AGENTS.md`（md 小节）
- Modify: `docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md`（§10 分步）

- [ ] **Step 1: 改 `SKILL.md`**

1. `description` 整行换成：

```
description: 用 md 命令读写句子秒懂（JZ Insight，控制台域名形如 *-insight.juzibot.com）上智能体 / bot 的画布、执行记录和测试中心：按区取身份、按名字找智能体和版本、拉草稿或历史版本、看节点 / 上下游 / 引用、用改动脚本批量改 prompt 或模型、自检、合并推送到草稿、回滚、查推送记录；查调优中心的执行记录（badcase、执行 id）：按条件搜、看节点轨迹和事件链、找出某句话是哪个节点产生的；单节点试跑（用执行记录的原始输入复现、推草稿后复验）；测试中心（测试集、用例、场景树，从执行记录导入用例并跨智能体换 id，跑回归、看进度、出 xlsx 报告、删测试集）；超门槛或调插件时先给确认码、要用户确认；看花费。任务涉及秒懂某个智能体（bot、机器人、workflow、话术、版本号如 v1.0.400、执行 id、badcase、试跑、测试集、回归、推到秒懂）时使用；只提到 prompt、节点、画布、回滚而没有秒懂上下文时不要用。把 Excel、飞书等外部数据批量建成用例暂时仍由 miaodong-test-case-import 负责。
```

2. 在 `## 修 bot 的标准流程` 整节后面，插入新的一节：

```
## 回归（测试中心）

1. 找要回归的执行：`md exec --bot <源智能体> …` 搜，输出最后一行「已存：<文件>」就是搜索结果文件；要测回复质量，就选生成回复的那条（太极类 bot 是「延时回复」那条）。也可以直接用执行 id。
2. `md test import <集> --bot <目标智能体> --from-execs <文件或执行 id>`：新建测试集并导入；导进已有的集加 `--into`。
   - 源智能体和目标不同时，md 按名字换事件 id 和会话变量 id。只给了 id 的要加 `--from-bot <源智能体>`，否则事件对不上时 md 会撤回这次导入。
3. `md test run <集> --bot <智能体> [--version vX] [--rounds 1]`：先做跑前检查、报预估。
   - 事件、会话变量、事件入口对不上的用例会静默空跑，默认拦下。
   - 要确认时同 `md trial`：单独问用户，同意后加 `--confirm <码>`。
4. `md test status <任务> --bot <智能体> --wait`：盯着跑。按实际花费推算超出额度会自动暂停，跑完记账。
5. `md test results <任务> [<任务2> …] --bot <智能体> --out <文件.xlsx>`：出报告。
   - 回复在下游事件里拿不到时加 `--deep`。
   - 给两个任务就按用例对齐，比较改前改后。
- 删测试集：`md test drop <集> --bot <智能体>` 先预演、给计划码，用户明确同意后才 `--confirm`。
- 输出怎么读、本地文件在哪、测试中心的坑，见 `references/test-center.md`。
```

3. `## 规矩` 末尾加：

```
- 导入、删测试集会写秒懂：导入前说清导到哪个智能体、哪个测试集；删测试集要用户明确同意（计划码）。
- 回归只跑用户说的集和轮数，不自己加条数、加轮数。
```

4. `## 领域常识` 里从「测试中心 md 还不支持，要在秒懂页面上操作。注意：」开始、到这一段结束的整段，换成：

```
测试中心（spec §2.3 实测）：
- 跑哪一版由任务决定：默认草稿，`--version` 跑某个版本。
- 从执行记录导入的用例是「未审核」，照样会跑。
- 事件、会话变量、事件入口对不上的用例，秒懂显示「成功」但什么都没执行（空跑）。`md test run` 的跑前检查会拦，报告里标「空跑」。
- 逐条花费跑完那一条才有；任务总花费跑完才有，暂停的任务不给花费。
- 测试中心里「发送」会执行并记成动作，用户经验是不会真的发到客户手里；插件和 HTTP 调用是真的。
- 跨智能体导入的用例，断言来自源智能体，通过率没有意义，要看实际回复。
- 只有暂停，没有取消；删了测试集，任务记录还在。
```

5. 退出码表里 5 那一行换成：

```
| 5 | 推送被拦（冲突、计划码不符、草稿与版本不同、回读不一致）；或试跑 / 回归 / 调高门槛要用户确认（输出里有确认码）、跑前检查不通过、节点不能试跑、删测试集的计划码不符 | 推送：按提示走 rebase / 重新预演 / 让用户在 `--onto-draft` 和 `--replace-draft` 之间选。确认类：把预估和原因单独告诉用户，同意后带 `--confirm <码>` 重跑；不要换个办法绕过去。跑前检查：按提示重新导入或说明后加 `--allow-preflight-errors` |
```

- [ ] **Step 2: 新建 `miaodong-kit/skill/references/test-center.md`**

````markdown
# 测试中心（md test）

## 命令一览

| 命令 | 做什么 |
|---|---|
| `md test sets --bot <智能体>` | 测试集列表；这个区有没有场景树 |
| `md test cases <集> --bot <智能体> [--out <文件.jsonl>]` | 用例汇总（触发类型、未审核、挂场景）；完整用例存本机 |
| `md test tree --bot <智能体>` | 场景树和各节点的用例数 |
| `md test import <集> --bot <目标> --from-execs <文件或 id> [--from-bot <源>] [--into]` | 从执行记录导入 |
| `md test run <集> --bot <智能体> [--version vX] [--rounds 1] [--concurrency 5] [--name <任务名>]` | 跑回归 |
| `md test status [<任务>] --bot <智能体> [--wait] [--timeout 540]` | 进度；不给任务时列最近的任务 |
| `md test results <任务> [<任务2> …] --bot <智能体> [--out <文件>] [--deep]` | 报告 |
| `md test stop <任务> --bot <智能体>` | 暂停（秒懂没有取消） |
| `md test drop <集> --bot <智能体> [--confirm <计划码>]` | 删测试集 |

测试集可以写名字、完整 id 或 id 前缀；任务可以写任务名、完整 id 或 id 前缀（至少 4 位）。

## 导入

- `--from-execs` 给 `md exec` 保存的搜索结果文件（文件里记着源智能体），或者逗号隔开的执行 id。
- 跨智能体（源和目标不同）时，按名字把事件 id、会话变量 id 换成目标智能体的，全量回写后再回读核对。
  - 名字在目标里没有、或者有重名的，会列出来；这些用例跑前检查会拦下。
- 只给了 id、没给 `--from-bot`，md 先当作目标智能体自己的执行。导完发现事件或会话变量对不上，就把这次导进来的撤回；集里原来的用例不动。
- 从文件导入时，会记下每条执行的时间、用户消息、线上回复，报告里的「线上回复」列就是它。

## 跑

- 跑前检查（都针对要跑的那张画布）：
  - 事件在这个智能体里存在，而且画布上有它的入口；
  - 会话变量存在；
  - 文本等其他触发器在画布上存在。
  - 对不上的用例秒懂会「成功」但空跑，所以默认拦下；确认要照跑才加 `--allow-preflight-errors`。
- 预估：
  - 单价按顺序取：这个测试集上次跑完的任务的平均每条花费；导入来源里源执行的平均花费；都没有就估不出。
  - 预估 = 单价 × 条数 × 轮数。
- 确认：
  - 估不出一律要确认；
  - 超单次门槛（默认 ¥2）、当天累计超上限（默认 ¥10）、画布上有会真调外部系统的插件，都要确认；
  - 做法同 `md trial`：单独问用户，同意后加 `--confirm <码>`。
- `md test status --wait`：
  - 每 15 秒看一次，默认最多等 9 分钟；
  - 按已跑完条目的平均花费推算整个任务，超过额度就自动暂停。额度是：自动放行的按单次门槛；用户确认过的按「确认的金额 + 一个单次门槛」。
  - 跑完用秒懂给的总花费记账，只记一次。

## 报告

- stdout：每个任务的汇总（版本、次数、通过率、空跑、花费、耗时），外加前几条没通过的。
- 逐条明细总是存一份 JSONL：`~/.miaodong/md/tests/<区>/<智能体 id 前 8 位>/results/`。
- `--out` 按扩展名导出：
  - `.xlsx`：「汇总」「逐条」两张表，通过和不通过用不同底色；
  - `.csv`：带 BOM，Excel 直接打开不乱码；
  - `.jsonl`。
- 逐条的列：用例名、调优中心执行 ID、场景、用户消息、期望、是否通过（通过 / 不通过 / 空跑）、断言结论、实际回复、实际动作、花费、耗时、测试执行 ID、线上回复。
- 实际回复的取法：
  - 优先取同一条链里的发送动作；
  - 没有的话，看断言里带出来的发出事件参数；
  - 还没有就加 `--deep`：按测试执行 id 去详情里取，每条约 2 秒。
- 给两个任务时，按用例对齐：每个任务一组「通过 k/n」「回复」。

## 本机文件

`~/.miaodong/md/tests/<区>/<智能体 id 前 8 位>/` 下：

| 目录 | 放什么 |
|---|---|
| `sources/` | 导入来源 |
| `tasks/` | md 建的任务：预估、账本记录、止损额度 |
| `exports/` | 导出的用例 |
| `results/` | 结果明细 |
| `backups/` | 删测试集前的备份 |

## 坑（都实测过）

- 空跑没有任何专门标记：`triggerExists` 仍是 true，只能靠「没有执行、花费为空」认出来。
- 逐条花费跑完那一条才有；任务总花费跑完才有，暂停后不给。
- 同一个智能体上的任务排队跑；只有暂停，没有取消。
- 测试中心会真的调插件和 HTTP；「发送」用户经验是不会真发到客户手里。
- 跨智能体导入的用例，断言来自源智能体，通过率没有意义，要看实际回复。
- `regression-test` 接口不用：它要求回归集至少 50 条，而且会忽略指定的测试集。
````

- [ ] **Step 3: 改 `miaodong-kit/skill/README.md`**

1. 功能列表里「单节点试跑」那一行下面加一行：

```
- 测试中心：从执行记录导入用例（跨智能体自动换 id）、跑回归、盯着进度、出 xlsx 报告、删测试集
```

2. 「花钱要你点头」那一条的开头「试跑超过单次门槛」改成「试跑或跑回归超过单次门槛」。

- [ ] **Step 4: 改 `CLAUDE.md`、`AGENTS.md` 的 md 小节**（两个文件做同样的修改）：在「改之前必读」列表末尾加一条

```
6. **测试中心**（`src/testcenter.mjs` 接口，`src/testcases.mjs` 换 id 与跑前检查）：秒懂对事件、会话变量对不上的用例不报错，显示成功但空跑（spec §2.3），所以跑前检查必须拦；导入的撤回只按导入前后的差集删，不碰集里原有的用例。
```

- [ ] **Step 5: 改 spec §10**：把「- **2c**：…」那一行换成

```
- **2c-1**：`md test` 的看、从执行记录导入（含跨智能体换 id）、跑、进度（含止损）、结果（含 xlsx）、暂停、删；相关文档；做了核对 6（09-25）。
- **2c-2**：从外部文件导入用例（§6.3，含审计）、批量改用例（§6.4）；征得同意后停用旧 skill。
```

- [ ] **Step 6: 核对**

Run: `grep -n "测试中心 md 还不支持" miaodong-kit/skill/SKILL.md; grep -c "testcenter.mjs" CLAUDE.md AGENTS.md; test -s miaodong-kit/skill/references/test-center.md && echo tc-doc-ok; PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm run check:md 2>&1 | grep -E "^# (pass|fail)"`
Expected：
- 第一个 grep 没有输出；
- 两个文件各输出 `1`；
- 打印 `tc-doc-ok`；
- `# fail 0`（安装测试会检查 description 不超过 1024 字）。

- [ ] **Step 7: 提交**

```bash
git add miaodong-kit/skill/SKILL.md miaodong-kit/skill/references/test-center.md miaodong-kit/skill/README.md CLAUDE.md AGENTS.md docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md
git commit -m "docs(md): skill 与仓库文档加上 md test 回归闭环"
```

---

### Task 13: 全量验证、安装、真机核对、整支审查后发布

**Files:** 无新增。只有核对中发现问题时才改代码，并且先写复现测试。

- [ ] **Step 1: 全量离线测试（源码 Node 22 + 产物 Node 18）**

Run: `MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node $HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/*.test.mjs > .superpowers/sdd/2026-09-25-miaodong-cli-step2c1/full.log 2>&1; tail -8 .superpowers/sdd/2026-09-25-miaodong-cli-step2c1/full.log`
Expected: `# fail 0`。

- [ ] **Step 2: 安装**

Run: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run md:install && ~/.local/bin/md --version && ~/.local/bin/md test 2>&1 | head -3`
Expected：
- 版本号是当前 HEAD；
- `md test` 不带子命令时是用法错误，列出可用的子命令。

- [ ] **Step 3: 真机只读核对（不花钱，不写入）**

在「太极2.0 质检革新版」（147bd600）上：
1. `~/.local/bin/md test sets --bot 147bd600`、`md test cases <那个集> --bot 147bd600`、`md test tree --bot 147bd600`：
   - 字段都能取到；
   - 场景树是空的时说明是空的。
2. `~/.local/bin/md test status --bot 147bd600`：列出已有的任务。
3. 挑一个已经跑完的任务：
   - 运行 `~/.local/bin/md test results <任务> --bot 147bd600 --out <草稿区>/r.xlsx`；
   - 用 macOS 的 `unzip -l` 看 xlsx 结构；
   - 必要时对 1 条加 `--deep`，核对取到的回复。

有问题就先写复现测试，再修。

- [ ] **Step 4: 真机回归一次（要用户单独授权；花费 ≤ ¥0.3）**

1. 先单独问用户：
   - 在「【测试测试测试】太极2.0 测试专用版」（179cd443）上建一个临时测试集；
   - 从「太极2.0 质检革新版」跨智能体导入 1–2 条近期的「延时回复」执行；
   - 跑 1 轮，出报告，再删掉这个测试集。
   - 预计 ¥0.05–0.3。
2. 用户明确同意后按 SKILL 的「回归」流程走：`import`（跨智能体）→ `run`（需要确认就单独问）→ `status --wait` → `results --out` → `drop`（预演后单独问）。
3. 期望：
   - 换 id 后跑前检查通过；
   - 报告里有「线上回复」列；
   - `md spend` 里多了这一笔，预估和实际都有；
   - 测试集删干净。

- [ ] **Step 5: 整支审查、修复、发布、记忆**

1. 按 superpowers:executing-plans 的 Final Review，派最强的模型审查这一段的提交。
2. 修 Critical 和 Important，每条先写会失败的测试。
3. 发布：做法同 2b，在草稿区的 magic-skills/miaodong 检出里运行 `npm run md:publish -- <检出>`，看过 diff 再提交推送。
4. 在 `/Users/hukui/.claude/projects/-Users-hukui-Desktop-workspace-Agentflow/memory/miaodong-cli-plan.md` 的第 2 步条目下补一行 2c-1：完成日期、提交区间、真机核对结论、花费。
