// 用打包产物跑。MD_E2E_NODE 指向 Node 18 时，验证的就是用户机器上默认的运行环境。
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBundle } from '../build.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { writeFileSync as writeFile } from 'node:fs';
import { encodeAuthBlob } from './helpers/seed.mjs';
import { PROMPT_FIX, planCodeOf, startBotServer } from './helpers/bot-server.mjs';

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

test('产物全流程：取身份 → 找智能体 → 拉 → 改 → diff → check → 推 → log', async () => {
  const bot = await startBotServer();
  try {
    const home = tempHome();
    const run = (args, input) => runCli(args, { home, bundle, input });
    const blob = encodeAuthBlob({ origin: bot.server.origin, token: 't', user: { id: 'u', name: '胡同学' }, currentOrg: { id: 'org-1', name: '兴趣岛平台' }, orgs: [{ id: 'org-1', name: '兴趣岛平台' }] });
    assert.equal((await run(['auth', 'import', '--stdin'], blob)).code, 0);
    assert.match((await run(['bots', '太极'])).stdout, /太极2\.0重构/);
    assert.equal((await run(['pull', '--bot', '太极2.0重构'])).code, 0);
    const script = join(home, 'fix.mjs');
    writeFile(script, PROMPT_FIX);
    assert.equal((await run(['apply', script])).code, 0);
    assert.match((await run(['diff'])).stdout, /\+ 发热≠发烧。/);
    assert.equal((await run(['check'])).code, 0);
    const dry = await run(['push']);
    assert.equal(dry.code, 0, dry.stderr);
    const done = await run(['push', '--confirm', planCodeOf(dry.stdout)]);
    assert.equal(done.code, 0, done.stderr);
    assert.doesNotMatch(`${dry.stderr}${done.stderr}`, /ExperimentalWarning/);
    assert.match((await run(['log'])).stdout, /~ 回答生成 \[00000002\]/);
  } finally {
    await bot.server.close();
  }
});
