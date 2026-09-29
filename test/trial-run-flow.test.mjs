import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runFlowOnce, sessionExecsAfter } from '../src/trial-run.mjs';
import { FX, startFlowServer } from './helpers/flow-server.mjs';

let fake;
before(async () => { fake = await startFlowServer(); });
after(() => fake.server.close());
const identity = () => ({ key: 'k1', label: '测试区', origin: fake.server.origin, token: 't' });
const body = (patch = {}) => ({ canvasId: 'main-1', sessionId: 'sess-0001-aaaa', triggerType: 'receive-text-message', receiveTextMessage: { text: '我想退款', customAttrs: [] }, ...patch });
const job = (patch) => ({ identity: identity(), orgId: 'org-1', body: body(patch) });
const noWait = { sleep: async () => {} };

test('runFlowOnce：POST 一次，查到终态；「有序发送」还在 sending 时接着等', async () => {
  fake.reset({ runningPolls: 1, deliveringPolls: 2 });
  const { execId, result, timedOut } = await runFlowOnce(job(), noWait);
  assert.equal(execId, FX(1));
  assert.equal(timedOut, false);
  assert.deepEqual(fake.state.posts, [body()]);
  assert.equal(fake.state.polls.get(FX(1)), 4);
  assert.equal(result.canvasExec.status, 'success');
  assert.equal(result.nodeResults.length, 5);
});

test('runFlowOnce：POST 5xx 报「有没有启动不确定」、绝不重发；4xx 明确没启动', async () => {
  fake.reset({ startStatus: 502 });
  await assert.rejects(runFlowOnce(job(), noWait), (e) => e.code === 'trial_start_unknown' && /不要重试/.test(e.hint));
  assert.equal(fake.state.posts.length, 1);
  fake.reset({ startStatus: 400 });
  await assert.rejects(runFlowOnce(job(), noWait), (e) => e.code === 'trial_not_started');
});

test('runFlowOnce：回了 code 0 却没有 execId 算「不确定」；没有 canvasId 不发请求', async () => {
  fake.reset();
  const original = fake.server.routes['POST /api/canvas/exec'];
  fake.server.routes['POST /api/canvas/exec'] = ({ body: b }) => { fake.state.posts.push(b); return { status: 201, body: { code: 0, data: {} } }; };
  try {
    await assert.rejects(runFlowOnce(job(), noWait), (e) => e.code === 'trial_start_unknown');
  } finally {
    fake.server.routes['POST /api/canvas/exec'] = original;
  }
  fake.reset();
  await assert.rejects(runFlowOnce(job({ canvasId: '' }), noWait), (e) => e.code === 'trial_not_started');
  assert.equal(fake.state.posts.length, 0);
});

test('runFlowOnce：查结果连续出错 3 次放弃并带上 execId；超时带回 timedOut', async () => {
  fake.reset({ pollStatus: 500 });
  await assert.rejects(runFlowOnce(job(), noWait), (e) => e.code === 'trial_poll_failed' && e.message.includes(FX(1)));
  fake.reset({ runningPolls: 1000 });
  let t = 0;
  const r = await runFlowOnce(job(), { sleep: async () => { t += 60_000; }, now: () => t, timeoutMs: 300_000 });
  assert.equal(r.timedOut, true);
});

test('sessionExecsAfter：只要同会话、这次之后的执行（不含这次），按时间排；参数照 09-29 实测', async () => {
  fake.reset();
  await runFlowOnce(job(), noWait);
  fake.state.later = [
    { execId: 'later-2', createdAt: new Date(Date.now() + 120_000).toISOString(), status: 'success', outputActions: [] },
    { execId: 'later-1', createdAt: new Date(Date.now() + 60_000).toISOString(), status: 'success', outputActions: [] },
    { execId: 'early-0', createdAt: new Date(Date.now() - 3_600_000).toISOString(), status: 'success', outputActions: [] },
  ];
  const rows = await sessionExecsAfter(identity(), 'org-1', { botId: 'b', sessionId: 'sess-0001-aaaa', execId: FX(1), sinceMs: Date.parse(fake.state.createdAt) });
  assert.deepEqual(rows.map((r) => r.execId), ['later-1', 'later-2']);
  const req = fake.server.requests.filter((r) => r.path === '/api/canvas/history/list-by-session').at(-1);
  assert.deepEqual([req.query.direction, req.query.pageSize, req.query.sessionId, req.query.botId], ['middle', '20', 'sess-0001-aaaa', 'b']);
  assert.match(req.query.timestamp, /^\d+$/);
});
