import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startTestCenterServer } from './helpers/testcenter-server.mjs';
import { CROSS_EXEC, SAME_EXEC, TARGET_BOT, importable } from './helpers/testcenter-fixtures.mjs';
import {
  attachCases, createCases, createTask, createTestSet, deleteCases, deleteTestSet, importExecs, listCases, listTestSets,
  pauseTask, recentTasks, scenarioTree, taskDetail, taskItems, updateCase,
} from '../src/testcenter.mjs';

let fake;
before(async () => { fake = await startTestCenterServer(); });
after(() => fake.server.close());
const t = () => ({ identity: { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't' }, orgId: 'org-1', botId: TARGET_BOT });
const unknownExec = (i) => `f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;

test('建集、导入（每批 20 条，计数在 data 外面）、读回、全量更新只传可写字段', async () => {
  const id = await createTestSet(t(), '回归-退款');
  const sum = await importExecs(t(), id, [SAME_EXEC, CROSS_EXEC, ...Array.from({ length: 21 }, (_, i) => unknownExec(i))]);
  assert.deepEqual(sum, { imported: 2, failed: 21, skippedNodeTypes: [] });
  assert.equal(fake.state.posts.import.length, 2);
  assert.equal(fake.state.posts.import[0].canvasExecIds.length, 20);
  assert.equal(fake.state.posts.import[0].includeSessionMemory, true);
  const cases = await listCases(t(), id);
  assert.equal(cases.length, 2);
  await updateCase(t(), { ...cases[0], name: '改过的名字' });
  const body = fake.state.posts.update[0];
  assert.equal(body.testCaseId, cases[0].testCaseId);
  assert.equal(body.name, '改过的名字');
  for (const key of ['status', 'isReviewed', 'testSetId', 'dimension']) assert.equal(key in body, false, key);
  for (const key of ['triggerInputs', 'sessionMemoryCustomData', 'canvasActionOutputAssertions', 'isStrictVerify']) assert.ok(key in body, key);
});

test('列表翻到底：超过一页（100 条）也读全', async () => {
  for (let i = 0; i < 105; i++) await createTestSet(t(), `集${i}`);
  assert.ok((await listTestSets(t())).length >= 105);
});

test('建任务（testRound 必填）、查详情往前走、逐条结果、最近的任务新的在前、暂停', async () => {
  const set = await createTestSet(t(), '跑一下');
  await importExecs(t(), set, [SAME_EXEC]);
  const task = await createTask(t(), { testSetId: set, canvasId: 'main-179c', name: '跑一下-草稿', rounds: 2, concurrency: 5 });
  assert.deepEqual(fake.state.posts.taskCreate.at(-1), { testSetId: set, canvasId: 'main-179c', name: '跑一下-草稿', testRound: 2, concurrency: 5, botId: TARGET_BOT });
  assert.equal((await taskDetail(t(), task)).status, 'finished');
  assert.equal((await taskItems(t(), task)).length, 2);
  assert.equal((await recentTasks(t(), { testSetId: set }))[0].testTaskId, task);
  await pauseTask(t(), task);
  assert.deepEqual(fake.state.posts.pause.at(-1), { testTaskId: task });
});

test('场景树：老一代 404 返回 null；删用例再删集', async () => {
  fake.state.tree = null;
  assert.equal(await scenarioTree(t()), null);
  fake.state.tree = [{ id: 'sc-1', name: '退款', ownCaseCount: 0, totalCaseCount: 0, children: [] }];
  assert.equal((await scenarioTree(t())).tree[0].name, '退款');
  const set = await createTestSet(t(), '要删的');
  await importExecs(t(), set, [SAME_EXEC]);
  await deleteCases(t(), (await listCases(t(), set)).map((c) => c.testCaseId));
  await deleteTestSet(t(), set);
  assert.equal((await listCases(t(), set)).length, 0);
  assert.ok(!(await listTestSets(t())).some((s) => s.testSetId === set));
});

test('翻页以 page.total 为准：服务端把每页封顶在 100 条时也读全；翻到页数上限还没读完就报错，不悄悄截断（审查 I5）', async () => {
  const set = await createTestSet(t(), '大集');
  const add = (n) => { for (let i = 0; i < n; i++) fake.state.cases.push({ ...structuredClone(importable[SAME_EXEC]), testCaseId: `e${String(fake.state.cases.length).padStart(7, '0')}-0000-4000-8000-000000000000`, testSetId: set }); };
  try {
    add(150);
    fake.state.pageCap = 100;
    assert.equal((await listCases(t(), set)).length, 150);
    add(51);
    fake.state.pageCap = 1;
    await assert.rejects(listCases(t(), set), (e) => /翻了 200 页还没读完（已读 200 条，共 201 条）/.test(e.message));
  } finally {
    fake.state.pageCap = undefined;
  }
});

test('批量建用例每批 50 条（create 不回 id，按 name 回读）；挂场景每批 100 个，返回挂上的条数', async () => {
  const id = await createTestSet(t(), '外部-批量');
  const cases = Array.from({ length: 120 }, (_, i) => ({ name: `外部-${i + 1}`, triggerType: 'receive-text-message', triggerInputs: { text: `问题 ${i + 1}` }, sessionMemoryCustomData: {}, testNodeOutputAssertions: [], canvasActionOutputAssertions: [] }));
  const before = fake.state.posts.caseCreate?.length ?? 0;
  const progress = [];
  await createCases(t(), id, cases, { onBatch: (done) => progress.push(done) });
  assert.deepEqual(fake.state.posts.caseCreate.slice(before).map((p) => p.testCases.length), [50, 50, 20]);
  assert.deepEqual(progress, [50, 100, 120]);
  const back = await listCases(t(), id);
  assert.equal(back.length, 120);
  assert.deepEqual([back[0].isReviewed, back[0].dimension], [true, '']);
  const savedTree = fake.state.tree;
  fake.state.tree = [{ id: 'sn-refund', name: '退款', path: '退款', ownCaseCount: 0, totalCaseCount: 0, children: [] }];
  try {
    assert.equal(await attachCases(t(), 'sn-refund', back.map((c) => c.testCaseId)), 120);
    assert.deepEqual(fake.state.posts.attach.slice(-2).map((p) => [p.testCaseIds.length, p.botId, p.scenarioNodeId]), [[100, TARGET_BOT, 'sn-refund'], [20, TARGET_BOT, 'sn-refund']]);
    assert.equal(fake.state.tree[0].ownCaseCount, 120);
  } finally {
    fake.state.tree = savedTree;
  }
});
