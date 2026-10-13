import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheck } from '../src/check.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { U, edge, sampleCanvas, sampleEvents, sampleSessions } from './helpers/fixtures.mjs';

const env = (canvas) => ({ canvas, sessions: sampleSessions, events: sampleEvents });
const patchNode = (canvas, id, fn) => canvas.map((c) => (c.id === id ? fn(structuredClone(c)) : c));

test('只改 prompt 文本：没有新问题', () => {
  const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.nodePayload.systemPrompt += '\n发热≠发烧。'; return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('节点名称最多 20 个字：中文、英文、数字、符号和 Unicode 字符都按字符计数', () => {
  for (const name of ['名'.repeat(20), 'a'.repeat(20), '名Ab1!'.repeat(4), '𠮷'.repeat(20)]) {
    const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.name = name; return c; });
    assert.deepEqual(runCheck(env(sampleCanvas()), env(after)).errors, [], name);
  }
  for (const name of ['名'.repeat(21), 'a'.repeat(21), '𠮷'.repeat(21)]) {
    const after = patchNode(sampleCanvas(), U(2), (c) => { c.data.name = name; return c; });
    assert.ok(runCheck(env(sampleCanvas()), env(after)).errors.some((e) => /00000002.*21.*20/.test(e)), name);
  }
});

test('20 字是最终画布的硬限制，原本就超长的节点也要报出来', () => {
  const base = patchNode(sampleCanvas(), U(2), (c) => { c.data.name = '名'.repeat(21); return c; });
  assert.ok(runCheck(env(base), env(base)).errors.some((e) => /21.*20/.test(e)));
  const after = patchNode(base, U(2), (c) => { c.data.name = '名'.repeat(20); return c; });
  assert.deepEqual(runCheck(env(base), env(after)).errors, []);
});

test('名称限制只检查业务节点，连线和便签上的文字不受 20 字限制', () => {
  const after = sampleCanvas();
  after.find((c) => c.id === U(900)).data.name = '便签'.repeat(30);
  after.find((c) => c.id === U(101)).data = { name: '连线'.repeat(30) };
  assert.deepEqual(runCheck(env(sampleCanvas()), env(after)).errors, []);
});

test('md check：还没 apply 时也能指出原画布的超长节点，不能因为无改动就漏报', async () => {
  const home = tempHome();
  const canvas = patchNode(sampleCanvas(), U(2), (c) => { c.data.name = '名'.repeat(21); return c; });
  await seedWorkspace(home, { canvas, sessions: sampleSessions, events: sampleEvents });
  const r = await runCli(['check'], { home });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /00000002.*21.*20/);
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
  // 老懂校验器的提示里带着老懂 Agent 的工具名，md 里没有这个工具
  assert.ok(!r.warnings.some((w) => /wire_input/.test(w)), r.warnings.join('\n'));
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

test('结构校验逐个节点报：两个节点都改坏了两个都报，不是只报第一个', () => {
  const after = patchNode(patchNode(sampleCanvas(), U(2), (c) => { delete c.view; return c; }), U(6), (c) => { delete c.size; return c; });
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.ok(r.errors.some((e) => /节点 00000002-.* 缺少 view/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /节点 00000006-.* 缺少 view/.test(e)), r.errors.join('\n'));
});

test('改动范围里原本就有的问题不会盖住这次新引入的：触发器原本缺 nodePayload，同时把另一个节点改坏了，照样报错', () => {
  const base = patchNode(sampleCanvas(), U(1), (c) => { delete c.data.nodePayload; return c; });
  const after = patchNode(patchNode(base, U(1), (c) => { c.data.name = '收到文本（改名）'; return c; }), U(6), (c) => { delete c.size; return c; });
  const r = runCheck(env(base), env(after));
  assert.ok(r.errors.some((e) => /节点 00000006-/.test(e)), r.errors.join('\n'));
  assert.ok(!r.errors.some((e) => /节点 00000001-/.test(e)), r.errors.join('\n'));
  assert.ok(r.notes.some((n) => /原本就有.*00000001-/.test(n)), r.notes.join('\n'));
});

test('悬空连线每条只报一次：连线由本工具自己查（逐条），结构校验只查节点，不再按节点各报一遍（整支审查 6）', () => {
  const after = sampleCanvas().filter((c) => c.id !== U(3) && c.id !== U(4)).map((c) => (c.id === U(2) ? patchNode([c], U(2), (x) => { x.data.nodePayload.systemPrompt = 'x'; return x; })[0] : c));
  const r = runCheck(env(sampleCanvas()), env(after));
  assert.equal(r.errors.filter((e) => /00000003-/.test(e)).length, 1, r.errors.join('\n'));
  assert.equal(r.errors.filter((e) => /00000004-/.test(e)).length, 1, r.errors.join('\n'));
  assert.equal(r.errors.length, 2, r.errors.join('\n'));
});

test('连线端口查得和结构校验一样严：端口没写、节点没有端口列表都算端口不存在', () => {
  const noPort = [...sampleCanvas(), { ...edge(105, 6, 3), target: { cell: U(3) } }];
  assert.ok(runCheck(env(sampleCanvas()), env(noPort)).errors.some((e) => /的端口不存在/.test(e)));
  const bare = [...patchNode(sampleCanvas(), U(900), (c) => c), edge(106, 1, 900)];
  assert.ok(runCheck(env(sampleCanvas()), env(bare)).errors.some((e) => /的端口不存在/.test(e)));
});

