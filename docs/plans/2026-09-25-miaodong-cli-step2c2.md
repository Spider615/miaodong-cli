# 秒懂 CLI 第 2c-2 步：外部用例导入与批量改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 md 加上：
- `md test import <集> --from-file <cases.jsonl>`：把 Excel、飞书、聊天记录转成的 JSONL 批量建成用例。本地先校验全部，先写 1 条读回来核对，再批量写、按 name 回读、挂场景、逐字段审计；
- `md test edit <集> <脚本.mjs>`：按脚本批量改用例，默认预演给计划码，确认后先备份、逐条全量更新、回读核对；
- 相关文档（新增 `references/test-cases.md`）。做完之后，旧 skill `miaodong-test-case-import` 的能力 md 全部都有。

**Architecture:**
- 纯逻辑：
  - `src/casefile.mjs`：JSONL 解析、触发与会话数据与断言的生成、本地校验、场景解析；
  - `src/caseedit.mjs`：跑改动脚本、给脚本的 `h`、改前改后比较；
  - `src/testcases.mjs` 加回读核对 `caseDiffs`。
- 接口层 `src/testcenter.mjs` 加 `createCases`、`attachCases`。
- 命令：
  - `src/commands/test-import-file.mjs`，由 `test-import.mjs` 按 `--from-file` 分过去；
  - `src/commands/test-edit.mjs`。
- 断言只生成 spec §2.3「核对 8」实测过的形状；别的形状用 `raw` 原样写。

**Tech Stack:** 产物跑在 Node 18+ ESM，源码测试用 Node 22；测试框架 node:test，esbuild 打成单文件；不新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-24-miaodong-cli-step2-design.md`，重点 §2.3（含核对 8）、§6.3、§6.4、§8。

> 执行方式：用户 09-25 设了目标「继续做完」，要求一路做完、不停下来问。所以计划写完直接按 superpowers:executing-plans 内联执行，不等审计划。
> 例外：需要用户单独拍板的两件事（往公开仓库发布、停用旧 skill）放到最后再问。

## Global Constraints

- 所有命令都在 worktree 根目录 `/Users/hukui/Desktop/workspace/Agentflow/.worktrees/miaodong-cli` 下运行；不要 `cd` 出去。
- 测试一律用 Node 22 的绝对路径（这台机器默认的 node 是 18）：
  - 单个文件：`$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/<文件>.test.mjs`
  - 全部：`PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node npm run check:md`
- 测试中心的每个请求，query 都带 `orgId` 和 `botId`；路径前缀 `/api/test-center/`（spec §2.3）。
- **写秒懂之前本地校验必须全部通过**；有任何错误就一条都不写（spec §6.3 第 1 步）。
- **外部用例先写 1 条读回来核对**，关键字段（name、触发类型、触发输入、会话数据、断言）被丢就撤回（spec §6.3 第 3 步）。
- **断言只生成核对 8 实测过的形状**：发文本（llm / similarity / equal）、发事件（带或不带 params）、转人工；别的一律 `raw`。
- `md test edit` 走计划码：默认预演；`--confirm <计划码>` 才写，写之前先备份到本机。计划码绑定每条改前和改后的内容。
- 测试里绝不连真实秒懂；假秒懂用 `test/helpers/testcenter-server.mjs`。
- 输出约定：stdout 放结果，stderr 放过程；第一行是目标行；长列表截断。
- 本机数据只写 `$MD_HOME/tests/<区>/<智能体 id 前 8 位>/…`。
- 中文注释、中文文案、英文标识符；不打印 token。
- **会发布到公开仓库的文件（`miaodong-kit/skill/` 下）不写具体 bot 名、客户名**：例子里的事件名用「发送」这类通用名字。
- 核对 8 的实测事实（spec §2.3）：
  - create 只回 `{code:0}`，不给 id；
  - 必填 5 项；触发类型 20 个；
  - 兴趣岛丢 `dimension`；
  - 接口建的用例 `isReviewed=true`；
  - 发事件断言缺 `eventName` 时服务端会补上。

## Review Focus

1. **AI 转出来的 JSONL 格式杂**：BOM、CRLF、空行、name 前后带空格。解析要容忍，name 要去空格。测试在 Task 2（解析）、Task 3（name 去空格）。
2. **静默失效的断言和字段**：
   - `expected` 这类拼错的字段；
   - 事件变量名拼错；
   - raw 断言两份 type 不一致；
   - 图片用例写了 `text`。
   都必须在写秒懂之前报错。测试在 Task 2、Task 3、Task 5。
3. **写到一半**：先写的 1 条关键字段被丢要撤回（新建的集一起删）；批量写到一半出错要说清留下了什么、怎么清理。测试在 Task 5。
4. **`--into` 重导**：已经写进去的 name 要被拦下，不能重复建。测试在 Task 5。
5. **批量改的安全**：
   - 改了不能改的字段、增删用例、name 空或重名，都要报错；
   - 预演之后集里的用例变了，计划码要对不上；
   - 写之前先备份。
   测试在 Task 6、Task 7。

---

### Task 1: 接口层 createCases / attachCases + 假秒懂的建用例、挂场景

**Files:**
- Modify: `miaodong-kit/src/testcenter.mjs`（在 `deleteCases` 前面加两个函数）
- Modify: `miaodong-kit/test/helpers/testcenter-server.mjs`
- Modify: `miaodong-kit/test/helpers/testcenter-fixtures.mjs`
- Test: `miaodong-kit/test/testcenter.test.mjs`

**Interfaces:**
- Produces:
  - `createCases(t, testSetId, cases, { batch = 50, onBatch } = {}) → Promise<void>`：`onBatch(已写条数)`；
  - `attachCases(t, scenarioNodeId, testCaseIds, { batch = 100 } = {}) → Promise<number>`：返回秒懂说挂上了几个。
- 假秒懂新增：
  - 状态 `keepDimension`（默认 false：create / update 都把 dimension 存成 ''）；
  - `dropFields`（create 时把这些字段存成空对象或空数组，模拟关键字段被丢）；
  - `failCreateAt`（第 N 次 create 起返回 502）；
  - `treeDrift`（每次挂场景额外给节点计数加几）。
- 夹具新增：目标 bot 的事件带 `variables`，会话变量带 `type`，多一个字符串变量「客户备注」(`tv-note`)；`scenarioTreeFixture()`。

- [ ] **Step 1: 夹具补事件变量、变量类型和场景树**

`testcenter-fixtures.mjs` 里把 `botEvents`、`botVars` 换成：

```js
export const botEvents = {
  [TARGET_BOT]: [
    { eventId: 'tev-delay', name: '延时回复', variables: [{ name: 'text', type: { type: 'string' } }] },
    { eventId: 'tev-send', name: '发送4.0', variables: [{ name: 'text', type: { type: 'string' } }, { name: 'urls', type: { type: 'array' } }] },
  ],
  [SOURCE_BOT]: [{ eventId: 'sev-delay', name: '延时回复' }, { eventId: 'sev-send', name: '发送4.0' }, { eventId: 'sev-only', name: '只在源里有' }],
};
export const botVars = {
  [TARGET_BOT]: [
    { id: 'tv-hist', name: '消息历史', isDefault: true, type: { type: 'array' } },
    { id: 'tv-flag', name: '已发优惠', isDefault: false, type: { type: 'boolean' } },
    { id: 'tv-note', name: '客户备注', isDefault: false, type: { type: 'string' } },
  ],
  [SOURCE_BOT]: [{ id: 'sv-hist', name: '消息历史', isDefault: true }, { id: 'sv-flag', name: '已发优惠', isDefault: false }],
};

// 场景树：两个「课程」同名，只能按路径找
export function scenarioTreeFixture() {
  return [
    { id: 'sn-refund', name: '退款', path: '退款', ownCaseCount: 3, totalCaseCount: 3, children: [
      { id: 'sn-refund-course', name: '课程', path: '退款/课程', ownCaseCount: 0, totalCaseCount: 0, children: [] },
    ] },
    { id: 'sn-consult', name: '咨询', path: '咨询', ownCaseCount: 0, totalCaseCount: 0, children: [
      { id: 'sn-consult-course', name: '课程', path: '咨询/课程', ownCaseCount: 0, totalCaseCount: 0, children: [] },
    ] },
  ];
}
```

- [ ] **Step 2: 写失败的测试**

`testcenter.test.mjs` 的 import 里加 `attachCases, createCases`，文件末尾加：

```js
test('批量建用例每批 50 条（create 不回 id，按 name 回读）；挂场景每批 100 个，返回挂上的条数', async () => {
  const id = await createTestSet(t(), '外部-批量');
  const cases = Array.from({ length: 120 }, (_, i) => ({ name: `外部-${i + 1}`, triggerType: 'receive-text-message', triggerInputs: { text: `问题 ${i + 1}` }, sessionMemoryCustomData: {}, testNodeOutputAssertions: [], canvasActionOutputAssertions: [] }));
  const before = fake.state.posts.caseCreate?.length ?? 0;
  const progress = [];
  await createCases(t(), id, cases, { onBatch: (done) => progress.push(done) });
  assert.deepEqual(fake.state.posts.caseCreate.slice(before).map((p) => p.testCases.length), [50, 50, 20]);
  assert.deepEqual(progress, [50, 100, 120]);
  const back = await listCases(t(), id);
  assert.equal(back.length, 120);
  assert.deepEqual([back[0].isReviewed, back[0].dimension], [true, '']);
  const savedTree = fake.state.tree;
  fake.state.tree = [{ id: 'sn-refund', name: '退款', path: '退款', ownCaseCount: 0, totalCaseCount: 0, children: [] }];
  try {
    assert.equal(await attachCases(t(), 'sn-refund', back.map((c) => c.testCaseId)), 120);
    assert.deepEqual(fake.state.posts.attach.slice(-2).map((p) => [p.testCaseIds.length, p.botId, p.scenarioNodeId]), [[100, TARGET_BOT, 'sn-refund'], [20, TARGET_BOT, 'sn-refund']]);
    assert.equal(fake.state.tree[0].ownCaseCount, 120);
  } finally {
    fake.state.tree = savedTree;
  }
});
```

- [ ] **Step 3: 跑，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/testcenter.test.mjs`
Expected: FAIL，`createCases` 没有导出（SyntaxError: ... does not provide an export named 'attachCases'）。

- [ ] **Step 4: 实现接口层**

`testcenter.mjs` 里 `deleteCases` 前面加：

```js
// 批量建外部用例：每批 50 条。create 只回 {code: 0}、不给 id，要按 name 回读（spec §2.3 核对 8）。onBatch(已写条数) 给命令报进度
export async function createCases(t, testSetId, cases, { batch = 50, onBatch } = {}) {
  for (let i = 0; i < cases.length; i += batch) {
    await post(t, '/test-case/create', { testSetId, testCases: cases.slice(i, i + batch) });
    onBatch?.(Math.min(i + batch, cases.length));
  }
}

// 挂场景：create 会丢掉 scenarioNodeId，只能建完再挂；每批 100 个，重复挂是幂等的（spec §2.3）。返回秒懂说挂上了几个
export async function attachCases(t, scenarioNodeId, testCaseIds, { batch = 100 } = {}) {
  let attached = 0;
  for (let i = 0; i < testCaseIds.length; i += batch) {
    const payload = await post(t, '/scenario/attach-cases', { botId: t.botId, testCaseIds: testCaseIds.slice(i, i + batch), scenarioNodeId });
    attached += Number(payload?.data?.attachedCount) || 0;
  }
  return attached;
}
```

- [ ] **Step 5: 假秒懂加两个接口，update 按兴趣岛丢 dimension**

`testcenter-server.mjs`：
- 文件头注释补上新状态的说明；
- `WRITABLE` 下面加 `TRIGGERS`；
- `test-case/update` 处理完加一行；
- 新增两个路由（放在 `test-case/batch-delete` 后面）。

```js
// 服务端的触发类型枚举（spec §2.3 核对 8）
const TRIGGERS = ['input', 'receive-text-message', 'receive-image-message', 'receive-audio-message', 'receive-video-message', 'receive-file-message', 'receive-other-message', 'receive-intent-comment', 'receive-note-message', 'receive-share-note-comment-message', 'receive-email-message', 'custom-attr-event', 'tag-event', 'join-room', 'new-friend', 'canvas-event-trigger', 'bot-receive-text-message', 'write-message', 'contact-lead-filled', 'wecom-contact-bind'];
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
```

`test-case/update` 的 `for (const key of WRITABLE) …` 后面加：

```js
      if (!state.keepDimension) c.dimension = '';  // 兴趣岛不保存 dimension（核对 8）
```

新路由：

```js
    'POST /api/test-center/test-case/create': ({ body, query }) => {
      record('caseCreate', body);
      const rows = Array.isArray(body.testCases) ? body.testCases : [];
      const problems = rows.flatMap((c, i) => [
        TRIGGERS.includes(c?.triggerType) ? null : `testCases.${i}.triggerType must be one of the following values: ${TRIGGERS.join(', ')}`,
        isObj(c?.triggerInputs) ? null : `testCases.${i}.triggerInputs must be an object`,
        isObj(c?.sessionMemoryCustomData) ? null : `testCases.${i}.sessionMemoryCustomData must be an object`,
        Array.isArray(c?.testNodeOutputAssertions) ? null : `testCases.${i}.testNodeOutputAssertions must be an array`,
        Array.isArray(c?.canvasActionOutputAssertions) ? null : `testCases.${i}.canvasActionOutputAssertions must be an array`,
      ]).filter(Boolean);
      if (problems.length) return bad(problems.join('；'));
      if (state.failCreateAt && state.posts.caseCreate.length >= state.failCreateAt) return { status: 502, body: { message: 'Bad Gateway' } };
      const eventNames = new Map((botEvents[query.botId] ?? []).map((e) => [e.eventId, e.name]));
      for (const c of rows) {
        const stored = { ...structuredClone(c), testCaseId: id('e', ++state.n), testSetId: body.testSetId, status: 'ready', isReviewed: true, scenarioNodeId: null, dimensionDetail: '', dimension: state.keepDimension ? (c.dimension ?? '') : '' };
        // 发事件断言没带 eventName 时服务端按 eventId 补上（核对 8）
        for (const a of stored.canvasActionOutputAssertions) {
          const payload = a?.actionContent?.payload;
          if (a?.actionContent?.type === 'canvas-event-action' && payload && !payload.eventName) payload.eventName = eventNames.get(payload.eventId) ?? '';
        }
        for (const field of state.dropFields ?? []) stored[field] = Array.isArray(c[field]) ? [] : {};
        state.cases.push(stored);
      }
      return { status: 201, body: { code: 0 } };
    },
    'POST /api/test-center/scenario/attach-cases': ({ body }) => {
      record('attach', body);
      let attachedCount = 0;
      for (const testCaseId of body.testCaseIds ?? []) {
        const c = state.cases.find((x) => x.testCaseId === testCaseId);
        if (c && c.scenarioNodeId !== body.scenarioNodeId) {
          c.scenarioNodeId = body.scenarioNodeId;
          attachedCount++;
        }
      }
      // 场景树计数跟着变；treeDrift 模拟「旧批次重复挂着」，计数和这次挂的条数对不上
      const bump = (nodes) => {
        for (const n of nodes ?? []) {
          if (n.id === body.scenarioNodeId) n.ownCaseCount = (n.ownCaseCount ?? 0) + attachedCount + (state.treeDrift ?? 0);
          bump(n.children);
        }
      };
      bump(state.tree);
      return ok({ attachedCount, scenarioPath: '' });
    },
```

- [ ] **Step 6: 跑，确认通过；再跑全套，确认夹具改动没影响 2c-1 的测试**

Run: 同 Step 3；再跑全部（Global Constraints 里的命令）。
Expected: testcenter.test 全过；全套全过。

- [ ] **Step 7: 提交**

```bash
git add miaodong-kit/src/testcenter.mjs miaodong-kit/test/helpers/testcenter-server.mjs miaodong-kit/test/helpers/testcenter-fixtures.mjs miaodong-kit/test/testcenter.test.mjs
git commit -m "feat(md): 测试中心接口层加批量建用例、挂场景；假秒懂按核对 8 的行为模拟"
```

---

### Task 2: casefile.mjs（一）：解析、历史、断言

**Files:**
- Create: `miaodong-kit/src/casefile.mjs`
- Test: `miaodong-kit/test/casefile.test.mjs`

**Interfaces:**
- Produces:
  - `TRIGGER_TYPES: string[]`（20 个）；`HISTORY_VAR = '消息历史'`；`isObject(v)`；
  - `parseCaseLines(text) → { rows: [{line, value}], errors: [{line, reason}] }`；
  - `byName(list, name, kind) → { hit } | { error }`；
  - `historyValue(items) → { value } | { error }`；
  - `buildExpect(expect, { events }) → { assertions, errors: string[] }`。

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGER_TYPES, buildExpect, historyValue, parseCaseLines } from '../src/casefile.mjs';
import { TARGET_BOT, botEvents } from './helpers/testcenter-fixtures.mjs';

const events = botEvents[TARGET_BOT];

test('parseCaseLines：去 BOM 和行尾 \\r、跳过空行；坏行带行号报出来，好行照收', () => {
  const { rows, errors } = parseCaseLines('﻿{"name":"a","text":"你好"}\r\n\r\n{坏的\r\n[1,2]\n{"name":"b","text":"在吗"}\n');
  assert.deepEqual(rows.map((r) => [r.line, r.value.name]), [[1, 'a'], [5, 'b']]);
  assert.deepEqual(errors.map((e) => e.line), [3, 4]);
  assert.match(errors[0].reason, /不是 JSON/);
  assert.match(errors[1].reason, /不是 JSON 对象/);
});

test('触发类型是核对 8 实测的 20 个', () => {
  assert.equal(TRIGGER_TYPES.length, 20);
  assert.ok(TRIGGER_TYPES.includes('canvas-event-trigger'));
});

test('historyValue：字符串记成 user；{role, content} 只认 user / assistant', () => {
  assert.deepEqual(historyValue(['我先问的', 'https://x/a.jpg', { role: 'assistant', content: '好的' }]).value, [
    { role: 'user', content: '我先问的' }, { role: 'user', content: 'https://x/a.jpg' }, { role: 'assistant', content: '好的' },
  ]);
  assert.match(historyValue([{ role: 'system', content: 'x' }]).error, /第 1 项/);
  assert.match(historyValue('一句话').error, /数组/);
});

test('buildExpect：字符串和 reply 生成发文本断言，两份内容一样（形状同核对 8）', () => {
  const { assertions, errors } = buildExpect(['应说明退款流程', { reply: { similar: '已为您登记' } }, { reply: { equal: '好的' } }], { events });
  assert.deepEqual(errors, []);
  assert.deepEqual(assertions.map((a) => a.verifyPayload.text), [
    { verifyType: 'llm', description: '应说明退款流程' },
    { verifyType: 'similarity', value: '已为您登记', threshold: 0.75 },
    { verifyType: 'equal', value: '好的' },
  ]);
  for (const a of assertions) assert.deepEqual(a.actionContent, { type: 'send-text-message', payload: { text: a.verifyPayload.text } });
});

test('buildExpect：转人工只有 type；发事件按名字换 id、带 eventName，params 核对事件变量名', () => {
  const { assertions, errors } = buildExpect([{ handover: true }, { event: '发送4.0', params: { text: '应礼貌', urls: { similar: 'https://x', threshold: 0.9 } } }], { events });
  assert.deepEqual(errors, []);
  assert.deepEqual(assertions[0], { verifyPayload: { type: 'handover' }, actionContent: { type: 'handover' } });
  const params = { text: { verifyType: 'llm', description: '应礼貌', value: '' }, urls: { verifyType: 'similarity', value: 'https://x', threshold: 0.9 } };
  assert.deepEqual(assertions[1], {
    verifyPayload: { type: 'canvas-event-action', eventId: 'tev-send', params },
    actionContent: { type: 'canvas-event-action', payload: { eventId: 'tev-send', eventName: '发送4.0', params } },
  });
});

test('buildExpect：写错的都报出来（写法不认识、事件或变量不存在、raw 两份类型不一致、阈值越界）；取不到事件列表也算错', () => {
  const { errors } = buildExpect([{ handover: false }, { event: '没有的事件' }, { event: '发送4.0', params: { txet: '拼错' } }, { raw: { verifyPayload: { type: 'tag-user' }, actionContent: { type: 'handover' } } }, { reply: { similar: 'x', threshold: 2 } }, { expected: 'x' }], { events });
  assert.equal(errors.length, 6);
  assert.match(errors.join('\n'), /handover: true[\s\S]*没有的事件[\s\S]*txet[\s\S]*type 一样[\s\S]*0 到 1[\s\S]*认不出来/);
  assert.match(buildExpect({ event: '发送4.0' }, { events: null }).errors[0], /取不到事件列表/);
});

test('buildExpect：raw 原样保留（打标签这类 md 不生成的断言用它）', () => {
  const tag = { verifyPayload: { type: 'tag-user', tagOperation: 'add', tagIds: ['t1'] }, actionContent: { type: 'tag-user', payload: { operation: 'add', tags: [{ tagId: 't1', tagName: '意向' }], tagIds: ['t1'] } } };
  assert.deepEqual(buildExpect({ raw: [tag] }, { events }).assertions, [tag]);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/casefile.test.mjs`
Expected: FAIL，找不到 `../src/casefile.mjs`。

- [ ] **Step 3: 实现**

```js
// 外部用例 JSONL（spec §6.3）：解析、本地校验、生成请求体。纯逻辑，不发请求。
// 断言只生成 spec §2.3 核对 8 实测过的形状：发文本、发事件、转人工；别的形状用 raw 原样写
// （断言写错时秒懂不报错，这条断言永远不生效）。

import { asArray } from './api.mjs';

// 服务端的触发类型枚举：核对 8 里 create 的 400 校验列出来的，共 20 个
export const TRIGGER_TYPES = ['input', 'receive-text-message', 'receive-image-message', 'receive-audio-message', 'receive-video-message', 'receive-file-message', 'receive-other-message', 'receive-intent-comment', 'receive-note-message', 'receive-share-note-comment-message', 'receive-email-message', 'custom-attr-event', 'tag-event', 'join-room', 'new-friend', 'canvas-event-trigger', 'bot-receive-text-message', 'write-message', 'contact-lead-filled', 'wecom-contact-bind'];

export const HISTORY_VAR = '消息历史';
const DEFAULT_THRESHOLD = 0.75; // 秒懂自动生成的相似度断言用的就是 0.75

export const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// 每行一个 JSON 对象；空行跳过；去掉 BOM 和行尾 \r（Excel、Windows 转出来的文件常带）
export function parseCaseLines(text) {
  const rows = [];
  const errors = [];
  String(text).replace(/^﻿/, '').split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      errors.push({ line: i + 1, reason: `不是 JSON：${error.message}` });
      return;
    }
    if (isObject(value)) rows.push({ line: i + 1, value });
    else errors.push({ line: i + 1, reason: '不是 JSON 对象（一行要是一个 {…}）' });
  });
  return { rows, errors };
}

// 按名字找唯一的一项：没有、重名都算错
export function byName(list, name, kind) {
  const hits = asArray(list).filter((x) => String(x?.name ?? '') === name);
  if (hits.length === 1) return { hit: hits[0] };
  return { error: hits.length ? `${kind}「${name}」在这个智能体里有 ${hits.length} 个同名` : `${kind}「${name}」在这个智能体里没有` };
}

// 「消息历史」的值：字符串记成 user 说的（图片写裸 URL）；对象要 {role: user 或 assistant, content}（真实历史里只见过这两种 role）
export function historyValue(items) {
  if (!Array.isArray(items)) return { error: 'history 要写成数组' };
  const value = [];
  for (const [i, item] of items.entries()) {
    if (typeof item === 'string') value.push({ role: 'user', content: item });
    else if (isObject(item) && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string') value.push({ role: item.role, content: item.content });
    else return { error: `history 第 ${i + 1} 项要么是字符串，要么是 {role: user 或 assistant, content: 字符串}` };
  }
  return { value };
}

// 判定写法（reply 和事件变量共用）：字符串 = LLM 判定；或者 {llm} / {similar, threshold} / {equal} 三选一。
// 事件变量的 LLM 判定带 value: ''，和真实用例里的一样（核对 8）
function verifyOf(spec, { param = false } = {}) {
  const llm = (description) => (param ? { verifyType: 'llm', description, value: '' } : { verifyType: 'llm', description });
  if (typeof spec === 'string') return spec.trim() ? { verify: llm(spec) } : { error: '判定不能是空字符串' };
  const keys = isObject(spec) ? ['llm', 'similar', 'equal'].filter((k) => spec[k] !== undefined) : [];
  const extra = isObject(spec) ? Object.keys(spec).filter((k) => !['llm', 'similar', 'equal', 'threshold'].includes(k)) : [];
  if (keys.length !== 1 || extra.length) return { error: '判定要写成字符串（LLM 判定），或者 {llm}、{similar, threshold}、{equal} 三选一' };
  const [kind] = keys;
  const text = spec[kind];
  if (typeof text !== 'string' || !text.trim()) return { error: `${kind} 要写成非空字符串` };
  if (spec.threshold !== undefined && kind !== 'similar') return { error: 'threshold 只用于 similar' };
  if (kind === 'llm') return { verify: llm(text) };
  if (kind === 'equal') return { verify: { verifyType: 'equal', value: text } };
  const threshold = spec.threshold ?? DEFAULT_THRESHOLD;
  if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) return { error: 'threshold 要是 0 到 1 之间的数' };
  return { verify: { verifyType: 'similarity', value: text, threshold } };
}

const failed = (message) => ({ assertions: [], errors: [message] });

// 一种写法 → 断言
function formAssertions(form, events) {
  const keys = isObject(form) ? Object.keys(form) : [];
  if (typeof form === 'string' || keys.includes('reply')) {
    if (keys.length > 1) return failed('reply 要单独写一项');
    const { verify, error } = verifyOf(typeof form === 'string' ? form : form.reply);
    if (error) return failed(error);
    return { assertions: [{ verifyPayload: { type: 'send-text-message', text: verify }, actionContent: { type: 'send-text-message', payload: { text: verify } } }], errors: [] };
  }
  if (keys.includes('handover')) {
    if (form.handover !== true || keys.length > 1) return failed('转人工写成 {handover: true}');
    return { assertions: [{ verifyPayload: { type: 'handover' }, actionContent: { type: 'handover' } }], errors: [] };
  }
  if (keys.includes('event')) {
    const extra = keys.filter((k) => !['event', 'params'].includes(k));
    if (extra.length) return failed(`发事件只认 event、params，多了 ${extra.join('、')}`);
    if (!events) return failed(`取不到事件列表，没法把「${form.event}」换成 id`);
    const { hit, error } = byName(events, String(form.event ?? ''), '事件');
    if (error) return failed(error);
    if (form.params !== undefined && !isObject(form.params)) return failed('params 要写成 {事件变量名: 判定}');
    const known = new Set(asArray(hit.variables).map((v) => String(v?.name ?? '')));
    const params = {};
    const errors = [];
    for (const [name, spec] of Object.entries(form.params ?? {})) {
      if (!known.has(name)) {
        errors.push(`事件「${hit.name}」没有变量「${name}」`);
        continue;
      }
      const { verify, error: problem } = verifyOf(spec, { param: true });
      if (problem) errors.push(`params.${name}：${problem}`);
      else params[name] = verify;
    }
    if (errors.length) return { assertions: [], errors };
    return { assertions: [{ verifyPayload: { type: 'canvas-event-action', eventId: hit.eventId, params }, actionContent: { type: 'canvas-event-action', payload: { eventId: hit.eventId, eventName: hit.name, params } } }], errors: [] };
  }
  if (keys.includes('raw')) {
    if (keys.length > 1) return failed('raw 要单独写一项');
    const list = Array.isArray(form.raw) ? form.raw : [form.raw];
    const bad = list.some((a) => !isObject(a) || typeof a?.verifyPayload?.type !== 'string' || a?.actionContent?.type !== a.verifyPayload.type);
    return bad ? failed('raw 断言要有 verifyPayload 和 actionContent，两份的 type 一样') : { assertions: list, errors: [] };
  }
  return failed('认不出来。可以写字符串、{reply}、{handover: true}、{event, params}、{raw}');
}

// expect → canvasActionOutputAssertions，顺序照写的顺序。events 取不到时是 null
export function buildExpect(expect, { events }) {
  const forms = expect === undefined ? [] : Array.isArray(expect) ? expect : [expect];
  const assertions = [];
  const errors = [];
  forms.forEach((form, i) => {
    const at = forms.length > 1 ? `expect 第 ${i + 1} 项` : 'expect';
    const one = formAssertions(form, events);
    assertions.push(...one.assertions);
    errors.push(...one.errors.map((e) => `${at}：${e}`));
  });
  return { assertions, errors };
}
```

- [ ] **Step 4: 跑，确认通过**

Run: 同 Step 2。
Expected: 7 个测试全过。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/casefile.mjs miaodong-kit/test/casefile.test.mjs
git commit -m "feat(md): 外部用例 JSONL 解析、聊天历史和断言生成（只生成核对 8 实测过的形状）"
```

---

### Task 3: casefile.mjs（二）：一行生成一条用例、全部校验、场景

**Files:**
- Modify: `miaodong-kit/src/casefile.mjs`
- Test: `miaodong-kit/test/casefile.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `TRIGGER_TYPES / HISTORY_VAR / isObject / byName / historyValue / buildExpect`。
- Produces:
  - `flattenTree(tree) → [{id, name, path, ownCaseCount}]`；
  - `resolveScenario(nodes, query) → { hit } | { error }`；
  - `buildCase(row, { events, vars, scenarios }) → { testCase, scenarioNodeId, errors: string[], warnings: string[] }`（`scenarios` 是 null 表示这个区没有场景树）；
  - `buildCases(rows, ctx, { existingNames = [] }) → { built: [{line, testCase, scenarioNodeId, errors, warnings}], errors: [{line, name, reason}] }`。

- [ ] **Step 1: 写失败的测试**

`casefile.test.mjs`：import 改成下面这样，再在末尾追加测试：

```js
import { TRIGGER_TYPES, buildCase, buildCases, buildExpect, flattenTree, historyValue, parseCaseLines } from '../src/casefile.mjs';
import { TARGET_BOT, botEvents, botVars, scenarioTreeFixture } from './helpers/testcenter-fixtures.mjs';
```

```js
const ctx = { events, vars: botVars[TARGET_BOT], scenarios: flattenTree(scenarioTreeFixture()) };
const row = (value, line = 1) => ({ line, value });
const llmReply = (description) => ({ verifyPayload: { type: 'send-text-message', text: { verifyType: 'llm', description } }, actionContent: { type: 'send-text-message', payload: { text: { verifyType: 'llm', description } } } });

test('buildCase：文本用例——text 进触发输入，history 进「消息历史」，vars 按名字换 id；name 去空格；_ 开头的字段不管', () => {
  const { testCase, errors, warnings } = buildCase(row({ name: ' 退款-01 ', text: '我想退款', history: ['之前问过价格'], vars: { 客户备注: '老客户', 已发优惠: true }, expect: '应说明退款流程', _row: 12 }), ctx);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(testCase, {
    name: '退款-01', triggerType: 'receive-text-message', triggerInputs: { text: '我想退款' },
    sessionMemoryCustomData: { 'tv-hist': [{ role: 'user', content: '之前问过价格' }], 'tv-note': '老客户', 'tv-flag': true },
    pluginMockOutputs: [], sqlDbMockOutputs: [], testNodeOutputAssertions: [],
    canvasActionOutputAssertions: [llmReply('应说明退款流程')],
    isStrictVerify: false,
  });
});

test('buildCase：图片用例推成 receive-image-message；写了 text 报错并说明文字要进 history', () => {
  const ok = buildCase(row({ name: '图-01', image: 'https://x/b.jpg', history: ['这张图是什么'] }), ctx);
  assert.deepEqual([ok.testCase.triggerType, ok.testCase.triggerInputs], ['receive-image-message', { imageUrl: 'https://x/b.jpg' }]);
  assert.match(buildCase(row({ name: '图-02', image: 'https://x/b.jpg', text: '这是什么' }), ctx).errors.join(), /history/);
});

test('buildCase：事件用例按名字换 eventId；data 的变量名要在事件里有、类型对得上', () => {
  const ok = buildCase(row({ name: '事件-01', event: '延时回复', data: { text: '课程怎么退' }, expect: { event: '发送4.0', params: { text: '应说明退课流程' } } }), ctx);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual([ok.testCase.triggerType, ok.testCase.triggerInputs], ['canvas-event-trigger', { eventId: 'tev-delay', data: { text: '课程怎么退' } }]);
  assert.match(buildCase(row({ name: '事件-02', event: '延时回复', data: { txt: 'x' } }), ctx).errors.join(), /没有变量「txt」/);
  assert.match(buildCase(row({ name: '事件-03', event: '延时回复', data: { text: 1 } }), ctx).errors.join(), /要字符串/);
});

test('buildCase：input 要和 trigger 一起写、不能和简写混用；没有简写的触发只能用 input；不认识的字段报错', () => {
  assert.deepEqual(buildCase(row({ name: 'i-1', trigger: 'receive-other-message', input: { rawContent: 'x' } }), ctx).errors, []);
  assert.match(buildCase(row({ name: 'i-2', input: { text: 'x' } }), ctx).errors.join(), /要写 trigger/);
  assert.match(buildCase(row({ name: 'i-3', trigger: 'receive-text-message', input: { text: 'x' }, text: 'y' }), ctx).errors.join(), /不能和 text 一起写/);
  assert.match(buildCase(row({ name: 'i-4', trigger: 'new-friend' }), ctx).errors.join(), /没有简写/);
  assert.match(buildCase(row({ name: 'i-5', trigger: 'x-invalid', input: {} }), ctx).errors.join(), /不是秒懂的触发类型/);
  assert.match(buildCase(row({ name: 'i-6', text: 'x', expected: 'y' }), ctx).errors.join(), /不认识的字段：expected/);
});

test('buildCase：会话变量不存在、类型不对、和 history 重复都报错；取不到列表时用到了才报错', () => {
  const errs = buildCase(row({ name: 'v-1', text: 'x', vars: { 不存在: 1, 已发优惠: 'true', 消息历史: [] }, history: [] }), ctx).errors.join('\n');
  assert.match(errs, /不存在」在这个智能体里没有/);
  assert.match(errs, /已发优惠」要布尔值/);
  assert.match(errs, /写了两遍/);
  assert.match(buildCase(row({ name: 'v-2', text: 'x', history: ['a'] }), { ...ctx, vars: null }).errors.join(), /取不到会话变量列表/);
  assert.deepEqual(buildCase(row({ name: 'v-3', text: 'x' }), { ...ctx, vars: null, events: null }).errors, []);
});

test('buildCase：场景按名字或路径找；同名要写路径；这个区没有场景树时只提醒', () => {
  assert.equal(buildCase(row({ name: 's-1', text: 'x', scenario: '退款' }), ctx).scenarioNodeId, 'sn-refund');
  assert.equal(buildCase(row({ name: 's-2', text: 'x', scenario: '咨询/课程' }), ctx).scenarioNodeId, 'sn-consult-course');
  assert.match(buildCase(row({ name: 's-3', text: 'x', scenario: '课程' }), ctx).errors.join(), /2 个同名.*写完整路径/);
  assert.match(buildCase(row({ name: 's-4', text: 'x', scenario: '不存在' }), ctx).errors.join(), /没有场景「不存在」/);
  const old = buildCase(row({ name: 's-5', text: 'x', expect: 'y', scenario: '退款' }), { ...ctx, scenarios: null });
  assert.deepEqual([old.errors, old.scenarioNodeId, old.warnings], [[], null, ['这个区没有场景树，scenario 不挂']]);
});

test('buildCases：name 在文件里重复、和集里已有的重复都报出来（带行号）；没写 expect 只提醒', () => {
  const { built, errors } = buildCases([row({ name: 'a', text: 'x' }, 1), row({ name: 'a', text: 'y', expect: 'z' }, 2), row({ name: '旧的', text: 'z', expect: 'z' }, 3)], ctx, { existingNames: ['旧的'] });
  assert.deepEqual(errors.map((e) => [e.line, e.reason]), [[1, 'name「a」在第 1、2 行重复'], [2, 'name「a」在第 1、2 行重复'], [3, 'name「旧的」集里已经有了']]);
  assert.deepEqual(built[0].warnings, ['没写 expect：没有断言，跑了只能看实际回复']);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/casefile.test.mjs`
Expected: FAIL，`buildCase` 没有导出。

- [ ] **Step 3: 实现**（追加到 `casefile.mjs` 末尾）

```js
const FIELDS = new Set(['name', 'trigger', 'text', 'image', 'event', 'data', 'input', 'history', 'vars', 'expect', 'scenario', 'dimension', 'strict', 'mocks']);
const TYPE_WORD = { string: '字符串', number: '数字', boolean: '布尔值', array: '数组' };

// 值和变量类型对不上时说要什么；tag、datetime 等类型不核对
function typeProblem(value, type) {
  const want = typeof type === 'string' ? type : type?.type;
  if (!TYPE_WORD[want]) return null;
  const ok = want === 'array' ? Array.isArray(value) : typeof value === want;
  return ok ? null : `要${TYPE_WORD[want]}`;
}

// 场景树拍平：每个节点带路径（父/子）
export function flattenTree(tree) {
  const out = [];
  const walk = (nodes, parent) => {
    for (const n of asArray(nodes)) {
      const name = String(n?.name ?? '');
      const path = String(n?.path || (parent ? `${parent}/${name}` : name));
      out.push({ id: n?.id, name, path, ownCaseCount: Number(n?.ownCaseCount) || 0 });
      walk(n?.children, path);
    }
  };
  walk(tree, '');
  return out;
}

// 带「/」按路径找，否则按名字找；同名的要求写路径
export function resolveScenario(nodes, query) {
  const hits = nodes.filter((n) => (query.includes('/') ? n.path === query : n.name === query));
  if (hits.length === 1) return { hit: hits[0] };
  if (hits.length > 1) return { error: `场景「${query}」有 ${hits.length} 个同名，写完整路径（父/子）：${hits.map((n) => n.path).join('、')}` };
  return { error: `没有场景「${query}」` };
}

// 触发：简写或 input → [triggerType, triggerInputs]。不写 trigger 时按简写推（spec §6.3）
function triggerOf(v, events, errors) {
  const shorthand = ['text', 'image', 'event', 'data'].filter((k) => v[k] !== undefined);
  if (v.trigger !== undefined && !TRIGGER_TYPES.includes(v.trigger)) {
    errors.push(`trigger「${v.trigger}」不是秒懂的触发类型`);
    return [v.trigger, {}];
  }
  if (v.input !== undefined) {
    if (shorthand.length) errors.push(`input 不能和 ${shorthand.join('、')} 一起写`);
    if (v.trigger === undefined) errors.push('写了 input 就要写 trigger');
    if (!isObject(v.input)) {
      errors.push('input 要写成对象（完整的 triggerInputs）');
      return [v.trigger, {}];
    }
    if (v.trigger === 'canvas-event-trigger' && events && !events.some((e) => e.eventId === v.input.eventId)) errors.push(`input.eventId「${v.input.eventId}」在这个智能体里没有`);
    return [v.trigger, v.input];
  }
  const trigger = v.trigger ?? (v.event !== undefined ? 'canvas-event-trigger' : v.image !== undefined ? 'receive-image-message' : v.text !== undefined ? 'receive-text-message' : undefined);
  const only = (allowed) => {
    const extra = shorthand.filter((k) => !allowed.includes(k));
    if (extra.length) errors.push(`${trigger} 用例不写 ${extra.join('、')}`);
  };
  if (trigger === 'receive-text-message') {
    only(['text']);
    if (typeof v.text !== 'string' || !v.text.trim()) errors.push('文本用例要写 text');
    return [trigger, { text: v.text }];
  }
  if (trigger === 'receive-image-message') {
    // 用户另发的文字属于聊天历史（IM 里文字和图片是两条消息）；triggerInputs.text 在秒懂里是图片自带的说明文字
    if (v.text !== undefined) errors.push('图片用例不写 text：用户另发的文字写进 history（text 在秒懂里是图片自带的说明文字）');
    only(['image', 'text']);
    if (typeof v.image !== 'string' || !v.image.trim()) errors.push('图片用例要写 image（最后一张图的 URL）');
    return [trigger, { imageUrl: v.image }];
  }
  if (trigger === 'canvas-event-trigger') {
    only(['event', 'data']);
    if (v.data !== undefined && !isObject(v.data)) errors.push('data 要写成 {事件变量名: 值}');
    if (!events) {
      errors.push(`取不到事件列表，没法把「${v.event}」换成 id`);
      return [trigger, {}];
    }
    const { hit, error } = byName(events, String(v.event ?? ''), '事件');
    if (error) {
      errors.push(error);
      return [trigger, {}];
    }
    const variables = new Map(asArray(hit.variables).map((x) => [String(x?.name ?? ''), x]));
    const data = isObject(v.data) ? v.data : {};
    for (const [key, value] of Object.entries(data)) {
      if (!variables.has(key)) errors.push(`事件「${hit.name}」没有变量「${key}」`);
      else {
        const problem = typeProblem(value, variables.get(key).type);
        if (problem) errors.push(`事件变量「${key}」${problem}`);
      }
    }
    return [trigger, { eventId: hit.eventId, data }];
  }
  if (trigger === undefined) errors.push('缺触发：写 text、image、event 之一，或者 trigger + input');
  else errors.push(`「${trigger}」没有简写，要写 input（完整的 triggerInputs）`);
  return [trigger, {}];
}

// 会话数据：history 写进「消息历史」，vars 按名字换成 id
function sessionOf(v, vars, errors) {
  const session = {};
  if (v.history !== undefined) {
    const history = historyValue(v.history);
    if (history.error) errors.push(history.error);
    else if (!vars) errors.push('取不到会话变量列表，history 写不进去');
    else {
      const { hit, error } = byName(vars, HISTORY_VAR, '会话变量');
      if (error) errors.push(`${error}，history 写不进去（可以用 vars 写进别的变量）`);
      else session[hit.id] = history.value;
    }
  }
  if (v.vars !== undefined) {
    if (!isObject(v.vars)) errors.push('vars 要写成 {会话变量名: 值}');
    else if (!vars) errors.push('取不到会话变量列表，没法把 vars 的名字换成 id');
    else {
      for (const [varName, value] of Object.entries(v.vars)) {
        const { hit, error } = byName(vars, varName, '会话变量');
        if (error) {
          errors.push(error);
          continue;
        }
        if (hit.id in session) {
          errors.push(`「${varName}」写了两遍（history 就是写进「${HISTORY_VAR}」的）`);
          continue;
        }
        const problem = typeProblem(value, hit.type);
        if (problem) errors.push(`会话变量「${varName}」${problem}`);
        else session[hit.id] = value;
      }
    }
  }
  return session;
}

// 一行 → 一条用例（create 的请求体）。ctx.scenarios 是 null 表示这个区没有场景树
export function buildCase(row, { events, vars, scenarios }) {
  const v = row.value;
  const errors = [];
  const warnings = [];
  const unknown = Object.keys(v).filter((k) => !k.startsWith('_') && !FIELDS.has(k));
  if (unknown.length) errors.push(`不认识的字段：${unknown.join('、')}（自己的备注写在 _ 开头的字段里）`);
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) errors.push('缺 name');
  const [triggerType, triggerInputs] = triggerOf(v, events, errors);
  const sessionMemoryCustomData = sessionOf(v, vars, errors);
  const expect = buildExpect(v.expect, { events });
  errors.push(...expect.errors);
  if (v.expect === undefined) warnings.push('没写 expect：没有断言，跑了只能看实际回复');
  let scenarioNodeId = null;
  if (v.scenario !== undefined) {
    if (typeof v.scenario !== 'string' || !v.scenario.trim()) errors.push('scenario 要写场景名或路径');
    else if (scenarios === null) warnings.push('这个区没有场景树，scenario 不挂');
    else {
      const { hit, error } = resolveScenario(scenarios, v.scenario.trim());
      if (error) errors.push(error);
      else scenarioNodeId = hit.id;
    }
  }
  if (v.dimension !== undefined && typeof v.dimension !== 'string') errors.push('dimension 要写成字符串');
  if (v.strict !== undefined && typeof v.strict !== 'boolean') errors.push('strict 要写成 true 或 false');
  const mocks = v.mocks ?? {};
  const mocksOk = isObject(mocks) && Object.keys(mocks).every((k) => ['plugin', 'sql'].includes(k)) && [mocks.plugin, mocks.sql].every((m) => m === undefined || Array.isArray(m));
  if (!mocksOk) errors.push('mocks 要写成 {plugin: [...], sql: [...]}');
  const testCase = {
    name, triggerType, triggerInputs, sessionMemoryCustomData,
    pluginMockOutputs: mocksOk && mocks.plugin ? mocks.plugin : [],
    sqlDbMockOutputs: mocksOk && mocks.sql ? mocks.sql : [],
    testNodeOutputAssertions: [],
    canvasActionOutputAssertions: expect.assertions,
    isStrictVerify: v.strict === true,
    ...(typeof v.dimension === 'string' ? { dimension: v.dimension } : {}),
  };
  return { testCase, scenarioNodeId, errors, warnings };
}

// 全部行：逐行生成，再查 name 重复（文件里、和集里已有的）。有错误就一条都不写（spec §6.3 第 1 步）
export function buildCases(rows, ctx, { existingNames = [] } = {}) {
  const built = rows.map((row) => ({ line: row.line, ...buildCase(row, ctx) }));
  const lines = new Map();
  for (const b of built) if (b.testCase.name) lines.set(b.testCase.name, [...(lines.get(b.testCase.name) ?? []), b.line]);
  const existing = new Set(existingNames);
  for (const b of built) {
    const at = lines.get(b.testCase.name) ?? [];
    if (at.length > 1) b.errors.push(`name「${b.testCase.name}」在第 ${at.join('、')} 行重复`);
    if (existing.has(b.testCase.name)) b.errors.push(`name「${b.testCase.name}」集里已经有了`);
  }
  const errors = built.flatMap((b) => b.errors.map((reason) => ({ line: b.line, name: b.testCase.name, reason })));
  return { built, errors };
}
```

- [ ] **Step 4: 跑，确认通过**

Run: 同 Step 2。
Expected: 14 个测试全过。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/casefile.mjs miaodong-kit/test/casefile.test.mjs
git commit -m "feat(md): 外部用例逐行生成与本地校验（触发简写、会话变量、场景、name 重复）"
```

---

### Task 4: 回读核对 caseDiffs

**Files:**
- Modify: `miaodong-kit/src/testcases.mjs`
- Test: `miaodong-kit/test/testcases.test.mjs`

**Interfaces:**
- Produces:
  - `CRITICAL_FIELDS: string[]`；
  - `fieldLabel(field) → 中文名`；
  - `caseDiffs(sent, got, fields = Object.keys(sent)) → [{ field, critical }]`（只比 `WRITABLE_FIELDS` 里的）。

- [ ] **Step 1: 写失败的测试**（`testcases.test.mjs` 的 import 加上 `CRITICAL_FIELDS, caseDiffs, fieldLabel`，末尾追加）

```js
test('caseDiffs：只比 update 会写的字段；关键字段（name、触发、会话数据、断言）和非关键字段（dimension 等）分开', () => {
  const sent = { name: 'a', triggerType: 'receive-text-message', triggerInputs: { text: 'x' }, sessionMemoryCustomData: { v: 1 }, canvasActionOutputAssertions: [], testNodeOutputAssertions: [], dimension: '分类', isStrictVerify: false, testCaseId: 'c1' };
  const got = { ...sent, sessionMemoryCustomData: {}, dimension: '', status: 'ready' };
  assert.deepEqual(caseDiffs(sent, got), [{ field: 'sessionMemoryCustomData', critical: true }, { field: 'dimension', critical: false }]);
  assert.deepEqual(caseDiffs(sent, got, ['dimension']), [{ field: 'dimension', critical: false }]);
  assert.deepEqual(caseDiffs(sent, undefined).map((d) => d.field).sort(), ['canvasActionOutputAssertions', 'dimension', 'isStrictVerify', 'name', 'sessionMemoryCustomData', 'testNodeOutputAssertions', 'triggerInputs', 'triggerType']);
  assert.ok(CRITICAL_FIELDS.includes('canvasActionOutputAssertions'));
  assert.equal(fieldLabel('sessionMemoryCustomData'), '会话数据');
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/testcases.test.mjs`
Expected: FAIL，`caseDiffs` 没有导出。

- [ ] **Step 3: 实现**（`testcases.mjs` 顶部 import 加两行，文件末尾追加）

```js
import { stableStringify } from './canvas.mjs';
import { WRITABLE_FIELDS } from './testcenter.mjs';
```

```js
// 回读核对（spec §6.3 第 3、5 步，§6.4）：只比 update 会写的字段。关键字段不对，这条就不是写进去的那条用例；
// 非关键字段有的区不保存（核对 8：兴趣岛丢 dimension），只提醒
export const CRITICAL_FIELDS = ['name', 'triggerType', 'triggerInputs', 'sessionMemoryCustomData', 'testNodeOutputAssertions', 'canvasActionOutputAssertions'];
const LABELS = { name: 'name', dimension: 'dimension', triggerType: '触发类型', triggerInputs: '触发输入', sessionMemoryCustomData: '会话数据', pluginMockOutputs: '插件 mock', sqlDbMockOutputs: '数据库 mock', testNodeOutputAssertions: '节点断言', canvasActionOutputAssertions: '断言', isStrictVerify: '严格校验' };
export const fieldLabel = (field) => LABELS[field] ?? field;

export function caseDiffs(sent, got, fields = Object.keys(sent ?? {})) {
  return fields
    .filter((field) => WRITABLE_FIELDS.includes(field) && stableStringify(sent?.[field]) !== stableStringify(got?.[field]))
    .map((field) => ({ field, critical: CRITICAL_FIELDS.includes(field) }));
}
```

- [ ] **Step 4: 跑，确认通过**

Run: 同 Step 2。
Expected: 全过。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/testcases.mjs miaodong-kit/test/testcases.test.mjs
git commit -m "feat(md): 用例回读核对，区分关键字段和这个区可能不保存的字段"
```

---

### Task 5: `md test import --from-file`

**Files:**
- Create: `miaodong-kit/src/commands/test-import-file.mjs`
- Modify: `miaodong-kit/src/commands/test-import.mjs`（`importCmd` 开头按 `--from-file` 分过去）
- Modify: `miaodong-kit/src/commands/test.mjs`（USAGE、summary）
- Test: `miaodong-kit/test/test-cli-cases.test.mjs`（新文件）

**Interfaces:**
- Consumes：
  - Task 1 的 `createCases / attachCases`；
  - Task 3 的 `parseCaseLines / buildCases / flattenTree`；
  - Task 4 的 `caseDiffs / fieldLabel`。
- Produces: `importFile(t, { name, file, into }) → EXIT.OK | EXIT.ERROR`。

- [ ] **Step 1: 写失败的测试**（新文件 `test-cli-cases.test.mjs`）

```js
// md test import --from-file / md test edit：外部用例和批量改（spec §6.3、§6.4），对着假秒懂跑真命令
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startTestCenterServer } from './helpers/testcenter-server.mjs';
import { scenarioTreeFixture } from './helpers/testcenter-fixtures.mjs';

let fake;
before(async () => { fake = await startTestCenterServer(); });
after(() => fake.server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const reset = (patch = {}) => Object.assign(fake.state, { sets: [], cases: [], tasks: [], items: new Map(), posts: {}, log: [], canvas: null, tree: [], pageCap: undefined, keepDimension: false, dropFields: [], failCreateAt: 0, treeDrift: 0, ...patch });
const jsonl = (h, rows, file = 'cases.jsonl') => {
  const path = join(h, file);
  writeFileSync(path, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  return path;
};
const casesIn = (setName) => {
  const set = fake.state.sets.find((s) => s.name === setName);
  return set ? fake.state.cases.filter((c) => c.testSetId === set.testSetId) : [];
};
const withoutScenario = (rows) => rows.map(({ scenario, ...rest }) => rest);

const THREE = [
  { name: '退款-01', text: '我想退款', history: ['之前问过价格'], expect: '应说明退款流程', dimension: '退款', scenario: '退款' },
  { name: '图片-01', image: 'https://x/b.jpg', history: ['这张图是什么'], expect: { reply: { similar: '这是一张图' } } },
  { name: '事件-01', event: '延时回复', data: { text: '课程怎么退' }, expect: [{ event: '发送4.0', params: { text: '应说明退课流程' } }, { handover: true }], scenario: '咨询/课程' },
];

test('import --from-file：先写 1 条读回来核对，其余一批写完，按 name 回读、挂场景；这个区丢 dimension 只提醒', async () => {
  reset({ tree: scenarioTreeFixture() });
  const h = home();
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, THREE)], h);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(fake.state.posts.caseCreate.map((p) => p.testCases.length), [1, 2]);
  assert.equal(casesIn('外部回归').length, 3);
  assert.match(r.stdout, /提交 3 · 回读 3 · 挂场景 2/);
  assert.match(r.stdout, /这个区不保存 dimension/);
  const stored = casesIn('外部回归').find((c) => c.name === '事件-01');
  assert.equal(stored.scenarioNodeId, 'sn-consult-course');
  assert.deepEqual(stored.triggerInputs, { eventId: 'tev-delay', data: { text: '课程怎么退' } });
  assert.deepEqual(stored.canvasActionOutputAssertions[1], { verifyPayload: { type: 'handover' }, actionContent: { type: 'handover' } });
  assert.deepEqual(fake.state.posts.attach.map((p) => [p.scenarioNodeId, p.testCaseIds.length]), [['sn-refund', 1], ['sn-consult-course', 1]]);
  assert.match(r.stdout, /下一步：md test run 外部回归/);
});

test('import --from-file：本地校验有错就一条都不写，带行号列出全部错误', async () => {
  reset({ tree: scenarioTreeFixture() });
  const h = home();
  const file = jsonl(h, [THREE[0], '{坏的', { name: '退款-01', text: '重名' }, { name: '事件-02', event: '没有的事件' }, { name: '拼错', text: 'x', expected: 'y' }]);
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', file], h);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /❌ .*5 处错误，一条都没写/);
  assert.match(r.stdout, /第 2 行：不是 JSON/);
  assert.match(r.stdout, /第 3 行「退款-01」：name「退款-01」在第 1、3 行重复/);
  assert.match(r.stdout, /第 4 行「事件-02」：事件「没有的事件」在这个智能体里没有/);
  assert.match(r.stdout, /第 5 行「拼错」：不认识的字段：expected/);
  assert.deepEqual(fake.state.log, []);
});

test('import --from-file：先写的 1 条关键字段被丢（会话数据）→ 撤回这 1 条、删掉新建的集，其余不写', async () => {
  reset({ dropFields: ['sessionMemoryCustomData'] });
  const h = home();
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, withoutScenario(THREE))], h);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /先写的第 1 条（第 1 行「退款-01」）这些字段读回来不一样：会话数据.*已撤回，也删了新建的测试集/);
  assert.equal(fake.state.posts.caseCreate.length, 1);
  assert.deepEqual([fake.state.sets, fake.state.cases], [[], []]);
});

test('import --from-file --into：和集里已有的 name 重复就拦下；不重复的追加进去', async () => {
  reset();
  const h = home();
  await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, [{ name: '旧-01', text: 'x', expect: 'y' }])], h);
  const dup = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--into', '--from-file', jsonl(h, [{ name: '旧-01', text: 'x', expect: 'y' }], 'b.jsonl')], h);
  assert.equal(dup.code, 1);
  assert.match(dup.stdout, /name「旧-01」集里已经有了/);
  const ok = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--into', '--from-file', jsonl(h, [{ name: '新-01', text: 'x', expect: 'y' }], 'c.jsonl')], h);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /导进已有的测试集「外部回归」/);
  assert.deepEqual(casesIn('外部回归').map((c) => c.name).sort(), ['新-01', '旧-01']);
});

test('import --from-file：没有场景树的区 scenario 只提醒、不挂；同名集已存在要加 --into；不能和 --from-execs 一起给', async () => {
  reset({ tree: null });
  const h = home();
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, THREE.slice(0, 1))], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /这个区没有场景树，scenario 不挂（1 条）/);
  assert.equal(fake.state.posts.attach, undefined);
  const again = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, [{ name: 'x', text: 'y' }], 'b.jsonl')], h);
  assert.equal(again.code, 5);
  assert.match(again.stderr, /已经有测试集「外部回归」/);
  const mixed = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', 'a.jsonl', '--from-execs', 'b'], h);
  assert.equal(mixed.code, 2);
});

test('import --from-file：写到一半出错，说清测试集已经建了、可能写进去一部分，怎么查、怎么接着导', async () => {
  reset({ failCreateAt: 2 });
  const h = home();
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, withoutScenario(THREE))], h);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /测试集「外部回归」\([0-9a-f]{8}\) 已经建了，可能已经写进去一部分/);
  assert.match(r.stderr, /用 --into 重导时已经写进去的 name 会被拦下/);
});

test('import --from-file：场景计数和挂的条数对不上就提醒（旧批次重复挂载）；回读翻页读全', async () => {
  reset({ tree: scenarioTreeFixture(), treeDrift: 1, pageCap: 2 });
  const h = home();
  const rows = Array.from({ length: 5 }, (_, i) => ({ name: `退款-${i + 1}`, text: `问题 ${i + 1}`, expect: '应说明退款流程', scenario: '退款' }));
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, rows)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /提交 5 · 回读 5 · 挂场景 5/);
  assert.match(r.stdout, /场景「退款」用例数变了 6，这次挂的是 5 条/);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/test-cli-cases.test.mjs`
Expected: FAIL（`--from-file` 还不认：报「缺 --from-execs」，退出码 2）。

- [ ] **Step 3: 实现命令** `src/commands/test-import-file.mjs`

```js
// md test import <集> --from-file <cases.jsonl> [--into]（spec §6.3）：外部用例。
// 本地先校验全部用例，有错就一条都不写 → 先写 1 条读回来核对，关键字段被丢就撤回 → 其余每批 50 条 →
// 按 name 回读拿 id → 按场景挂 → 逐字段审计、场景计数对账。

import { existsSync, readFileSync } from 'node:fs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { note, out, shortId, targetLine } from '../output.mjs';
import { listEvents, listSessions } from '../api.mjs';
import { attachCases, createCases, createTestSet, deleteCases, deleteTestSet, listCases, listTestSets, scenarioTree } from '../testcenter.mjs';
import { buildCases, flattenTree, parseCaseLines } from '../casefile.mjs';
import { caseDiffs, fieldLabel } from '../testcases.mjs';
import { resolveTestSet } from '../test-common.mjs';

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

// 写到一半出错：说清留下了什么、怎么查、怎么接着导（同 --from-execs）
function partial(t, set, created, error) {
  return new MdError(error?.code ?? 'upstream', `${error?.message ?? error}（测试集「${set.name}」(${shortId(set.testSetId)}) ${created ? '已经建了' : '是已有的'}，可能已经写进去一部分）`, {
    exitCode: error?.exitCode,
    hint: `md test cases ${set.testSetId} --bot ${shortId(t.botId)} 看写进去了哪些；用 --into 重导时已经写进去的 name 会被拦下，只导缺的那几行`,
  });
}

// 先写第 1 条读回来：关键字段被服务端丢了，就撤回这 1 条（新建的集整个删掉）再报错；非关键字段丢了提醒后继续。
// 返回这个区不保存的非关键字段，后面的审计就不再重复提醒
async function canary(t, set, created, first) {
  try {
    await createCases(t, set.testSetId, [first.testCase]);
  } catch (error) {
    throw partial(t, set, created, error);
  }
  const rows = await listCases(t, set.testSetId);
  const got = rows.find((c) => c.name === first.testCase.name);
  const diffs = got ? caseDiffs(first.testCase, got) : [];
  const soft = diffs.filter((d) => !d.critical).map((d) => d.field);
  if (got && soft.length === diffs.length) {
    if (soft.length) out(`⚠️ 这个区不保存 ${soft.map(fieldLabel).join('、')}（先写的 1 条读回来不一样）：分类、溯源信息请写进 name。其余照写`);
    return new Set(soft);
  }
  // 撤回：新建的集里只有这 1 条，全删；导进已有的集时，只删按 name 找到的那条
  const doomed = created ? rows.map((c) => c.testCaseId) : got ? [got.testCaseId] : [];
  if (doomed.length) await deleteCases(t, doomed);
  const left = (await listCases(t, set.testSetId)).filter((c) => doomed.includes(c.testCaseId)).length;
  if (created && !left) await deleteTestSet(t, set.testSetId);
  const what = got ? `这些字段读回来不一样：${diffs.filter((d) => d.critical).map((d) => fieldLabel(d.field)).join('、')}` : '按 name 找不到';
  const tail = left
    ? `；还剩 ${left} 条没删掉，用 md test drop ${set.testSetId} --bot ${shortId(t.botId)} 清理`
    : created ? '，也删了新建的测试集' : got ? '' : `；集里可能多了一条，用 md test cases ${set.testSetId} --bot ${shortId(t.botId)} 看`;
  throw new MdError('canary_failed', `先写的第 1 条（第 ${first.line} 行「${first.testCase.name}」）${what}：秒懂没存下 md 写的内容，已撤回${tail}`, {
    hint: '可能是这个区的版本字段不一样：把这一行改用 input / raw 原样写法再试；还不行就告诉 md 的维护者',
  });
}

// 按场景分组挂上去；挂之前（导入开始时读的树）和挂之后各看一次场景树，每个节点的用例数变化要等于这次挂的条数（spec §6.3 第 5 步）
async function attachAll(t, built, back, tree) {
  const groups = new Map();
  for (const b of built) {
    const got = back.get(b.testCase.name);
    if (b.scenarioNodeId && got) groups.set(b.scenarioNodeId, [...(groups.get(b.scenarioNodeId) ?? []), got.testCaseId]);
  }
  if (!groups.size) return { attached: 0, notes: [] };
  const before = new Map(flattenTree(tree.tree).map((n) => [n.id, n.ownCaseCount]));
  let attached = 0;
  const notes = [];
  try {
    for (const [nodeId, ids] of groups) {
      const n = await attachCases(t, nodeId, ids);
      attached += n;
      if (n !== ids.length) notes.push(`挂到场景 ${shortId(nodeId)} 的 ${ids.length} 条，秒懂说挂上了 ${n} 条`);
    }
  } catch (error) {
    throw new MdError(error?.code ?? 'upstream', `用例都写进去了，挂场景时出错：${error?.message ?? error}（已挂 ${attached} 条）`, { exitCode: error?.exitCode, hint: '在秒懂页面上把剩下的挂上；或者 md test drop 删掉这个集后重导' });
  }
  const after = new Map(flattenTree((await scenarioTree(t))?.tree).map((n) => [n.id, n]));
  for (const [nodeId, ids] of groups) {
    const node = after.get(nodeId);
    const delta = (node?.ownCaseCount ?? 0) - (before.get(nodeId) ?? 0);
    if (delta !== ids.length) notes.push(`场景「${node?.path ?? nodeId}」用例数变了 ${delta}，这次挂的是 ${ids.length} 条：可能有旧批次重复挂在这里`);
  }
  return { attached, notes };
}

export async function importFile(t, { name, file, into }) {
  if (!existsSync(file)) throw usage(`找不到文件：${file}`);
  const parsed = parseCaseLines(readFileSync(file, 'utf-8'));
  if (!parsed.rows.length && !parsed.errors.length) throw usage(`${file} 里没有用例`);
  const [events, vars, tree, sets] = await Promise.all([listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId), scenarioTree(t), listTestSets(t)]);
  let set = null;
  if (into) set = await resolveTestSet(t, name, sets);
  else if (sets.some((s) => s.name === name)) {
    throw new MdError('testset_exists', `${t.botName} 下已经有测试集「${name}」`, { exitCode: EXIT.BLOCKED, hint: '导进这个已有的集加 --into；否则换个名字' });
  }
  const existingNames = set ? (await listCases(t, set.testSetId)).map((c) => c.name) : [];
  const { built, errors } = buildCases(parsed.rows, { events, vars, scenarios: tree === null ? null : flattenTree(tree.tree) }, { existingNames });
  const problems = [...parsed.errors.map((e) => ({ ...e, name: '' })), ...errors].sort((a, b) => a.line - b.line);
  out(targetLine(t));
  if (problems.length) {
    out(`❌ ${file}：${problems.length} 处错误，一条都没写：`);
    for (const p of problems.slice(0, 50)) out(`  第 ${p.line} 行${p.name ? `「${p.name}」` : ''}：${p.reason}`);
    if (problems.length > 50) out(`  …另有 ${problems.length - 50} 处`);
    throw new MdError('invalid_cases', `${file} 有 ${problems.length} 处错误，什么都没写`, { hint: '改好文件再导；格式见 skill 的 references/test-cases.md' });
  }
  const warnings = new Map();
  for (const b of built) for (const w of b.warnings) bump(warnings, w);
  for (const [w, n] of warnings) out(`⚠️ ${w}（${n} 条）`);

  let created = false;
  if (!set) {
    set = { testSetId: await createTestSet(t, name), name };
    created = true;
  }
  out(`${created ? '新建' : '导进已有的'}测试集「${set.name}」(${shortId(set.testSetId)})：${built.length} 条用例`);
  const known = await canary(t, set, created, built[0]);
  let back;
  try {
    await createCases(t, set.testSetId, built.slice(1).map((b) => b.testCase), { onBatch: (done) => note(`（已写 ${done + 1}/${built.length}）`) });
    back = new Map((await listCases(t, set.testSetId)).map((c) => [c.name, c]));
  } catch (error) {
    throw partial(t, set, created, error);
  }

  // 审计：逐条逐字段比，按字段汇总
  const missing = built.filter((b) => !back.has(b.testCase.name));
  const soft = new Map();
  const hard = [];
  for (const b of built) {
    const got = back.get(b.testCase.name);
    if (!got) continue;
    const diffs = caseDiffs(b.testCase, got);
    for (const d of diffs) if (!d.critical && !known.has(d.field)) bump(soft, d.field);
    const critical = diffs.filter((d) => d.critical);
    if (critical.length) hard.push({ b, fields: critical.map((d) => fieldLabel(d.field)) });
  }
  const { attached, notes } = await attachAll(t, built, back, tree);
  out(`提交 ${built.length} · 回读 ${built.length - missing.length} · 挂场景 ${attached}${missing.length ? ` · 缺失 ${missing.length}` : ''}`);
  if (missing.length) out(`⚠️ 回读找不到：${missing.slice(0, 10).map((b) => `第 ${b.line} 行「${b.testCase.name}」`).join('、')}${missing.length > 10 ? '…' : ''}`);
  for (const [field, n] of soft) out(`⚠️ ${fieldLabel(field)}：${n} 条读回来和写的不一样（这个区可能不保存这个字段）`);
  for (const h of hard.slice(0, 20)) out(`❌ 第 ${h.b.line} 行「${h.b.testCase.name}」：${h.fields.join('、')} 读回来和写的不一样`);
  for (const n of notes) out(`⚠️ ${n}`);
  out(`下一步：md test run ${set.name} --bot ${shortId(t.botId)}`);
  return missing.length || hard.length ? EXIT.ERROR : EXIT.OK;
}
```

- [ ] **Step 4: 接到 importCmd 上**

`test-import.mjs`：
- import 加 `import { importFile } from './test-import-file.mjs';`；
- `importCmd` 开头换成下面这样。后面的 `const into = boolArg(args, 'into');` 及其后面的代码不动，原来的 `if (!from) throw usage(...)` 这一行删掉（已经挪进下面）。

```js
export async function importCmd(args) {
  const t = await testTarget(args);
  const name = String(args._[0] ?? '').trim();
  if (!name) throw usage('缺测试集：md test import <集> --bot <智能体> --from-execs <文件或执行 id> | --from-file <cases.jsonl>');
  const from = strArg(args, 'from-execs');
  const fromFile = strArg(args, 'from-file');
  if (from && fromFile) throw usage('--from-execs 和 --from-file 只能给一个');
  if (fromFile) {
    for (const flag of ['from-bot', 'allow-preflight-errors']) if (args[flag] !== undefined) throw usage(`--${flag} 只用于 --from-execs`);
    return importFile(t, { name, file: fromFile, into: boolArg(args, 'into') });
  }
  if (!from) throw usage('缺 --from-execs 或 --from-file', '执行记录：给 md exec 保存的 .jsonl 或执行 id；外部用例：给 cases.jsonl（格式见 skill 的 references/test-cases.md）');
```

`test.mjs` 的 USAGE：在 import 那行后面加一行，summary 改成含「外部用例导入」：

```js
  'md test import <集> --bot <智能体> --from-file <cases.jsonl> [--into]   外部用例：本地先校验全部，有错一条都不写；先写 1 条读回来核对，再批量写、挂场景、审计',
```

```js
  summary: '测试中心：看测试集 / 用例 / 场景树，从执行记录或外部文件导入，批量改用例，跑回归（超门槛要用户确认），看进度和结果，暂停，删测试集',
```

- [ ] **Step 5: 跑，确认通过；再跑全套**

Run: 同 Step 2；再跑全部。
Expected: 7 个新测试全过；全套全过。旧测试里如果断言了「缺 --from-execs：」的旧文案，按新文案改，并在账本记 Ruling。

- [ ] **Step 6: 提交**

```bash
git add miaodong-kit/src/commands/test-import-file.mjs miaodong-kit/src/commands/test-import.mjs miaodong-kit/src/commands/test.mjs miaodong-kit/test/test-cli-cases.test.mjs
git commit -m "feat(md): md test import --from-file——外部用例本地校验、先写 1 条核对、批量写、回读、挂场景、审计"
```

---

### Task 6: caseedit.mjs：改动脚本、h、改前改后比较

**Files:**
- Create: `miaodong-kit/src/caseedit.mjs`
- Test: `miaodong-kit/test/caseedit.test.mjs`

**Interfaces:**
- Consumes：
  - Task 2 的 `HISTORY_VAR / TRIGGER_TYPES / buildExpect / byName / historyValue / isObject`；
  - `WRITABLE_FIELDS`（testcenter.mjs）。
- Produces:
  - `createEditHelpers(cases, { events, vars }, log) → h`；
  - `runEditScript(file, cases, { events, vars }) → { cases, log }`；
  - `editChanges(before, after) → { changed: [{before, after, fields}], errors: string[] }`。

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './helpers/run-cli.mjs';
import { createEditHelpers, editChanges, runEditScript } from '../src/caseedit.mjs';
import { TARGET_BOT, botEvents, botVars } from './helpers/testcenter-fixtures.mjs';

const ctx = { events: botEvents[TARGET_BOT], vars: botVars[TARGET_BOT] };
const stored = (i, patch = {}) => ({ testCaseId: `c${i}`, testSetId: 's1', name: `退款-0${i}`, status: 'ready', isReviewed: true, scenarioNodeId: null, dimension: '', triggerType: 'receive-text-message', triggerInputs: { text: `问题 ${i}` }, sessionMemoryCustomData: {}, pluginMockOutputs: [], sqlDbMockOutputs: [], testNodeOutputAssertions: [], canvasActionOutputAssertions: [], isStrictVerify: false, ...patch });
let n = 0;
const script = (body) => {
  const file = join(tempHome(), `edit-${++n}.mjs`);
  writeFileSync(file, body);
  return file;
};

test('h：按名字挑用例、取 id、生成断言和历史；找不到就报错', () => {
  const cases = [stored(1), stored(2)];
  const log = [];
  const h = createEditHelpers(cases, ctx, log);
  assert.deepEqual(h.pick('退款-02').map((c) => c.testCaseId), ['c2']);
  assert.equal(h.pick(/退款/).length, 2);
  assert.deepEqual(h.pick((c) => c.testCaseId === 'c1').map((c) => c.name), ['退款-01']);
  assert.throws(() => h.pick(['退款-01', '没有的']), /没有用例「没有的」/);
  assert.equal(h.eventId('发送4.0'), 'tev-send');
  assert.equal(h.varId('已发优惠'), 'tv-flag');
  assert.equal(h.historyVarId(), 'tv-hist');
  assert.throws(() => h.varId('不存在'), /不存在」在这个智能体里没有/);
  assert.deepEqual(h.expect({ handover: true }), [{ verifyPayload: { type: 'handover' }, actionContent: { type: 'handover' } }]);
  assert.throws(() => h.expect({ event: '没有的事件' }), /没有的事件/);
  assert.deepEqual(h.history(['a']), [{ role: 'user', content: 'a' }]);
  h.log('改了断言');
  assert.deepEqual(log, ['改了断言']);
});

test('runEditScript：脚本改的是副本；脚本出错、没有默认导出都报清楚', async () => {
  const cases = [stored(1)];
  const { cases: after } = await runEditScript(script(`export default ({ cases, h }) => { for (const c of cases) c.canvasActionOutputAssertions = h.expect('应说明退款流程'); };`), cases, ctx);
  assert.equal(cases[0].canvasActionOutputAssertions.length, 0);
  assert.equal(after[0].canvasActionOutputAssertions[0].verifyPayload.text.description, '应说明退款流程');
  await assert.rejects(runEditScript(script('export default () => { throw new Error("写错了"); };'), cases, ctx), /脚本出错：写错了/);
  await assert.rejects(runEditScript(script('export const x = 1;'), cases, ctx), /export default/);
});

test('editChanges：只列 update 会写的字段；改了别的字段、增删用例、name 空或重名、触发类型不对都算错', () => {
  const before = [stored(1), stored(2)];
  const ok = editChanges(before, [stored(1, { name: '退款-01-改', dimension: '退款' }), stored(2)]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.changed.map((c) => [c.after.testCaseId, c.fields]), [['c1', ['name', 'dimension']]]);
  const bad = editChanges(before, [stored(1, { scenarioNodeId: 'sn-x', isReviewed: false }), stored(2, { name: '退款-01' }), stored(3)]);
  const text = bad.errors.join('\n');
  assert.match(text, /2 条变成了 3 条/);
  assert.match(text, /改了不能改的字段：isReviewed、scenarioNodeId/);
  assert.match(text, /name「退款-01」有 2 条重名/);
  assert.match(editChanges(before, [stored(1, { name: ' ' }), stored(2)]).errors.join(), /name 被改成空的/);
  assert.match(editChanges(before, [stored(1, { triggerType: 'x' }), stored(2)]).errors.join(), /不是秒懂的触发类型/);
  assert.match(editChanges(before, [stored(1, { canvasActionOutputAssertions: [{ verifyPayload: { type: 'handover' }, actionContent: { type: 'tag-user' } }] }), stored(2)]).errors.join(), /类型不一致/);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/caseedit.test.mjs`
Expected: FAIL，找不到 `../src/caseedit.mjs`。

- [ ] **Step 3: 实现**

```js
// 批量改用例（spec §6.4）：跑改动脚本、给脚本的 h、比较改前改后。
// 脚本约定同 md apply：export default ({ cases, h }) => void，直接改 cases 里的对象（是副本，改坏了不影响秒懂）。
// h 找不到东西就报错，不猜。

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MdError, usage } from './errors.mjs';
import { stableStringify } from './canvas.mjs';
import { WRITABLE_FIELDS } from './testcenter.mjs';
import { HISTORY_VAR, TRIGGER_TYPES, buildExpect, byName, historyValue, isObject } from './casefile.mjs';

const scriptError = (message) => new MdError('edit_script', message);

export function createEditHelpers(cases, { events, vars }, log) {
  const find = (list, name, kind) => {
    if (!list) throw scriptError(`取不到${kind}列表`);
    const { hit, error } = byName(list, String(name), kind);
    if (error) throw scriptError(error);
    return hit;
  };
  return {
    pick(query) {
      if (typeof query === 'function') return cases.filter(query);
      if (query instanceof RegExp) return cases.filter((c) => query.test(String(c?.name ?? '')));
      return (Array.isArray(query) ? query : [query]).map((name) => {
        const hits = cases.filter((c) => c?.name === name);
        if (hits.length !== 1) throw scriptError(hits.length ? `用例「${name}」有 ${hits.length} 条同名` : `没有用例「${name}」`);
        return hits[0];
      });
    },
    eventId: (name) => find(events, name, '事件').eventId,
    varId: (name) => find(vars, name, '会话变量').id,
    historyVarId: () => find(vars, HISTORY_VAR, '会话变量').id,
    expect(form) {
      const { assertions, errors } = buildExpect(form, { events });
      if (errors.length) throw scriptError(errors.join('；'));
      return assertions;
    },
    history(items) {
      const { value, error } = historyValue(items);
      if (error) throw scriptError(error);
      return value;
    },
    log(message) {
      log.push(String(message));
    },
  };
}

export async function runEditScript(file, cases, ctx) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw usage(`找不到脚本：${abs}`);
  // 带时间戳参数绕开 ESM 模块缓存（同 md apply）
  const mod = await import(`${pathToFileURL(abs).href}?t=${Date.now()}`);
  if (typeof mod.default !== 'function') throw usage(`${abs} 需要 export default ({ cases, h }) => { ... }`);
  const copy = structuredClone(cases);
  const log = [];
  try {
    await mod.default({ cases: copy, h: createEditHelpers(copy, ctx, log) });
  } catch (error) {
    if (error instanceof MdError) throw error;
    throw scriptError(`脚本出错：${error?.message ?? String(error)}`);
  }
  return { cases: copy, log };
}

const SHAPES = [['triggerInputs', isObject, '对象'], ['sessionMemoryCustomData', isObject, '对象'], ['testNodeOutputAssertions', Array.isArray, '数组'], ['canvasActionOutputAssertions', Array.isArray, '数组']];

// 改前改后逐条比：只看 update 会写的字段。别的字段变了、条数或 id 变了、name 空或重名、形状不对都算错（spec §6.4）
export function editChanges(before, after) {
  const errors = [];
  if (after.length !== before.length) errors.push(`用例从 ${before.length} 条变成了 ${after.length} 条：edit 不能增删用例（加用 md test import，删用 md test drop）`);
  const byId = new Map(after.map((c) => [c?.testCaseId, c]));
  const changed = [];
  for (const b of before) {
    const a = byId.get(b.testCaseId);
    if (!a) {
      errors.push(`用例「${b.name}」不见了（testCaseId 被改或被删）`);
      continue;
    }
    const locked = Object.keys({ ...b, ...a }).filter((k) => !WRITABLE_FIELDS.includes(k) && stableStringify(a[k]) !== stableStringify(b[k]));
    if (locked.length) errors.push(`用例「${b.name}」改了不能改的字段：${locked.join('、')}（只能改 ${WRITABLE_FIELDS.join('、')}）`);
    const fields = WRITABLE_FIELDS.filter((k) => stableStringify(a[k]) !== stableStringify(b[k]));
    if (fields.length) changed.push({ before: b, after: a, fields });
  }
  // name 不能空、不能重名：秒懂按 name 找用例，结果报告也靠它
  const names = new Map();
  for (const c of after) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name) errors.push(`用例 ${String(c?.testCaseId ?? '?').slice(0, 8)} 的 name 被改成空的`);
    else names.set(name, (names.get(name) ?? 0) + 1);
  }
  for (const [name, count] of names) if (count > 1) errors.push(`name「${name}」有 ${count} 条重名`);
  for (const { after: a } of changed) {
    if (!TRIGGER_TYPES.includes(a.triggerType)) errors.push(`用例「${a.name}」的触发类型「${a.triggerType}」不是秒懂的触发类型`);
    for (const [key, check, word] of SHAPES) if (!check(a[key])) errors.push(`用例「${a.name}」的 ${key} 要是${word}`);
    const assertions = Array.isArray(a.canvasActionOutputAssertions) ? a.canvasActionOutputAssertions : [];
    if (assertions.some((x) => typeof x?.verifyPayload?.type !== 'string' || x?.actionContent?.type !== x.verifyPayload.type)) {
      errors.push(`用例「${a.name}」有断言的 verifyPayload 和 actionContent 类型不一致`);
    }
  }
  return { changed, errors };
}
```

- [ ] **Step 4: 跑，确认通过**

Run: 同 Step 2。
Expected: 3 个测试全过。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/caseedit.mjs miaodong-kit/test/caseedit.test.mjs
git commit -m "feat(md): 批量改用例的脚本运行、h 辅助和改前改后校验"
```

---

### Task 7: `md test edit`

**Files:**
- Create: `miaodong-kit/src/commands/test-edit.mjs`
- Modify: `miaodong-kit/src/commands/test.mjs`（SUBS 加 edit、USAGE 加一行）
- Test: `miaodong-kit/test/test-cli-cases.test.mjs`（追加）

**Interfaces:**
- Consumes：
  - Task 6 的 `runEditScript / editChanges`；
  - Task 4 的 `caseDiffs / CRITICAL_FIELDS / fieldLabel`；
  - `confirmCode / givenCode`（confirm.mjs）；
  - `hashOf`（canvas.mjs）；
  - `updateCase / listCases`。
- Produces: `edit(args) → EXIT`。

- [ ] **Step 1: 写失败的测试**（追加到 `test-cli-cases.test.mjs`）

```js
const EDIT = `export default ({ cases, h }) => {
  for (const c of h.pick(/^退款/)) c.canvasActionOutputAssertions = h.expect({ event: '发送4.0', params: { text: '应说明退款流程' } });
  h.log('退款类改成核对发送事件');
};`;

async function seedExternal(h) {
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, [
    { name: '退款-01', text: '我想退款', expect: '应说明退款流程' },
    { name: '退款-02', text: '课程能退吗', expect: '应说明退课流程' },
    { name: '咨询-01', text: '怎么报名', expect: '应给报名链接' },
  ], 'seed.jsonl')], h);
  assert.equal(r.code, 0, r.stderr);
}
const editFile = (h, body = EDIT, file = 'edit.mjs') => {
  const path = join(h, file);
  writeFileSync(path, body);
  return path;
};
const planCode = (stdout) => stdout.match(/计划码：([0-9a-f]{8})/)?.[1];

test('edit：默认预演，列出改了哪几条、哪些字段，给计划码；什么都不写', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const writes = fake.state.log.length;
  const r = await md(['test', 'edit', '外部回归', editFile(h), '--bot', '179cd443'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /退款类改成核对发送事件/);
  assert.match(r.stdout, /要改 2 条（共 3 条）/);
  assert.match(r.stdout, /退款-01：断言/);
  assert.ok(planCode(r.stdout));
  assert.match(r.stdout, /这是预演，什么都没改/);
  assert.equal(fake.state.log.length, writes);
});

test('edit --confirm：先备份，再逐条全量 update，回读核对；计划码对不上退出码 5', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const file = editFile(h);
  const code = planCode((await md(['test', 'edit', '外部回归', file, '--bot', '179cd443'], h)).stdout);
  const wrong = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', '00000000'], h);
  assert.equal(wrong.code, 5);
  assert.match(wrong.stderr, /计划码对不上/);
  const r = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  const backup = r.stdout.match(/备份：(\S+)/)[1];
  assert.ok(existsSync(backup));
  assert.equal(JSON.parse(readFileSync(backup, 'utf-8')).cases.length, 3);
  assert.equal(fake.state.posts.update.length, 2);
  for (const body of fake.state.posts.update) for (const key of ['name', 'triggerType', 'triggerInputs', 'sessionMemoryCustomData', 'canvasActionOutputAssertions']) assert.ok(key in body, key);
  assert.equal(casesIn('外部回归').find((c) => c.name === '退款-01').canvasActionOutputAssertions[0].verifyPayload.type, 'canvas-event-action');
  assert.match(r.stdout, /已改 2 条/);
});

test('edit：预演之后集里的用例变了，原来的计划码对不上，什么都不写', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const file = editFile(h);
  const code = planCode((await md(['test', 'edit', '外部回归', file, '--bot', '179cd443'], h)).stdout);
  casesIn('外部回归').find((c) => c.name === '退款-02').triggerInputs.text = '页面上被人改了';
  const r = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 5);
  assert.equal(fake.state.posts.update, undefined);
});

test('edit：脚本改了不能改的字段或把 name 改成重名，什么都不写，列出问题', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const r = await md(['test', 'edit', '外部回归', editFile(h, `export default ({ cases }) => { cases[0].scenarioNodeId = 'sn-x'; cases[1].name = cases[2].name; };`, 'bad.mjs'), '--bot', '179cd443'], h);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /改了不能改的字段：scenarioNodeId/);
  assert.match(r.stdout, /有 2 条重名/);
  assert.equal(fake.state.posts.update, undefined);
});
```

- [ ] **Step 2: 跑，确认失败**

Run: `$HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/test-cli-cases.test.mjs`
Expected: 新加的 4 个 FAIL（「不认识 md test edit」，退出码 2）。

- [ ] **Step 3: 实现** `src/commands/test-edit.mjs`

```js
// md test edit <集> <脚本.mjs> [--confirm <计划码>]（spec §6.4）：按脚本批量改用例。
// 默认预演：跑脚本，比较改前改后，列出改了哪些，给计划码。带 --confirm 才写：先备份，再逐条 update（全量覆盖），最后回读核对。
// 计划码绑定每条改前和改后的内容：预演之后集里的用例、或者脚本变了，确认就对不上。

import { join } from 'node:path';
import { EXIT, MdError, usage } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { writeJson } from '../home.mjs';
import { stamp } from '../workspace.mjs';
import { hashOf } from '../canvas.mjs';
import { confirmCode, givenCode } from '../confirm.mjs';
import { listEvents, listSessions } from '../api.mjs';
import { listCases, updateCase } from '../testcenter.mjs';
import { CRITICAL_FIELDS, caseDiffs, fieldLabel, idProblems } from '../testcases.mjs';
import { editChanges, runEditScript } from '../caseedit.mjs';
import { resolveTestSet, testTarget, testsDir } from '../test-common.mjs';

export async function edit(args) {
  const t = await testTarget(args);
  const set = await resolveTestSet(t, args._[0]);
  const file = args._[1];
  if (!file) throw usage('缺脚本：md test edit <集> <脚本.mjs> --bot <智能体>', '脚本写法见 skill 的 references/test-cases.md');
  const given = givenCode(args);
  const [before, events, vars] = await Promise.all([listCases(t, set.testSetId), listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId)]);
  const { cases: after, log } = await runEditScript(file, before, { events, vars });
  const { changed, errors } = editChanges(before, after);
  // 改出来的事件、会话变量要在这个智能体里有；列表取不到时这里不查，md test run 的跑前检查会拦
  if (events && vars) for (const p of idProblems(changed.map((c) => c.after), { events, vars })) errors.push(`用例「${p.name}」：${p.reason}`);
  out(targetLine(t));
  for (const line of log) out(`  · ${line}`);
  if (errors.length) {
    out(`❌ ${errors.length} 处问题，什么都没改：`);
    for (const e of errors.slice(0, 30)) out(`  - ${e}`);
    if (errors.length > 30) out(`  …另有 ${errors.length - 30} 处`);
    throw new MdError('edit_invalid', `脚本改出来的用例有 ${errors.length} 处问题，什么都没改`, { hint: '改脚本再预演' });
  }
  if (!changed.length) {
    out(`脚本没改测试集「${set.name}」里的任何用例`);
    return EXIT.OK;
  }
  const code = confirmCode({ kind: 'test-edit', botId: t.botId, testSetId: set.testSetId, changes: hashOf(changed.map((c) => [c.before, c.after])) });
  out(`测试集「${set.name}」(${shortId(set.testSetId)})：要改 ${changed.length} 条（共 ${before.length} 条）`);
  for (const c of changed.slice(0, 30)) out(`  ${c.before.name}${c.fields.includes('name') ? ` → ${c.after.name}` : ''}：${c.fields.map(fieldLabel).join('、')}`);
  if (changed.length > 30) out(`  …另有 ${changed.length - 30} 条`);
  if (given === null) {
    out(`这是预演，什么都没改。计划码：${code}`);
    out(`用户明确同意后执行：md test edit ${set.testSetId} ${file} --bot ${shortId(t.botId)} --confirm ${code}`);
    return EXIT.OK;
  }
  if (given !== code) {
    throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：预演之后集里的用例或脚本变了，或者计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
  }
  const backup = join(testsDir(t, 'backups'), `${shortId(set.testSetId)}-edit-${stamp()}.json`);
  writeJson(backup, { testSet: set, cases: before });
  let done = 0;
  try {
    for (const c of changed) {
      await updateCase(t, c.after);
      done++;
    }
  } catch (error) {
    throw new MdError(error?.code ?? 'upstream', `${error?.message ?? error}（已改 ${done}/${changed.length} 条）`, {
      exitCode: error?.exitCode,
      hint: `改之前的全部用例备份在 ${backup}；md test cases ${set.testSetId} --bot ${shortId(t.botId)} 看现在的样子`,
    });
  }
  // 回读：改了的字段和关键字段逐条比；这个区不保存的非关键字段（dimension）只提醒
  const back = new Map((await listCases(t, set.testSetId)).map((c) => [c.testCaseId, c]));
  const soft = new Map();
  const hard = [];
  for (const c of changed) {
    for (const d of caseDiffs(c.after, back.get(c.after.testCaseId), [...new Set([...c.fields, ...CRITICAL_FIELDS])])) {
      if (d.critical) hard.push(`${c.after.name}：${fieldLabel(d.field)}`);
      else soft.set(d.field, (soft.get(d.field) ?? 0) + 1);
    }
  }
  out(`已改 ${changed.length} 条；备份：${backup}`);
  for (const [field, n] of soft) out(`⚠️ ${fieldLabel(field)}：${n} 条读回来和改的不一样（这个区可能不保存这个字段）`);
  if (hard.length) {
    for (const line of hard.slice(0, 20)) out(`  ❌ ${line} 读回来和改的不一样`);
    throw new MdError('edit_readback', `${hard.length} 处回读和改的不一样`, { hint: `改之前的全部用例备份在 ${backup}` });
  }
  return EXIT.OK;
}
```

`test.mjs`：import 加 `import { edit } from './test-edit.mjs';`，SUBS 加 `edit`，USAGE 在 import 两行后面加：

```js
  'md test edit <集> <脚本.mjs> --bot <智能体> [--confirm <计划码>]   按脚本批量改用例：默认预演给计划码；确认后先备份、逐条全量更新、回读核对',
```

- [ ] **Step 4: 跑，确认通过；再跑全套**

Run: 同 Step 2；再跑全部。
Expected: 全过。

- [ ] **Step 5: 提交**

```bash
git add miaodong-kit/src/commands/test-edit.mjs miaodong-kit/src/commands/test.mjs miaodong-kit/test/test-cli-cases.test.mjs
git commit -m "feat(md): md test edit——按脚本批量改用例，预演给计划码，确认后先备份、全量更新、回读核对"
```

---

### Task 8: 打包产物在 Node 18 上跑外部用例导入和批量改

**Files:**
- Test: `miaodong-kit/test/bundle.test.mjs`

- [ ] **Step 1: 写测试**（末尾追加）

```js
test('产物能导外部用例、批量改用例（Node 18 上跑改动脚本、structuredClone）', async () => {
  const { server } = await startTestCenterServer();
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const file = join(home, 'cases.jsonl');
    writeFile(file, `${JSON.stringify({ name: '退款-01', text: '我想退款', expect: '应说明退款流程' })}\n${JSON.stringify({ name: '事件-01', event: '延时回复', data: { text: '课程怎么退' }, expect: { handover: true } })}\n`);
    const imported = await runCli(['test', 'import', '外部', '--bot', '179cd443', '--from-file', file], { home, bundle });
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /提交 2 · 回读 2/);
    const script = join(home, 'edit.mjs');
    writeFile(script, `export default ({ cases, h }) => { for (const c of h.pick('退款-01')) c.canvasActionOutputAssertions = h.expect({ handover: true }); };`);
    const preview = await runCli(['test', 'edit', '外部', script, '--bot', '179cd443'], { home, bundle });
    assert.equal(preview.code, 0, preview.stderr);
    const code = preview.stdout.match(/计划码：([0-9a-f]{8})/)[1];
    const done = await runCli(['test', 'edit', '外部', script, '--bot', '179cd443', '--confirm', code], { home, bundle });
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /已改 1 条/);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: 用 Node 18 跑打包测试**

Run: `MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node $HOME/.nvm/versions/node/v22.23.1/bin/node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test miaodong-kit/test/bundle.test.mjs`
Expected: 全过。前面几个任务的代码都在，所以这一步应该直接通过；它不是 RED/GREEN，是验证产物在 Node 18 上能跑。
如果失败，说明打包或 Node 18 兼容性有问题（比如用了 Node 18 没有的 API），按 systematic-debugging 查。

- [ ] **Step 3: 提交**

```bash
git add miaodong-kit/test/bundle.test.mjs
git commit -m "test(md): 打包产物跑外部用例导入和批量改（Node 18）"
```

---

### Task 9: 文档

**Files:**
- Create: `miaodong-kit/skill/references/test-cases.md`
- Modify: `miaodong-kit/skill/SKILL.md`、`miaodong-kit/skill/README.md`、`miaodong-kit/skill/references/test-center.md`
- Modify: `CLAUDE.md`、`AGENTS.md`（md 条目里补上外部用例和批量改）

- [ ] **Step 1: 写 `references/test-cases.md`**，内容按下面的结构写全（不写具体 bot 名、客户名；例子里的事件名用「延时回复」「发送」这类通用名字）：

````markdown
# 外部用例与批量改（md test import --from-file / md test edit）

## 什么时候用
- 把 Excel、飞书、聊天记录这类外部数据批量建成回归用例：写一段脚本把源数据转成 JSONL（一行一条），再 `md test import`。
- 已有用例要成批改（换断言、补历史、改名字）：写一个改动脚本，`md test edit` 先预演、用户同意后再确认。
- 用脚本生成，不要逐条手写：分类和字段映射是机械规则，脚本能保证一条不漏。

## 导入
```
md test import <集> --bot <智能体> --from-file cases.jsonl [--into]
```
（字段表：name / trigger / text / image / event + data / input / history / vars / expect / scenario / dimension、strict、mocks / 以 _ 开头的字段——含义同 spec §6.3，逐项写清）
（expect 的五种写法，各给一行 JSONL 例子；发事件的例子写 `{"event": "发送", "params": {"text": "应说明退款流程"}}`）
（建模规则：触发输入只放触发这一轮的那条消息；用户先说的话、先发的图都进 history，图片写裸 URL；图片用例不写 text）
（触发类型 20 个，有简写的 3 个；其余写 trigger + input，字段拿不准就先在页面建一条同类用例，用 md test cases --out 导出来照抄 triggerInputs）
（md 导入时做的事：本地校验全部、先写 1 条读回来、批量写、回读、挂场景、审计；输出的「提交 · 回读 · 挂场景 · 缺失」怎么读；报错怎么改）

## 批量改
```
md test edit <集> <脚本.mjs> --bot <智能体>                    # 预演，给计划码
md test edit <集> <脚本.mjs> --bot <智能体> --confirm <计划码>  # 用户明确同意后
```
（脚本写法：export default ({ cases, h }) => { … }；h.pick / h.eventId / h.varId / h.historyVarId / h.expect / h.history / h.log，各一句说明 + 一个完整例子）
（只能改的字段；改了别的会报错；预演之后用例变了计划码就对不上；确认时先备份到本机）

## 坑（实测）
- create 不返回 id，md 按 name 回读，所以 name 在集里必须唯一；溯源信息（源文件第几行）写进 name。
- 有的区不保存 dimension（写进去读回来是空的），md 会提醒；分类信息别指望 dimension。
- 接口建的用例直接是「已审核」；从执行记录导入的是「未审核」，但未审核的也照样会跑。
- 场景树是整个智能体共用的，重复导同一批数据会让场景计数翻倍，md 导完会对账提醒。
- 断言写错时秒懂不报错，这条断言永远不生效：md 只生成实测过的形状，别的用 raw 原样写（先在页面建一条、导出来照抄）。
- 事件触发的外部用例还没实测跑过：第一次用先跑 1 条看结果对不对。
````

- [ ] **Step 2: 改 SKILL.md**
- description 里「把 Excel、飞书等外部数据批量建成用例暂时仍由 miaodong-test-case-import 负责。」改成：测试中心那一段加上「从 Excel、飞书等外部数据批量建用例、按脚本批量改用例」。
- 「## 回归（测试中心）」后面加一节「## 外部用例与批量改」，写两条流程：
  - 外部用例：转成 JSONL → `md test import <集> --bot <智能体> --from-file <文件>`；有错改文件重导。
  - 批量改：写脚本 → `md test edit` 预演 → 把「改哪几条、改了什么」和计划码交给用户 → 用户明确同意后 `--confirm`。
  - 细节见 `references/test-cases.md`。
- 「## 规矩」里「导入、删测试集会写秒懂…」那条改成：导入、批量改、删测试集都会写秒懂；导入前说清导到哪个智能体、哪个测试集；批量改和删测试集要用户明确同意（计划码）。

- [ ] **Step 3: 改 README.md、test-center.md、CLAUDE.md / AGENTS.md**
- README 第 9 行测试中心那条补上「从 Excel、飞书等外部数据批量建用例、按脚本批量改用例」。
- test-center.md 命令表加两行：
  - `md test import <集> --bot <目标> --from-file <cases.jsonl> [--into]` → 外部用例（格式见 test-cases.md）；
  - `md test edit <集> <脚本.mjs> --bot <智能体> [--confirm <计划码>]` → 批量改。
- CLAUDE.md、AGENTS.md 的 md 条目：先看现有写法再补一句，和现有措辞一致。

- [ ] **Step 4: 检查公开文件里没有具体 bot 名、客户名**

Run: `grep -rnE "太极|兴趣岛|量子之歌|有赞|网易|willow|xlink|inkwell|petal|cloudweave" miaodong-kit/skill/`
Expected: 没有输出。

- [ ] **Step 5: 跑全套，提交**

Run: 全部（Global Constraints 里的命令）。
Expected: 全过。

```bash
git add miaodong-kit/skill CLAUDE.md AGENTS.md
git commit -m "docs(md): skill 与仓库文档加上外部用例导入和批量改"
```

---

### Task 10: 全量验证、安装、真机核对、整支审查、收尾

- [ ] **Step 1: 全量测试 + 安装**

Run: 全部；`PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm run md:install`；`~/.local/bin/md --version`
Expected: 全过；版本号是最新提交。

- [ ] **Step 2: 真机核对（不花钱）**：在「【测试测试测试】太极2.0 测试专用版」上。用户在核对 8 时同意过：临时测试集，只写不跑，核完删掉。
  1. 写一个 4 条的 JSONL，放在 scratchpad：
     - 文本 + 历史 + 会话变量 + LLM 判定，带 dimension；
     - 图片 + similar；
     - 事件「延时回复」+ `{event: 发送4.0, params: {text}}`；
     - 文本 + `{handover: true}`。
  2. `md test import md核对-2c2 --bot 179cd443 --from-file <文件>`。期望：
     - `提交 4 · 回读 4`；
     - 有「这个区不保存 dimension」的提醒；
     - 退出码 0。
  3. 写改动脚本：把一条的断言换成 `h.expect({ handover: true })`。先预演看清单，再 `--confirm`。期望 `已改 1 条`，没有回读不一致。
  4. `md test cases md核对-2c2 --bot 179cd443 --out <scratchpad>` 看结构（只看键，不看内容）。
  5. `md test drop` 预演 → `--confirm` 删掉临时集，回读确认。
  6. 结论记进账本；和预期不一致的，先写会失败的测试再修。

- [ ] **Step 3: 整支审查**

按 superpowers:executing-plans 的 Final Review，派最强的模型审查 2c-2 这一段的提交（从本计划第一条提交的前一个提交到 HEAD）。
- Critical 和 Important 一轮修完，每条先写会失败的测试；
- Minor 记账，写进最后的消息。

- [ ] **Step 4: spec §10 标完成、记忆**
- spec §10 的 2c-2 那行补「已完成（09-25）」和提交区间；
- `/Users/hukui/.claude/projects/-Users-hukui-Desktop-workspace-Agentflow/memory/miaodong-cli-plan.md` 补 2c-2 完成的一行：提交区间、测试数、真机核对结论、没修的小问题；
- MEMORY.md 那一行同步。

- [ ] **Step 5: 要用户拍板的两件事（不自己做）**
- **发布**：magic-skills/miaodong 现在是公开仓库，而且带着客户区表；发布要等用户对「仓库公开」做决定。
- **停用旧 skill `miaodong-test-case-import`**（spec §8）：
  - 本机停用，是把 `~/.claude/skills/`、`~/.codex/skills/`、`~/.agents/skills/` 下的它挪走；
  - 在它的仓库里加「已并入 miaodong」的说明，是往公开仓库推送。
  两件都要用户明确同意。
