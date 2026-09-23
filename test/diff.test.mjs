import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffEnvelopes, fieldChanges, lineDiff, nameMapOf, renderDiff } from '../src/diff.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { U, node, sampleCanvas, sampleEvents } from './helpers/fixtures.mjs';

function editedCanvas() {
  return sampleCanvas()
    .map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '你是客服。\n发热≠发烧。\n请礼貌回答。' } } } : c))
    .map((c) => (c.id === U(6) ? { ...c, position: { x: 5, y: 5 } } : c))
    .filter((c) => c.id !== U(103))
    .concat([node(7, { name: '新节点' })]);
}

test('lineDiff：只显示改动行和前后各 1 行', () => {
  assert.deepEqual(lineDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne'), ['  …', '  b', '- c', '+ X', '  d', '  …']);
});

test('fieldChanges：数组被改成对象时标成 typechange', () => {
  assert.deepEqual(fieldChanges({ inputs: [1, 2] }, { inputs: { 0: 1 } }).map((f) => [f.path, f.kind]), [['inputs', 'typechange']]);
  assert.deepEqual(fieldChanges({ a: 1 }, { a: 1, b: 2 }).map((f) => [f.path, f.kind]), [['b', 'added']]);
});

test('diffEnvelopes：新增 / 改动 / 删连线；挪位置只计数', () => {
  const d = diffEnvelopes({ canvas: sampleCanvas() }, { canvas: editedCanvas() });
  assert.deepEqual(d.added.map((c) => c.id), [U(7)]);
  assert.deepEqual(d.changed.map((c) => c.id), [U(2)]);
  assert.equal(d.changed[0].fields[0].kind, 'text');
  assert.equal(d.layoutOnly, 1);
  assert.equal(d.edgesRemoved.length, 1);
  assert.equal(d.empty, false);
});

test('renderDiff：给人看的清单', () => {
  const base = sampleCanvas();
  const after = editedCanvas();
  const text = renderDiff(diffEnvelopes({ canvas: base }, { canvas: after }), { names: nameMapOf(base, after) }).join('\n');
  assert.match(text, /新增节点 1 · 删除节点 0 · 改动节点 1 · 新增连线 0 · 删除连线 1 · 仅挪位置 1/);
  assert.match(text, /~ 回答生成 \(llm-completion\) \[00000002\]/);
  assert.match(text, /data\.nodePayload\.systemPrompt（文本 12 → 19 字）/);
  assert.match(text, /\+ 发热≠发烧。/);
  assert.match(text, /- 连线 回答生成 \[00000002\] → 触发延时回复 \[00000004\]/);
});

test('md diff：在工作副本上输出清单；--json 可解析', async () => {
  const home = tempHome();
  await seedWorkspace(home, { canvas: sampleCanvas(), events: sampleEvents });
  const script = join(home, 'p.mjs');
  writeFileSync(script, "export default ({ h }) => { h.insertAfter(h.node('00000002'), 'data.nodePayload.systemPrompt', '你是客服。', '\\n发热≠发烧。'); };\n");
  await runCli(['apply', script], { home });
  const r = await runCli(['diff'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\+ 发热≠发烧。/);
  const j = await runCli(['diff', '--json'], { home });
  assert.equal(JSON.parse(j.stdout).changed[0].id, U(2));
});

test('fieldChanges：null / 标量与对象、数组互换是 reshape，只有数组与对象互换才是 typechange', () => {
  assert.deepEqual(fieldChanges({ a: null }, { a: { x: 1 } }).map((f) => [f.path, f.kind]), [['a', 'reshape']]);
  assert.deepEqual(fieldChanges({ a: [1] }, { a: 'x' }).map((f) => [f.path, f.kind]), [['a', 'reshape']]);
});
