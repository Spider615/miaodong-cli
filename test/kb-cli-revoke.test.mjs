// md kb revoke（spec 3b §5）：删掉这次建的，把这次删的从备份原样重建（id 会变），读回核对；先重建后删；导入后被人改过的要列出来；撤回也能续做
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { faq, writePackage } from './helpers/kb-import-fixtures.mjs';
import { goodPackage, importServerOptions } from './helpers/kb-import-data.mjs';

function homeFor(server) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
async function withServer(options, fn) {
  const server = await startKbServer(importServerOptions(options));
  try {
    await fn(server, homeFor(server));
  } finally {
    await server.close();
  }
}
const codeOf = (r) => r.stdout.match(/计划码：([0-9a-f]{8})/)?.[1];
const recordOf = (r) => r.stdout.match(/导入记录：(\S+)（(\S+)）/);
async function importPackage(spec, h, env) {
  const dir = writePackage(spec);
  const p = await runCli(['kb', 'import', dir], { home: h });
  assert.equal(p.code, 0, p.stderr);
  return runCli(['kb', 'import', dir, '--confirm', codeOf(p)], { home: h, env });
}
const at = (server, pred) => server.requests.findIndex(pred);

test('md kb revoke：预演只读；确认后先从备份重建删掉的（审核状态照原样、摘要写回），再删这次建的；读回核对', async () => {
  await withServer({}, async (server, h) => {
    const r = await importPackage(goodPackage(), h);
    assert.equal(r.code, 0, r.stderr);
    const [, importId, recDir] = recordOf(r);
    const writesBefore = server.writes().length;
    const p = await runCli(['kb', 'revoke', importId], { home: h });
    assert.equal(p.code, 0, p.stderr);
    assert.equal(p.stdout.split('\n')[0], `测试区 / 兴趣岛平台 / 售后 FAQ (aaaa0001) · 撤回导入 ${importId}`);
    assert.match(p.stdout, /这次导入：已完成/);
    assert.match(p.stdout, /要删（这次建的，还在库里的）：FAQ 1 条 · 文件 1 个/);
    assert.match(p.stdout, /要重建（这次删的，从备份）：FAQ 1 条 · 文件 1 个（2 段）/);
    assert.match(p.stdout, /导入后被人改过的：没有/);
    assert.match(p.stdout, new RegExp(`原文件传不回秒懂：重建的是同名手工文件（段落一样），原文件在备份里：${recDir.replace(/[/\\.]/g, '\\$&')}/backup/docs`));
    assert.equal(server.writes().length, writesBefore);

    const firstCall = server.requests.length;
    const done = await runCli(['kb', 'revoke', importId, '--confirm', codeOf(p)], { home: h });
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /撤回完成/);
    assert.equal(server.state.faqs.some((f) => f.question === '课程怎么退款呀'), false);
    assert.equal(server.state.files.some((f) => f.name === '新价格表'), false);
    const rebuilt = server.state.faqs.filter((f) => f.question === '退款多久到账');
    assert.equal(rebuilt.length, 1);
    assert.notEqual(rebuilt[0].id, 7002);
    assert.deepEqual([rebuilt[0].answer, rebuilt[0].isReviewed], ['审核通过后三个工作日内原路退回。', true]);
    const doc = server.state.files.find((f) => f.name === '旧价格表');
    assert.equal(doc.abstract, '旧价格表的摘要');
    assert.deepEqual(server.state.paragraphs.filter((x) => x.fileId === doc.id).map((x) => [x.content, x.status]), [['瑜伽月卡 299 元', 'ready'], ['瑜伽年卡 1999 元', 'ready']]);
    // 先重建后删：重建的 batch-create 在删这次建的 batch-delete 之前
    const rebuildAt = at(server, (q, i) => i >= firstCall && q.path === '/api/qa/batch-create');
    const deleteAt = at(server, (q, i) => i >= firstCall && q.path === '/api/qa/batch-delete');
    assert.ok(rebuildAt >= firstCall && rebuildAt < deleteAt);
    const state = JSON.parse(readFileSync(join(recDir, 'state.json'), 'utf-8'));
    assert.equal(state.status, 'revoked');
    assert.deepEqual(state.revoke.faqIds, { 7002: rebuilt[0].id });

    const again = await runCli(['kb', 'revoke', importId], { home: h });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /这次导入已经撤回了/);
    const resume = await runCli(['kb', 'import', '--resume', importId], { home: h });
    assert.equal(resume.code, 1);
    assert.match(resume.stderr, /已经撤回/);
    assert.deepEqual(server.unexpected(), []);
  });
});

test('md kb revoke：导入做到一半（停在建 FAQ）——只删已经建的，没删过旧的就不重建', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [3] } }, async (server, h) => {
    const spec = { ...goodPackage(), faqs: Array.from({ length: 60 }, (_, i) => faq(`f${i + 1}`, `批量问题${i + 1}`)) };
    const r = await importPackage(spec, h);
    assert.equal(r.code, 1);
    const importId = recordOf(r)[1];
    assert.equal(server.state.faqs.filter((f) => f.question.startsWith('批量问题')).length, 51);
    const p = await runCli(['kb', 'revoke', importId], { home: h });
    assert.match(p.stdout, /这次导入：停在「建 FAQ」/);
    // 试写建了 1 条 FAQ 和新文件的第 1 段，第 2 批建了 50 条：还没记进状态的也要对账找回来一起删；只写了一段的文件不算被人改过
    assert.match(p.stdout, /要删（这次建的，还在库里的）：FAQ 51 条 · 文件 1 个/);
    assert.match(p.stdout, /要重建（这次删的，从备份）：没有/);
    assert.match(p.stdout, /导入后被人改过的：没有/);
    const done = await runCli(['kb', 'revoke', importId, '--confirm', codeOf(p)], { home: h });
    assert.equal(done.code, 0, done.stderr);
    assert.equal(server.state.faqs.some((f) => f.question.startsWith('批量问题')), false);
    assert.equal(server.state.files.some((f) => f.name === '新价格表'), false);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), true);
  });
});

test('md kb revoke：导入后被人改过的条目要列出来（撤回会连改动一起删掉），计划码绑定它们', async () => {
  await withServer({}, async (server, h) => {
    const r = await importPackage(goodPackage(), h);
    const importId = recordOf(r)[1];
    server.state.faqs.find((f) => f.question === '课程怎么退款呀').answer = '运营改过的答案';
    const p = await runCli(['kb', 'revoke', importId], { home: h });
    assert.match(p.stdout, /导入后被人改过的（撤回会连改动一起删掉）：FAQ「课程怎么退款呀」/);
    const done = await runCli(['kb', 'revoke', importId, '--confirm', codeOf(p)], { home: h });
    assert.equal(done.code, 0, done.stderr);
    assert.equal(server.state.faqs.some((f) => f.question === '课程怎么退款呀'), false);
  });
});

test('md kb revoke：撤回中途断了——再运行一次接着做，不会重复重建', async () => {
  // 导入时删旧文件是第 1 次调用；撤回时删这次建的文件是第 2 次
  await withServer({ failOn: { 'POST /api/knowledge-base/file/delete': [2] } }, async (server, h) => {
    const r = await importPackage(goodPackage(), h);
    assert.equal(r.code, 0, r.stderr);
    const importId = recordOf(r)[1];
    const p = await runCli(['kb', 'revoke', importId], { home: h });
    const stop = await runCli(['kb', 'revoke', importId, '--confirm', codeOf(p)], { home: h });
    assert.equal(stop.code, 1);
    assert.match(stop.stderr, /停在「删掉这次建的」/);
    const p2 = await runCli(['kb', 'revoke', importId], { home: h });
    assert.match(p2.stdout, /撤回停在「删掉这次建的」/);
    const done = await runCli(['kb', 'revoke', importId, '--confirm', codeOf(p2)], { home: h });
    assert.equal(done.code, 0, done.stderr);
    assert.equal(server.state.faqs.filter((f) => f.question === '退款多久到账').length, 1);
    assert.equal(server.state.files.filter((f) => f.name === '旧价格表').length, 1);
    assert.equal(server.state.files.some((f) => f.name === '新价格表'), false);
  });
});

test('md kb revoke：删旧的重建了同一个问题——撤回后只剩旧答案的那一条', async () => {
  await withServer({}, async (server, h) => {
    const spec = { faqs: [faq('f1', '退款多久到账', '新答案：两个工作日到账。')], deletes: [{ type: 'faq', id: 7002, question: '退款多久到账' }] };
    const r = await importPackage(spec, h);
    assert.equal(r.code, 0, r.stderr);
    const importId = recordOf(r)[1];
    const p = await runCli(['kb', 'revoke', importId], { home: h });
    const done = await runCli(['kb', 'revoke', importId, '--confirm', codeOf(p)], { home: h });
    assert.equal(done.code, 0, done.stderr);
    const rows = server.state.faqs.filter((f) => f.question === '退款多久到账');
    assert.deepEqual(rows.map((f) => [f.answer, f.isReviewed]), [['审核通过后三个工作日内原路退回。', true]]);
  });
});

test('md kb revoke：删旧的时请求生效了、回复丢了——删之后一列认得出是这次删的（导入照样做完），撤回照样把它重建回来', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-delete': [{ n: 1, applied: true }] } }, async (server, h) => {
    const r = await importPackage(goodPackage(), h);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), false);
    const importId = recordOf(r)[1];
    assert.deepEqual(JSON.parse(readFileSync(join(recordOf(r)[2], 'state.json'), 'utf-8')).deleted, { faq: [7002], doc: [601] });
    const p = await runCli(['kb', 'revoke', importId], { home: h });
    assert.match(p.stdout, /要重建（这次删的，从备份）：FAQ 1 条/);
    const done = await runCli(['kb', 'revoke', importId, '--confirm', codeOf(p)], { home: h });
    assert.equal(done.code, 0, done.stderr);
    assert.equal(server.state.faqs.filter((f) => f.question === '退款多久到账').length, 1);
    assert.equal(server.state.files.filter((f) => f.name === '旧价格表').length, 1);
    assert.equal(server.state.files.some((f) => f.name === '新价格表'), false);
  });
});

test('md kb imports：列出本机的导入记录——区、库、增删条数、状态（已完成、停在哪一步、已撤回）', async () => {
  await withServer({}, async (server, h) => {
    const empty = await runCli(['kb', 'imports'], { home: h });
    assert.equal(empty.code, 0, empty.stderr);
    assert.match(empty.stdout, /本机还没有导入记录/);
    const r = await importPackage(goodPackage(), h);
    const importId = recordOf(r)[1];
    const listed = await runCli(['kb', 'imports'], { home: h });
    assert.match(listed.stdout, new RegExp(`${importId}  测试区 / 兴趣岛平台 / 售后 FAQ \\(aaaa0001\\)  加 FAQ 1 · 文件 1；删 FAQ 1 · 文件 1  已完成`));
    const p = await runCli(['kb', 'revoke', importId], { home: h });
    await runCli(['kb', 'revoke', importId, '--confirm', codeOf(p)], { home: h });
    const after = await runCli(['kb', 'imports'], { home: h });
    assert.match(after.stdout, new RegExp(`${importId}  .*  已撤回`));
  });
});
