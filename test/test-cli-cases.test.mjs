// md test import --from-file / md test edit：外部用例和批量改（spec §6.3、§6.4），对着假秒懂跑真命令
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startTestCenterServer } from './helpers/testcenter-server.mjs';
import { scenarioTreeFixture } from './helpers/testcenter-fixtures.mjs';

let fake;
before(async () => { fake = await startTestCenterServer(); });
after(() => fake.server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const reset = (patch = {}) => Object.assign(fake.state, { sets: [], cases: [], tasks: [], items: new Map(), posts: {}, log: [], canvas: null, tree: [], pageCap: undefined, keepDimension: false, dropFields: [], failCreateAt: 0, treeDrift: 0, renameCreated: '', ...patch });
const jsonl = (h, rows, file = 'cases.jsonl') => {
  const path = join(h, file);
  writeFileSync(path, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  return path;
};
const casesIn = (setName) => {
  const set = fake.state.sets.find((s) => s.name === setName);
  return set ? fake.state.cases.filter((c) => c.testSetId === set.testSetId) : [];
};
const withoutScenario = (rows) => rows.map(({ scenario, ...rest }) => rest);

const THREE = [
  { name: '退款-01', text: '我想退款', history: ['之前问过价格'], expect: '应说明退款流程', dimension: '退款', scenario: '退款' },
  { name: '图片-01', image: 'https://x/b.jpg', history: ['这张图是什么'], expect: { reply: { similar: '这是一张图' } } },
  { name: '事件-01', event: '延时回复', data: { text: '课程怎么退' }, expect: [{ event: '发送4.0', params: { text: '应说明退课流程' } }, { handover: true }], scenario: '咨询/课程' },
];

test('import --from-file：先写 1 条读回来核对，其余一批写完，按 name 回读、挂场景；这个区丢 dimension 只提醒', async () => {
  reset({ tree: scenarioTreeFixture() });
  const h = home();
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, THREE)], h);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(fake.state.posts.caseCreate.map((p) => p.testCases.length), [1, 2]);
  assert.equal(casesIn('外部回归').length, 3);
  assert.match(r.stdout, /提交 3 · 回读 3 · 挂场景 2/);
  assert.match(r.stdout, /这个区不保存 dimension/);
  const stored = casesIn('外部回归').find((c) => c.name === '事件-01');
  assert.equal(stored.scenarioNodeId, 'sn-consult-course');
  assert.deepEqual(stored.triggerInputs, { eventId: 'tev-delay', data: { text: '课程怎么退' } });
  assert.deepEqual(stored.canvasActionOutputAssertions[1], { verifyPayload: { type: 'handover' }, actionContent: { type: 'handover' } });
  assert.deepEqual(fake.state.posts.attach.map((p) => [p.scenarioNodeId, p.testCaseIds.length]), [['sn-refund', 1], ['sn-consult-course', 1]]);
  assert.match(r.stdout, /下一步：md test run 外部回归/);
});

test('import --from-file：本地校验有错就一条都不写，带行号列出全部错误', async () => {
  reset({ tree: scenarioTreeFixture() });
  const h = home();
  const file = jsonl(h, [THREE[0], '{坏的', { name: '退款-01', text: '重名' }, { name: '事件-02', event: '没有的事件' }, { name: '拼错', text: 'x', expected: 'y' }]);
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', file], h);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /❌ .*5 处错误，一条都没写/);
  assert.match(r.stdout, /第 2 行：不是 JSON/);
  assert.match(r.stdout, /第 3 行「退款-01」：name「退款-01」在第 1、3 行重复/);
  assert.match(r.stdout, /第 4 行「事件-02」：事件「没有的事件」在这个智能体里没有/);
  assert.match(r.stdout, /第 5 行「拼错」：不认识的字段：expected/);
  assert.deepEqual(fake.state.log, []);
});

test('import --from-file：先写的 1 条关键字段被丢（会话数据）→ 撤回这 1 条、删掉新建的集，其余不写', async () => {
  reset({ dropFields: ['sessionMemoryCustomData'] });
  const h = home();
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, withoutScenario(THREE))], h);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /先写的第 1 条（第 1 行「退款-01」）这些字段读回来不一样：会话数据.*已撤回，也删了新建的测试集/);
  assert.equal(fake.state.posts.caseCreate.length, 1);
  assert.deepEqual([fake.state.sets, fake.state.cases], [[], []]);
});

test('import --from-file --into：和集里已有的 name 重复就拦下；不重复的追加进去', async () => {
  reset();
  const h = home();
  await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, [{ name: '旧-01', text: 'x', expect: 'y' }])], h);
  const dup = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--into', '--from-file', jsonl(h, [{ name: '旧-01', text: 'x', expect: 'y' }], 'b.jsonl')], h);
  assert.equal(dup.code, 1);
  assert.match(dup.stdout, /name「旧-01」集里已经有了/);
  const ok = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--into', '--from-file', jsonl(h, [{ name: '新-01', text: 'x', expect: 'y' }], 'c.jsonl')], h);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /导进已有的测试集「外部回归」/);
  assert.deepEqual(casesIn('外部回归').map((c) => c.name).sort(), ['新-01', '旧-01']);
});

test('import --from-file：没有场景树的区 scenario 只提醒、不挂；同名集已存在要加 --into；不能和 --from-execs 一起给', async () => {
  reset({ tree: null });
  const h = home();
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, THREE.slice(0, 1))], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /这个区没有场景树，scenario 不挂（1 条）/);
  assert.equal(fake.state.posts.attach, undefined);
  const again = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, [{ name: 'x', text: 'y' }], 'b.jsonl')], h);
  assert.equal(again.code, 5);
  assert.match(again.stderr, /已经有测试集「外部回归」/);
  const mixed = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', 'a.jsonl', '--from-execs', 'b'], h);
  assert.equal(mixed.code, 2);
});

test('import --from-file：写到一半出错，说清测试集已经建了、可能写进去一部分，怎么查、怎么接着导', async () => {
  reset({ failCreateAt: 2 });
  const h = home();
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, withoutScenario(THREE))], h);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /测试集「外部回归」\([0-9a-f]{8}\) 已经建了，可能已经写进去一部分/);
  assert.match(r.stderr, /用 --into 重导时已经写进去的 name 会被拦下/);
});

test('import --from-file：场景计数和挂的条数对不上就提醒（旧批次重复挂载）；回读翻页读全', async () => {
  reset({ tree: scenarioTreeFixture(), treeDrift: 1, pageCap: 2 });
  const h = home();
  const rows = Array.from({ length: 5 }, (_, i) => ({ name: `退款-${i + 1}`, text: `问题 ${i + 1}`, expect: '应说明退款流程', scenario: '退款' }));
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, rows)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /提交 5 · 回读 5 · 挂场景 5/);
  assert.match(r.stdout, /场景「退款」用例数变了 6，这次挂的是 5 条/);
});

const EDIT = `export default ({ cases, h }) => {
  for (const c of h.pick(/^退款/)) c.canvasActionOutputAssertions = h.expect({ event: '发送4.0', params: { text: '应说明退款流程' } });
  h.log('退款类改成核对发送事件');
};`;

async function seedExternal(h) {
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, [
    { name: '退款-01', text: '我想退款', expect: '应说明退款流程' },
    { name: '退款-02', text: '课程能退吗', expect: '应说明退课流程' },
    { name: '咨询-01', text: '怎么报名', expect: '应给报名链接' },
  ], 'seed.jsonl')], h);
  assert.equal(r.code, 0, r.stderr);
}
const editFile = (h, body = EDIT, file = 'edit.mjs') => {
  const path = join(h, file);
  writeFileSync(path, body);
  return path;
};
const planCode = (stdout) => stdout.match(/计划码：([0-9a-f]{8})/)?.[1];

test('edit：默认预演，列出改了哪几条、哪些字段，给计划码；什么都不写', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const writes = fake.state.log.length;
  const r = await md(['test', 'edit', '外部回归', editFile(h), '--bot', '179cd443'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /退款类改成核对发送事件/);
  assert.match(r.stdout, /要改 2 条（共 3 条）/);
  assert.match(r.stdout, /退款-01：断言/);
  assert.ok(planCode(r.stdout));
  assert.match(r.stdout, /这是预演，什么都没改/);
  assert.equal(fake.state.log.length, writes);
});

test('edit --confirm：先备份，再逐条全量 update，回读核对；计划码对不上退出码 5', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const file = editFile(h);
  const code = planCode((await md(['test', 'edit', '外部回归', file, '--bot', '179cd443'], h)).stdout);
  const wrong = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', '00000000'], h);
  assert.equal(wrong.code, 5);
  assert.match(wrong.stderr, /计划码对不上/);
  const r = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  const backup = r.stdout.match(/备份：(\S+)/)[1];
  assert.ok(existsSync(backup));
  assert.equal(JSON.parse(readFileSync(backup, 'utf-8')).cases.length, 3);
  assert.equal(fake.state.posts.update.length, 2);
  for (const body of fake.state.posts.update) for (const key of ['name', 'triggerType', 'triggerInputs', 'sessionMemoryCustomData', 'canvasActionOutputAssertions']) assert.ok(key in body, key);
  assert.equal(casesIn('外部回归').find((c) => c.name === '退款-01').canvasActionOutputAssertions[0].verifyPayload.type, 'canvas-event-action');
  assert.match(r.stdout, /已改 2 条/);
});

test('edit：预演之后集里的用例变了，原来的计划码对不上，什么都不写', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const file = editFile(h);
  const code = planCode((await md(['test', 'edit', '外部回归', file, '--bot', '179cd443'], h)).stdout);
  casesIn('外部回归').find((c) => c.name === '退款-02').triggerInputs.text = '页面上被人改了';
  const r = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 5);
  assert.equal(fake.state.posts.update, undefined);
});

test('edit：秒懂列用例的顺序变了（内容没变），预演给的计划码照样对得上', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const file = editFile(h);
  const code = planCode((await md(['test', 'edit', '外部回归', file, '--bot', '179cd443'], h)).stdout);
  fake.state.cases.reverse();
  const r = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.posts.update.length, 2);
});

test('edit：脚本改了不能改的字段或把 name 改成重名，什么都不写，列出问题', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const r = await md(['test', 'edit', '外部回归', editFile(h, `export default ({ cases }) => { cases[0].scenarioNodeId = 'sn-x'; cases[1].name = cases[2].name; };`, 'bad.mjs'), '--bot', '179cd443'], h);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /改了不能改的字段：scenarioNodeId/);
  assert.match(r.stdout, /有 2 条重名/);
  assert.equal(fake.state.posts.update, undefined);
});

test('edit --confirm：update 把没改的字段冲掉了（这个区不保存 dimension）也要提醒（审查 I1）', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  casesIn('外部回归').find((c) => c.name === '退款-01').dimension = '退款'; // 页面上建的，带着分类
  const file = editFile(h);
  const code = planCode((await md(['test', 'edit', '外部回归', file, '--bot', '179cd443'], h)).stdout);
  const r = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /dimension：1 条读回来和改的不一样/);
});

test('edit --confirm：写之前先打出备份路径，中途出错说清改了几条（审查 M8）', async () => {
  reset();
  const h = home();
  await seedExternal(h);
  const file = editFile(h);
  const code = planCode((await md(['test', 'edit', '外部回归', file, '--bot', '179cd443'], h)).stdout);
  const original = fake.server.routes['POST /api/test-center/test-case/update'];
  let calls = 0;
  fake.server.routes['POST /api/test-center/test-case/update'] = (req) => (++calls === 2 ? { status: 502, body: { message: 'Bad Gateway' } } : original(req));
  try {
    const r = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', code], h);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /已备份全部 3 条用例：\S+/);
    assert.match(r.stderr, /已改 1\/2 条/);
  } finally {
    fake.server.routes['POST /api/test-center/test-case/update'] = original;
  }
});

test('import --from-file：先写的那 1 条读回来时出错、挂场景时出错，都说清留下了什么（审查 M1）', async () => {
  reset();
  const h = home();
  const list = fake.server.routes['GET /api/test-center/test-case/list'];
  fake.server.routes['GET /api/test-center/test-case/list'] = (req) => (fake.state.posts.caseCreate?.length === 1 ? { status: 502, body: { message: 'Bad Gateway' } } : list(req));
  try {
    const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, withoutScenario(THREE))], h);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /测试集「外部回归」\([0-9a-f]{8}\) 已经建了，可能已经写进去一部分/);
    assert.match(r.stderr, /md test drop/);
  } finally {
    fake.server.routes['GET /api/test-center/test-case/list'] = list;
  }
  reset({ tree: scenarioTreeFixture() });
  const attach = fake.server.routes['POST /api/test-center/scenario/attach-cases'];
  fake.server.routes['POST /api/test-center/scenario/attach-cases'] = () => ({ status: 502, body: { message: 'Bad Gateway' } });
  try {
    const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, THREE, 'b.jsonl')], h);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /提交 3 · 回读 3/);
    assert.match(r.stderr, /用例都写进去了，挂场景时出错/);
  } finally {
    fake.server.routes['POST /api/test-center/scenario/attach-cases'] = attach;
  }
});

test('import --from-file --into：先写的 1 条被丢时只撤回这 1 条；按 name 找不到就一条都不删，说清集里可能多了一条（审查 I5）', async () => {
  reset();
  const h = home();
  await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, [{ name: '旧-01', text: 'x', expect: 'y' }])], h);
  fake.state.dropFields = ['sessionMemoryCustomData'];
  const r = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--into', '--from-file', jsonl(h, withoutScenario(THREE), 'b.jsonl')], h);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /已撤回/);
  assert.doesNotMatch(r.stderr, /删了新建的测试集/);
  assert.deepEqual(casesIn('外部回归').map((c) => c.name), ['旧-01']);
  assert.equal(fake.state.sets.length, 1);
  Object.assign(fake.state, { dropFields: [], renameCreated: '（服务端改了名）' });
  const lost = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--into', '--from-file', jsonl(h, withoutScenario(THREE), 'c.jsonl')], h);
  assert.equal(lost.code, 1);
  assert.match(lost.stderr, /按 name 找不到：秒懂没存下 md 写的内容，没法撤回：集里可能多了一条/);
  assert.deepEqual(casesIn('外部回归').map((c) => c.name).sort(), ['旧-01', '退款-01（服务端改了名）']);
});

test('edit：只删断言 verifyPayload.params 里的一个参数，秒懂存的时候两处一起删——回读不能报「不一致」（09-29 误报 62 处）', async () => {
  reset();
  const h = home();
  const seeded = await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, [
    { name: '退款-01', text: '我想退款', expect: { event: '发送4.0', params: { text: '应说明退款流程', urls: '应带退款链接' } } },
  ], 'seed-urls.jsonl')], h);
  assert.equal(seeded.code, 0, seeded.stdout + seeded.stderr);
  const file = editFile(h, `export default ({ cases }) => {
  for (const c of cases) for (const a of c.canvasActionOutputAssertions) delete a.verifyPayload.params.urls;
};`, 'drop-urls.mjs');
  const code = planCode((await md(['test', 'edit', '外部回归', file, '--bot', '179cd443'], h)).stdout);
  assert.ok(code);
  const r = await md(['test', 'edit', '外部回归', file, '--bot', '179cd443', '--confirm', code], h);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /读回来和改的不一样/);
  const saved = casesIn('外部回归')[0].canvasActionOutputAssertions[0];
  assert.deepEqual(Object.keys(saved.verifyPayload.params), ['text']);
  assert.deepEqual(Object.keys(saved.actionContent.payload.params), ['text']);
});

test('md test cases --scenario：按场景列用例（跨测试集），说清每条在哪个集；和集一起给就只看这个集的', async () => {
  reset({ tree: scenarioTreeFixture() });
  const h = home();
  assert.equal((await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', jsonl(h, THREE)], h)).code, 0);
  const r = await md(['test', 'cases', '--scenario', '咨询/课程', '--bot', '179cd443'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /场景「咨询\/课程」：1 条用例/);
  assert.match(r.stdout, /事件-01 · 测试集「外部回归」 · /);
  const inSet = await md(['test', 'cases', '外部回归', '--scenario', '退款', '--bot', '179cd443'], h);
  assert.match(inSet.stdout, /场景「退款」、测试集「外部回归」：1 条用例/);
  const ambiguous = await md(['test', 'cases', '--scenario', '课程', '--bot', '179cd443'], h);
  assert.equal(ambiguous.code, 4);
  assert.match(ambiguous.stderr, /有 2 个同名/);
});

test('md test audit：拿本地的 cases.jsonl 和秒懂里存的逐条逐字段对账——缺的、多的、关键字段不一样的、没挂对场景的都列出来；只读', async () => {
  reset({ tree: scenarioTreeFixture() });
  const h = home();
  const file = jsonl(h, THREE);
  assert.equal((await md(['test', 'import', '外部回归', '--bot', '179cd443', '--from-file', file], h)).code, 0);
  const clean = await md(['test', 'audit', '外部回归', '--from-file', file, '--bot', '179cd443'], h);
  assert.equal(clean.code, 0, clean.stderr + clean.stdout);
  assert.match(clean.stdout, /文件 3 条 · 秒懂 3 条 · 对上 3 条/);
  assert.match(clean.stdout, /⚠️ dimension：1 条和文件不一样（这个区可能不保存这个字段）/);
  const writes = fake.state.log.length;
  const stored = casesIn('外部回归');
  stored.find((c) => c.name === '图片-01').triggerInputs.imageUrl = 'https://x/被改了.jpg';
  stored.find((c) => c.name === '事件-01').scenarioNodeId = null;
  fake.state.cases = fake.state.cases.filter((c) => c.name !== '退款-01');
  fake.state.cases.push({ ...structuredClone(stored[1]), name: '多出来的', testCaseId: 'e9999999-0000-4000-8000-000000000000' });
  const r = await md(['test', 'audit', '外部回归', '--from-file', file, '--bot', '179cd443'], h);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /秒懂里没有：第 1 行「退款-01」/);
  assert.match(r.stdout, /文件里没有：「多出来的」/);
  assert.match(r.stdout, /❌ 第 2 行「图片-01」：触发输入 和文件不一样/);
  assert.match(r.stdout, /❌ 第 3 行「事件-01」：没挂在场景「咨询\/课程」上/);
  assert.equal(fake.state.log.length, writes, '审计只读');
});

