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
const reset = (patch = {}) => Object.assign(fake.state, { sets: [], cases: [], tasks: [], items: new Map(), posts: {}, log: [], canvas: null, tree: [], pageCap: undefined, keepDimension: false, dropFields: [], failCreateAt: 0, treeDrift: 0, ...patch });
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
