import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MD_HOME = mkdtempSync(join(tmpdir(), 'md-spend-'));
const { DEFAULT_LIMITS, amountOf, loadLimits, readSpends, recordSpend, saveLimits, spendDecision, spentOn, updateSpend, withSpendLock } = await import('../src/spend.mjs');

test('门槛：没配过用默认 ¥2 / ¥10；配过的读配置；坏值回退默认', () => {
  assert.deepEqual(loadLimits(), DEFAULT_LIMITS);
  saveLimits({ perCommand: 5, perDay: 30 });
  assert.deepEqual(loadLimits(), { perCommand: 5, perDay: 30 });
  writeFileSync(join(process.env.MD_HOME, 'config.json'), JSON.stringify({ spend: { perCommand: -1, perDay: 'x' } }));
  assert.deepEqual(loadLimits(), DEFAULT_LIMITS);
});

test('账本：先记预估，跑完追加实际；读的时候按 id 合并', () => {
  const id = recordSpend({ kind: 'trial', botId: 'b1', what: '回答生成', estimate: 0.03 });
  updateSpend(id, { actual: 0.031 });
  const row = readSpends().find((r) => r.id === id);
  assert.equal(row.estimate, 0.03);
  assert.equal(row.actual, 0.031);
  assert.equal(row.what, '回答生成');
});

test('今天已花：有实际用实际，没有用预估；不算昨天的', () => {
  const now = new Date(2026, 8, 24, 12).getTime();
  const rows = [
    { id: 'a', at: new Date(2026, 8, 24, 9).toISOString(), estimate: 1, actual: 0.5 },
    { id: 'b', at: new Date(2026, 8, 24, 10).toISOString(), estimate: 0.3, actual: null },
    { id: 'c', at: new Date(2026, 8, 23, 23).toISOString(), estimate: 5, actual: 5 },
  ];
  assert.equal(spentOn(rows, now), 0.8);
});

test('要不要用户确认：超单次、超每日、估不出、今天已到上限、会调外部系统', () => {
  const limits = { perCommand: 2, perDay: 10 };
  assert.deepEqual(spendDecision({ estimate: 1 }, { limits, today: 0 }), { needApproval: false, reasons: [] });
  assert.match(spendDecision({ estimate: 3 }, { limits, today: 0 }).reasons.join(), /超过单次门槛 ¥2/);
  assert.match(spendDecision({ estimate: 1 }, { limits, today: 9.5 }).reasons.join(), /超过每日上限 ¥10/);
  assert.match(spendDecision({ estimate: null }, { limits, today: 0 }).reasons.join(), /估不出花费/);
  assert.match(spendDecision({ estimate: null }, { limits, today: 10 }).reasons.join(), /今天已到每日上限/);
  assert.match(spendDecision({ estimate: 0.01, externalCalls: ['兴趣岛用户详情'] }, { limits, today: 0 }).reasons.join(), /会真的调用外部系统：兴趣岛用户详情/);
});

test('amountOf：跑完的 = 实际 + 花费未知那几次的保守估计；还没跑完的按预留（估不出时也有预留）', () => {
  assert.equal(amountOf({ actual: 0.1, assumed: 0.7 }), 0.1 + 0.7);
  assert.equal(amountOf({ actual: 0.1 }), 0.1);
  assert.equal(amountOf({ actual: null, reserve: 0.7, estimate: null }), 0.7);
  assert.equal(amountOf({ actual: null, estimate: 0.3 }), 0.3);
});

test('withSpendLock：同时来的两个调用一个一个进（审查 I3）；进程被杀留下的旧锁会被清掉', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = withSpendLock(async () => { order.push('a进'); await gate; order.push('a出'); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = withSpendLock(async () => { order.push('b进'); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(order, ['a进']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a进', 'a出', 'b进']);
  const lock = join(process.env.MD_HOME, 'spend.lock');
  writeFileSync(lock, '99999');
  utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  assert.equal(await withSpendLock(async () => 'ok'), 'ok');
});
