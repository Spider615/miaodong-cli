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
import { seedIdentity } from './helpers/seed.mjs';
import { startExecServer } from './helpers/exec-server.mjs';
import { startTrialServer } from './helpers/trial-server.mjs';
import { startTestCenterServer } from './helpers/testcenter-server.mjs';
import { SAME_EXEC } from './helpers/testcenter-fixtures.mjs';
import { X } from './helpers/exec-fixtures.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ, kbExec, toolCall } from './helpers/kb-fixtures.mjs';

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

test('产物不带源码注释和源码路径（打包会把内部注释原样带进对外发布的文件）', () => {
  const text = readFileSync(bundle, 'utf-8');
  assert.doesNotMatch(text, /\/\/ (src|vendor|apps|packages)\//);
  assert.doesNotMatch(text, /锘崴|xiaoju-new-pc|ddregion/);
});

test('产物能查执行记录（把老懂的执行记录纯函数一起打进去，且不带数据库依赖）', async () => {
  const server = await startExecServer();
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const r = await runCli(['exec', X(2)], { home, bundle });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /整条链最终：发文本/);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  } finally {
    await server.close();
  }
});

test('产物能试跑（把老懂的试跑纯函数一起打进去，且不带数据库依赖）', async () => {
  const { server } = await startTrialServer();
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const r = await runCli(['trial', '回答生成', '--bot', '147bd600', '--from-exec', X(2)], { home, bundle });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /#1 ✅ success/);
  } finally {
    await server.close();
  }
});

test('产物能跑 md test（测试中心接口、换 id、xlsx 一起打进去，且不带数据库依赖）', async () => {
  const { server } = await startTestCenterServer();
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const imported = await runCli(['test', 'import', '回归', '--bot', '179cd443', '--from-execs', SAME_EXEC], { home, bundle });
    assert.equal(imported.code, 0, imported.stderr);
    const sets = await runCli(['test', 'sets', '--bot', '179cd443'], { home, bundle });
    assert.match(sets.stdout, /回归/);
  } finally {
    await server.close();
  }
});

test('产物能导外部用例、批量改用例（Node 18 上跑改动脚本、structuredClone）', async () => {
  const { server } = await startTestCenterServer();
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const file = join(home, 'cases.jsonl');
    writeFile(file, `${JSON.stringify({ name: '退款-01', text: '我想退款', expect: '应说明退款流程' })}\n${JSON.stringify({ name: '事件-01', event: '延时回复', data: { text: '课程怎么退' }, expect: { handover: true } })}\n`);
    const imported = await runCli(['test', 'import', '外部', '--bot', '179cd443', '--from-file', file], { home, bundle });
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /提交 2 · 回读 2/);
    const script = join(home, 'edit.mjs');
    writeFile(script, `export default ({ cases, h }) => { for (const c of h.pick('退款-01')) c.canvasActionOutputAssertions = h.expect({ handover: true }); };`);
    const preview = await runCli(['test', 'edit', '外部', script, '--bot', '179cd443'], { home, bundle });
    assert.equal(preview.code, 0, preview.stderr);
    const code = preview.stdout.match(/计划码：([0-9a-f]{8})/)[1];
    const done = await runCli(['test', 'edit', '外部', script, '--bot', '179cd443', '--confirm', code], { home, bundle });
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /已改 1 条/);
  } finally {
    await server.close();
  }
});

test('产物能跑 md kb（知识库读接口、画布引用、why 的重放一起打进去，且不带数据库依赖）', async () => {
  const server = await startKbServer({ details: { [X(41)]: kbExec(41, '课程可以退吗', [toolCall(KB_FAQ, '课程可以退吗', { threshold: 0.6 })]) } });
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const listed = await runCli(['kb', 'list', '--bot', '147bd600'], { home, bundle });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /⚠️ 未审核 1 条/);
    const why = await runCli(['kb', 'why', X(41), '--expect', '7004'], { home, bundle });
    assert.equal(why.code, 0, why.stderr);
    assert.match(why.stdout, /结论：未审核/);
    assert.doesNotMatch(`${listed.stderr}${why.stderr}`, /ExperimentalWarning/);
    assert.deepEqual(server.unexpected(), []);
  } finally {
    await server.close();
  }
});
