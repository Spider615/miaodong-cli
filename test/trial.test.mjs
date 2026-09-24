import test from 'node:test';
import assert from 'node:assert/strict';
import { node } from './helpers/fixtures.mjs';
import { buildTrialInputs, classifyTrialNode, costSummary, draftVsLocal, inputDefs, parseInputPairs } from '../src/trial.mjs';

const llm = node(2, { name: '回答生成', payload: { inputs: [{ name: 'text', referenceNodeId: 'x' }, { name: '质检规则', operationAttrId: 'op-1' }] } });

test('classifyTrialNode：计算类能跑；插件类要 --allow-plugin；动作、触发、未知一律不跑', () => {
  assert.equal(classifyTrialNode(llm).kind, 'allowed');
  assert.equal(classifyTrialNode(node(3, { type: 'rule-center' })).kind, 'allowed');
  assert.deepEqual(classifyTrialNode(node(7, { name: '兴趣岛用户详情', type: 'plugin-calculation' })), { kind: 'plugin', type: 'plugin-calculation', plugins: ['兴趣岛用户详情'] });
  const withTool = node(8, { payload: { tools: [{ toolType: 'query_kb' }, { toolType: 'plugin', name: '写多维表' }] } });
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

test('costSummary：跑完的按实际（没有花费字段算 ¥0）；超时没跑完的花费未知，不当 ¥0 摊进每次花费', () => {
  assert.deepEqual(costSummary([{ cost: 0.01, timedOut: false }, { cost: null, timedOut: false }]), { actual: 0.01, perRun: 0.005, unknownRuns: 0 });
  assert.deepEqual(costSummary([{ cost: null, timedOut: true }]), { actual: 0, perRun: null, unknownRuns: 1 });
  assert.deepEqual(costSummary([{ cost: 0.02, timedOut: false }, { cost: null, timedOut: true }]), { actual: 0.02, perRun: 0.02, unknownRuns: 1 });
  assert.deepEqual(costSummary([]), { actual: 0, perRun: null, unknownRuns: 0 });
});
