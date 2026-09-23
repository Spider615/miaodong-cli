// 用打包产物跑。MD_E2E_NODE 指向 Node 18 时，验证的就是用户机器上默认的运行环境。
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBundle } from '../build.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';

let bundle;
before(async () => {
  ({ outfile: bundle } = await buildBundle({ outfile: join(tempHome(), 'md.mjs') }));
});

test('产物能跑 --version，带构建号，不打实验特性警告', async () => {
  const r = await runCli(['--version'], { home: tempHome(), bundle });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.trim(), /^md [0-9a-z]+@\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});

test('产物里没有老懂数据库依赖', () => {
  const text = readFileSync(bundle, 'utf-8');
  assert.doesNotMatch(text, /better-sqlite3|drizzle-orm/);
  assert.ok(text.startsWith('#!/usr/bin/env -S node --no-warnings'));
});
