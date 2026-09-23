import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCanvas } from '../src/merge.mjs';
import { U, edge, node, sampleCanvas } from './helpers/fixtures.mjs';

const patch = (canvas, id, fn) => canvas.map((c) => (c.id === id ? fn(structuredClone(c)) : c));
const prompt = (text) => (c) => { c.data.nodePayload.systemPrompt = text; return c; };
const find = (canvas, id) => canvas.find((c) => c.id === id);

test('都没改：noop', () => {
  const m = mergeCanvas(sampleCanvas(), sampleCanvas(), sampleCanvas());
  assert.equal(m.noop, true);
  assert.deepEqual(m.conflicts, []);
});

test('我改 2、别人改 6：两边都保留', () => {
  const ours = patch(sampleCanvas(), U(2), prompt('我的'));
  const theirs = patch(sampleCanvas(), U(6), prompt('别人的'));
  const m = mergeCanvas(sampleCanvas(), ours, theirs);
  assert.deepEqual(m.conflicts, []);
  assert.equal(find(m.canvas, U(2)).data.nodePayload.systemPrompt, '我的');
  assert.equal(find(m.canvas, U(6)).data.nodePayload.systemPrompt, '别人的');
  assert.deepEqual(m.ours.changed, [U(2)]);
  assert.equal(m.theirs.changed, 1);
  assert.equal(m.noop, false);
});

test('双方改同一节点：内容不同 → 冲突；内容相同 → 不冲突', () => {
  const m1 = mergeCanvas(sampleCanvas(), patch(sampleCanvas(), U(2), prompt('A')), patch(sampleCanvas(), U(2), prompt('B')));
  assert.equal(m1.conflicts.length, 1);
  assert.match(m1.conflicts[0].reason, /你和别人都改了这个节点/);
  const m2 = mergeCanvas(sampleCanvas(), patch(sampleCanvas(), U(2), prompt('A')), patch(sampleCanvas(), U(2), prompt('A')));
  assert.deepEqual(m2.conflicts, []);
});

test('别人挪了位置、我改了内容：用我的内容 + 别人的位置', () => {
  const ours = patch(sampleCanvas(), U(2), prompt('我的'));
  const theirs = patch(sampleCanvas(), U(2), (c) => { c.position = { x: 999, y: 999 }; return c; });
  const m = mergeCanvas(sampleCanvas(), ours, theirs);
  assert.deepEqual(m.conflicts, []);
  assert.equal(find(m.canvas, U(2)).data.nodePayload.systemPrompt, '我的');
  assert.deepEqual(find(m.canvas, U(2)).position, { x: 999, y: 999 });
});

test('我删节点但别人改了它 → 冲突；别人删了我改的节点 → 冲突', () => {
  const ours = sampleCanvas().filter((c) => c.id !== U(6) && c.id !== U(104));
  const m1 = mergeCanvas(sampleCanvas(), ours, patch(sampleCanvas(), U(6), prompt('别人的')));
  assert.ok(m1.conflicts.some((c) => /你删了这个节点/.test(c.reason)));
  const theirs = sampleCanvas().filter((c) => c.id !== U(2));
  const m2 = mergeCanvas(sampleCanvas(), patch(sampleCanvas(), U(2), prompt('我的')), theirs);
  assert.ok(m2.conflicts.some((c) => /被别人删了/.test(c.reason)));
});

test('我新增节点和连线，别人没动：并进去；合并后端点消失 → 冲突', () => {
  const ours = sampleCanvas().concat([node(7, { name: '新节点' }), edge(105, 3, 7)]);
  const m = mergeCanvas(sampleCanvas(), ours, sampleCanvas());
  assert.deepEqual(m.conflicts, []);
  assert.ok(find(m.canvas, U(7)));
  assert.ok(m.canvas.some((c) => c.source?.cell === U(3) && c.target?.cell === U(7)));
  const theirs = sampleCanvas().filter((c) => c.id !== U(3) && c.id !== U(102));
  const m2 = mergeCanvas(sampleCanvas(), ours, theirs);
  assert.ok(m2.conflicts.some((c) => /端点节点不存在/.test(c.reason)));
});

test('只有别人改了：merged 与 theirs 一致 → noop', () => {
  const theirs = patch(sampleCanvas(), U(6), prompt('别人的'));
  assert.equal(mergeCanvas(sampleCanvas(), sampleCanvas(), theirs).noop, true);
});
