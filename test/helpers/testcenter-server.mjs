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
