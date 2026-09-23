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
