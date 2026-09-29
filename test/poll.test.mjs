import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envPollMs } from '../src/poll.mjs';

test('轮询间隔的环境变量（测试里用来调快）：只能调快、不能调慢，认不出的值用默认', () => {
  const at = (value) => {
    process.env.MD_SAMPLE_POLL_MS = value;
    try {
      return envPollMs('MD_SAMPLE_POLL_MS', 2000);
    } finally {
      delete process.env.MD_SAMPLE_POLL_MS;
    }
  };
  assert.equal(envPollMs('MD_SAMPLE_POLL_MS', 2000), 2000);
  assert.equal(at('5'), 5);
  assert.equal(at('abc'), 2000);
  assert.equal(at('0'), 2000);
  assert.equal(at('-3'), 2000);
  // 比默认还慢的用默认：超过 2^31 毫秒的 setTimeout 会立刻触发，一个很大的值反而变成不停地发请求
  assert.equal(at('99999999999'), 2000);
  assert.equal(at('0.2'), 1);
});

test('读轮询间隔环境变量的只有 src/poll.mjs：各处都走同一套上下限', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.mjs') ? [join(dir, d.name)] : []));
  const readers = files(SRC).filter((file) => /process\.env\.MD_\w*POLL/.test(readFileSync(file, 'utf-8'))).map((file) => relative(SRC, file));
  assert.deepEqual(readers, []);
});
