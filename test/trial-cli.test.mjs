import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity, seedWorkspace } from './helpers/seed.mjs';
import { startTrialServer, trialDraft } from './helpers/trial-server.mjs';
import { ASK, EXEC_BOT, X } from './helpers/exec-fixtures.mjs';
import { U } from './helpers/fixtures.mjs';
import { ok } from './helpers/fake-miaodong.mjs';

let fake;
before(async () => { fake = await startTrialServer(); });
after(() => fake.server.close());
const reset = (patch = {}) => { Object.assign(fake.state, { posts: [], polls: new Map(), startStatus: 201, runningPolls: 1, pollStatus: 200, cost: 0.0123, ...patch }); };

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const spends = (h) => {
  const file = join(h, 'md', 'spend.jsonl');
  if (!existsSync(file)) return [];
  const byId = new Map();
  for (const line of readFileSync(file, 'utf-8').trim().split('\n')) { const row = JSON.parse(line); byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row }); }
  return [...byId.values()];
};
const limits = (h, spend) => { mkdirSync(join(h, 'md'), { recursive: true }); writeFileSync(join(h, 'md', 'config.json'), JSON.stringify({ spend })); };
const codeIn = (stdout) => stdout.match(/确认码：([0-9a-f]{8})/)?.[1];

test('--from-exec：用那次执行里这个节点的输入，去掉平台参数；记账本；结果和 prompt 落盘', async () => {
  reset();
  const h = home();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.state.posts[0].inputs.inputData, { text: ASK });
  assert.match(r.stdout, /去掉平台参数：质检规则/);
  assert.match(r.stdout, /#1 ✅ success 1\.2s ¥0\.012/);
  assert.match(r.stdout, /输出：回复：我想退款/);
  const [row] = spends(h);
  assert.deepEqual([row.kind, row.estimate, row.actual, row.approved, row.nodeId], ['trial', 0.0102, 0.0123, 'auto', U(2)]);
  const dir = r.stdout.match(/结果和 prompt 在 (\S+)/)[1];
  assert.deepEqual(readdirSync(dir).sort(), ['prompt-1.txt', 'run-1.json']);
});

test('--keep-platform-params 保留；--input 覆盖；--times 2 跑两次并汇总', async () => {
  reset();
  await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2), '--keep-platform-params']);
  assert.equal(fake.state.posts[0].inputs.inputData.质检规则, '旧规则');
  reset();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2), '--input', 'text=你好', '--times', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.posts.length, 2);
  assert.ok(fake.state.posts.every((p) => p.inputs.inputData.text === '你好'));
  assert.match(r.stdout, /2 次里 1 种不同输出/);
});

test('动作类节点不跑；插件节点没有 --allow-plugin 不跑；有了也要先给确认码、不跑', async () => {
  reset();
  const action = await md(['trial', '触发发送', '--bot', '147bd600']);
  assert.equal(action.code, 5);
  assert.match(action.stderr, /不做单节点试跑/);
  const plugin = await md(['trial', '兴趣岛用户详情', '--bot', '147bd600', '--input', 'x=1']);
  assert.equal(plugin.code, 5);
  assert.match(plugin.stderr, /--allow-plugin/);
  const tool = await md(['trial', '带插件的大模型', '--bot', '147bd600', '--input', 'text=1', '--allow-plugin']);
  assert.equal(tool.code, 5);
  assert.match(tool.stderr, /需要用户确认.*会真的调用外部系统：写多维表/);
  assert.ok(codeIn(tool.stdout), tool.stdout);
  assert.equal(fake.state.posts.length, 0);
});

test('插件节点：用户同意后带确认码才跑；账本记「用户确认」和那个码', async () => {
  reset();
  const h = home();
  const args = ['trial', '带插件的大模型', '--bot', '147bd600', '--input', 'text=1', '--allow-plugin'];
  const code = codeIn((await md(args, h)).stdout);
  assert.ok(code);
  const r = await md([...args, '--confirm', code], h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.state.posts.length, 1);
  const [row] = spends(h);
  assert.deepEqual([row.approved, row.code], ['confirm', code]);
});

test('预估超单次门槛：不跑、不记账，给确认码；码不对不跑；带对的码才跑；同一个码不能再用', async () => {
  reset({ cost: 0.0102 });
  const h = home();
  limits(h, { perCommand: 0.001, perDay: 10 });
  const args = ['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)];
  const r = await md(args, h);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /超过单次门槛/);
  assert.match(r.stdout, /预计 ¥0\.010/);
  const code = codeIn(r.stdout);
  assert.ok(code, r.stdout);
  assert.equal(fake.state.posts.length, 0);
  assert.deepEqual(spends(h), []);
  const wrong = await md([...args, '--confirm', '00000000'], h);
  assert.equal(wrong.code, 5);
  assert.match(wrong.stderr, /确认码对不上/);
  assert.equal(fake.state.posts.length, 0);
  const ok = await md([...args, '--confirm', code], h);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(fake.state.posts.length, 1);
  const again = await md([...args, '--confirm', code], h);
  assert.equal(again.code, 5);
  assert.match(again.stderr, /已经用过/);
  assert.equal(fake.state.posts.length, 1);
});

test('不需要确认时，多给的 --confirm 不影响：照常跑，记「自动」', async () => {
  reset();
  const h = home();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2), '--confirm', 'deadbeef'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(spends(h)[0].approved, 'auto');
});

test('估不出花费：先跑 1 次，用实际推算其余；推算超门槛就停下、给其余几次的确认码，已跑的记账；带码跑剩下的', async () => {
  reset();
  const h = home();
  limits(h, { perCommand: 0.02, perDay: 10 });
  const args = ['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好'];
  const r = await md([...args, '--times', '3'], h);
  assert.equal(r.code, 5);
  assert.equal(fake.state.posts.length, 1);
  assert.match(r.stdout, /估不出，先跑 1 次看实际/);
  assert.match(r.stderr, /超过单次门槛/);
  assert.match(r.stderr, /--times 改成 2/);
  const [row] = spends(h);
  assert.deepEqual([row.estimate, row.actual, row.runs], [null, 0.0123, 1]);
  const code = codeIn(r.stdout);
  assert.ok(code, r.stdout);
  const rest = await md([...args, '--times', '2', '--confirm', code], h);
  assert.equal(rest.code, 0, rest.stderr);
  assert.equal(fake.state.posts.length, 3);
  assert.equal(spends(h)[1].approved, 'confirm');
});

test('本地改了还没推：醒目提示跑的是草稿上的旧版本', async () => {
  reset();
  const h = home();
  const dir = await seedWorkspace(h, { canvas: trialDraft(), meta: { botId: EXEC_BOT, botName: '太极2.0 质检革新版' } });
  const { saveAfter } = await import('../src/workspace.mjs');
  const changed = trialDraft().map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '本地新 prompt' } } } : c));
  saveAfter(dir, { canvas: changed, sessions: [], events: [] });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /⚠️ 本地改动还没推：这次跑的是草稿上的旧版本/);
});

test('POST 5xx：报不确定、不重发，退出码 1', async () => {
  reset({ startStatus: 502 });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好', '--times', '3']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /有没有启动不确定/);
  assert.equal(fake.state.posts.length, 1);
});

test('估不出花费、第 1 次又超时没跑完：还是估不出，其余几次要用户确认，不能当 ¥0 放行', async () => {
  reset({ runningPolls: 100000 });
  const h = home();
  const r = await runCli(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好', '--times', '3'], { home: h, env: { MD_TRIAL_TIMEOUT_MS: '50' } });
  assert.equal(r.code, 5, r.stderr);
  assert.equal(fake.state.posts.length, 1);
  assert.match(r.stdout, /#1 ⏳ 5 分钟没跑完|#1 ⏳ .*没跑完/);
  assert.match(r.stderr, /估不出花费/);
  assert.ok(codeIn(r.stdout), r.stdout);
  const [row] = spends(h);
  assert.deepEqual([row.runs, row.unknownRuns, row.actualPerRun], [1, 1, null]);
});

test('预估偏低（同一模型，执行记录里 ¥0.01/次、现在 ¥1/次）：跑完第 1 次按实际推算超门槛就停，不会一口气花 ¥10（审查 C1）', async () => {
  reset({ cost: 1 });
  const h = home();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2), '--times', '10'], h);
  assert.equal(r.code, 5, r.stderr);
  assert.equal(fake.state.posts.length, 1);
  assert.match(r.stderr, /超过单次门槛/);
  assert.match(r.stderr, /--times 改成 9/);
  const [row] = spends(h);
  assert.deepEqual([row.actual, row.runs], [1, 1]);
});

test('估不出时先跑 1 次：拿「已花 + 其余」比门槛，¥0.9 × 3 在第 1 次后停（审查 C1）', async () => {
  reset({ cost: 0.9 });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好', '--times', '3']);
  assert.equal(r.code, 5, r.stderr);
  assert.equal(fake.state.posts.length, 1);
});

test('执行之后这个节点换了模型：那次的花费不能当预估，按估不出处理并说明（审查 R2）', async () => {
  reset();
  const original = fake.server.routes['GET /api/canvas/get'];
  const gemini = trialDraft().map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, modelType: 'gemini-3.5-flash' } } } : c));
  fake.server.routes['GET /api/canvas/get'] = () => ok({ canvasId: 'main-1', rawCanvas: gemini, version: 'v1.0.403', updatedAt: '2026-09-24T01:00:00.000Z' });
  try {
    const h = home();
    const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)], h);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /模型从 doubao-seed-2\.0-lite 换成了 gemini-3\.5-flash/);
    assert.match(r.stdout, /估不出，先跑 1 次看实际/);
    assert.equal(spends(h)[0].estimate, null);
  } finally {
    fake.server.routes['GET /api/canvas/get'] = original;
  }
});

test('结果里没有花费字段（大模型）：不当 ¥0——不写进每次花费、按保守单价记账；--times 3 跑完第 1 次就停（审查 I1）', async () => {
  reset({ cost: null });
  const h = home();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好', '--times', '3'], h);
  assert.equal(r.code, 5, r.stderr);
  assert.equal(fake.state.posts.length, 1);
  const [row] = spends(h);
  assert.deepEqual([row.actualPerRun, row.unknownRuns, row.assumed], [null, 1, 0.7]);
});

test('POST 结果不明、查结果连续失败：那一次按保守单价入账，「今天已花」不会是 ¥0（审查 I2）', async () => {
  for (const patch of [{ startStatus: 502 }, { pollStatus: 500 }]) {
    reset(patch);
    const h = home();
    const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好'], h);
    assert.equal(r.code, 1, r.stderr);
    const [row] = spends(h);
    assert.deepEqual([row.runs, row.unknownRuns, row.assumed], [1, 1, 0.7], JSON.stringify(patch));
    const shown = (await md(['spend'], h)).stdout;
    assert.match(shown, /今天已花 ¥0\.700/);
    assert.match(shown, /实际 ¥0（另有 1 次花费不知道，按 ¥0\.700 记）/);
  }
});

test('并行跑：「查今天已花 → 判断 → 记账」加了锁，同时进来的几条命令不会一起越过每日上限（审查 I3）', async () => {
  reset();
  const h = home();
  await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好'], h);
  limits(h, { perCommand: 2, perDay: 0.04 });
  reset();
  const rs = await Promise.all(Array.from({ length: 6 }, () => md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好'], h)));
  assert.equal(rs.filter((r) => r.code === 0).length, 2, rs.map((r) => r.code).join(','));
  assert.equal(fake.state.posts.length, 2);
});

test('--ws 和 --bot 同时给：报用法错误（二选一），不悄悄忽略 --bot', async () => {
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--ws', '/tmp/x', '--input', 'text=1']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /--ws 和 --bot 只能给一个/);
});

const withLocalPrompt = () => trialDraft().map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '本地新 prompt' } } } : c));

test('要确认时，预演里也有「本地改动还没推」的提醒：用户是看着它决定的（审查 I6）', async () => {
  reset();
  const h = home();
  limits(h, { perCommand: 0.001, perDay: 10 });
  const dir = await seedWorkspace(h, { canvas: trialDraft(), meta: { botId: EXEC_BOT, botName: '太极2.0 质检革新版' } });
  const { saveAfter } = await import('../src/workspace.mjs');
  saveAfter(dir, { canvas: withLocalPrompt(), sessions: [], events: [] });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)], h);
  assert.equal(r.code, 5, r.stderr);
  assert.match(r.stdout, /⚠️ 本地改动还没推[\s\S]*确认码：/);
  assert.equal(fake.state.posts.length, 0);
});

test('这个智能体有好几个工作副本：优先看有没推改动的那个，后拉的副本不会把「没推」的提醒盖掉（审查 M8）', async () => {
  reset();
  const h = home();
  const older = await seedWorkspace(h, { canvas: trialDraft(), meta: { botId: EXEC_BOT, botName: '太极2.0 质检革新版', pulledAt: '2026-09-20T00:00:00.000Z' } });
  const { saveAfter } = await import('../src/workspace.mjs');
  saveAfter(older, { canvas: withLocalPrompt(), sessions: [], events: [] });
  await seedWorkspace(h, { canvas: trialDraft(), meta: { botId: EXEC_BOT, botName: '太极2.0 质检革新版', pulledAt: '2026-09-24T00:00:00.000Z' } });
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /⚠️ 本地改动还没推/);
});

test('--from-exec 的输出里有真实用户原话：和 md exec 一样先打一句「只作诊断材料」（审查 M2）', async () => {
  reset();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /以下含真实用户对话，只作诊断材料/);
  reset();
  const plain = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好']);
  assert.doesNotMatch(plain.stdout, /只作诊断材料/);
});

test('结果目录开跑前就打印：命令被中途杀掉也知道结果在哪、跑了几次（审查 M7）', async () => {
  reset();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好']);
  assert.equal(r.code, 0, r.stderr);
  const at = r.stdout.indexOf('结果和 prompt 存在 ');
  assert.ok(at >= 0 && at < r.stdout.indexOf('#1 '), r.stdout);
});

test('--from-exec 的节点在执行那一版里有、草稿里已经删了：说清楚，不只报「没有节点」（审查 M3，真机核对时踩到）', async () => {
  reset();
  const original = fake.server.routes['GET /api/canvas/get'];
  fake.server.routes['GET /api/canvas/get'] = () => ok({ canvasId: 'main-1', rawCanvas: trialDraft().filter((c) => c.id !== U(2)), version: 'v1.0.403', updatedAt: '2026-09-24T01:00:00.000Z' });
  try {
    const r = await md(['trial', U(2).slice(0, 8), '--bot', '147bd600', '--from-exec', X(2)]);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /「回答生成」\[00000002\] 在执行 e0000002 跑的那一版（v1\.0\.402）里有，但现在的草稿里已经删了/);
  } finally {
    fake.server.routes['GET /api/canvas/get'] = original;
  }
});

test('跑的过程中把这一笔的预留更新成按实际推算的整条命令：并行的别的命令算今天已花时，看到的是真实量级（审查 I3 的延续）', async () => {
  reset({ cost: 0.5 });
  const h = home();
  const r = await md(['trial', '回答生成', '--bot', '147bd600', '--input', 'text=你好', '--times', '3'], h);
  assert.equal(r.code, 0, r.stderr);
  const lines = readFileSync(join(h, 'md', 'spend.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.some((l) => l.reserve === 1.5 && l.kind === undefined), JSON.stringify(lines));
});
