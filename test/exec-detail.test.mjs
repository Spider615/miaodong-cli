import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { U, edge, node } from './helpers/fixtures.mjs';
import { ASK, REPLY, X, delayDetail, draftCanvas, execSnapshot } from './helpers/exec-fixtures.mjs';
import { driftAgainst, findExecNode, locateText, nodeLine, normalizeDetail, orderExecuted, renderNodeDetail, verdictLine } from '../src/exec-detail.mjs';

test('orderExecuted：按快照连线拓扑排序；环里剩下的按原顺序补在后面', () => {
  assert.deepEqual(orderExecuted([U(3), U(5), U(4), U(2)], execSnapshot()), [U(5), U(2), U(3), U(4)]);
  const loop = [
    { id: 'a' }, { id: 'b' }, { id: 'c' },
    { id: 'e1', shape: 'custom-curve-edge', source: { cell: 'a' }, target: { cell: 'b' } },
    { id: 'e2', shape: 'custom-curve-edge', source: { cell: 'b' }, target: { cell: 'a' } },
  ];
  assert.deepEqual(orderExecuted(['a', 'b', 'c'], loop), ['c', 'a', 'b']);
});

test('normalizeDetail：名字、类型、分支名、模型、花费；快照里没有的节点照样列出', () => {
  const detail = delayDetail();
  detail.nodeResults.push({ nodeId: U(99), status: 'error', errorMessage: '循环子节点报错', inputs: {}, output: null });
  const norm = normalizeDetail(detail);
  assert.deepEqual(norm.nodes.map((n) => n.name), ['延时回复入口', '回答生成', '规则中心', '触发发送', '(快照里没有这个节点)']);
  assert.equal(norm.nodes[1].model, 'doubao-seed-2.0-lite');
  assert.equal(norm.nodes[1].cost, 0.0102);
  assert.equal(norm.nodes[2].branch, 'L3');
  assert.equal(norm.version, 'v1.0.402');
  assert.equal(norm.exec.triggerText, ASK);
  assert.equal(norm.exec.event.eventId, 'ev-delay');
  assert.match(nodeLine(norm.nodes[2]), /规则中心 \[rule-center\] → 分支「L3」/);
  assert.match(nodeLine(norm.nodes[4]), /❌ \(快照里没有这个节点\) \[\?\] ：循环子节点报错/);
});

test('findExecNode：按名字、#序号、id 前缀找；这次没跑到的节点说清楚', () => {
  const norm = normalizeDetail(delayDetail());
  assert.equal(findExecNode(norm, '回答生成').id, U(2));
  assert.equal(findExecNode(norm, '#3').name, '规则中心');
  assert.equal(findExecNode(norm, U(4).slice(0, 8)).name, '触发发送');
  assert.throws(() => findExecNode(norm, '收到文本'), (e) => e.code === 'node_not_found' && /这次执行没有跑到/.test(e.message));
  assert.throws(() => findExecNode(norm, '不存在'), (e) => e.code === 'node_not_found' && /画布里没有节点/.test(e.message));
});

test('renderNodeDetail：输入逐键、prompt 长度与文件、推理、工具调用、token；超长内容截断', () => {
  const detail = delayDetail();
  const llm = detail.nodeResults.find((r) => r.nodeId === U(2));
  llm.metadata.prompt[0].content = '长'.repeat(20000);
  llm.output = { message: '答'.repeat(20000) };
  const n = normalizeDetail(detail).nodes[1];
  const text = renderNodeDetail(n, { nodeFile: '/tmp/n.json', promptFile: '/tmp/p.txt' }).join('\n');
  assert.match(text, /text: 我想退款/);
  assert.match(text, /质检规则: 旧规则/);
  assert.match(text, /Prompt：system 20000 字 · user 4 字 → \/tmp\/p\.txt/);
  assert.match(text, /推理：用户要退款，先登记/);
  assert.match(text, /工具：query_kb「退款政策」 → 返回 2 条/);
  assert.match(text, /token：prompt 1500 · completion 20 · reasoning 5 · ¥0\.010/);
  assert.ok(text.length < 6000, `输出应当截断，实际 ${text.length} 字`);
});

test('locateText：写死在配置里 / 由节点生成 / 来自触发内容 / 没找到', () => {
  const norm = normalizeDetail(delayDetail());
  const generated = locateText(norm, REPLY);
  assert.equal(generated.verdict.kind, 'generated');
  assert.equal(generated.verdict.node.name, '回答生成');
  assert.match(verdictLine(generated.verdict), /最早由 #2「回答生成」/);
  assert.equal(locateText(norm, ASK).verdict.kind, 'trigger');
  assert.equal(locateText(norm, 'zzz').verdict.kind, 'none');
  assert.throws(() => locateText(norm, '  '), (e) => e.exitCode === 2);
});

test('locateText：配置里写着这段话、但真正输出它的是别的节点时，结论指向输出它的节点（审查 I-1）', () => {
  const detail = delayDetail();
  // 在「延时回复入口」和「回答生成」之间加一个意图识别节点：few-shot 里写着回复原文，输出只是意图
  detail.canvas.rawCanvas = [...detail.canvas.rawCanvas, node(10, { name: '意图识别', payload: { systemPrompt: `例：${REPLY} → 退款意图` } }), edge(110, 5, 10), edge(111, 10, 2)];
  detail.nodeResults.push({ nodeId: U(10), status: 'success', inputs: { inputData: { text: ASK } }, output: { intent: '退款' }, actions: [] });
  const v = locateText(normalizeDetail(detail), REPLY).verdict;
  assert.deepEqual([v.kind, v.node.name], ['generated', '回答生成']);
});

test('locateText：输出它的节点配置里就写着 → 写死在配置里；只在配置里出现、这次没输出 → 单独说明', () => {
  const detail = delayDetail();
  detail.nodeResults.find((r) => r.nodeId === U(2)).output = { message: `欢迎来到兴趣岛，${REPLY}` };
  const hard = locateText(normalizeDetail(detail), '欢迎来到兴趣岛').verdict;
  assert.deepEqual([hard.kind, hard.node.name], ['hardcoded', '回答生成']);
  const only = locateText(normalizeDetail(delayDetail()), '欢迎来到兴趣岛').verdict;
  assert.deepEqual([only.kind, only.node.name], ['config-only', '回答生成']);
  assert.match(verdictLine(only), /写在 #2「回答生成」.*的配置里，但这次执行没有输出它/);
});

test('driftAgainst：跑过的节点里哪些在草稿里改了、删了', () => {
  const { changed, removed } = driftAgainst(normalizeDetail(delayDetail()), draftCanvas());
  assert.deepEqual(changed.map((c) => c.node.name), ['回答生成']);
  assert.deepEqual(changed[0].paths, ['data.nodePayload.systemPrompt']);
  assert.deepEqual(removed.map((n) => n.name), ['规则中心']);
});

test('exec-store：详情只存一份画布；缓存按 id 能找回；未结束的执行不当缓存', async () => {
  process.env.MD_HOME = mkdtempSync(join(tmpdir(), 'md-store-'));
  const { execDir, findCachedExec, loadCachedDetail, saveDetail } = await import('../src/exec-store.mjs');
  const target = { identityKey: 'k1', regionLabel: '测试区', orgId: 'org-1', orgName: '兴趣岛平台', botId: '147bd600-0000-4000-8000-000000000000', botName: '质检革新版', identity: { token: 'SECRET' } };
  const dir = execDir(target, X(2));
  saveDetail(dir, target, delayDetail());
  const saved = JSON.parse(readFileSync(join(dir, 'detail.json'), 'utf-8'));
  assert.equal(saved.canvasExec.rawCanvas, undefined);
  assert.equal(saved.canvas.rawCanvas.length, execSnapshot().length);
  assert.doesNotMatch(readFileSync(join(dir, 'target.json'), 'utf-8'), /SECRET/);
  assert.equal(findCachedExec(X(2)).target.botName, '质检革新版');
  const running = delayDetail();
  running.canvasExec.status = 'running';
  saveDetail(dir, target, running);
  assert.equal(loadCachedDetail(dir), null);
});
