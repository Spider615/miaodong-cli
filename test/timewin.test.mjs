import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseTime, timeWindow } from '../src/timewin.mjs';

const span = (w) => [w.start, w.end];

test('parseDuration：分钟、小时、天', () => {
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('7d'), 604_800_000);
  assert.throws(() => parseDuration('1w'), (e) => e.exitCode === 2);
  assert.throws(() => parseDuration('0h'), (e) => e.exitCode === 2);
});

test('parseTime：日期和时分按本地时间理解，也认 ISO', () => {
  assert.equal(parseTime('2026-09-23 10:00'), new Date(2026, 8, 23, 10, 0, 0).getTime());
  assert.equal(parseTime('2026-09-23T10:00:30'), new Date(2026, 8, 23, 10, 0, 30).getTime());
  assert.equal(parseTime('2026-09-23'), new Date(2026, 8, 23).getTime());
  assert.equal(parseTime('2026-09-23T02:00:00.000Z'), Date.UTC(2026, 8, 23, 2));
  assert.throws(() => parseTime('昨天'), (e) => e.exitCode === 2);
});

test('timeWindow：默认最近 24 小时；--since / --from / --to；互斥与先后校验', () => {
  const now = new Date(2026, 8, 24, 12, 0).getTime();
  assert.deepEqual(span(timeWindow({}, { now })), [now - 86_400_000, now]);
  assert.deepEqual(span(timeWindow({ since: '6h' }, { now })), [now - 21_600_000, now]);
  const w = timeWindow({ from: '2026-09-23 10:00', to: '2026-09-23 12:00' }, { now });
  assert.deepEqual(span(w), [new Date(2026, 8, 23, 10).getTime(), new Date(2026, 8, 23, 12).getTime()]);
  assert.equal(w.label, '2026-09-23 10:00 ~ 2026-09-23 12:00');
  assert.throws(() => timeWindow({ since: '1h', from: '2026-09-23' }, { now }), (e) => e.exitCode === 2);
  assert.throws(() => timeWindow({ from: '2026-09-24 13:00' }, { now }), (e) => e.exitCode === 2);
});
