import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startTestCenterServer } from './helpers/testcenter-server.mjs';
import { CROSS_EXEC, LOST_EXEC, SAME_EXEC, SOURCE_BOT, TARGET_BOT, execSearchLines, importable, pluginCanvas } from './helpers/testcenter-fixtures.mjs';

let fake;
before(async () => { fake = await startTestCenterServer(); });
after(() => fake.server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home(), env = {}) => runCli(args, { home: h, env });
const reset = (patch = {}) => Object.assign(fake.state, { sets: [], cases: [], tasks: [], items: new Map(), posts: {}, log: [], canvas: null, itemCost: 0.02, perPoll: Infinity, tree: [], ...patch });

// 直接往假秒懂里放一个测试集和若干导入好的用例（前缀 4 / a，和假秒懂自己生成的 id 不撞）
function seedSet(name, execIds = [SAME_EXEC]) {
  const testSetId = `4${String(fake.state.sets.length + 1).padStart(7, '0')}-0000-4000-8000-000000000000`;
  fake.state.sets.push({ testSetId, name, botId: TARGET_BOT, testNodes: [], createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' });
  for (const execId of execIds) {
    fake.state.cases.push({ ...structuredClone(importable[execId]), testCaseId: `a${String(fake.state.cases.length + 1).padStart(7, '0')}-0000-4000-8000-000000000000`, testSetId });
  }
  return testSetId;
}

test('md test sets：列测试集、说明有没有场景树；老一代说清楚', async () => {
  reset();
  seedSet('回归-退款');
  const r = await md(['test', 'sets', '--bot', '179cd443']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /测试专用版/);
  assert.match(r.stdout, /场景树：0 个节点/);
  assert.match(r.stdout, /回归-退款 \(40000001\) · 1 条/);
  reset({ tree: null });
  assert.match((await md(['test', 'sets', '--bot', '179cd443'])).stdout, /场景树：这个区没有（老一代测试中心）/);
});

test('md test cases：汇总、事件名、完整用例存本机；--out 导出 JSONL；id 前缀也能找；名字找不到退出码 4', async () => {
  reset();
  const id = seedSet('回归-退款', [SAME_EXEC, CROSS_EXEC]);
  const h = home();
  const outFile = join(h, 'cases.jsonl');
  const r = await md(['test', 'cases', '回归-退款', '--bot', '179cd443', '--out', outFile], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 条 · canvas-event-trigger 2 · 未审核 2 · 挂了场景 0/);
  assert.match(r.stdout, /事件「延时回复」 · 我想退款/);
  assert.match(r.stdout, /事件「sev-dela（这个智能体里没有）」/);
  assert.equal(readFileSync(outFile, 'utf-8').trim().split('\n').length, 2);
  assert.equal((await md(['test', 'cases', id.slice(0, 8), '--bot', '179cd443'])).code, 0);
  const miss = await md(['test', 'cases', '没有这个集', '--bot', '179cd443']);
  assert.equal(miss.code, 4);
  assert.match(miss.stderr, /没有测试集「没有这个集」/);
});

test('md test tree：场景树逐层列出；空树、老一代各自说明', async () => {
  reset({ tree: [{ id: 'sc-1', name: '退款', ownCaseCount: 2, totalCaseCount: 3, children: [{ id: 'sc-2', name: '课程退款', ownCaseCount: 1, totalCaseCount: 1, children: [] }] }] });
  const r = await md(['test', 'tree', '--bot', '179cd443']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, / {2}退款 · 本节点 2 · 含子节点 3\n {4}课程退款 · 本节点 1/);
  reset({ tree: [] });
  assert.match((await md(['test', 'tree', '--bot', '179cd443'])).stdout, /场景树是空的/);
  reset({ tree: null });
  assert.match((await md(['test', 'tree', '--bot', '179cd443'])).stdout, /这个区没有场景树/);
});

test('md test 不认识的子命令：用法错误，列出可用的', async () => {
  const r = await md(['test', 'nope', '--bot', '179cd443']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /不认识「md test nope」/);
});
