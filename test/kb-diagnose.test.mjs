// 「为什么没召回这一条」的判定（spec 3a §3.5 第 6 步）
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMON_THRESHOLD, diagnose, drifted } from '../src/kb-diagnose.mjs';

const call = (extra = {}) => ({ kind: 'call', query: '怎么退款', threshold: 0.6, limit: 10, ok: true, failed: false, error: '', noReplay: null, estimated: false, ...extra });
const reviewed = { inQueriedKb: true, reviewed: true };
const codes = (r) => r.map((x) => x.code);

test('diagnose：工具调用失败时只报这一条，不当成没召回（Review Focus 3）', () => {
  assert.deepEqual(diagnose({ retrieval: call({ ok: false, failed: true, error: '知识库服务超时' }), target: reviewed }), [{ code: 'tool_error', title: '知识库工具调用失败', detail: '知识库服务超时' }]);
  // 返回认不出：不说失败，也不当成召回 0 条去推原因
  assert.deepEqual(diagnose({ retrieval: call({ ok: false, error: '这次调用的返回认不出（没有 success=true 和召回列表）' }), target: reviewed }), [{ code: 'tool_unknown', title: '工具的返回认不出', detail: '这次调用的返回认不出（没有 success=true 和召回列表）' }]);
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
  assert.deepEqual(codes(diagnose({ retrieval: call({ noReplay: '查的库只有文件段落，没有语义搜索接口' }), target: { inQueriedKb: true, status: 'processing' } })), ['processing']);
});

test('diagnose：查询被改写——原话能召回、模型的查询不能；分数不够作为补充', () => {
  const r = diagnose({ retrieval: call({ query: '退款流程', recorded: 0 }), target: reviewed, userText: '课程怎么退款', replay: { query: { floor: null, count: 0 }, user: { score: 1, rank: 1 } } });
  assert.deepEqual(codes(r), ['rewritten', 'below_threshold']);
  assert.equal(r[0].detail, '拿去查的是「退款流程」，不是用户原话；用原话查，这一条排第 1（1.000）');
  assert.equal(r[1].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的），它的分数低于 0.8；这次一条都没召回，说明没有过门槛 0.600 的，它也没过');
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
  assert.equal(r[0].title, '被挤出前 10 名');
  assert.equal(r[0].detail, '分数 0.900 过了门槛，但排第 12 名（同一条 FAQ 在索引里可能占好几个名次）');
});

test('diagnose：重放里没有这一条（分数低于 0.8，控制台看不到）时按门槛和召回条数推断（spec §3.5 判定表）', () => {
  const missing = (retrieval, count, { floor = count ? 0.82 : null, passing = count, truncated = false } = {}) => diagnose({ retrieval, target: reviewed, replay: { query: { floor, count, passing, truncated } } });
  // 门槛不低于 0.8：它的分数低于门槛
  const high = missing(call({ threshold: 0.85, recorded: 0 }), 3, { passing: 2 });
  assert.deepEqual(codes(high), ['below_threshold']);
  assert.equal(high[0].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的），它的分数低于门槛 0.850');
  // 0.8 以上的行都过了门槛，已经占了 12 个名次：被挤出前 10 名（门槛低于 0.8、等于 0.8 都一样）
  const crowded = missing(call({ recorded: 10 }), 12);
  assert.deepEqual(codes(crowded), ['crowded_out']);
  assert.equal(crowded[0].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的）；过了门槛、分数比它高的已经占了 12 个名次（同一条 FAQ 在索引里可能占好几个名次）');
  // 门槛 0.8、重放没截断时，它不在 0.8 以上的结果里，分数也必然低于门槛：不够门槛作补充（整支审查小问题 2）
  assert.deepEqual(codes(missing(call({ threshold: 0.8, recorded: 10 }), 12)), ['crowded_out', 'below_threshold']);
  // 这次一条都没召回：没有过门槛的，它也没过
  assert.deepEqual(codes(missing(call({ recorded: 0 }), 0)), ['below_threshold']);
  // 召回了 3 条、不满 10 条也推不出：同一条 FAQ 占好几行时，前 10 行去重后本来就不满 10 条（09-25 真机：20 次不满 10 条全是这样）
  const few = missing(call({ recorded: 3 }), 3);
  assert.deepEqual(codes(few), ['low_score']);
  assert.equal(few[0].title, '分数偏低');
  assert.equal(few[0].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的），它的分数低于 0.8，更低的分数控制台看不到；推不出是没过门槛 0.600 还是被挤出前 10 名，用 md trial 换问法试');
  assert.deepEqual(codes(missing(call({ recorded: 10 }), 3)), ['low_score']);
  assert.deepEqual(codes(missing(call({ recorded: 10 }), 0)), ['low_score']);
});

test('diagnose：知识库查询节点的结论注明是估计；没有运行记录时推不出就是分数偏低；只有文件的库没法重放', () => {
  const node = (extra) => call({ kind: 'node', limit: 5, estimated: true, recorded: null, ...extra });
  const r = diagnose({ retrieval: node({ threshold: 0.9 }), target: reviewed, replay: { query: { score: 0.85, rank: 1 } } });
  assert.deepEqual(codes(r), ['below_threshold']);
  assert.match(r[0].detail, /这是按语义分数估计的，用 md trial 确认/);
  assert.deepEqual(codes(diagnose({ retrieval: node({ threshold: 0.6 }), target: reviewed, replay: { query: { floor: 0.82, count: 2 } } })), ['low_score']);
  const f = diagnose({ retrieval: node({ noReplay: '查的库只有文件段落，没有语义搜索接口' }), target: { inQueriedKb: true, status: 'ready' } });
  assert.deepEqual(codes(f), ['unknown']);
  assert.match(f[0].detail, /只有文件段落，没有语义搜索接口/);
});

test('diagnose：都不成立就是查不出', () => {
  assert.deepEqual(codes(diagnose({ retrieval: call(), target: reviewed, replay: { query: { score: 0.9, rank: 1 } } })), ['unknown']);
});

const row = (id, similarity) => ({ id, similarity });
const hit = (faqId, score, type = 'qa') => ({ faqId, score, type });
const rec = (hits, extra = {}) => ({ kind: 'call', threshold: 0.6, limit: 10, hits, ...extra });
const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('drifted：只比分数不低于门槛和 0.8 里较大那个的部分；门槛和 0.8 之间的召回重放看不到，不算改过', () => {
  assert.equal(drifted(rec([hit(1, 0.9), hit(2, 0.75)]), [row(1, 0.9)]), false);
  assert.equal(drifted(rec([hit(1, 0.9)]), [row(3, 0.95), row(1, 0.9)]), true);
  assert.equal(drifted(rec([hit(1, 0.9), hit(2, 0.85)]), [row(1, 0.9)]), true);
  assert.equal(drifted(rec([hit(1, 0.9)], { threshold: 0.92 }), [row(3, 0.91), row(1, 0.9)]), false);
});

test('drifted：同一条 FAQ 在重放里占好几行时，按工具的做法取前 10 行再去重（09-25 真机验收）', () => {
  const rows = [row(1, 0.99), row(1, 0.95), ...ids(2, 9).map((id) => row(id, 0.9)), row(10, 0.85)];
  assert.equal(drifted(rec([hit(1, 0.99), ...ids(2, 9).map((id) => hit(id, 0.9))]), rows), false);
  assert.equal(drifted(rec([hit(1, 0.99), ...ids(2, 10).map((id) => hit(id, id === 10 ? 0.85 : 0.9))]), rows), true);
});

test('drifted：边界上分数只差一点点的一进一出不算改过（两边分数实测最多差 0.0007）', () => {
  // 第 10 名和第 11 名只差 0.0001：记录里是 #11，重放里是 #10
  const rows = [...ids(1, 9).map((id) => row(id, 0.95)), row(10, 0.8569), row(11, 0.8568)];
  assert.equal(drifted(rec([...ids(1, 9).map((id) => hit(id, 0.95)), hit(11, 0.8569)]), rows), false);
  // 记录的 0.8003 过了 0.8，重放的那一行是 0.7998、看不到
  assert.equal(drifted(rec([hit(1, 0.95), hit(2, 0.8003)]), [row(1, 0.95)]), false);
});

test('drifted：召回里的段落占掉名额，段落本身不和重放比', () => {
  const rows = ids(1, 10).map((id) => row(id, 0.9));
  assert.equal(drifted(rec([hit(900, 0.95, 'doc'), ...ids(1, 9).map((id) => hit(id, 0.9))]), rows), false);
});

test('diagnose：「用 0.6 就能过」要看名次——排在前 10 名之外时，换成 0.6 也照样进不去', () => {
  const r = diagnose({ retrieval: call({ threshold: 0.9 }), target: reviewed, replay: { query: { score: 0.8333, rank: 13 } } });
  assert.deepEqual(codes(r), ['below_threshold']);
  assert.equal(r[0].detail, `分数 0.833 低于门槛 0.900；门槛是模型这次自己定的，用 ${COMMON_THRESHOLD} 也只排第 13 名，照样进不了前 10 名`);
});

test('diagnose：重放不了（查询取不到、带了标签、库已删、只有文件）时只报查不出，不拿空的重放推原因', () => {
  for (const why of ['这次检索的查询取不到', '模型这次按标签（售后）过滤了，重放不带标签，结果不可比', '查的库已经不在企业里了（执行之后被删了？）']) {
    const r = diagnose({ retrieval: call({ noReplay: why, recorded: 0 }), target: reviewed, replay: { query: { floor: null, count: 0 } } });
    assert.deepEqual(r, [{ code: 'unknown', title: '查不出', detail: `${why}，只能用 md trial 看` }]);
  }
});

test('diagnose：被挤出和不够门槛同时成立时都报：被挤出是结论，不够门槛作补充（整支审查小问题 2）', () => {
  const missing = (retrieval, q) => diagnose({ retrieval, target: reviewed, replay: { query: q } });
  const both = missing(call({ threshold: 0.8, recorded: 10 }), { floor: 0.82, count: 12, passing: 12, truncated: false });
  assert.deepEqual(codes(both), ['crowded_out', 'below_threshold']);
  assert.equal(both[1].detail, '重放结果里没有这一条（语义搜索只返回 0.8 以上的），它的分数低于门槛 0.800');
  // 门槛 0.85：最低分 0.82 没过门槛，但过了门槛的也已经有 11 行
  assert.deepEqual(codes(missing(call({ threshold: 0.85, recorded: 10 }), { floor: 0.82, count: 30, passing: 11, truncated: false })), ['crowded_out', 'below_threshold']);
  // 重放截断了（取满 50 行）、最低分也过了门槛：它可能也在 0.8 以上，只能说被挤出
  assert.deepEqual(codes(missing(call({ threshold: 0.8, recorded: 10 }), { floor: 0.9, count: 50, passing: 50, truncated: true })), ['crowded_out']);
  // 找到了、分数不够门槛：过了门槛的已经占了 11 个名次，就算它过了门槛也进不去
  const found = diagnose({ retrieval: call({ threshold: 0.9 }), target: reviewed, replay: { query: { score: 0.8333, rank: 13, passing: 11 } } });
  assert.deepEqual(codes(found), ['below_threshold', 'crowded_out']);
  assert.equal(found[1].detail, '过了门槛、分数比它高的已经占了 11 个名次，就算它过了门槛也进不了前 10 名（同一条 FAQ 在索引里可能占好几个名次）');
});

test('diagnose：工具调用没记录门槛时，只下和门槛无关的结论（整支审查小问题 5）', () => {
  const noT = (q, extra = {}) => diagnose({ retrieval: call({ threshold: null, recorded: 3, ...extra }), target: reviewed, replay: { query: q } });
  const far = noT({ score: 0.9, rank: 12, passing: null });
  assert.deepEqual(codes(far), ['crowded_out']);
  assert.equal(far[0].detail, '分数 0.900，排第 12 名：就算过了门槛也进不了前 10 名（同一条 FAQ 在索引里可能占好几个名次）');
  assert.deepEqual(codes(noT({ floor: 0.82, count: 12, passing: null, truncated: false })), ['crowded_out']);
  assert.deepEqual(noT({ score: 0.9, rank: 2, passing: null }), [{ code: 'unknown', title: '查不出', detail: '这次调用没记录门槛，推不出为什么没召回；用 md trial 看' }]);
  assert.deepEqual(codes(noT({ floor: 0.82, count: 3, passing: null, truncated: false })), ['unknown']);
  // 也不判「查询被改写」：原话能不能召回要看门槛
  const r = diagnose({ retrieval: call({ threshold: null, query: '退款流程' }), target: reviewed, userText: '课程怎么退款', replay: { query: { floor: null, count: 0, passing: null, truncated: false }, user: { score: 1, rank: 1, passing: null } } });
  assert.deepEqual(codes(r), ['unknown']);
});

test('drifted：没记录门槛时，拿记录里最低的分数当线（门槛不会比它高）', () => {
  assert.equal(drifted(rec([hit(1, 0.9), hit(2, 0.85)], { threshold: null }), [row(1, 0.9), row(2, 0.85), row(3, 0.82)]), false);
  assert.equal(drifted(rec([hit(1, 0.9), hit(2, 0.85)], { threshold: null }), [row(1, 0.9), row(3, 0.87), row(2, 0.85)]), true);
  assert.equal(drifted(rec([], { threshold: null }), [row(1, 0.9)]), false);
});
