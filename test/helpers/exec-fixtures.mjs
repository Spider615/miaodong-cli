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
