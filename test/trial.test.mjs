import test from 'node:test';
import assert from 'node:assert/strict';
import { node } from './helpers/fixtures.mjs';
import { UNKNOWN_RUN_COST, buildTrialInputs, classifyTrialNode, costOf, costSummary, draftVsLocal, inputDefs, nextRunCheck, parseInputPairs } from '../src/trial.mjs';

const llm = node(2, { name: '回答生成', payload: { inputs: [{ name: 'text', referenceNodeId: 'x' }, { name: '质检规则', operationAttrId: 'op-1' }] } });

test('classifyTrialNode：计算类能跑；插件类要 --allow-plugin；动作、触发、未知一律不跑', () => {
  assert.equal(classifyTrialNode(llm).kind, 'allowed');
  assert.equal(classifyTrialNode(node(3, { type: 'rule-center' })).kind, 'allowed');
  assert.deepEqual(classifyTrialNode(node(7, { name: '兴趣岛用户详情', type: 'plugin-calculation' })), { kind: 'plugin', type: 'plugin-calculation', plugins: ['兴趣岛用户详情'] });
  const withTool = node(8, { payload: { tools: [{ type: 'query_kb', configParams: { knowledgeBaseId: 'kb-1' } }, { type: 'plugin', name: '写多维表' }] } });
  assert.deepEqual(classifyTrialNode(withTool).plugins, ['写多维表']);
  for (const type of ['send-text-message', 'handover', 'canvas-event-action', 'update-data', 'tag-user', 'plugin-action', 'receive-text-message', 'loop', 'write-content-router', 'whatever-new']) {
    assert.equal(classifyTrialNode(node(9, { type })).kind, 'denied', type);
  }
});

test('inputDefs：标出平台参数；没有 inputs 时用 query；web-search 要 count；语音按 mediaUrl 类型', () => {
  assert.deepEqual(inputDefs(llm), [{ name: 'text', platform: false }, { name: '质检规则', platform: true }]);
  assert.deepEqual(inputDefs(node(4, { type: 'query-knowledge-base', payload: { query: { name: 'query' } } })), [{ name: 'query', platform: false }]);
  assert.ok(inputDefs(node(5, { type: 'web-search', payload: { inputs: [{ name: 'q' }] } })).some((d) => d.name === 'count'));
  assert.ok(inputDefs(node(6, { type: 'speech-to-text', payload: { mediaUrl: { type: { type: 'audio' } } } })).some((d) => d.name === 'audioUrl'));
});

test('parseInputPairs：键=值；值里可以再有等号；没有等号报用法错误', () => {
  assert.deepEqual(parseInputPairs(['text=你好', 'expr=a=b']), { text: '你好', expr: 'a=b' });
  assert.throws(() => parseInputPairs(['text']), (e) => e.exitCode === 2);
});

test('buildTrialInputs：执行里带的平台参数默认去掉；文件和 --input 覆盖；列出缺的和多的', () => {
  const defs = inputDefs(llm);
  const fromExec = { text: '我想退款', 质检规则: '旧规则', extra1: 'x' };
  const a = buildTrialInputs(defs, { fromExec });
  assert.deepEqual(a.inputs, { text: '我想退款', extra1: 'x' });
  assert.deepEqual(a.dropped, ['质检规则']);
  assert.deepEqual(a.extra, ['extra1']);
  assert.deepEqual(buildTrialInputs(defs, { fromExec, keepPlatform: true }).inputs.质检规则, '旧规则');
  const b = buildTrialInputs(defs, { fromExec, fromFile: { text: '文件里的' }, overrides: { text: '参数里的' } });
  assert.equal(b.inputs.text, '参数里的');
  assert.deepEqual(buildTrialInputs(defs, {}).missing, ['text']);
});

test('draftVsLocal：本地改了没推 / 草稿在拉取后被改过 / 一致 / 没有工作副本', () => {
  const draft = [llm];
  const changed = { ...llm, data: { ...llm.data, nodePayload: { ...llm.data.nodePayload, systemPrompt: '新' } } };
  assert.equal(draftVsLocal(llm.id, draft, null).status, 'no-workspace');
  assert.equal(draftVsLocal(llm.id, draft, { dir: '/w', base: { canvas: [llm] }, after: { canvas: [changed] } }).status, 'unpushed');
  assert.equal(draftVsLocal(llm.id, draft, { dir: '/w', base: { canvas: [changed] }, after: null }).status, 'draft-changed');
  assert.equal(draftVsLocal(llm.id, draft, { dir: '/w', base: { canvas: [llm] }, after: null }).status, 'same');
});

test('draftVsLocal：本地只改了别的节点、这个节点没动，而草稿里它被人改了 → 算草稿被改过，不算本地没推', () => {
  const other = node(3, { name: '别的节点' });
  const otherEdited = { ...other, data: { ...other.data, name: '别的节点（本地改）' } };
  const remote = { ...llm, data: { ...llm.data, nodePayload: { ...llm.data.nodePayload, systemPrompt: '网页上改的' } } };
  const ws = { dir: '/w', base: { canvas: [llm, other] }, after: { canvas: [llm, otherEdited] } };
  assert.equal(draftVsLocal(llm.id, [remote, other], ws).status, 'draft-changed');
  assert.equal(draftVsLocal(other.id, [remote, other], ws).status, 'unpushed');
});

test('costOf：有花费字段用它；超时没跑完不知道；没有花费字段时只有代码、规则、计算器这类本来免费的节点算 ¥0（审查 I1）', () => {
  assert.equal(costOf({ cost: { cny: 0.02 } }, 'llm-completion', false), 0.02);
  assert.equal(costOf({ cost: { cny: 0.02 } }, 'llm-completion', true), null);
  assert.equal(costOf({ cost: { cny: null } }, 'llm-completion', false), null);
  assert.equal(costOf({ cost: { cny: null } }, 'image-generation', false), null);
  assert.equal(costOf({ cost: { cny: null } }, 'javascript-code', false), 0);
  assert.equal(costOf({ cost: { cny: null } }, 'rule-center', false), 0);
});

test('costSummary：知道的按实际；不知道的不算进实际、不摊进每次花费，另按保守单价记（审查 I2）', () => {
  assert.deepEqual(costSummary([{ cost: 0.01 }, { cost: 0 }]), { actual: 0.01, perRun: 0.005, unknownRuns: 0, assumed: 0 });
  assert.deepEqual(costSummary([{ cost: null }]), { actual: 0, perRun: null, unknownRuns: 1, assumed: UNKNOWN_RUN_COST });
  assert.deepEqual(costSummary([{ cost: 0.02 }, { cost: null }]), { actual: 0.02, perRun: 0.02, unknownRuns: 1, assumed: 0.02 });
  assert.deepEqual(costSummary([{ cost: null }, { cost: null }], 0.3), { actual: 0, perRun: null, unknownRuns: 2, assumed: 0.6 });
  assert.deepEqual(costSummary([]), { actual: 0, perRun: null, unknownRuns: 0, assumed: 0 });
});

test('nextRunCheck：每跑完一次按实际重算整条命令，超单次门槛 / 每日上限就在下一次之前停（审查 C1）', () => {
  const limits = { perCommand: 2, perDay: 10 };
  const base = { limits, othersToday: 0, confirmed: false, confirmedEstimate: null };
  // 预估偏低：执行记录里 ¥0.0102/次，实际 ¥1/次，--times 10
  const stale = nextRunCheck({ ...base, runs: [{ cost: 1 }], remaining: 9, perRun: 0.0102 });
  assert.equal(stale.ok, false);
  assert.match(stale.reasons.join(), /整条命令要 ¥10\.00，超过单次门槛 ¥2\.00/);
  assert.equal(stale.rest, 9);
  // 先跑 1 次：拿「已花 + 其余」比门槛，不是只拿其余
  assert.equal(nextRunCheck({ ...base, runs: [{ cost: 0.9 }], remaining: 2, perRun: null }).ok, false);
  assert.equal(nextRunCheck({ ...base, runs: [{ cost: 0.01 }], remaining: 1, perRun: 0.01 }).ok, true);
  assert.equal(nextRunCheck({ ...base, runs: [{ cost: 0.01 }], remaining: 1, perRun: 0.01 }).projected, 0.02);
  // 还是估不出：停；用户确认过「估不出」就照跑
  const unknown = nextRunCheck({ ...base, runs: [{ cost: null }], remaining: 2, perRun: null });
  assert.deepEqual([unknown.ok, unknown.rest], [false, null]);
  assert.match(unknown.reasons.join(), /估不出花费/);
  assert.equal(nextRunCheck({ ...base, confirmed: true, runs: [{ cost: null }], remaining: 2, perRun: null }).ok, true);
  // 用户确认过 ¥5：实际推算超出一个单次门槛以上才停
  assert.equal(nextRunCheck({ ...base, confirmed: true, confirmedEstimate: 5, runs: [{ cost: 0.6 }], remaining: 9, perRun: 0.5 }).ok, true);
  const over = nextRunCheck({ ...base, confirmed: true, confirmedEstimate: 5, runs: [{ cost: 1 }], remaining: 9, perRun: 0.5 });
  assert.equal(over.ok, false);
  assert.match(over.reasons.join(), /比确认时的预估 ¥5\.00 高出一个单次门槛以上/);
  // 每日上限：今天别的花费 + 这条命令
  const daily = nextRunCheck({ ...base, othersToday: 9.5, runs: [{ cost: 0.3 }], remaining: 1, perRun: 0.3 });
  assert.equal(daily.ok, false);
  assert.match(daily.reasons.join(), /每日上限/);
});

test('classifyTrialNode：工具按真实字段 type 认，只放行知识库查询；认不出的工具类型一律按外部调用处理（审查 M6，计划里写的 toolType 在真实画布里不存在）', () => {
  assert.equal(classifyTrialNode(node(8, { payload: { tools: [{ type: 'query_kb', configParams: { knowledgeBaseId: 'kb-1' } }] } })).kind, 'allowed');
  assert.deepEqual(classifyTrialNode(node(8, { payload: { tools: [{ type: 'http_request', name: '调接口' }] } })).plugins, ['调接口']);
  assert.deepEqual(classifyTrialNode(node(8, { payload: { tools: [{ type: 'mcp' }] } })).plugins, ['mcp']);
  assert.deepEqual(classifyTrialNode(node(8, { payload: { tools: [{ toolType: 'plugin', name: '旧写法' }] } })).plugins, ['旧写法']);
});

test('nextRunCheck：按类型证明不花钱（free）的直接放行，不因今天超了每日上限停下；没有 free 的照旧停（审查 I1）', () => {
  const limits = { perCommand: 2, perDay: 100 };
  const base = { runs: [{ cost: 0 }], remaining: 2, perRun: 0, confirmed: false, confirmedEstimate: null, limits, othersToday: 117.82 };
  assert.deepEqual(nextRunCheck({ ...base, free: true }), { ok: true, projected: 0 });
  assert.equal(nextRunCheck(base).ok, false);
});
