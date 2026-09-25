// md kb import 的执行和续跑（spec 3b §4.2、§4.3）：先备份后写；试写一条读回核对；先加后删；中途断了续跑补完、不重复创建
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ } from './helpers/kb-fixtures.mjs';
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
const at = (server, pred) => server.requests.findIndex(pred);
async function preview(args, h, env) {
  const r = await runCli(args, { home: h, env });
  assert.equal(r.code, 0, r.stderr);
  return codeOf(r);
}

test('md kb import 执行：备份在第一个写请求之前；试写一条；建 FAQ、文件和段落；审核后才生效；等向量化；最后才删旧的', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage(goodPackage());
    const code = await preview(['kb', 'import', dir], h);
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 0, r.stderr);
    for (const step of ['快照', '备份要删的', '试写一条', '建 FAQ', '建文件和段落', '核对内容', '审核 FAQ（生效）', '等向量化', '删旧的']) assert.match(r.stdout, new RegExp(`${step}：`));
    const [, importId, recDir] = recordOf(r);
    assert.match(r.stdout, new RegExp(`完成。要撤回就运行：md kb revoke ${importId}`));

    const created = server.state.faqs.find((f) => f.question === '课程怎么退款呀');
    assert.equal(created.isReviewed, true);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), false);
    const doc = server.state.files.find((f) => f.name === '新价格表');
    assert.deepEqual(server.state.paragraphs.filter((p) => p.fileId === doc.id).map((p) => [p.content, p.status]), [['瑜伽月卡 399 元', 'ready'], ['瑜伽年卡 2999 元', 'ready']]);
    assert.equal(server.state.files.some((f) => f.id === 601), false);

    // 顺序：原文件下载（备份）在第一个写请求之前；删旧的在审核之后（每个位置都要真的找得到：找不到是 -1，比大小会误过，审查 I6）
    const firstWrite = at(server, (q) => q.method === 'POST' && q.path !== '/api/qa/list' && q.path !== '/api/qa/check-similarity');
    const download = at(server, (q) => q.path.startsWith('/files/601/'));
    const review = at(server, (q) => q.path === '/api/qa/batch-review');
    const delFaq = at(server, (q) => q.path === '/api/qa/batch-delete');
    const delDoc = at(server, (q) => q.path === '/api/knowledge-base/file/delete');
    for (const i of [firstWrite, download, review, delFaq, delDoc]) assert.ok(i >= 0);
    assert.ok(download < firstWrite);
    assert.ok(review < delFaq && review < delDoc);
    assert.equal(server.requests.find((q) => q.path.startsWith('/files/601/')).auth, null);

    // 备份原样：要删的 FAQ 原始行、旧文件的详情、全部段落、原文件
    const backupFaqs = readFileSync(join(recDir, 'backup', 'faqs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(backupFaqs.map((f) => [f.id, f.question, f.answer]), [[7002, '退款多久到账', '审核通过后三个工作日内原路退回。']]);
    assert.deepEqual(readFileSync(join(recDir, 'backup', 'docs', '601', 'paragraphs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l).content), ['瑜伽月卡 299 元', '瑜伽年卡 1999 元']);
    assert.equal(readFileSync(join(recDir, 'backup', 'docs', '601', 'original.pdf'), 'utf-8'), '旧价格表 的原文件内容');
    const state = JSON.parse(readFileSync(join(recDir, 'state.json'), 'utf-8'));
    assert.equal(state.status, 'done');
    assert.deepEqual(state.deleted, { faq: [7002], doc: [601] });
    assert.deepEqual(server.unexpected(), []);
  });
});

test('md kb import 执行：试写的 FAQ 读回来只差空白（问题、答案去掉空白后一样）——能证明是自己建的，删掉，停下，别的一条都不写', async () => {
  await withServer({ mangle: (s) => s.replace('，', '， ') }, async (server, h) => {
    const dir = writePackage(goodPackage());
    const code = await preview(['kb', 'import', dir], h);
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「试写一条」：试写的 FAQ 读回来和包里的只差空白.*已经把它删了/);
    assert.equal(server.state.faqs.some((f) => f.question === '课程怎么退款呀'), false);
    assert.equal(server.state.files.some((f) => f.name === '新价格表'), false);
    assert.equal(server.writes().filter((q) => q.path === '/api/qa/batch-create').length, 1);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), true);
  });
});

for (const [label, mangle] of [['答案被改了', (s) => (s.endsWith('。') ? `${s}（改）` : s)], ['问题、答案都被改了', (s) => `${s}（改）`]]) {
  test(`md kb import 执行：试写的 FAQ ${label}——证明不了是自己建的（可能是同一时间别人加的）：不删它，停下并列出来，别的一条都不写`, async () => {
    await withServer({ mangle }, async (server, h) => {
      const dir = writePackage(goodPackage());
      const code = await preview(['kb', 'import', dir], h);
      const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /停在「试写一条」：1 条 FAQ 发出去了，但在库里没有一模一样的（「课程怎么退款呀」）；写的时候库里多出来 1 条对不上的：#90001「课程怎么退款呀/);
      assert.match(r.stderr, /md 不会动它们/);
      assert.equal(server.state.faqs.some((f) => f.id === 90001), true);
      assert.deepEqual(server.writes().map((q) => q.path), ['/api/qa/batch-create']);
    });
  });
}

const sixty = () => ({ faqs: Array.from({ length: 60 }, (_, i) => faq(`f${i + 1}`, `批量问题${i + 1}`)) });
const countNew = (server) => server.state.faqs.filter((f) => f.kb === KB_FAQ && f.question.startsWith('批量问题')).length;

test('md kb import：第 3 批写进去了、回复丢了——请求前后一比认得回来，不用停，一次做完，不重复创建', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [{ n: 3, applied: true }] } }, async (server, h) => {
    const dir = writePackage(sixty());
    const code = await preview(['kb', 'import', dir], h);
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(countNew(server), 60);
    assert.equal(server.writes().filter((q) => q.path === '/api/qa/batch-create').length, 3);
  });
});

{
  test('md kb import 续跑：第 3 批直接失败——停在「建 FAQ」；--resume 补完，不重复创建', async () => {
    await withServer({ failOn: { 'POST /api/qa/batch-create': [3] } }, async (server, h) => {
      const dir = writePackage(sixty());
      const code = await preview(['kb', 'import', dir], h);
      const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /停在「建 FAQ」/);
      const importId = recordOf(r)[1];
      assert.match(r.stderr, new RegExp(`md kb import --resume ${importId}`));
      const p = await runCli(['kb', 'import', '--resume', importId], { home: h });
      assert.equal(p.code, 0, p.stderr);
      assert.match(p.stdout, /停在「建 FAQ」/);
      assert.match(p.stdout, /上次停下时发出去、还没对上的：FAQ 9 条/);
      assert.match(p.stdout, /没对上的 9 条在库里找不到，写的时候库里也没多出来别的：就是没建成，续跑会重新发一次/);
      assert.match(p.stdout, /还要做：建 FAQ、建文件和段落、核对内容、审核 FAQ（生效）、等向量化、删旧的/);
      const done = await runCli(['kb', 'import', '--resume', importId, '--confirm', codeOf(p)], { home: h });
      assert.equal(done.code, 0, done.stderr);
      assert.equal(countNew(server), 60);
      assert.ok(server.state.faqs.filter((f) => f.question.startsWith('批量问题')).every((f) => f.isReviewed));
    });
  });
}

test('md kb import 续跑：等向量化超时就停下（旧的还没删）；向量化完成后 --resume 接着做完', async () => {
  await withServer({ readyAfter: 1e9 }, async (server, h) => {
    const dir = writePackage(goodPackage());
    const code = await preview(['kb', 'import', dir], h);
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h, env: { MD_KB_WAIT_S: '0.05' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「等向量化」：向量化还没完成：1 个文件的段落还没 ready/);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), true);
    assert.equal(server.state.files.some((f) => f.id === 601), true);
    server.state.paragraphs.forEach((p) => { p.status = 'ready'; });
    const importId = recordOf(r)[1];
    const p = await runCli(['kb', 'import', '--resume', importId], { home: h });
    const done = await runCli(['kb', 'import', '--resume', importId, '--confirm', codeOf(p)], { home: h });
    assert.equal(done.code, 0, done.stderr);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), false);
    assert.equal(server.state.files.some((f) => f.id === 601), false);
  });
});

test('md kb import：预演之后包改了、或者要删的 FAQ 被人改了——计划码作废（退出码 5），一条都不写', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage(goodPackage());
    const code = await preview(['kb', 'import', dir], h);
    writeFileSync(join(dir, 'faqs.jsonl'), JSON.stringify(faq('f1', '课程怎么退款呀', '改过的答案')));
    const changed = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(changed.code, 5);
    const code2 = await preview(['kb', 'import', dir], h);
    server.state.faqs.find((f) => f.id === 7002).answer = '有人在控制台改了答案';
    const edited = await runCli(['kb', 'import', dir, '--confirm', code2], { home: h });
    assert.equal(edited.code, 5);
    assert.deepEqual(server.writes(), []);
  });
});

test('md kb import：要删的内容在备份之后被人改过——删旧的这一步停下、一条都不删（按旧备份删会丢掉改动）', async () => {
  await withServer({ readyAfter: 1e9 }, async (server, h) => {
    const dir = writePackage(goodPackage());
    const code = await preview(['kb', 'import', dir], h);
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h, env: { MD_KB_WAIT_S: '0.05' } });
    assert.match(r.stderr, /停在「等向量化」/);
    server.state.faqs.find((f) => f.id === 7002).answer = '有人在控制台改了答案';
    server.state.paragraphs.forEach((p) => { p.status = 'ready'; });
    const importId = recordOf(r)[1];
    const p = await runCli(['kb', 'import', '--resume', importId], { home: h });
    const done = await runCli(['kb', 'import', '--resume', importId, '--confirm', codeOf(p)], { home: h });
    assert.equal(done.code, 1);
    assert.match(done.stderr, /停在「删旧的」：要删的内容在备份之后被人改过：FAQ #7002。按旧备份删掉会丢掉这些改动，所以一条都没删/);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), true);
    assert.equal(server.state.files.some((f) => f.id === 601), true);
    assert.equal(server.writes().filter((q) => q.path === '/api/qa/batch-delete' || q.path === '/api/knowledge-base/file/delete').length, 0);
  });
});
