import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHelpers, getPath, parsePath, runTransform, setPath } from '../src/transform.mjs';
import { tempHome } from './helpers/run-cli.mjs';
import { U, sampleCanvas } from './helpers/fixtures.mjs';

function helpersFor(canvas) {
  const ctx = { canvas, sessions: [], events: [] };
  const log = [];
  return { h: createHelpers(ctx, log), ctx, log };
}

test('路径：两种数组写法都认；数组不会被改成对象；不存在的路径报错', () => {
  const obj = { data: { nodePayload: { inputs: [{ referenceNodeId: 'a' }, { referenceNodeId: 'b' }] } } };
  assert.equal(getPath(obj, 'data.nodePayload.inputs[1].referenceNodeId'), 'b');
  assert.equal(getPath(obj, 'data.nodePayload.inputs.1.referenceNodeId'), 'b');
  setPath(obj, 'data.nodePayload.inputs.0.referenceNodeId', 'z');
  assert.ok(Array.isArray(obj.data.nodePayload.inputs));
  assert.equal(obj.data.nodePayload.inputs.length, 2);
  assert.equal(obj.data.nodePayload.inputs[0].referenceNodeId, 'z');
  assert.throws(() => setPath(obj, 'data.nodePayload.nope.x', 1), /路径不存在/);
  assert.throws(() => getPath(obj, 'data.nodePayload.inputs.x'), /要用下标/);
  assert.deepEqual(parsePath('a[0].b.2'), ['a', 0, 'b', '2']);
});

test('replaceOnce 必须恰好命中 1 次；insertAfter 基于它；replaceAll 带数量守卫', () => {
  const { h } = helpersFor(sampleCanvas());
  const n = h.node('00000002');
  h.insertAfter(n, 'data.nodePayload.systemPrompt', '你是客服。', '\n发热≠发烧。');
  assert.equal(n.data.nodePayload.systemPrompt, '你是客服。\n发热≠发烧。\n请礼貌回答。');
  assert.throws(() => h.replaceOnce(n, 'data.nodePayload.systemPrompt', '不存在的锚点', 'x'), /出现 0 次/);
  h.set(n, 'data.nodePayload.systemPrompt', 'A A');
  assert.throws(() => h.replaceOnce(n, 'data.nodePayload.systemPrompt', 'A', 'B'), /出现 2 次/);
  assert.equal(h.replaceAll(n, 'data.nodePayload.systemPrompt', 'A', 'B', { expect: 2 }), 2);
  assert.throws(() => h.replaceAll(n, 'data.nodePayload.systemPrompt', 'B', 'C', { expect: 3 }), /预期 3 次/);
});

test('select + expectCount：批量换模型', () => {
  const { h, log } = helpersFor(sampleCanvas());
  const llms = h.expectCount(h.select((node) => node.data.type === 'llm-completion'), 2, 'LLM 节点');
  for (const node of llms) h.set(node, 'data.nodePayload.modelType', 'gpt-5.6-luna');
  assert.equal(log.length, 2);
  assert.throws(() => h.expectCount(llms, 3), /有 2 个，预期 3 个/);
});

test('retargetRefs：改引用并校验命中数', () => {
  const { h, ctx } = helpersFor(sampleCanvas());
  assert.equal(h.retargetRefs({ from: U(2), to: U(6), toDataPath: 'output', expect: 1 }), 1);
  const send = ctx.canvas.find((c) => c.id === U(3));
  assert.equal(send.data.nodePayload.inputs[0].referenceNodeId, U(6));
  assert.throws(() => h.retargetRefs({ from: U(2), to: U(6), expect: 1 }), /命中 0 处，预期 1 处/);
});

test('cloneNode + portOf + addEdge；removeNode 连带删线', () => {
  const { h, ctx } = helpersFor(sampleCanvas());
  const copy = h.cloneNode('00000002', { name: '回答生成（副本）' });
  assert.notEqual(copy.id, U(2));
  assert.notEqual(copy.ports.items[0].id, 'p2-in');
  assert.equal(copy.data.name, '回答生成（副本）');
  const trigger = h.node('00000001');
  const edge = h.addEdge(trigger, h.portOf(trigger, 'right'), copy, h.portOf(copy, 'left'));
  assert.equal(edge.shape, 'custom-curve-edge');
  assert.deepEqual(edge.attrs, { line: { stroke: '#999' } });
  assert.throws(() => h.addEdge(copy, 'no-port', copy, h.portOf(copy, 'left')), /没有端口 no-port/);
  const count = ctx.canvas.length;
  h.removeNode('00000003');
  assert.equal(ctx.canvas.length, count - 2);
});

test('runTransform：在副本上跑、不改入参；改会话变量被拒；脚本抛错被包装', async () => {
  const dir = tempHome();
  const envelope = { canvas: sampleCanvas(), sessions: [], events: [] };
  const good = join(dir, 'good.mjs');
  writeFileSync(good, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.modelType', 'luna'); };\n");
  const { envelope: next, log } = await runTransform(good, envelope);
  assert.equal(next.canvas.find((c) => c.id === U(2)).data.nodePayload.modelType, 'luna');
  assert.equal(envelope.canvas.find((c) => c.id === U(2)).data.nodePayload.modelType, 'doubao');
  assert.equal(log.length, 1);
  const bad = join(dir, 'bad.mjs');
  writeFileSync(bad, "export default ({ sessions }) => { sessions.push({ id: 'x' }); };\n");
  await assert.rejects(runTransform(bad, envelope), (e) => e.code === 'unsupported');
  const boom = join(dir, 'boom.mjs');
  writeFileSync(boom, "export default () => { throw new Error('锚点没找到'); };\n");
  await assert.rejects(runTransform(boom, envelope), (e) => e.code === 'transform_failed' && /锚点没找到/.test(e.message));
});
