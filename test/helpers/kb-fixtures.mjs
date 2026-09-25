// 知识库测试数据：三个知识库（售后 FAQ、产品手册、财务 FAQ），一张挂了知识库工具的画布，一个拼执行详情的函数。
// 结构照 09-25 的真实数据（spec 3a §2.1、§2.4、§2.5）。分数用一个确定的假相似度算：假服务器的语义搜索也用它，
// 所以用执行里记录的查询重放时，结果和记录一致（真实环境里两边分数也一致，spec §2.3）。
import { U, edge, node } from './fixtures.mjs';
import { X, chainRows, detailOf } from './exec-fixtures.mjs';

// 32 位、不带横杠，和真实的知识库 id 一样
export const KB_FAQ = `aaaa0001${'0'.repeat(24)}`;
export const KB_FILE = `bbbb0002${'0'.repeat(24)}`;
export const KB_OTHER = `cccc0003${'0'.repeat(24)}`;
export const KB_GONE = `dddd0004${'0'.repeat(24)}`; // 画布还引用着，企业里已经没有了

// 假相似度：两句话按两个字一组切开，算 Dice 系数，保留 4 位小数。两句一样时是 1
export function sim(a, b) {
  const grams = (s) => {
    const t = String(s).replace(/\s+/g, '');
    const out = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out.length ? out : [t];
  };
  const A = grams(a);
  const pool = grams(b);
  const total = A.length + pool.length;
  let hit = 0;
  for (const g of A) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return Math.round(((2 * hit) / total) * 10000) / 10000;
}

export const faqs = () => [
  { id: 7001, kb: KB_FAQ, question: '课程怎么退款', answer: '在订单详情页点申请退款，三个工作日内原路退回。', isReviewed: true },
  { id: 7002, kb: KB_FAQ, question: '退款多久到账', answer: '审核通过后三个工作日内原路退回。', isReviewed: true },
  { id: 7003, kb: KB_FAQ, question: '怎么修改收货地址', answer: '发货前可以在订单详情页修改。', isReviewed: true },
  { id: 7004, kb: KB_FAQ, question: '课程可以退吗', answer: '开课七天内可以全额退。', isReviewed: false }, // 未审核：语义搜索搜不到
  { id: 7101, kb: KB_OTHER, question: '发票怎么开', answer: '在我的订单里申请电子发票。', isReviewed: true },
];

export const kbList = () => [
  { id: KB_FAQ, name: '售后 FAQ', qaCount: 4, fileCount: 0, pageCount: 0, videoCount: 0, modelType: 'text-embedding-ada-002' },
  { id: KB_FILE, name: '产品手册', qaCount: 0, fileCount: 1, pageCount: 0, videoCount: 0, modelType: 'text-embedding-ada-002' },
  { id: KB_OTHER, name: '财务 FAQ', qaCount: 1, fileCount: 0, pageCount: 0, videoCount: 0, modelType: 'text-embedding-ada-002' },
];

export const files = () => [{ id: 501, kb: KB_FILE, name: '手册.pdf', extension: 'pdf', status: 'ready', paragraphCount: 2 }];
export const paragraphs = () => [
  { id: 9001, fileId: 501, index: 0, content: '课程退款规则：开课七天内全额退款。', wordCount: 16, status: 'ready' },
  { id: 9002, fileId: 501, index: 1, content: '发票在订单完成后可以申请。', wordCount: 13, status: 'processing' },
];

// 画布：1 收到文本 → 2 回答生成（挂售后 FAQ、财务 FAQ 两个知识库工具）、3 闲聊（挂了一个已被删的库）、4 查手册（知识库查询节点）
export function kbCanvas() {
  const tool = (kb) => ({ type: 'query_kb', configParams: { knowledgeBaseId: kb } });
  return [
    node(1, { name: '收到文本', type: 'receive-text-message', category: 'trigger' }),
    node(2, { name: '回答生成', payload: { modelType: 'doubao', tools: [tool(KB_FAQ), tool(KB_OTHER)] } }),
    node(3, { name: '闲聊', payload: { modelType: 'doubao', tools: [tool(KB_GONE)] } }),
    node(4, {
      name: '查手册', type: 'query-knowledge-base',
      payload: { knowledgeBaseIds: [KB_FILE], resultCount: 5, threshold: 80, rerankType: 'weighted', weightedRerankConfig: { vectorWeight: 0.5 }, query: { valueType: 'reference', dataPath: 'text' } },
    }),
    edge(101, 1, 2), edge(102, 1, 3), edge(103, 1, 4),
  ];
}

// 一次大模型调知识库工具的记录（spec §2.5 的真实结构）。召回按假相似度现算：只有已审核的、过了门槛的，最多 10 条
export function toolCall(kb, query, { threshold = 0.6, topK = 3, success = true } = {}) {
  const result = faqs()
    .filter((f) => f.kb === kb && f.isReviewed)
    .map((f) => ({ f, score: sim(query, f.question) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ f, score }) => ({
      knowledgeBaseId: kb, score, content: `${f.question} ${f.answer}`, sourceType: 'qa',
      reference: { type: 'qa', source: { id: f.id, question: f.question, answer: f.answer, reviewed: true, duplicateStatus: 'normal' } },
    }));
  return {
    name: `q_kb_${kb}`, toolType: 'query_kb', toolCallArguments: { query, threshold, topK },
    toolResult: success ? { success: true, result } : { success: false, error: '知识库服务超时' },
  };
}

// 一条执行：用户问 ask（event=true 时是事件触发、取不到用户原话），「回答生成」这次的知识库工具调用是 calls
export function kbExec(n, ask, calls, { extraResults = [], event = false } = {}) {
  const row = { ...chainRows()[0], execId: X(n) };
  if (event) {
    row.triggerContent = { triggerType: 'canvas-event-trigger', content: { eventId: 'ev-x', eventName: '回访', data: { contactId: 'c1' } } };
    row.rawTrigger = { triggerType: 'canvas-event-trigger', sessionId: row.sessionId, triggerSource: 'mh', canvasEvent: { eventId: 'ev-x', data: { contactId: 'c1' } } };
  } else {
    row.triggerContent = { triggerType: 'receive-text-message', content: { text: ask } };
    row.rawTrigger = { triggerType: 'receive-text-message', sessionId: row.sessionId, triggerSource: 'mh', receiveTextMessage: { text: ask, contactId: 'c1' } };
  }
  const nodeResults = [
    { nodeId: U(1), status: 'success', inputs: { inputData: {} }, output: { text: ask }, processDuration: 1, actions: [] },
    { nodeId: U(2), status: 'success', inputs: { inputData: { text: ask } }, output: { message: '好的' }, processDuration: 900, actions: [], metadata: { toolCallResults: calls } },
    ...extraResults,
  ];
  return detailOf(row, { snapshot: kbCanvas(), nodeResults });
}
