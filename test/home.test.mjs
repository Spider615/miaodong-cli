import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNewDir } from '../src/home.mjs';

test('ensureNewDir：目录已经有了就加 -2、-3，不和别的进程共用一个目录（审查 M7：同一秒对同一节点的两次试跑会互相覆盖结果）', () => {
  const root = mkdtempSync(join(tmpdir(), 'md-home-'));
  const base = join(root, '20260925-003308-a4c8595f');
  assert.equal(ensureNewDir(base), base);
  assert.equal(ensureNewDir(base), `${base}-2`);
  assert.equal(ensureNewDir(base), `${base}-3`);
  assert.ok(existsSync(`${base}-3`));
});
