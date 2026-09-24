import test from 'node:test';
import assert from 'node:assert/strict';
import { boolArg, intArg, listArg, parseArgs, strArg } from '../src/args.mjs';

test('同一个参数给多次：收成数组，listArg 取全部', () => {
  const args = parseArgs(['--input', 'a=1', '--input', 'b=2', '--input=c=3']);
  assert.deepEqual(args.input, ['a=1', 'b=2', 'c=3']);
  assert.deepEqual(listArg(args, 'input'), ['a=1', 'b=2', 'c=3']);
  assert.deepEqual(listArg(parseArgs(['--input', 'x=1']), 'input'), ['x=1']);
  assert.deepEqual(listArg(parseArgs([]), 'input'), []);
});

test('只该给一次的参数给了多次：报用法错误，不悄悄取最后一个', () => {
  const args = parseArgs(['--bot', '甲', '--bot', '乙', '--limit', '1', '--limit', '2']);
  assert.throws(() => strArg(args, 'bot'), (e) => e.exitCode === 2 && /只能给一次/.test(e.message));
  assert.throws(() => intArg(args, 'limit', 10), (e) => e.exitCode === 2 && /只能给一次/.test(e.message));
});

test('listArg：漏了值报用法错误', () => {
  assert.throws(() => listArg(parseArgs(['--input', '--times', '2']), 'input'), (e) => e.exitCode === 2);
});

test('boolArg：开关给了两次报用法错误，不按真值算（--replace-draft false 给两次曾被当成开，审查 I4）；带了奇怪的值也报错', () => {
  assert.equal(boolArg(parseArgs([]), 'json'), false);
  assert.equal(boolArg(parseArgs(['--json']), 'json'), true);
  assert.equal(boolArg(parseArgs(['--json', 'false']), 'json'), false);
  assert.equal(boolArg(parseArgs(['--json=yes']), 'json'), true);
  assert.throws(() => boolArg(parseArgs(['--replace-draft', 'false', '--replace-draft', 'false']), 'replace-draft'), (e) => e.exitCode === 2 && /只能给一次/.test(e.message));
  assert.throws(() => boolArg(parseArgs(['--json', 'abc']), 'json'), (e) => e.exitCode === 2 && /开关/.test(e.message));
});
