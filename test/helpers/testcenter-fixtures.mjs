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
