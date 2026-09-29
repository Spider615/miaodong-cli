// 带整条试跑接口的假秒懂（spec 2026-09-29）。reset(patch) 改 state：
//   startStatus（POST 的 HTTP 状态）、runningPolls（先回几次 running）、deliveringPolls（到终态后还有几次「有序发送中」）、
//   pollStatus（GET 的 HTTP 状态）、cost / tokenCount（花费字段）、detailsStatus（history/details 的 HTTP 状态）、
//   later（list-by-session 额外返回的同会话后续执行）、laterStatus（list-by-session 的 HTTP 状态）、
//   onPost(n)（第 n 次 POST 之后调，用来模拟跑的过程中草稿被改）、canvas / events / sessions。POST 的请求体记在 state.posts。
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { U, edge, node } from './fixtures.mjs';

export const FLOW_BOT = 'f10b0000-0000-4000-8000-000000000000';
export const FX = (n) => `f${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;

export function flowEvents() {
  return [
    { eventId: 'ev-delay-0001', name: '延时回复', variables: [{ name: 'text', type: 'string' }] },
    { eventId: 'ev-plugin-002', name: '查用户', variables: [{ name: 'uid', type: { type: 'string' } }] },
  ];
}

export function flowSessions() {
  return [
    { id: 'v-stage', name: '客户阶段', isDefault: false, type: { type: 'string' } },
    { id: 'v-src', name: '最后一条消息来源', isDefault: true, type: { type: 'string' } },
  ];
}

const trigger = (n, name, type) => node(n, { name, type, category: 'trigger' });
const action = (n, name, type, payload = {}) => node(n, { name, type, category: 'action', payload });
const eventEntry = (n, name, eventId) => ({ ...node(n, { name, type: 'canvas-event-trigger', category: 'trigger', payload: { eventId } }), shape: eventId });

// 收到文本 → 回答生成 → 规则中心 → 发送文本；规则中心 → 触发延时回复 ⇢ 延时回复入口 → 写意向
// 查用户入口 → 兴趣岛用户详情（插件）：从文本走不到，--event 查用户 能走到
export function flowDraft() {
  return [
    trigger(1, '收到文本', 'receive-text-message'),
    node(2, { name: '回答生成', payload: { modelType: 'doubao', inputs: [{ name: 'text', referenceNodeId: U(1), dataPath: 'text' }] } }),
    node(3, { name: '规则中心', type: 'rule-center', payload: { branches: [{ branchId: 'br-refund', name: '退款' }], defaultBranchId: 'br-default' } }),
    action(4, '发送文本', 'send-text-message'),
    action(5, '触发延时回复', 'canvas-event-action', { eventId: 'ev-delay-0001', triggerType: 'SCHEDULE', delaySeconds: 10 }),
    eventEntry(6, '延时回复入口', 'ev-delay-0001'),
    action(7, '写意向', 'update-data'),
    eventEntry(8, '查用户入口', 'ev-plugin-002'),
    node(9, { name: '兴趣岛用户详情', type: 'plugin-calculation' }),
    edge(101, 1, 2), edge(102, 2, 3), edge(103, 3, 4), edge(104, 3, 5), edge(105, 6, 7), edge(106, 8, 9),
  ];
}

function textResult(state, body, execId) {
  const text = body.receiveTextMessage?.text ?? '';
  const reply = `回复：${text}`;
  const outputActions = [
    { type: 'send-text-message', status: 'send', payload: { text: reply, clientIds: ['c-1'] }, nodeId: U(4) },
    { type: 'canvas-event-action', status: 'send', payload: { eventId: 'ev-delay-0001', eventName: '延时回复', params: { text } }, nodeId: U(5) },
  ];
  return {
    canvasExec: {
      execId, sessionId: body.sessionId, status: 'success', testRun: true, triggerType: body.triggerType, processDuration: 3200,
      totalCostInCny: state.cost, tokenCount: state.tokenCount, outputActions, createdAt: state.createdAt, sessionMemorySnapshot: {},
    },
    // 故意打乱顺序：真实响应就不是执行顺序
    nodeResults: [
      { nodeId: U(3), status: 'success', inputs: { inputData: {} }, output: {}, outputBranchId: 'br-refund', processDuration: 2 },
      { nodeId: U(1), status: 'success', inputs: { inputData: {} }, output: { text }, processDuration: 1 },
      { nodeId: U(2), status: 'success', inputs: { inputData: { text } }, output: { message: reply }, processDuration: 2100, metadata: { prompt: [{ role: 'user', content: text }], tokenUsage: { prompt: 100, completion: 10, costInCny: state.cost } } },
      { nodeId: U(4), status: 'success', inputs: { inputData: { text: reply } }, output: {}, processDuration: 5, actions: [outputActions[0]] },
      { nodeId: U(5), status: 'success', inputs: { inputData: {} }, output: {}, processDuration: 3, actions: [outputActions[1]] },
    ],
  };
}

function eventResult(state, body, execId) {
  const outputActions = [{ type: 'update-data', status: 'send', payload: { operations: [{ fieldId: 'v-stage', updateOperation: 'set', value: '意向' }] }, nodeId: U(7) }];
  return {
    canvasExec: {
      execId, sessionId: body.sessionId, status: 'success', testRun: true, triggerType: body.triggerType, processDuration: 50,
      totalCostInCny: 0, tokenCount: {}, outputActions, createdAt: state.createdAt,
    },
    nodeResults: [
      { nodeId: U(6), status: 'success', inputs: { inputData: {} }, output: body.canvasEvent?.data ?? {}, processDuration: 1 },
      { nodeId: U(7), status: 'success', inputs: { inputData: {} }, output: {}, processDuration: 2, actions: outputActions },
    ],
  };
}

export async function startFlowServer() {
  const state = {};
  const reset = (patch = {}) => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, {
      posts: [], polls: new Map(), startStatus: 200, runningPolls: 1, deliveringPolls: 0, pollStatus: 200, detailsStatus: 200,
      cost: 0.0123, tokenCount: { doubao: { prompt: 100, completion: 10 } }, later: [], laterStatus: 200, onPost: null, createdAt: new Date().toISOString(),
      canvas: flowDraft(), events: flowEvents(), sessions: flowSessions(), ...patch,
    });
  };
  reset();
  const bodyOf = (execId) => state.posts.find((_, k) => FX(k + 1) === execId);
  const resultOf = (execId) => {
    const body = bodyOf(execId);
    return body.triggerType === 'canvas-event-trigger' ? eventResult(state, body, execId) : textResult(state, body, execId);
  };
  const server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: FLOW_BOT, name: '整条试跑测试机' }] : []),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: state.canvas, version: '', updatedAt: '2026-09-29T01:00:00.000Z' }),
    'GET /api/canvas/event/list': () => ok(state.events),
    'GET /api/session-memory/list': () => ok(state.sessions),
    'POST /api/canvas/exec': ({ body }) => {
      state.posts.push(body);
      if (state.startStatus >= 400) return { status: state.startStatus, body: { statusCode: state.startStatus, message: state.startStatus >= 500 ? 'Bad Gateway' : 'Bad Request' } };
      state.onPost?.(state.posts.length);
      return { status: 201, body: { code: 0, data: { execId: FX(state.posts.length) } } };
    },
    'GET /api/canvas/exec': ({ query }) => {
      if (state.pollStatus >= 400) return { status: state.pollStatus, body: { message: 'Internal Server Error' } };
      const n = (state.polls.get(query.canvasExecId) ?? 0) + 1;
      state.polls.set(query.canvasExecId, n);
      if (n <= state.runningPolls) return ok({ canvasExec: { execId: query.canvasExecId, status: 'running' }, nodeResults: [] });
      const result = resultOf(query.canvasExecId);
      if (n <= state.runningPolls + state.deliveringPolls) {
        result.nodeResults = result.nodeResults.map((r) => (r.nodeId === U(4) ? { ...r, metadata: { orderedDelivery: { state: 'sending', totalCount: 1, accepted: [] } } } : r));
      }
      return ok(result);
    },
    'GET /api/canvas/history/details': ({ query }) => {
      if (state.detailsStatus >= 400) return { status: state.detailsStatus, body: { message: 'Internal Server Error' } };
      if (!bodyOf(query.execId)) return { status: 201, body: { code: -1, message: 'CANVAS_EXEC_NOT_FOUND' } };
      const result = resultOf(query.execId);
      return ok({ ...result, canvasExec: { ...result.canvasExec, botId: FLOW_BOT }, canvas: { canvasId: 'main-1', version: '', rawCanvas: state.canvas } });
    },
    'GET /api/canvas/history/list-by-session': ({ query }) => {
      if (state.laterStatus >= 400) return { status: state.laterStatus, body: { message: 'Internal Server Error' } };
      const mine = state.posts.map((b, k) => ({ b, id: FX(k + 1) })).filter(({ b }) => b.sessionId === query.sessionId).map(({ id }) => {
        const r = resultOf(id).canvasExec;
        return { execId: id, createdAt: r.createdAt, status: r.status, outputActions: r.outputActions, triggerContent: { triggerType: r.triggerType, content: {} } };
      });
      return ok([...mine, ...state.later]);
    },
  });
  return { server, state, reset };
}
