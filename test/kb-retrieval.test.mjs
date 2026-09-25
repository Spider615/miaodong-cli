// 执行记录里的知识库检索（spec 3a §2.5、§3.5 第 2 步）
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDetail } from '../src/exec-detail.mjs';
import { retrievalsOf } from '../src/kb-retrieval.mjs';
import { U } from './helpers/fixtures.mjs';
import { KB_FAQ, KB_FILE, KB_GONE, KB_OTHER, kbExec, toolCall } from './helpers/kb-fixtures.mjs';

test('kb retrieval：大模型每次调知识库工具是一次检索：库、查询、模型定的门槛、最多 10 条、召回的条目（类型、分数）', () => {
  const norm = normalizeDetail(kbExec(11, '课程怎么退款', [toolCall(KB_FAQ, '怎么退款', { threshold: 0.6 })]));
  assert.equal(norm.exec.triggerText, '课程怎么退款');
  const { calls, kbNodes, silent } = retrievalsOf(norm);
  assert.equal(calls.length, 1);
  const { hits, ...call } = calls[0];
  assert.deepEqual(call, { kind: 'call', nodeId: U(2), nodeName: '回答生成', order: 2, callIndex: 1, kbId: KB_FAQ, query: '怎么退款', threshold: 0.6, tags: [], limit: 10, ok: true, failed: false, error: '' });
  assert.deepEqual(hits, [{ faqId: 7001, question: '课程怎么退款', score: 0.75, kbId: KB_FAQ, type: 'qa' }]);
  assert.deepEqual([kbNodes, silent], [[], []]);
});

test('kb retrieval：一个节点调了两个库就是两次检索；工具调用失败也列出来（ok=false）', () => {
  const norm = normalizeDetail(kbExec(12, '发票', [toolCall(KB_FAQ, '发票', { threshold: 0.6 }), toolCall(KB_OTHER, '发票', { success: false })]));
  const { calls } = retrievalsOf(norm);
  assert.deepEqual(calls.map((c) => [c.callIndex, c.kbId, c.ok, c.error]), [[1, KB_FAQ, true, ''], [2, KB_OTHER, false, '知识库服务超时']]);
});

test('kb retrieval：挂了知识库工具、这次一次都没调的大模型节点算 silent；知识库查询节点带配置和原样的输入', () => {
  const extra = [
    { nodeId: U(3), status: 'success', inputs: { inputData: { text: '你好' } }, output: { message: '你好呀' }, processDuration: 5, actions: [], metadata: {} },
    { nodeId: U(4), status: 'success', inputs: { inputData: { query: '你好' } }, output: { result: [] }, processDuration: 5, actions: [] },
  ];
  const { calls, kbNodes, silent } = retrievalsOf(normalizeDetail(kbExec(13, '你好', [], { extraResults: extra })));
  assert.deepEqual(calls, []);
  assert.deepEqual(silent.map((s) => [s.nodeName, s.order, s.kbIds]), [['回答生成', 2, [KB_FAQ, KB_OTHER]], ['闲聊', 3, [KB_GONE]]]);
  assert.equal(kbNodes.length, 1);
  assert.deepEqual({ ...kbNodes[0], output: undefined }, { kind: 'node', nodeId: U(4), nodeName: '查手册', order: 4, kbIds: [KB_FILE], threshold: 80, limit: 5, rerank: '加权（向量 0.5）', inputs: { query: '你好' }, output: undefined });
});

test('kb retrieval：召回条目没写类型时当作 FAQ（spec §2.5：76 次调用全是 qa）；写了就照记', () => {
  const c = toolCall(KB_FAQ, '怎么退款', { threshold: 0.6 });
  const bare = { ...c, toolResult: { success: true, result: c.toolResult.result.map(({ sourceType, reference, ...h }) => ({ ...h, reference: { source: reference.source } })) } };
  const doc = { ...c, toolResult: { success: true, result: [{ knowledgeBaseId: KB_FAQ, score: 0.85, content: '段落', sourceType: 'doc', reference: { type: 'doc', source: { id: 9001 } } }] } };
  const { calls } = retrievalsOf(normalizeDetail(kbExec(14, '怎么退款', [bare, doc])));
  assert.deepEqual(calls.map((x) => x.hits.map((h) => [h.faqId, h.type])), [[[7001, 'qa']], [[9001, 'doc']]]);
});

test('kb retrieval：返回认不出（没有 success=true 和召回列表）不当成「成功、召回 0 条」；模型传的标签照记', () => {
  const c = toolCall(KB_FAQ, '怎么退款', { threshold: 0.6 });
  const odd = [{ ...c, toolResult: { error: 'timeout' } }, { ...c, toolResult: undefined }, { ...c, toolResult: { success: true, result: null } }];
  const tagged = { ...c, toolCallArguments: { ...c.toolCallArguments, tags: ['售后'] } };
  const { calls } = retrievalsOf(normalizeDetail(kbExec(15, '怎么退款', [...odd, tagged])));
  assert.deepEqual(calls.slice(0, 3).map((x) => [x.ok, x.failed, x.error]), Array(3).fill([false, false, '这次调用的返回认不出（没有 success=true 和召回列表）']));
  assert.deepEqual([calls[3].ok, calls[3].tags], [true, ['售后']]);
});
