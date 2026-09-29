import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOLEAN_FLAGS, DUAL_FLAGS, boolArg, intArg, listArg, parseArgs, strArg } from '../src/args.mjs';

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

test('带值参数的值恰好是 0 / no / n / off / false：原样当字符串，不当成开关「关」（--keyword 0 曾被当成没给）', () => {
  assert.equal(strArg(parseArgs(['--keyword', '0']), 'keyword'), '0');
  assert.equal(strArg(parseArgs(['--find', 'no']), 'find'), 'no');
  assert.equal(strArg(parseArgs(['--text=off']), 'text'), 'off');
  assert.equal(strArg(parseArgs(['--per-command', '0']), 'per-command'), '0');
  assert.deepEqual(listArg(parseArgs(['--input', 'n', '--input', 'x=1']), 'input'), ['n', 'x=1']);
  assert.equal(strArg(parseArgs(['--no-keyword']), 'keyword'), undefined);
});

test('纯开关后面跟的不是真假词：不吃掉它（md exec --vs-draft <id> 的 id 曾被当成开关的值吞掉）', () => {
  const a = parseArgs(['--vs-draft', 'abc123', '--down']);
  assert.deepEqual(a._, ['abc123']);
  assert.equal(boolArg(a, 'vs-draft'), true);
  assert.equal(boolArg(a, 'down'), true);
  const b = parseArgs(['--up', 'false', 'x', '--base=no']);
  assert.equal(boolArg(b, 'up'), false);
  assert.equal(boolArg(b, 'base'), false);
  assert.deepEqual(b._, ['x']);
});

test('intArg：超过上限报用法错误，不悄悄截成上限；0 也报错，不当成没给', () => {
  assert.throws(() => intArg(parseArgs(['--limit', '1500']), 'limit', 20, 1000), (e) => e.exitCode === 2 && /最多 1000/.test(e.message));
  assert.equal(intArg(parseArgs(['--limit', '1000']), 'limit', 20, 1000), 1000);
  assert.throws(() => intArg(parseArgs(['--limit', '0']), 'limit', 20), (e) => e.exitCode === 2 && /正整数/.test(e.message));
});

// 参数在解析时就要知道是不是开关：开关不带值、不吃后面的词；别的参数的值原样是字符串。登记表漏了、登错了都要红
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const srcFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.mjs') ? [join(dir, d.name)] : []));
const sources = srcFiles(SRC).map((file) => ({ file: relative(SRC, file), text: readFileSync(file, 'utf-8') }));
const keysOf = (pattern) => new Set(sources.flatMap(({ text }) => [...text.matchAll(pattern)].map((m) => m[1])));
const asBool = keysOf(/\bboolArg\(args, '([a-z-]+)'\)/g);
const asValue = keysOf(/\b(?:strArg|intArg|listArg|moneyArg)\(args, '([a-z-]+)'/g);

test('开关登记表和代码里的读法一致：按开关读的都登记了，登记了的没有哪里当带值参数读', () => {
  for (const key of asBool) if (!DUAL_FLAGS.has(key)) assert.ok(BOOLEAN_FLAGS.has(key), `--${key} 按开关读，却没登记进 BOOLEAN_FLAGS：md x --${key} <位置参数> 会把位置参数吞成它的值`);
  for (const key of BOOLEAN_FLAGS) assert.ok(asBool.has(key), `--${key} 登记成开关，代码里却没有按开关读`);
  for (const key of BOOLEAN_FLAGS) assert.ok(!asValue.has(key), `--${key} 登记成开关，但有地方按带值参数读`);
  assert.deepEqual([...asBool].filter((key) => asValue.has(key)).sort(), [...DUAL_FLAGS].sort(), '既当开关又带值的参数只能是登记过的那几个');
});

test('读命令行参数一律走 boolArg / strArg / intArg / listArg / givenCode；直接读 args.x 只许判「给没给」', () => {
  const readers = sources.filter(({ file, text }) => file !== 'args.mjs' && file !== 'confirm.mjs' && /from '\.\.?\/args\.mjs'/.test(text));
  assert.ok(readers.length > 20);
  for (const { file, text } of readers) {
    for (const m of text.matchAll(/\bargs(?:\.([a-zA-Z_]\w*)|\[([^\]]+)\])(.{0,16})/g)) {
      if (m[1] === '_' || m[1] === 'mjs') continue;
      assert.match(m[3], /^ [!=]== undefined/, `${file}: 直接读了 args${m[1] ? `.${m[1]}` : `[${m[2]}]`}${m[3]}`);
    }
  }
});
