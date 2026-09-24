import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeOnce } from '../src/trial-run.mjs';
import { startTrialServer } from './helpers/trial-server.mjs';
import { U } from './helpers/fixtures.mjs';

let fake;
before(async () => { fake = await startTrialServer(); });
after(() => fake.server.close());
const identity = () => ({ key: 'k1', label: '测试区', origin: fake.server.origin, token: 't' });
const NODE = { id: U(2), name: '回答生成', type: 'llm-completion', category: 'calculation' };
const job = () => ({ identity: identity(), orgId: 'org-1', canvasId: 'main-1', node: NODE, inputs: { text: '你好' } });
const noWait = { sleep: async () => {} };
const reset = (patch = {}) => { Object.assign(fake.state, { posts: [], polls: new Map(), startStatus: 201, runningPolls: 1, pollStatus: 200, cost: 0.0123, ...patch }); };

test('POST 一次，查到跑完为止；结果里有输出、推理、花费', async () => {
  reset();
  const { execId, run, timedOut } = await runNodeOnce(job(), noWait);
  assert.equal(execId, 'ne-1');
  assert.equal(timedOut, false);
  assert.equal(fake.state.posts.length, 1);
  assert.deepEqual(fake.state.posts[0], { canvasId: 'main-1', nodeId: U(2), inputs: { inputData: { text: '你好' } } });
  assert.equal(fake.state.polls.get('ne-1'), 2);
  assert.equal(run.nodeResults[0].output.message, '回复：你好');
  assert.equal(run.cost.cny, 0.0123);
});

test('POST 5xx：报「有没有启动不确定」，绝不重发', async () => {
  reset({ startStatus: 502 });
  await assert.rejects(runNodeOnce(job(), noWait), (e) => e.code === 'trial_start_unknown' && /不要重试/.test(e.hint));
  assert.equal(fake.state.posts.length, 1);
});

test('POST 4xx：明确没启动', async () => {
  reset({ startStatus: 400 });
  await assert.rejects(runNodeOnce(job(), noWait), (e) => e.code === 'trial_not_started');
});

test('查结果出错会再查，连续 3 次才放弃，并带上 execId', async () => {
  reset({ pollStatus: 500 });
  await assert.rejects(runNodeOnce(job(), noWait), (e) => e.code === 'trial_poll_failed' && /ne-1/.test(e.message));
  assert.equal(fake.state.posts.length, 1);
});

test('超过时限还没跑完：带回 timedOut，不再等', async () => {
  reset({ runningPolls: 1000 });
  let t = 0;
  const r = await runNodeOnce(job(), { sleep: async () => { t += 60_000; }, now: () => t, timeoutMs: 300_000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.run.status, 'running');
});

test('企业已到期（HTTP 403）是明确被拒：原样报企业到期，不说「不确定有没有启动」', async () => {
  reset();
  const original = fake.server.routes['POST /api/canvas/node/exec'];
  fake.server.routes['POST /api/canvas/node/exec'] = () => ({ status: 403, body: { code: -7, reason: 'EXPIRED', message: '企业已到期' } });
  try {
    await assert.rejects(runNodeOnce(job(), noWait), (e) => e.code === 'org_expired');
  } finally {
    fake.server.routes['POST /api/canvas/node/exec'] = original;
  }
});

test('5xx 的正文里恰好带着「HTTP 404」：按真实状态码算，还是「不确定有没有启动」，不能判成没启动（审查 I5）', async () => {
  reset();
  const original = fake.server.routes['POST /api/canvas/node/exec'];
  fake.server.routes['POST /api/canvas/node/exec'] = ({ body }) => {
    fake.state.posts.push(body);
    return { status: 502, body: { message: 'upstream node-exec returned HTTP 404 Not Found' } };
  };
  try {
    await assert.rejects(runNodeOnce(job(), noWait), (e) => e.code === 'trial_start_unknown' && /不要重试/.test(e.hint));
  } finally {
    fake.server.routes['POST /api/canvas/node/exec'] = original;
  }
});

test('还没发请求就失败（比如草稿没有 canvasId）：明确没启动，不说「不确定、不要重试」', async () => {
  reset();
  await assert.rejects(runNodeOnce({ ...job(), canvasId: '' }, noWait), (e) => e.code === 'trial_not_started');
  assert.equal(fake.state.posts.length, 0);
});
