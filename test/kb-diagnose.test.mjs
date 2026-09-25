// 「为什么没召回这一条」的判定（spec 3a §3.5 第 6 步）
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMON_THRESHOLD, diagnose } from '../src/kb-diagnose.mjs';

const call = (extra = {}) => ({ kind: 'call', query: '怎么退款', threshold: 0.6, limit: 10, ok: true, error: '', replayable: true, estimated: false, ...extra });
const reviewed = { inQueriedKb: true, reviewed: true };
const codes = (r) => r.map((x) => x.code);

test('diagnose：工具调用失败时只报这一条，不当成没召回（Review Focus 3）', () => {
  assert.deepEqual(diagnose({ retrieval: call({ ok: false, error: '知识库服务超时' }), target: reviewed }), [{ code: 'tool_error', title: '知识库工具调用失败', detail: '知识库服务超时' }]);
});

test('diagnose：挂了知识库工具、这次一次都没调', () => {
  assert.deepEqual(codes(diagnose({ retrieval: null, silent: true })), ['no_call']);
});

test('diagnose：不在查询的库里就报出在哪个库，不再算分数', () => {
  const r = diagnose({ retrieval: call(), target: { inQueriedKb: false, otherKbName: '财务 FAQ' }, replay: { query: { floor: 0.85, count: 3 } } });
  assert.deepEqual(codes(r), ['wrong_kb']);
  assert.equal(r[0].detail, '这一条在「财务 FAQ」里，这次查的不是这个库');
});

test('diagnose：未审核的只报未审核，不拿重放结果凑「分数不够」；段落没处理完报还在处理', () => {
  assert.deepEqual(codes(diagnose({ retrieval: call({ recorded: 3 }), target: { inQueriedKb: true, reviewed: false }, replay: { query: { floor: 0.85, count: 3 } } })), ['unreviewed']);
  assert.deepEqual(codes(diagnose({ retrieval: call({ replayable: false }), target: { inQueriedKb: true, status: 'processing' } })), ['processing']);
});

test('diagnose：查询被改写——原话能召回、模型的查询不能；分数不够作为补充', () => {
  const r = diagnose({ retrieval: call({ query: '退款流程', recorded: 0 }), target: reviewed, userText: '课程怎么退款', replay: { query: { floor: null, count: 0 }, user: { score: 1, rank: 1 } } });
  assert.deepEqual(codes(r), ['rewritten', 'below_threshold']);
  assert.equal(r[0].detail, '拿去查的是「退款流程」，不是用户原话；用原话查，这一条排第 1（1.000）');
  assert.equal(r[1].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的），它的分数低于 0.8；这次只召回了 0 条（不满 10 条），过了门槛的都召回了，所以它没过门槛 0.600');
});

test('diagnose：取不到用户原话时不判「查询被改写」（Review Focus 4）', () => {
  const r = diagnose({ retrieval: call({ query: '退款流程', recorded: 0 }), target: reviewed, userText: '', replay: { query: { floor: null, count: 0 }, user: { score: 1, rank: 1 } } });
  assert.deepEqual(codes(r), ['below_threshold']);
});

test('diagnose：门槛是模型自己定的、比常见的 0.6 高时，说出换成 0.6 能不能过', () => {
  const r = diagnose({ retrieval: call({ query: '课程怎么退', threshold: 0.9 }), target: reviewed, userText: '课程怎么退', replay: { query: { score: 0.8889, rank: 1 }, user: { score: 0.8889, rank: 1 } } });
  assert.deepEqual(codes(r), ['below_threshold']);
  assert.equal(r[0].detail, `分数 0.889 低于门槛 0.900；门槛是模型这次自己定的，用 ${COMMON_THRESHOLD} 就能过`);
});

test('diagnose：分数过了门槛但排在 10 条之外是被挤出', () => {
  const r = diagnose({ retrieval: call(), target: reviewed, replay: { query: { score: 0.9, rank: 12 } } });
  assert.deepEqual(codes(r), ['crowded_out']);
  assert.equal(r[0].detail, '分数 0.900 过了门槛，但排第 12');
});

test('diagnose：重放里没有这一条（分数低于 0.8，控制台看不到）时按门槛和召回条数推断（spec §3.5 判定表）', () => {
  const missing = (retrieval, count, floor = count ? 0.82 : null) => diagnose({ retrieval, target: reviewed, replay: { query: { floor, count } } });
  // 门槛不低于 0.8：它的分数低于门槛
  const high = missing(call({ threshold: 0.85, recorded: 0 }), 3);
  assert.deepEqual(codes(high), ['below_threshold']);
  assert.equal(high[0].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的），它的分数低于门槛 0.850');
  // 0.8 以上的都过了门槛，已经有 12 条：被挤出前 10 条（门槛低于 0.8、等于 0.8 都一样）
  const crowded = missing(call({ recorded: 10 }), 12);
  assert.deepEqual(codes(crowded), ['crowded_out']);
  assert.equal(crowded[0].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的）；过了门槛、分数比它高的已经有 12 条');
  assert.deepEqual(codes(missing(call({ threshold: 0.8, recorded: 10 }), 12)), ['crowded_out']);
  // 这次只召回了 3 条，不满 10 条：过了门槛的都召回了，它没过门槛
  const few = missing(call({ recorded: 3 }), 3);
  assert.deepEqual(codes(few), ['below_threshold']);
  assert.match(few[0].detail, /这次只召回了 3 条（不满 10 条）/);
  // 召回满了 10 条、0.8 以上的只有 3 条（或者一条都没有）：推不出是没过门槛还是被挤出
  const low = missing(call({ recorded: 10 }), 3);
  assert.deepEqual(codes(low), ['low_score']);
  assert.equal(low[0].title, '分数偏低');
  assert.equal(low[0].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的），它的分数低于 0.8，更低的分数控制台看不到；这次召回满了 10 条，推不出是没过门槛 0.600 还是被挤出前 10 条，用 md trial 换问法试');
  assert.deepEqual(codes(missing(call({ recorded: 10 }), 0)), ['low_score']);
});

test('diagnose：知识库查询节点的结论注明是估计；没有运行记录时推不出就是分数偏低；只有文件的库没法重放', () => {
  const node = (extra) => call({ kind: 'node', limit: 5, estimated: true, recorded: null, ...extra });
  const r = diagnose({ retrieval: node({ threshold: 0.9 }), target: reviewed, replay: { query: { score: 0.85, rank: 1 } } });
  assert.deepEqual(codes(r), ['below_threshold']);
  assert.match(r[0].detail, /这是按语义分数估计的，用 md trial 确认/);
  assert.deepEqual(codes(diagnose({ retrieval: node({ threshold: 0.6 }), target: reviewed, replay: { query: { floor: 0.82, count: 2 } } })), ['low_score']);
  const f = diagnose({ retrieval: node({ replayable: false }), target: { inQueriedKb: true, status: 'ready' } });
  assert.deepEqual(codes(f), ['unknown']);
  assert.match(f[0].detail, /只有文件段落，没有语义搜索接口/);
});

test('diagnose：都不成立就是查不出', () => {
  assert.deepEqual(codes(diagnose({ retrieval: call(), target: reviewed, replay: { query: { score: 0.9, rank: 1 } } })), ['unknown']);
});
