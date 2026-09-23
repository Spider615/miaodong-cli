import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheck } from '../src/check.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { U, sampleCanvas, sampleEvents, sampleSessions } from './helpers/fixtures.mjs';

const env = (canvas) => ({ canvas, sessions: sampleSessions, events: sampleEvents });
const patchNode = (canvas, id, fn) => canvas.map((c) => (c.id === id ? fn(structuredClone(c)) : c));

test('只改 prompt 文本：没有新问题', () => {
  const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.systemPrompt += '\n发热≠发烧。'; return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('数组被改成对象：报错', () => {
  const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.inputs = { 0: c.data.nodePayload.inputs[0] }; return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.errors.some((e) => /类型从 array 变成了 object/.test(e)), r.errors.join('\n'));
});

test('删掉被引用的节点：新增悬空引用报错', () => {
  const after = sampleCanvas().filter((c) => c.id !== U(1) && c.id !== U(101));
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.errors.some((e) => /引用了不存在的节点 00000001/.test(e)), r.errors.join('\n'));
});

test('清空模型：新增风险 H1 进 warnings', () => {
  const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.modelType = ''; return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.warnings.some((w) => /\[H1\].*未配置 modelType/.test(w)), r.warnings.join('\n'));
});

test('触发器原本就缺 nodePayload：只改它的名字不算这次引入的问题', () => {
  const base = patchNode(sampleCanvas(), U(1), (c) => { delete c.data.nodePayload; return c; });
  const after = patchNode(base, U(1), (c) => { c.data.name = '收到文本（改名）'; return c; });
  const r = runCheck(env(base), env(after));
  assert.deepEqual(r.errors, []);
  assert.ok(r.notes.some((n) => /原本就有/.test(n)));
});

test('md check：有问题时退出码 1', async () => {
  const home = tempHome();
  await seedWorkspace(home, { canvas: sampleCanvas(), sessions: sampleSessions, events: sampleEvents });
  const script = join(home, 'bad.mjs');
  writeFileSync(script, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.inputs', { 0: 'x' }); };\n");
  await runCli(['apply', script], { home });
  const r = await runCli(['check'], { home });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /❌ .*类型从 array 变成了 object/);
});

test('新出现的自引用：报错', () => {
  const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.inputs[0].referenceNodeId = U(2); return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.errors.some((e) => /引用了自己/.test(e)), r.errors.join('\n'));
});

test('连线指向不存在的端口：报错', () => {
  const after = patchNode(sampleCanvas(), U(3), (c) => { c.ports.items = c.ports.items.filter((p) => p.id !== 'p3-in'); return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.errors.some((e) => /的端口不存在/.test(e)), r.errors.join('\n'));
});

test('null 改成对象只是警告，不拦推送', () => {
  const base = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.extra = null; return c; });
  const after = patchNode(base, U(2), (c) => { c.data.nodePayload.extra = { x: 1 }; return c; });
  const r = runCheck(env(base), env(after));
  assert.ok(!r.errors.some((e) => /类型从/.test(e)), r.errors.join('\n'));
  assert.ok(r.warnings.some((w) => /类型从 null 变成了 object/.test(w)), r.warnings.join('\n'));
});
