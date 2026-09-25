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

test('import：同一个智能体的执行 id → 新建测试集、导入、给下一步；已有同名集要 --into', async () => {
  reset();
  const h = home();
  const r = await md(['test', 'import', '回归-退款', '--bot', '179cd443', '--from-execs', SAME_EXEC], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /新建测试集「回归-退款」/);
  assert.match(r.stdout, /导入：成功 1 · 失败 0/);
  assert.match(r.stdout, /下一步：md test run 回归-退款 --bot 179cd443/);
  assert.equal(fake.state.posts.import[0].includeSessionMemory, true);
  const again = await md(['test', 'import', '回归-退款', '--bot', '179cd443', '--from-execs', SAME_EXEC], h);
  assert.equal(again.code, 5);
  assert.match(again.stderr, /已经有测试集「回归-退款」/);
  const into = await md(['test', 'import', '回归-退款', '--bot', '179cd443', '--from-execs', SAME_EXEC, '--into'], h);
  assert.equal(into.code, 0, into.stderr);
  assert.equal(fake.state.cases.length, 2);
});

test('import：只给了 id、其实是别的智能体的执行 → 撤回这次导进来的，集里原有的（哪怕同名）不动；新建的集也删掉（审查重点 1、2）', async () => {
  reset();
  const set = seedSet('已有的集', [SAME_EXEC]);
  const before = fake.state.cases.map((c) => c.testCaseId);
  const r = await md(['test', 'import', '已有的集', '--bot', '179cd443', '--from-execs', `${SAME_EXEC},${CROSS_EXEC}`, '--into']);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /1 条用例的事件或会话变量在「【测试测试测试】太极2\.0 测试专用版」里对不上/);
  assert.match(r.stderr, /--from-bot/);
  assert.deepEqual(fake.state.cases.map((c) => c.testCaseId), before);
  assert.ok(fake.state.sets.some((s) => s.testSetId === set));
  reset();
  const fresh = await md(['test', 'import', '新集', '--bot', '179cd443', '--from-execs', CROSS_EXEC]);
  assert.equal(fresh.code, 5);
  assert.equal(fake.state.sets.length, 0);
  assert.equal(fake.state.cases.length, 0);
});

test('import：从 md exec 保存的文件导入（来源是另一个智能体）→ 按名字换 id、全量回写不清掉名字、回读不剩源 id；换不了的列出来；记下线上回复', async () => {
  reset();
  const h = home();
  const file = join(h, 'search.jsonl');
  writeFileSync(file, execSearchLines({ ids: [CROSS_EXEC, LOST_EXEC] }));
  const r = await md(['test', 'import', '跨智能体回归', '--bot', '179cd443', '--from-execs', file], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /来自「太极2\.0 质检革新版」（跨智能体/);
  assert.match(r.stdout, /换 id：更新了 2 条/);
  assert.match(r.stdout, /事件「只在源里有」在目标里没有/);
  assert.match(r.stdout, /1 条用例对不上这个智能体，md test run 的跑前检查会拦下它们/);
  const cross = fake.state.cases.find((c) => c.name.includes(CROSS_EXEC));
  assert.equal(cross.name, `调优中心导入(${CROSS_EXEC})`);
  assert.equal(cross.triggerInputs.eventId, 'tev-delay');
  assert.deepEqual(Object.keys(cross.sessionMemoryCustomData).sort(), ['tv-flag', 'tv-hist']);
  assert.equal(cross.canvasActionOutputAssertions[1].actionContent.payload.eventId, 'tev-send');
  const sourcesFile = r.stdout.match(/结果报告里对照用：(\S+)/)[1];
  assert.match(JSON.parse(readFileSync(sourcesFile, 'utf-8'))[CROSS_EXEC].reply, /线上回复 1/);
});

test('import：给了 --from-bot 的跨智能体 id 列表，也按名字换 id', async () => {
  reset();
  const r = await md(['test', 'import', '跨智能体', '--bot', '179cd443', '--from-execs', CROSS_EXEC, '--from-bot', '147bd600']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.cases[0].triggerInputs.eventId, 'tev-delay');
});

test('import：--from-bot 和文件里的来源对不上、执行 id 不完整：用法错误', async () => {
  reset();
  const h = home();
  const file = join(h, 'search.jsonl');
  writeFileSync(file, execSearchLines({ ids: [CROSS_EXEC] }));
  const conflict = await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', file, '--from-bot', '179cd443'], h);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /--from-bot 是「【测试测试测试】太极2\.0 测试专用版」，但文件里的执行来自「太极2\.0 质检革新版」/);
  const short = await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', 'e0000011']);
  assert.equal(short.code, 2);
  assert.match(short.stderr, /不是完整的执行 id：e0000011/);
});

function spendRows(h) {
  const file = join(h, 'md', 'spend.jsonl');
  if (!existsSync(file)) return [];
  const byId = new Map();
  for (const line of readFileSync(file, 'utf-8').trim().split('\n')) {
    const row = JSON.parse(line);
    byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row });
  }
  return [...byId.values()];
}
// 这个集上次跑完的任务：平均每条 avg 元（md test run 按它估花费）
const seedFinished = (testSetId, avg) => fake.state.tasks.push({ testTaskId: '70000099-0000-4000-8000-000000000000', botId: TARGET_BOT, testSetId, name: '上次', status: 'finished', averageCostInCny: avg, createdAt: '2026-09-24T00:00:00.000Z' });
const codeIn = (stdout) => stdout.match(/确认码：([0-9a-f]{8})/)?.[1];

test('run：跑前检查不过（跨智能体没换 id 的用例）→ 不建任务、不记账，退出码 5（审查重点 1）', async () => {
  reset();
  seedSet('集', [SAME_EXEC, CROSS_EXEC]);
  const h = home();
  const r = await md(['test', 'run', '集', '--bot', '179cd443'], h);
  assert.equal(r.code, 5);
  assert.match(r.stdout, /❌ 跑前检查：2 处对不上/);
  assert.match(r.stderr, /跑前检查有 2 处对不上，没有建任务/);
  assert.equal(fake.state.posts.taskCreate, undefined);
  assert.deepEqual(spendRows(h), []);
});

test('run：估不出花费一律要确认；带码才建任务（testRound、草稿的 canvasId、默认任务名）；账本记预留和码；本机记下任务', async () => {
  reset();
  seedSet('集', [SAME_EXEC]);
  const h = home();
  const first = await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '2'], h);
  assert.equal(first.code, 5);
  assert.match(first.stdout, /1 条 × 2 轮 = 2 次/);
  assert.match(first.stdout, /预计 估不出（参考：单条 ¥0–0\.3）/);
  assert.match(first.stderr, /估不出花费/);
  assert.equal(fake.state.posts.taskCreate, undefined);
  const code = codeIn(first.stdout);
  const r = await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '2', '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  const body = fake.state.posts.taskCreate[0];
  assert.deepEqual([body.testRound, body.canvasId, body.concurrency], [2, 'main-179c', 5]);
  assert.match(body.name, /^集-草稿-\d{4}-\d{4}$/);
  const [row] = spendRows(h);
  assert.deepEqual([row.kind, row.approved, row.code, row.reserve, row.count], ['test', 'confirm', code, 0.6, 2]);
  const taskId = fake.state.tasks[0].testTaskId;
  assert.match(r.stdout, new RegExp(`已建任务 .*（${taskId}）`));
  const rec = JSON.parse(readFileSync(join(h, 'md', 'tests', 'k1', '179cd443', 'tasks', `${taskId}.json`), 'utf-8'));
  assert.equal(rec.spendId, row.id);
});

test('run：这个集上次跑完的任务有平均花费 → 按它估；不超门槛、不调插件就直接建任务；有别的任务在跑会说排队', async () => {
  reset();
  const set = seedSet('集', [SAME_EXEC]);
  seedFinished(set, 0.02);
  fake.state.tasks.push({ testTaskId: '70000098-0000-4000-8000-000000000000', botId: TARGET_BOT, testSetId: set, name: '别人的任务', status: 'processing', createdAt: '2026-09-24T01:00:00.000Z' });
  const r = await md(['test', 'run', '集', '--bot', '179cd443']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /预计 ¥0\.020（上次跑完的任务「上次」平均每条 ¥0\.020）/);
  assert.match(r.stdout, /排队：这个智能体上还有 1 个任务没跑完/);
  assert.equal(fake.state.posts.taskCreate.length, 1);
});

test('run：画布上有插件就要确认，哪怕很便宜；--version 跑那个版本的 canvasId', async () => {
  reset({ canvas: pluginCanvas() });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  const first = await md(['test', 'run', '集', '--bot', '179cd443', '--version', 'v1.0.215'], h);
  assert.equal(first.code, 5);
  assert.match(first.stdout, /v1\.0\.215/);
  assert.match(first.stdout, /会真实调用的外部系统：查用户详情/);
  assert.match(first.stderr, /会真的调用外部系统：查用户详情/);
  const r = await md(['test', 'run', '集', '--bot', '179cd443', '--version', 'v1.0.215', '--confirm', codeIn(first.stdout)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.posts.taskCreate[0].canvasId, 'ver-215');
});

test('run：建任务明确被拒（4xx）→ 这一笔记 0；结果不明（5xx）→ 保留预留，提示别重跑（审查重点 3）', async () => {
  reset();
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const original = fake.server.routes['POST /api/test-center/test-task/create'];
  try {
    fake.server.routes['POST /api/test-center/test-task/create'] = () => ({ status: 400, body: { statusCode: 400, message: 'bad request' } });
    const h = home();
    assert.equal((await md(['test', 'run', '集', '--bot', '179cd443'], h)).code, 1);
    assert.deepEqual([spendRows(h)[0].actual, spendRows(h)[0].runs], [0, 0]);
    fake.server.routes['POST /api/test-center/test-task/create'] = () => ({ status: 502, body: { message: 'Bad Gateway' } });
    const h2 = home();
    const unknown = await md(['test', 'run', '集', '--bot', '179cd443'], h2);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /任务可能已经建了.*不要重跑/);
    assert.deepEqual([spendRows(h2)[0].actual, spendRows(h2)[0].reserve], [null, 0.02]);
  } finally {
    fake.server.routes['POST /api/test-center/test-task/create'] = original;
  }
});
