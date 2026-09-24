import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startExecServer } from './helpers/exec-server.mjs';
import { EXEC_BOT, REPLY, X, chainRows, detailOf } from './helpers/exec-fixtures.mjs';

let server;
before(async () => {
  const testRow = { ...chainRows().find((r) => r.execId === X(3)), execId: X(9) };
  server = await startExecServer({ extraDetails: { [X(9)]: detailOf(testRow, { testRun: true }) } });
});
after(() => server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const lastList = () => server.requests.filter((q) => q.path === '/api/canvas/history/list').at(-1).body;
const count = (path) => server.requests.filter((q) => q.path === path).length;

test('md exec --bot：默认最近 24 小时、新到旧；存 JSONL，不带会话变量快照', async () => {
  const r = await md(['exec', '--bot', '太极2.0 质检革新版']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0 质检革新版 \(147bd600\)/);
  assert.match(r.stdout, /共 5 条，显示 5 条/);
  const ids = [...r.stdout.matchAll(/ (e0000\d{3})-0000-/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['e0000003', 'e0000004', 'e0000002', 'e0000006', 'e0000001']);
  const body = lastList();
  assert.ok(Math.abs(body.endTimestamp - body.startTimestamp - 86_400_000) < 5000);
  const file = r.stdout.match(/已存：(\S+\.jsonl)/)[1];
  const saved = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(saved[0].kind, 'md-exec-search');
  assert.equal(saved[0].botId, EXEC_BOT);
  assert.equal(saved.length, 6);
  assert.ok(saved.slice(1).every((row) => !('sessionMemorySnapshot' in row)));
});

test('md exec --event：请求里带事件触发类型，事件名在本地比，说清扫了多少', async () => {
  const r = await md(['exec', '--bot', '147bd600', '--event', '延时回复']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastList().triggerType, 'canvas-event-trigger');
  assert.match(r.stdout, /条件：事件「延时回复」/);
  assert.match(r.stdout, /扫了 3 条，命中 2 条（已扫完）/);
});

test('md exec：版本、触发、动作、点踩、灰度、报错、关键词都进请求体', async () => {
  const r = await md(['exec', '--bot', '147bd600', '--version', 'v1.0.402', '--trigger', 'text', '--action', 'event', '--down', '--no-canary', '--failed', '--keyword', '退款']);
  assert.equal(r.code, 0, r.stderr);
  const body = lastList();
  assert.deepEqual(
    [body.canvasId, body.triggerType, body.actionType, body.feedbackStatus, body.isCanary, body.allNodesSuccess, body.keyword],
    ['ver-402', 'receive-text-message', 'canvas-event-action', 'thumb-down', false, false, '退款'],
  );
});

test('md exec：用法错误退出码 2，并说清错在哪', async () => {
  const conflict = await md(['exec', '--bot', '147bd600', '--event', '延时回复', '--trigger', 'text']);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /--event 只能配事件触发/);
  const since = await md(['exec', '--bot', '147bd600', '--since', '3w']);
  assert.equal(since.code, 2);
  assert.match(since.stderr, /时间长度写成/);
  const bare = await md(['exec']);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /缺 --bot/);
});

test('md exec <id>：不给 --bot 也能找到；事件链、节点按执行顺序、详情缓存', async () => {
  const h = home();
  const r = await md(['exec', X(2)], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0 质检革新版 \(147bd600\) \/ v1\.0\.402/);
  assert.match(r.stdout, /事件「延时回复」 · success · 节点 4 个/);
  assert.match(r.stdout, /← e0000001/);
  assert.match(r.stdout, /→ e0000003 .*发文本「已为您登记退款」/);
  assert.match(r.stdout, new RegExp(`整条链最终：发文本「${REPLY}」`));
  assert.doesNotMatch(r.stdout, /e0000004/);
  const order = [...r.stdout.matchAll(/^\s+\d+ ✅ (\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['延时回复入口', '回答生成', '规则中心', '触发发送']);
  const detailFile = r.stdout.match(/详情：(\S+detail\.json)/)[1];
  const saved = JSON.parse(readFileSync(detailFile, 'utf-8'));
  assert.equal(saved.canvasExec.rawCanvas, undefined);
  assert.ok(Array.isArray(saved.canvas.rawCanvas));
  const fetched = count('/api/canvas/history/details');
  assert.equal((await md(['exec', X(2)], h)).code, 0);
  assert.equal(count('/api/canvas/history/details'), fetched, '第二次应当读缓存，不再请求详情');
});

test('md exec <id> --bot 走指定智能体；找不到退出码 4；id 不完整退出码 2', async () => {
  assert.equal((await md(['exec', X(2), '--bot', '147bd600'])).code, 0);
  const missing = await md(['exec', X(5)]);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /找不到执行/);
  assert.equal((await md(['exec', 'e0000002'])).code, 2);
});

test('测试执行：说明没有事件链，不去查列表', async () => {
  const lists = count('/api/canvas/history/list');
  const r = await md(['exec', X(9)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /测试执行/);
  assert.match(r.stdout, /不在执行列表里，没有事件链/);
  assert.equal(count('/api/canvas/history/list'), lists);
});
