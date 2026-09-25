// 用户 09-25 定的规矩：查 case 时知识库只读，只有处理客户资料才写库（spec 3b §1）。
// 靠结构保证：查 case 用的命令，顺着 import 往下找，一个都不能碰到写接口 src/kb-write.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REPO } from './helpers/run-cli.mjs';

const WRITE = resolve(REPO, 'src', 'kb-write.mjs');
const READ_ONLY = ['kb-list.mjs', 'kb-pull.mjs', 'kb-find.mjs', 'kb-why.mjs', 'exec.mjs', 'trial.mjs'].map((f) => resolve(REPO, 'src', 'commands', f));

function reach(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = readFileSync(file, 'utf-8');
  for (const m of text.matchAll(/(?:import|export)[^'"]*from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const next = resolve(dirname(file), m[1]);
    if (existsSync(next)) reach(next, seen);
  }
  return seen;
}

test('查 case 的命令（kb list/pull/find/why、exec、trial）顺着 import 找不到知识库写接口', () => {
  for (const cmd of READ_ONLY) {
    assert.ok(existsSync(cmd), cmd);
    assert.equal(reach(cmd).has(WRITE), false, `${cmd.replace(`${REPO}/`, '')} 碰到了 src/kb-write.mjs`);
  }
});

test('写知识库的只有 md kb import 和 md kb revoke', () => {
  const writers = ['kb-import.mjs', 'kb-revoke.mjs'].map((f) => resolve(REPO, 'src', 'commands', f));
  for (const w of writers) assert.equal(reach(w).has(WRITE), true);
  assert.ok(existsSync(join(REPO, 'src', 'kb-write.mjs')));
});
