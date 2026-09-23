import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, refsTo, resolveNode, traceLines } from '../src/graph.mjs';
import { compareNodes } from '../src/canvas.mjs';
import { U, sampleCanvas, sampleEvents } from './helpers/fixtures.mjs';

test('buildIndex：连线、事件跳转、引用路径、出入度', () => {
  const index = buildIndex(sampleCanvas(), sampleEvents);
  assert.equal(index.nodes.length, 6);
  const ev = index.edges.find((e) => e.kind === 'event');
  assert.deepEqual([ev.from, ev.to, ev.eventName], [U(4), U(5), '延时回复']);
  assert.deepEqual(index.refs.find((r) => r.from === U(2)), { from: U(2), to: U(1), path: 'data.nodePayload.inputs[0]', dataPath: 'text' });
  const n2 = index.nodes.find((n) => n.id === U(2));
  assert.equal(n2.model, 'doubao');
  assert.equal(n2.in, 1);
  assert.equal(n2.out, 2);
});

test('resolveNode：id / 前缀 / 唯一名字；同名报歧义', () => {
  const canvas = sampleCanvas();
  assert.equal(resolveNode(canvas, U(3)).id, U(3));
  assert.equal(resolveNode(canvas, '00000003').id, U(3));
  assert.equal(resolveNode(canvas, '发送文本').id, U(3));
  assert.throws(() => resolveNode(canvas, '回答生成'), (e) => e.code === 'node_ambiguous' && e.exitCode === 4);
  assert.throws(() => resolveNode(canvas, 'ffff'), (e) => e.code === 'node_not_found');
});

test('traceLines：往下会跨事件跳转，往上能回到触发器', () => {
  const index = buildIndex(sampleCanvas(), sampleEvents);
  const down = traceLines(index, U(1)).join('\n');
  assert.match(down, /▶ 收到文本/);
  assert.match(down, /↳ 回答生成 \(llm-completion\) \[00000002\]/);
  assert.match(down, /⇢ 事件「延时回复」→ 延时回复入口/);
  assert.match(down, /\[00000006\]/);
  const up = traceLines(index, U(3), { direction: 'up' }).join('\n');
  assert.match(up, /▶ 发送文本[\s\S]*↳ 回答生成[\s\S]*↳ 收到文本/);
});

test('refsTo：谁引用了回答生成', () => {
  assert.deepEqual(refsTo(buildIndex(sampleCanvas(), sampleEvents), U(2)).map((r) => r.from), [U(3)]);
});

test('compareNodes：挪位置不算改动，改内容算', () => {
  const a = sampleCanvas();
  const moved = a.map((c) => (c.id === U(6) ? { ...c, position: { x: 1, y: 1 } } : c));
  assert.equal(compareNodes(a, moved).same, true);
  const changed = a.map((c) => (c.id === U(6) ? { ...c, data: { ...c.data, name: '新名字' } } : c));
  assert.deepEqual(compareNodes(a, changed), { onlyA: 0, onlyB: 0, changed: 1, edgesDiffer: 0, same: false });
});
