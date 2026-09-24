import test from 'node:test';
import assert from 'node:assert/strict';
import { codeFor, confirmCode, givenCode } from '../src/confirm.mjs';

const op = { kind: 'trial', botId: 'b', nodeId: 'n', times: 2, inputs: { text: '你好', n: 1 }, estimate: 0.6, external: [], day: '2026-9-25' };

test('confirmCode：8 位；同一笔操作同一个码（键的顺序不影响）；次数、输入、预估、节点、插件、日期任何一样变了码就变', () => {
  assert.match(confirmCode(op), /^[0-9a-f]{8}$/);
  assert.equal(confirmCode({ ...op, inputs: { n: 1, text: '你好' } }), confirmCode(op));
  for (const patch of [{ times: 3 }, { inputs: { text: '您好', n: 1 } }, { estimate: 0.61 }, { estimate: null }, { nodeId: 'm' }, { external: ['写多维表'] }, { day: '2026-9-26' }]) {
    assert.notEqual(confirmCode({ ...op, ...patch }), confirmCode(op), JSON.stringify(patch));
  }
});

test('givenCode：没给是 null；只写 --confirm 没给值是空串（一定对不上）；去掉首尾空白；只能给一次', () => {
  assert.equal(givenCode({}), null);
  assert.equal(givenCode({ confirm: true }), '');
  assert.equal(givenCode({ confirm: ' abc12345 ' }), 'abc12345');
  assert.throws(() => givenCode({ confirm: ['a', 'b'] }), (e) => e.exitCode === 2);
});

test('codeFor：同一笔操作每确认过一次，码就换一个——用过的码对不上、认得出是用过的；同样的操作再问一次能拿到新码', () => {
  const first = codeFor(op, []);
  assert.match(first.code, /^[0-9a-f]{8}$/);
  assert.equal(first.previous, null);
  const used = [{ id: 'x', opKey: first.opKey, code: first.code }];
  const second = codeFor(op, used);
  assert.equal(second.opKey, first.opKey);
  assert.notEqual(second.code, first.code);
  assert.equal(second.previous, first.code);
  assert.equal(codeFor({ ...op, times: 3 }, used).previous, null);
});
