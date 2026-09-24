import test from 'node:test';
import assert from 'node:assert/strict';
import { intArg, listArg, parseArgs, strArg } from '../src/args.mjs';

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
