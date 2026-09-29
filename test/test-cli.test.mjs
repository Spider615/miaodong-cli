import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startTestCenterServer } from './helpers/testcenter-server.mjs';
import { CROSS_EXEC, LOST_EXEC, SAME_EXEC, SOURCE_BOT, STALE_EXEC, TARGET_BOT, execSearchLines, importable, pluginCanvas } from './helpers/testcenter-fixtures.mjs';

let fake;
before(async () => { fake = await startTestCenterServer(); });
after(() => fake.server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home(), env = {}) => runCli(args, { home: h, env });
const reset = (patch = {}) => Object.assign(fake.state, { sets: [], cases: [], tasks: [], items: new Map(), posts: {}, log: [], canvas: null, itemCost: 0.02, perPoll: Infinity, tree: [], assertions: 1, judgeFee: 0, ...patch });

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

test('import：同一个智能体的执行、只有断言里的事件后来删了 → 不当成别的智能体撤回，导进来并提醒（跑前检查会拦）', async () => {
  reset();
  const r = await md(['test', 'import', '断言过期', '--bot', '179cd443', '--from-execs', STALE_EXEC]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.cases.length, 1);
  assert.match(r.stdout, /1 条用例对不上这个智能体，md test run 的跑前检查会拦下它们/);
  assert.match(r.stdout, /发事件断言里的事件 tev-gone 在这个智能体里不存在/);
});

test('edit：用例里本来就对不上的断言（事件后来删了）只提醒、不拦只改别的字段的脚本；脚本改出新的对不上才拦', async () => {
  reset();
  const h = home();
  seedSet('过期', [STALE_EXEC]);
  const rename = join(h, 'rename.mjs');
  writeFileSync(rename, 'export default ({ cases }) => { for (const c of cases) c.name = `${c.name}-改`; };');
  const ok = await md(['test', 'edit', '过期', rename, '--bot', '179cd443'], h);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /这是预演/);
  assert.match(ok.stdout, /⚠️ 改之前就对不上.*发事件断言里的事件 tev-gone 在这个智能体里不存在/);
  const broken = join(h, 'broken.mjs');
  writeFileSync(broken, "export default ({ cases }) => { for (const c of cases) c.triggerInputs.eventId = 'tev-nope'; };");
  const bad = await md(['test', 'edit', '过期', broken, '--bot', '179cd443'], h);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /事件 tev-nope 在这个智能体里不存在/);
  assert.equal(fake.state.posts.update, undefined);
});

test('edit：只修好一部分原本就有的问题（两个不存在的会话变量删掉一个），剩下那个不算新问题、不拦（整支审查 5）', async () => {
  reset();
  const h = home();
  seedSet('跨', [CROSS_EXEC]);
  const script = join(h, 'fix-one.mjs');
  writeFileSync(script, "export default ({ cases }) => { for (const c of cases) delete c.sessionMemoryCustomData['sv-flag']; };");
  const r = await md(['test', 'edit', '跨', script, '--bot', '179cd443'], h);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /这是预演/);
  assert.match(r.stdout, /⚠️ 改之前就对不上.*1 个会话变量在这个智能体里不存在（sv-hist）/);
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
  const sources = JSON.parse(readFileSync(sourcesFile, 'utf-8'));
  assert.match(sources.execs[CROSS_EXEC].reply, /线上回复 1/);
  assert.equal(sources.byCase[cross.testCaseId], CROSS_EXEC);
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
// 这个集上次跑完的任务：真正执行了 1 条，花了 avg 元（md test run 按「总花费 ÷ 真正执行的条数」估单价，审查 C1）
function seedFinished(testSetId, avg) {
  const testTaskId = '70000099-0000-4000-8000-000000000000';
  fake.state.tasks.push({ testTaskId, botId: TARGET_BOT, testSetId, name: '上次', status: 'finished', totalCostInCny: avg, averageCostInCny: avg, createdAt: '2026-09-24T00:00:00.000Z' });
  fake.state.items.set(testTaskId, [{ testTaskItemId: '90000099-0000-4000-8000-000000000000', testTaskId, testCaseId: 'x', testCaseName: '上次的用例', status: 'success', passed: true, costInCny: avg, canvasExecAvailable: true }]);
}
const codeIn = (stdout) => stdout.match(/确认码：([0-9a-f]{8})/)?.[1];

test('run：跑前检查不过（跨智能体没换 id 的用例）→ 不建任务、不记账，退出码 5（审查重点 1）', async () => {
  reset();
  seedSet('集', [SAME_EXEC, CROSS_EXEC]);
  const h = home();
  const r = await md(['test', 'run', '集', '--bot', '179cd443'], h);
  assert.equal(r.code, 5);
  assert.match(r.stdout, /❌ 跑前检查：4 处对不上（触发、会话变量对不上的用例会「成功」但什么都没执行；断言里引用的对不上，那条断言永远不过）/);
  assert.match(r.stdout, /发事件断言里的事件 sev-send 在这个智能体里不存在/);
  assert.match(r.stderr, /跑前检查有 4 处对不上，没有建任务/);
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
  assert.match(r.stdout, /预计 ¥0\.020（上次跑完的任务「上次」真正执行的 1 条平均 ¥0\.020）/);
  assert.match(r.stdout, /排队：这个智能体上还有 1 个任务没跑完/);
  assert.equal(fake.state.posts.taskCreate.length, 1);
});

test('run --case：只跑挑出来的几条（名字、用例 id 或 id 前缀）——跑前检查、预估、任务、进度都只算这几条；找不到、重名的报错', async () => {
  reset();
  const set = seedSet('集', [SAME_EXEC, CROSS_EXEC, STALE_EXEC]);
  seedFinished(set, 0.02);
  const same = fake.state.cases.find((c) => c.name.includes(SAME_EXEC));
  const h = home();
  const r = await md(['test', 'run', '集', '--bot', '179cd443', '--case', same.testCaseId.slice(0, 8)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /测试集「集」\(40000001\)：挑出来的 1 条（集里共 3 条） × 1 轮 = 1 次/);
  assert.deepEqual(fake.state.posts.taskCreate[0].selectedTestCaseIds, [same.testCaseId]);
  const task = fake.state.tasks.at(-1).testTaskId;
  const st = await md(['test', 'status', task.slice(0, 8), '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.match(st.stdout, / finished · 1\/1 · /);
  const byName = await md(['test', 'run', '集', '--bot', '179cd443', '--case', same.name], h);
  assert.equal(byName.code, 0, byName.stderr);
  const missing = await md(['test', 'run', '集', '--bot', '179cd443', '--case', '没有这条']);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /测试集「集」里没有用例「没有这条」[\s\S]*md test cases 40000001 --bot 179cd443/);
  reset();
  seedSet('重名', [SAME_EXEC, SAME_EXEC]);
  const dup = await md(['test', 'run', '重名', '--bot', '179cd443', '--case', `调优中心导入(${SAME_EXEC})`]);
  assert.equal(dup.code, 4);
  assert.match(dup.stderr, /有 2 条同名/);
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

const taskOf = (name) => fake.state.tasks.find((x) => x.name.startsWith(name)).testTaskId;

test('status：不给任务时列最近的任务；--wait 跑完后记一次实际花费，再查不重复记（审查重点 3）', async () => {
  reset({ perPoll: 1 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '2'], h)).code, 0);
  const list = await md(['test', 'status', '--bot', '179cd443'], h);
  assert.match(list.stdout, /集-草稿-\d{4}-\d{4} · processing/);
  const task = taskOf('集-草稿');
  const r = await md(['test', 'status', task.slice(0, 8), '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /finished · 2\/2 · 通过 2 · ¥0\.040/);
  assert.match(r.stdout, /看结果：md test results/);
  assert.equal(spendRows(h).find((x) => x.kind === 'test').actual, 0.04);
  await md(['test', 'status', task.slice(0, 8), '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  const settles = readFileSync(join(h, 'md', 'spend.jsonl'), 'utf-8').trim().split('\n').filter((line) => line.includes('"actual":0.04'));
  assert.equal(settles.length, 1);
});

test('status --wait 止损：按已跑完的平均花费推算整个任务超过额度就暂停（审查重点 3）', async () => {
  reset({ perPoll: 1, itemCost: 1 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.001);
  const h = home();
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '3'], h)).code, 0);
  const task = taskOf('集-草稿');
  const r = await md(['test', 'status', task, '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.equal(r.code, 0, r.stderr);
  // 每条 ¥1 + 1 条断言的判定费 ¥0.012（09-29 实测，逐条花费里没有这笔）
  assert.match(r.stdout, /⛔ 按已跑完的 1 条平均 ¥1\.01 推算（含断言判定），整个任务要 ¥3\.04，超过额度 ¥2\.00，已暂停任务/);
  assert.deepEqual(fake.state.posts.pause.at(-1), { testTaskId: task });
});

test('status --wait 到时限还没跑完：说还没跑完、怎么接着等', async () => {
  reset({ perPoll: 0 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const r = await md(['test', 'status', taskOf('集-草稿'), '--bot', '179cd443', '--wait', '--timeout', '1'], h, { MD_TEST_POLL_MS: '200' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /还没跑完（等了 1 秒）；接着等：md test status/);
});

test('stop：暂停正在跑的任务；已经跑完的说不用暂停；找不到的任务退出码 4', async () => {
  reset({ perPoll: 0 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const task = taskOf('集-草稿');
  const r = await md(['test', 'stop', task.slice(0, 8), '--bot', '179cd443'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已暂停任务 .*paused/);
  assert.match((await md(['test', 'stop', '70000099', '--bot', '179cd443'], h)).stdout, /已经是 finished，不用暂停/);
  assert.equal((await md(['test', 'stop', 'ffffffff', '--bot', '179cd443'], h)).code, 4);
});

test('stop：暂停后账本按已跑完的条目记实际，不再挂着预估（审查 C1：任务停下来就记实际）', async () => {
  reset({ perPoll: 1, itemCost: 0.02 });
  seedFinished(seedSet('集', [SAME_EXEC, SAME_EXEC, SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const task = taskOf('集-草稿');
  await md(['test', 'status', task, '--bot', '179cd443'], h);
  const r = await md(['test', 'stop', task, '--bot', '179cd443'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /账本保留预估/);
  assert.match(r.stdout, /paused · 1\/3/);
  const [row] = spendRows(h);
  // 已跑完的 1 条：逐条花费 ¥0.02 + 1 条断言的判定费 ¥0.012
  assert.ok(Math.abs(row.actual - 0.032) < 1e-9, JSON.stringify(row));
  assert.equal(row.runs, 1);
});

const savedRows = (stdout) => readFileSync(stdout.match(/逐条明细：(\S+)/)[1], 'utf-8').trim().split('\n').map((line) => JSON.parse(line));

test('results：一个任务 → 汇总、没通过的（空跑单独说）、逐条明细存本机；线上回复从导入来源取；--out 出 xlsx / csv / jsonl，别的扩展名报错', async () => {
  reset();
  const h = home();
  const file = join(h, 'search.jsonl');
  writeFileSync(file, execSearchLines({ botId: TARGET_BOT, botName: '【测试测试测试】太极2.0 测试专用版', ids: [SAME_EXEC] }));
  assert.equal((await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', file], h)).code, 0);
  const set = fake.state.sets[0].testSetId;
  fake.state.cases.push({ ...structuredClone(importable[CROSS_EXEC]), testCaseId: 'b0000001-0000-4000-8000-000000000000', testSetId: set });
  seedFinished(set, 0.02);
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--allow-preflight-errors'], h)).code, 0);
  const task = taskOf('集-草稿');
  const xlsx = join(h, 'report.xlsx');
  const r = await md(['test', 'results', task.slice(0, 8), '--bot', '179cd443', '--out', xlsx], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /以下含真实用户对话/);
  assert.match(r.stdout, /finished · v1\.0\.216 · 2 次 · 通过 1（50%） · 空跑 1 · ¥0\.020/);
  assert.match(r.stdout, /没有真正执行/);
  const rows = savedRows(r.stdout);
  assert.equal(rows.find((x) => x.execId === SAME_EXEC).online, '发出事件「发送4.0」：线上回复 1');
  assert.ok(readFileSync(xlsx).subarray(0, 2).equals(Buffer.from('PK')));
  const csv = join(h, 'report.csv');
  await md(['test', 'results', task.slice(0, 8), '--bot', '179cd443', '--out', csv], h);
  assert.match(readFileSync(csv, 'utf-8'), /^﻿用例名,调优中心执行ID,场景,用户消息/);
  const jsonl = join(h, 'report.jsonl');
  await md(['test', 'results', task.slice(0, 8), '--bot', '179cd443', '--out', jsonl], h);
  assert.equal(readFileSync(jsonl, 'utf-8').trim().split('\n').length, 2);
  const bad = await md(['test', 'results', task.slice(0, 8), '--bot', '179cd443', '--out', join(h, 'r.txt')], h);
  assert.equal(bad.code, 2);
});

test('results --deep：测试项里没有回复（回复在下游事件里）的，按测试执行 id 取详情补上', async () => {
  reset();
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const task = taskOf('集-草稿');
  await md(['test', 'status', task, '--bot', '179cd443'], h);
  for (const i of fake.state.items.get(task)) Object.assign(i, { executedActions: [{ type: 'canvas-event-action', summary: '触发 发送4.0 事件' }], canvasActionOutputAssertionResult: [] });
  assert.equal(savedRows((await md(['test', 'results', task, '--bot', '179cd443'], h)).stdout)[0].reply, '');
  const deep = await md(['test', 'results', task, '--bot', '179cd443', '--deep'], h);
  assert.match(deep.stderr, /--deep：1 条要取执行详情/);
  assert.equal(savedRows(deep.stdout)[0].reply, '发出事件「发送4.0」：详情里的回复');
});

test('results 两个任务：按用例对齐，--out csv 每个任务一组「通过 / 回复」列', async () => {
  reset();
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443', '--name', '改前'], h);
  await md(['test', 'run', '集', '--bot', '179cd443', '--name', '改后'], h);
  const out = join(h, 'cmp.csv');
  const r = await md(['test', 'results', '改前', '改后', '--bot', '179cd443', '--out', out], h);
  assert.equal(r.code, 0, r.stderr);
  const csv = readFileSync(out, 'utf-8');
  assert.match(csv, /用例名,调优中心执行ID,用户消息,线上回复,改前 通过,改前 回复,改后 通过,改后 回复/);
  assert.match(csv, /1\/1,回复：我想退款,1\/1,回复：我想退款/);
});

test('drop：先预演给计划码、什么都不删；码不对退出码 5；对了先备份，再先删用例后删集，回读确认（审查重点 4）', async () => {
  reset();
  seedSet('要删的集', [SAME_EXEC, CROSS_EXEC]);
  const h = home();
  const preview = await md(['test', 'drop', '要删的集', '--bot', '179cd443'], h);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /要删的测试集「要删的集」\(40000001\)：2 条用例/);
  const code = preview.stdout.match(/计划码：([0-9a-f]{8})/)[1];
  assert.deepEqual(fake.state.log, []);
  assert.equal((await md(['test', 'drop', '要删的集', '--bot', '179cd443', '--confirm', '00000000'], h)).code, 5);
  const r = await md(['test', 'drop', '要删的集', '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.state.log, ['batchDelete', 'setDelete']);
  assert.equal(fake.state.sets.length, 0);
  const backup = r.stdout.match(/备份：(\S+)/)[1];
  assert.equal(JSON.parse(readFileSync(backup, 'utf-8')).cases.length, 2);
});

test('drop：预演之后集里的用例变了，原来的计划码就对不上，什么都不删', async () => {
  reset();
  const set = seedSet('集', [SAME_EXEC]);
  const h = home();
  const code = (await md(['test', 'drop', '集', '--bot', '179cd443'], h)).stdout.match(/计划码：([0-9a-f]{8})/)[1];
  fake.state.cases.push({ ...structuredClone(importable[CROSS_EXEC]), testCaseId: 'b0000009-0000-4000-8000-000000000000', testSetId: set });
  const r = await md(['test', 'drop', '集', '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /计划码对不上/);
  assert.equal(fake.state.sets.length, 1);
  assert.deepEqual(fake.state.log, []);
});

test('results：被暂停、没跑完的任务，没跑的条目标「未跑」，不说成空跑、不进通过率（审查 I1）', async () => {
  reset({ perPoll: 0 });
  seedFinished(seedSet('集', [SAME_EXEC, SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const task = taskOf('集-草稿');
  await md(['test', 'stop', task, '--bot', '179cd443'], h);
  const r = await md(['test', 'results', task, '--bot', '179cd443'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /paused · v1\.0\.216 · 0 次 · 通过 0 · ¥0 · 还有 2 条没跑/);
  assert.doesNotMatch(r.stdout, /空跑|没有真正执行/);
});

test('results：用例在页面上改了名，执行 id 和线上回复照样对得上（导入时记下了用例 id → 执行，审查 I6）', async () => {
  reset();
  const h = home();
  const file = join(h, 'search.jsonl');
  writeFileSync(file, execSearchLines({ botId: TARGET_BOT, botName: '【测试测试测试】太极2.0 测试专用版', ids: [SAME_EXEC] }));
  await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', file], h);
  fake.state.cases[0].name = '退款-课程-01';
  seedFinished(fake.state.sets[0].testSetId, 0.02);
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const [row] = savedRows((await md(['test', 'results', taskOf('集-草稿'), '--bot', '179cd443'], h)).stdout);
  assert.deepEqual([row.name, row.execId, row.online], ['退款-课程-01', SAME_EXEC, '发出事件「发送4.0」：线上回复 1']);
});

test('results --deep：某一条取详情失败，标出来、接着取别的，不让整次白费（审查 M7）', async () => {
  reset();
  seedFinished(seedSet('集', [SAME_EXEC, SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const task = taskOf('集-草稿');
  await md(['test', 'status', task, '--bot', '179cd443'], h);
  for (const i of fake.state.items.get(task)) Object.assign(i, { executedActions: [], canvasActionOutputAssertionResult: [] });
  const [first] = fake.state.items.get(task);
  const original = fake.server.routes['GET /api/canvas/history/details'];
  fake.server.routes['GET /api/canvas/history/details'] = (req) => (req.query.execId === first.canvasExecId ? { status: 502, body: { message: 'Bad Gateway' } } : original(req));
  try {
    const r = await md(['test', 'results', task, '--bot', '179cd443', '--deep'], h);
    assert.equal(r.code, 0, r.stderr);
    const rows = savedRows(r.stdout);
    assert.match(rows.find((x) => x.testExecId === first.canvasExecId).reply, /取详情失败/);
    assert.equal(rows.find((x) => x.testExecId !== first.canvasExecId).reply, '发出事件「发送4.0」：详情里的回复');
  } finally {
    fake.server.routes['GET /api/canvas/history/details'] = original;
  }
});

const writeLimits = (h, spend) => { mkdirSync(join(h, 'md'), { recursive: true }); writeFileSync(join(h, 'md', 'config.json'), JSON.stringify({ spend })); };

test('止损暂停后：账本按观察到的花费记实际，「今天已花」看得到；重跑按观察到的单价估价，超门槛就要确认，不会一轮轮自动放行（审查 C1）', async () => {
  reset({ perPoll: 1, itemCost: 1 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.001);
  const h = home();
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '3'], h)).code, 0);
  const task = taskOf('集-草稿');
  const paused = await md(['test', 'status', task, '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.match(paused.stdout, /已暂停任务/);
  assert.match(paused.stdout, /重新 md test run 会把已经跑完的条目再花一次钱/);
  assert.match((await md(['spend'], h)).stdout, /今天已花 ¥1\.01/);
  const again = await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '3'], h);
  assert.equal(again.code, 5, again.stdout);
  assert.match(again.stdout, /预计 ¥3\.04（上次盯着跑时观察到每条 ¥1\.01）/);
  assert.match(again.stdout, /确认码：/);
});

test('resume：止损暂停的任务接着跑剩下的——先预演（剩几条、按实际单价估其余花费、给计划码），什么都不写；带对的码才继续，额度跟着调，--wait 不会又立刻暂停', async () => {
  reset({ perPoll: 1, itemCost: 1 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.001);
  const h = home();
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '3'], h)).code, 0);
  const task = taskOf('集-草稿');
  const paused = await md(['test', 'status', task, '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.match(paused.stdout, /要接着跑剩下的 2 条：md test resume 7\w{7} --bot 179cd443/);
  const dry = await md(['test', 'resume', task.slice(0, 8), '--bot', '179cd443'], h);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /已跑完 1\/3 条，花了 ¥1\.01；剩下 2 条按每条 ¥1\.01 估要 ¥2\.02/);
  assert.match(dry.stdout, /这是预演，什么都没写/);
  const code = dry.stdout.match(/计划码：([0-9a-f]{8})/)?.[1];
  assert.ok(code, dry.stdout);
  assert.equal(fake.state.posts.resume, undefined);
  const wrong = await md(['test', 'resume', task, '--bot', '179cd443', '--confirm', '00000000'], h);
  assert.equal(wrong.code, 5);
  assert.equal(fake.state.posts.resume, undefined);
  const done = await md(['test', 'resume', task, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(fake.state.posts.resume, [{ testTaskId: task }]);
  assert.match((await md(['spend'], h)).stdout, /「继续 集-草稿.*」×2 预估 ¥2\.02 实际 记在原任务那一笔（用户确认）/);
  const waited = await md(['test', 'status', task, '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.doesNotMatch(waited.stdout, /已暂停任务/);
  assert.match(waited.stdout, / finished · 3\/3 · /);
  const again = await md(['test', 'resume', task, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /已经是 finished，只有暂停的任务能继续/);
  assert.equal(fake.state.posts.resume.length, 1);
});

test('估价不被空跑稀释：上次跑完的任务按真正执行了的条目算单价；全是空跑（单价 0）就当估不出、要确认（审查 C1）', async () => {
  reset();
  const set = seedSet('集', [SAME_EXEC]);
  fake.state.tasks.push({ testTaskId: '70000097-0000-4000-8000-000000000000', botId: TARGET_BOT, testSetId: set, name: '上次', status: 'finished', totalCostInCny: 0.02, averageCostInCny: 0.01, createdAt: '2026-09-24T00:00:00.000Z' });
  fake.state.items.set('70000097-0000-4000-8000-000000000000', [
    { testCaseId: 'x1', status: 'success', passed: true, costInCny: 0.02, canvasExecAvailable: true },
    { testCaseId: 'x2', status: 'success', passed: false, costInCny: null, canvasExecAvailable: false },
  ]);
  const mixed = await md(['test', 'run', '集', '--bot', '179cd443']);
  assert.equal(mixed.code, 0, mixed.stderr);
  assert.match(mixed.stdout, /预计 ¥0\.020（上次跑完的任务「上次」真正执行的 1 条平均 ¥0\.020）/);
  reset();
  const set2 = seedSet('集', [SAME_EXEC]);
  fake.state.tasks.push({ testTaskId: '70000096-0000-4000-8000-000000000000', botId: TARGET_BOT, testSetId: set2, name: '全空跑', status: 'finished', totalCostInCny: 0, averageCostInCny: 0, createdAt: '2026-09-24T00:00:00.000Z' });
  const allNoop = await md(['test', 'run', '集', '--bot', '179cd443']);
  assert.equal(allNoop.code, 5);
  assert.match(allNoop.stdout, /预计 估不出/);
});

test('status 不带 --wait 也判断止损：超额度就暂停；自动放行的任务还看每日上限（审查 I2）', async () => {
  reset({ perPoll: 1, itemCost: 1 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.001);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '3'], h);
  const r = await md(['test', 'status', taskOf('集-草稿'), '--bot', '179cd443'], h);
  // 每条 ¥1 + 1 条断言的判定费 ¥0.012（09-29 实测，逐条花费里没有这笔）
  assert.match(r.stdout, /⛔ 按已跑完的 1 条平均 ¥1\.01 推算（含断言判定），整个任务要 ¥3\.04，超过额度 ¥2\.00，已暂停任务/);
  reset({ perPoll: 1, itemCost: 1 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.001);
  const h2 = home();
  writeLimits(h2, { perCommand: 10, perDay: 2 });
  await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '3'], h2);
  const daily = await md(['test', 'status', taskOf('集-草稿'), '--bot', '179cd443'], h2);
  assert.match(daily.stdout, /⛔ .*超过每日上限 ¥2\.00，已暂停任务/);
});

test('status --wait 遇到一次网络错误或 5xx 不放弃，接着查（09-25 真机见过一次 DNS 解析失败就断掉）', async () => {
  reset({ perPoll: 1 });
  seedFinished(seedSet('集', [SAME_EXEC, SAME_EXEC]), 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443'], h);
  const original = fake.server.routes['GET /api/test-center/test-task/detail'];
  let calls = 0;
  fake.server.routes['GET /api/test-center/test-task/detail'] = (req) => (++calls === 2 ? { status: 502, body: { message: 'Bad Gateway' } } : original(req));
  try {
    const r = await md(['test', 'status', taskOf('集-草稿'), '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /查进度出错/);
    assert.match(r.stdout, /finished · 2\/2/);
  } finally {
    fake.server.routes['GET /api/test-center/test-task/detail'] = original;
  }
});

test('run：建任务时身份失效 → 原样报（退出码 3），不说「可能已经建了」；账本这一笔记 0（审查 M3）', async () => {
  reset();
  seedFinished(seedSet('集', [SAME_EXEC]), 0.02);
  const original = fake.server.routes['POST /api/test-center/test-task/create'];
  fake.server.routes['POST /api/test-center/test-task/create'] = () => ({ status: 401, body: { statusCode: 401, message: 'Authentication failed' } });
  try {
    const h = home();
    const r = await md(['test', 'run', '集', '--bot', '179cd443'], h);
    assert.equal(r.code, 3, r.stderr);
    assert.doesNotMatch(r.stderr, /可能已经建了/);
    assert.equal(spendRows(h)[0].actual, 0);
  } finally {
    fake.server.routes['POST /api/test-center/test-task/create'] = original;
  }
});

// 让事件列表接口出错（模拟个别区版本不齐）
async function withoutEventList(fn) {
  const original = fake.server.routes['GET /api/canvas/event/list'];
  fake.server.routes['GET /api/canvas/event/list'] = () => ({ status: 502, body: { message: 'Bad Gateway' } });
  try {
    return await fn();
  } finally {
    fake.server.routes['GET /api/canvas/event/list'] = original;
  }
}

test('取不到事件列表：import 在写秒懂之前就停下（什么都没写）；run 算跑前检查不通过；cases 说「取不到」不说「没有」（审查 I4）', async () => {
  reset();
  const h = home();
  await withoutEventList(async () => {
    const imp = await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', SAME_EXEC], h);
    assert.equal(imp.code, 5, imp.stderr);
    assert.match(imp.stderr, /取不到这个智能体的事件 \/ 会话变量列表.*什么都没写/);
    assert.deepEqual(fake.state.log, []);
    seedFinished(seedSet('已有', [SAME_EXEC]), 0.02);
    const run = await md(['test', 'run', '已有', '--bot', '179cd443'], h);
    assert.equal(run.code, 5);
    assert.match(run.stdout, /取不到这个智能体的事件或会话变量列表/);
    assert.equal(fake.state.posts.taskCreate, undefined);
    const cases = await md(['test', 'cases', '已有', '--bot', '179cd443'], h);
    assert.match(cases.stdout, /（取不到事件列表）/);
    assert.doesNotMatch(cases.stdout, /这个智能体里没有/);
  });
});

test('md test cases：输出里有用户原话，开头先说「只作诊断材料」（审查 M5）', async () => {
  reset();
  seedSet('集', [SAME_EXEC]);
  assert.match((await md(['test', 'cases', '集', '--bot', '179cd443'])).stdout, /以下含真实用户对话，只作诊断材料/);
});

test('import 写到一半出错：报错里说清测试集已经建了、可能留下了什么、怎么清理（审查 I4）', async () => {
  reset();
  const original = fake.server.routes['POST /api/test-center/test-case/import'];
  fake.server.routes['POST /api/test-center/test-case/import'] = () => ({ status: 502, body: { message: 'Bad Gateway' } });
  try {
    const r = await md(['test', 'import', '集', '--bot', '179cd443', '--from-execs', SAME_EXEC]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /测试集「集」\(\w{8}\) 已经建了，可能已经导进去了一部分/);
    assert.match(r.stderr, /md test drop/);
  } finally {
    fake.server.routes['POST /api/test-center/test-case/import'] = original;
  }
});

// 让批量删用例只删掉第一条（模拟部分失败）
async function withPartialDelete(fn) {
  const original = fake.server.routes['POST /api/test-center/test-case/batch-delete'];
  fake.server.routes['POST /api/test-center/test-case/batch-delete'] = (req) => original({ ...req, body: { testCaseIds: req.body.testCaseIds.slice(0, 1) } });
  try {
    return await fn();
  } finally {
    fake.server.routes['POST /api/test-center/test-case/batch-delete'] = original;
  }
}

test('drop：用例没删干净就不删集，说清还剩几条、备份在哪；预演时说明有任务还在跑（审查 M6）', async () => {
  reset({ perPoll: 0 });
  const set = seedSet('集', [SAME_EXEC, CROSS_EXEC]);
  seedFinished(set, 0.02);
  const h = home();
  await md(['test', 'run', '集', '--bot', '179cd443', '--allow-preflight-errors'], h);
  const preview = await md(['test', 'drop', '集', '--bot', '179cd443'], h);
  assert.match(preview.stdout, /其中 1 个还在跑或排队/);
  const code = preview.stdout.match(/计划码：([0-9a-f]{8})/)[1];
  await withPartialDelete(async () => {
    const r = await md(['test', 'drop', '集', '--bot', '179cd443', '--confirm', code], h);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /还剩 1 条用例没删掉，测试集先不删/);
    assert.match(r.stderr, /已备份/);
  });
  assert.ok(fake.state.sets.some((s) => s.testSetId === set));
  assert.equal(fake.state.posts.setDelete, undefined);
});

test('import 撤回没删干净：不删集，说清还剩几条、怎么清理（审查 M6）', async () => {
  reset();
  await withPartialDelete(async () => {
    const r = await md(['test', 'import', '新集', '--bot', '179cd443', '--from-execs', `${CROSS_EXEC},${LOST_EXEC}`]);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /还剩 1 条没删掉，用 md test drop/);
  });
  assert.equal(fake.state.sets.length, 1);
});

test('止损算上断言判定费：逐条花费推算没超额度、加上判定费超了，也要暂停（09-29：任务总额比逐条花费多 21%）', async () => {
  reset({ perPoll: 1, itemCost: 0.64, assertions: 10 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.001);
  const h = home();
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '3'], h)).code, 0);
  const r = await md(['test', 'status', taskOf('集-草稿'), '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /⛔ 按已跑完的 1 条平均 ¥0\.760 推算（含断言判定），整个任务要 ¥2\.28，超过额度 ¥2\.00，已暂停任务/);
});

test('任务跑完：按秒懂总额反推每条断言的判定费、记下含判定费的单价；下一轮估价按它算（09-29）', async () => {
  reset({ itemCost: 0.2, assertions: 2, judgeFee: 0.4 });
  seedFinished(seedSet('集', [SAME_EXEC]), 0.001);
  const h = home();
  assert.equal((await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '2'], h)).code, 0);
  const done = await md(['test', 'status', taskOf('集-草稿'), '--bot', '179cd443', '--wait'], h, { MD_TEST_POLL_MS: '5' });
  assert.equal(done.code, 0, done.stderr);
  const row = spendRows(h).find((x) => x.kind === 'test' && x.taskId);
  assert.ok(Math.abs(row.actual - 0.8) < 1e-9, JSON.stringify(row));
  assert.ok(Math.abs(row.judgePerAssertion - 0.1) < 1e-9, JSON.stringify(row));
  assert.ok(Math.abs(row.actualPerRun - 0.4) < 1e-9, JSON.stringify(row));
  const again = await md(['test', 'run', '集', '--bot', '179cd443', '--rounds', '2'], h);
  assert.match(again.stdout, /预计 ¥0\.800（/);
});

test('只有导入来源的执行花费可参考时：估价按这个集每条用例的断言数补上判定费（执行记录里没有这笔）', async () => {
  reset();
  const h = home();
  const file = join(h, 'src.jsonl');
  writeFileSync(file, execSearchLines({ botId: TARGET_BOT, botName: '【测试测试测试】太极2.0 测试专用版', ids: [SAME_EXEC] }));
  const imported = await md(['test', 'import', '回归-退款', '--bot', '179cd443', '--from-execs', file], h);
  assert.equal(imported.code, 0, imported.stdout + imported.stderr);
  const r = await md(['test', 'run', '回归-退款', '--bot', '179cd443'], h);
  const m = r.stdout.match(/预计 ¥([\d.]+)（导入来源的 1 条执行平均 ¥([\d.]+)，加上断言判定约 ¥0\.024\/条）/);
  assert.ok(m, r.stdout);
  assert.ok(Math.abs(Number(m[1]) - (Number(m[2]) + 0.024)) < 0.0011, r.stdout);
});
