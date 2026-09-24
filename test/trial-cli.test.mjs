import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity, seedWorkspace } from './helpers/seed.mjs';
import { startTrialServer, trialDraft } from './helpers/trial-server.mjs';
import { ASK, EXEC_BOT, X } from './helpers/exec-fixtures.mjs';
import { U } from './helpers/fixtures.mjs';

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
  reset();
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
