// 3b 复审（第二轮）的修复：只有「内容完全对得上」才认成这次建的（FAQ 问题和答案、文件同名 + 手工 + 还是空的），
// 窗口只用来找「可疑的」；导入过程中只删能证明是自己的；晚落库、列表有延迟、列表失败都认得回来，不重复建；
// 用户确认过「不是这次建的」那几条不会被忘掉；重建一直过不去时撤回能跳过它、先删这次建的；撤回之后旧计划码作废；锁接管没有竞态
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOADER_URL, REPO, runCli } from './helpers/run-cli.mjs';
import { KB_FAQ } from './helpers/kb-fixtures.mjs';
import { doc, faq, writePackage } from './helpers/kb-import-fixtures.mjs';
import { goodPackage, importFaqRows } from './helpers/kb-import-data.mjs';
import { codeOf, confirmImport, previewCode, recordOf, resume, revoke, withServer } from './helpers/kb-import-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gatewayTimeout = { status: 504, body: { statusCode: 504, message: 'Gateway Timeout' } };
const badGateway = { status: 502, body: { statusCode: 502, message: 'Bad Gateway' } };
const docsNamed = (server, name) => server.state.files.filter((f) => f.kb === KB_FAQ && f.name === name);
const faqsAsking = (server, q) => server.state.faqs.filter((f) => f.kb === KB_FAQ && f.question === q);
const touched = (server, docId) => server.requests.filter((q) => (q.path === '/api/knowledge-base/file/manual-create-paragraph' && q.body.docId === docId)
  || (q.path === '/api/knowledge-base/file/delete' && q.body.id === docId));
// 第 n 次调用 route 时换成 fn（其余照常）
function onCall(server, route, n, fn) {
  const orig = server.routes[route];
  let calls = 0;
  server.routes[route] = async (rec) => {
    calls++;
    return calls === n ? fn(rec, orig) : orig(rec);
  };
}
// 同事在控制台建了一个同名文件、写了一段
function colleagueDoc(server, id, name) {
  server.state.files.push({ id, kb: KB_FAQ, name, extension: '', status: 'ready', manual: true, tags: [], abstract: '', original: '' });
  server.state.paragraphs.push({ id: id * 10 + 1, fileId: id, index: 0, content: '同事写的：月卡活动价 199', wordCount: 12, status: 'ready' });
}

for (const [label, pkg, call, step] of [
  ['试写的文件', { docs: [doc('d1', '价格表', ['瑜伽月卡 399 元'])] }, 1, '试写一条'],
  ['第 2 个文件', { docs: [doc('d1', '价格表一', ['一']), doc('d2', '价格表', ['瑜伽月卡 399 元'])] }, 2, '建文件和段落'],
]) {
  test(`${label}：建文件的请求 504 没落库，窗口里同事建了同名文件、写了内容——不认它、不往里写、不删它，停下列出来`, async () => {
    await withServer({}, async (server, h) => {
      const dir = writePackage(pkg);
      const code = await previewCode(dir, h);
      onCall(server, 'POST /api/knowledge-base/file/manual-create', call, () => {
        colleagueDoc(server, 7777, '价格表');
        return gatewayTimeout;
      });
      const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`停在「${step}」`));
      assert.match(r.stderr, /#7777「价格表」/);
      assert.deepEqual(touched(server, 7777), []);
      assert.deepEqual(server.state.paragraphs.filter((p) => p.fileId === 7777).map((p) => p.content), ['同事写的：月卡活动价 199']);
    });
  });
}

test('试写 FAQ 的请求 504 没落库，窗口里同事加了同一个问题（答案不一样）——不认它、不删它，停下列出来', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ faqs: [faq('f1', '瑜伽课怎么请假', '在课表页点请假。')] });
    const code = await previewCode(dir, h);
    onCall(server, 'POST /api/qa/batch-create', 1, () => {
      server.state.faqs.push({ id: 6001, kb: KB_FAQ, question: '瑜伽课怎么请假', answer: '同事写的：提前 2 小时请假。', isReviewed: true });
      return gatewayTimeout;
    });
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「试写一条」[^\n]*#6001「瑜伽课怎么请假」/);
    assert.equal(server.writes().filter((q) => q.path === '/api/qa/batch-delete').length, 0);
    assert.equal(server.state.faqs.some((f) => f.id === 6001), true);
  });
});

test('建 FAQ 的第 2 批 504 没落库，窗口里同事加了同一个问题——停在建 FAQ；撤回不把它当成「这次建的」删掉', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ faqs: [faq('f1', '新问题一', '答案一。'), faq('f2', '瑜伽课怎么请假', '在课表页点请假。')] });
    const code = await previewCode(dir, h);
    onCall(server, 'POST /api/qa/batch-create', 2, () => {
      server.state.faqs.push({ id: 6001, kb: KB_FAQ, question: '瑜伽课怎么请假', answer: '同事写的：提前 2 小时请假。', isReviewed: true });
      return gatewayTimeout;
    });
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「建 FAQ」/);
    const rv = await revoke(recordOf(r)[1], h);
    assert.doesNotMatch(rv.preview.stdout.split('\n').find((l) => l.startsWith('要删')) ?? '', /6001/);
    assert.match(rv.preview.stdout, /分不清是不是这次建的[^\n]*#6001/);
    assert.equal(rv.done.code, 1);
    assert.equal(server.state.faqs.some((f) => f.id === 6001), true);
    assert.equal(faqsAsking(server, '新问题一').length, 0);
  });
});

for (const [label, route, pkg, count] of [
  ['文件', 'POST /api/knowledge-base/file/manual-create', { docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])] }, (s) => docsNamed(s, '新价格表').length],
  ['FAQ', 'POST /api/qa/batch-create', { faqs: [faq('f1', '课程怎么退款呀', '在订单详情页申请。')] }, (s) => faqsAsking(s, '课程怎么退款呀').length],
]) {
  test(`${label}：建的请求回了 504、过一会儿才落库——续跑认得回来（不重复建）；撤回删得掉，干净了才说撤回完成`, async () => {
    await withServer({}, async (server, h) => {
      const dir = writePackage(pkg);
      const code = await previewCode(dir, h);
      onCall(server, route, 1, (rec, orig) => {
        setTimeout(() => orig(rec), 300);
        return gatewayTimeout;
      });
      const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
      assert.equal(r.code, 1);
      await sleep(600);
      const importId = recordOf(r)[1];
      const { preview, done } = await resume(importId, h);
      assert.match(preview.stdout, /现在在库里对上了、当成这次建的/);
      assert.equal(done.code, 0, done.stderr);
      assert.equal(count(server), 1);
      const rv = await revoke(importId, h);
      assert.equal(rv.done.code, 0, rv.done.stderr);
      assert.match(rv.done.stdout, /撤回完成/);
      assert.equal(count(server), 0);
    });
  });
}

test('文件列表有延迟（新建之后 200ms 才读得到）：续跑认得回来，不会每续跑一次多一个空文件', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元', '瑜伽年卡 2999 元'])] });
    const code = await previewCode(dir, h);
    const route = 'POST /api/knowledge-base/file/manual-create';
    const orig = server.routes[route];
    server.routes[route] = async (rec) => {
      setTimeout(() => orig(rec), 200);
      return { status: 200, body: { code: 0, data: null } };
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    let last = r;
    for (let i = 0; i < 3 && last.code !== 0; i++) {
      await sleep(400);
      last = (await resume(recordOf(r)[1], h)).done;
    }
    assert.equal(last.code, 0, last.stderr);
    assert.equal(docsNamed(server, '新价格表').length, 1);
  });
});

test('建文件成功、紧接着的那次列表 502——再列几次就认得回来，不重复建', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])] });
    const code = await previewCode(dir, h);
    const create = 'POST /api/knowledge-base/file/manual-create';
    const list = 'GET /api/knowledge-base/file/list';
    const oc = server.routes[create];
    const ol = server.routes[list];
    let armed = false;
    server.routes[create] = async (rec) => {
      const reply = await oc(rec);
      armed = true;
      return reply;
    };
    server.routes[list] = async (rec) => {
      if (armed) {
        armed = false;
        return badGateway;
      }
      return ol(rec);
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(docsNamed(server, '新价格表').length, 1);
  });
});

test('排队的第一次请求和续跑重发的那次落在同一个窗口：两条一模一样——认一条，另一条是自己的副本、删掉；不说「对不上」', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ faqs: [faq('f1', '课程怎么退款呀', '在订单详情页申请。')] });
    const code = await previewCode(dir, h);
    const route = 'POST /api/qa/batch-create';
    const orig = server.routes[route];
    let queued = null;
    server.routes[route] = async (rec) => {
      if (!queued && !server.state.faqs.some((f) => f.question === '课程怎么退款呀')) {
        queued = rec;
        return gatewayTimeout;
      }
      if (queued) {
        await orig(queued);
        queued = false;
      }
      return orig(rec);
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    const { done } = await resume(recordOf(r)[1], h);
    assert.equal(done.code, 0, done.stderr);
    assert.doesNotMatch(done.stdout + done.stderr, /对不上/);
    assert.equal(faqsAsking(server, '课程怎么退款呀').length, 1);
  });
});

test('用户确认过「多出来的不是这次建的」、重发又对不上：拒绝续跑时两次多出来的都列出来；撤回也都列；都删掉之后复查才算干净', async () => {
  await withServer({ mangle: (s) => s.replace(/（/g, '(').replace(/）/g, ')') }, async (server, h) => {
    const r = await confirmImport(writePackage({ faqs: [faq('f1', '课程怎么退款呀', '答案一'), faq('f2', '退款（部分）怎么算', '答案二')] }), h);
    const importId = recordOf(r)[1];
    const first = await resume(importId, h);
    assert.equal(first.done.code, 1);
    const refused = await runCli(['kb', 'import', '--resume', importId], { home: h });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /#90002「退款\(部分\)怎么算」/);
    assert.match(refused.stderr, /#90003「退款\(部分\)怎么算」/);
    const rv = await revoke(importId, h);
    assert.equal(rv.done.code, 1);
    assert.match(rv.done.stdout, /还有 2 条分不清是不是这次建的，没删：[^\n]*#90002[^\n]*#90003|还有 2 条分不清是不是这次建的，没删：[^\n]*#90003[^\n]*#90002/);
    server.state.faqs = server.state.faqs.filter((f) => f.id !== 90002 && f.id !== 90003);
    const again = await runCli(['kb', 'revoke', importId], { home: h });
    assert.equal(again.code, 0, again.stdout);
  });
});

test('撤回之后，用过的计划码不能不经预演、不问用户就再导一遍', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ faqs: [faq('f1', '课程怎么退款呀', '在订单详情页申请。')], docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])] });
    const code = await previewCode(dir, h);
    const r1 = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r1.code, 0, r1.stderr);
    const rv = await revoke(recordOf(r1)[1], h);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    const again = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(again.code, 5);
    assert.match(again.stderr, /计划码对不上/);
    assert.equal(faqsAsking(server, '课程怎么退款呀').length, 0);
    assert.equal(docsNamed(server, '新价格表').length, 0);
  });
});

test('撤回时秒懂一直改写重建的内容：两次都对不上之后，预演给出「跳过它的重建、先删这次建的」，确认后这次建的都删掉，改写出来的列出来', async () => {
  const faqRows = importFaqRows().map((f) => (f.id === 7002 ? { ...f, question: '退款多久到账（原路）' } : f));
  await withServer({ faqRows }, async (server, h) => {
    const pkg = { ...goodPackage(), deletes: [{ type: 'faq', id: 7002, question: '退款多久到账（原路）' }, { type: 'doc', id: 601, name: '旧价格表' }] };
    const r = await confirmImport(writePackage(pkg), h);
    assert.equal(r.code, 0, r.stderr);
    const importId = recordOf(r)[1];
    const route = 'POST /api/qa/batch-create';
    const orig = server.routes[route];
    server.routes[route] = async (rec) => orig({ ...rec, body: { ...rec.body, qaList: rec.body.qaList.map((q) => ({ ...q, question: q.question.replace(/（/g, '(').replace(/）/g, ')') })) } });
    const first = await revoke(importId, h);
    assert.equal(first.done.code, 1);
    const second = await revoke(importId, h);
    assert.equal(second.done.code, 1);
    const third = await revoke(importId, h);
    assert.match(third.preview.stdout, /重建不了[^\n]*FAQ #7002「退款多久到账（原路）」/);
    assert.match(third.preview.stdout, /backup/);
    assert.equal(third.done.code, 1);
    assert.equal(faqsAsking(server, '课程怎么退款呀').length, 0);
    assert.equal(docsNamed(server, '新价格表').length, 0);
    assert.equal(docsNamed(server, '旧价格表').length, 1);
    assert.match(third.done.stdout, /还有 2 条分不清是不是这次建的，没删/);
    assert.equal(faqsAsking(server, '退款多久到账(原路)').length, 2);
  });
});

test('撤回：FAQ 和文件撞号（都是 #601），重建 FAQ 之后列表一直失败——再运行一次撤回认得回来，不重复建', async () => {
  const faqRows = [...importFaqRows(), { id: 601, kb: KB_FAQ, question: '撞号的问题', answer: '撞号的答案', isReviewed: true }];
  await withServer({ faqRows }, async (server, h) => {
    const r = await confirmImport(writePackage({ deletes: [{ type: 'faq', id: 601, question: '撞号的问题' }, { type: 'doc', id: 601, name: '旧价格表' }] }), h);
    assert.equal(r.code, 0, r.stderr);
    const importId = recordOf(r)[1];
    const create = 'POST /api/qa/batch-create';
    const list = 'POST /api/qa/list';
    const oc = server.routes[create];
    const ol = server.routes[list];
    let failing = 0;
    server.routes[create] = async (rec) => {
      const reply = await oc(rec);
      failing = 10;
      return reply;
    };
    server.routes[list] = async (rec) => {
      if (failing > 0) {
        failing--;
        return badGateway;
      }
      return ol(rec);
    };
    const first = await revoke(importId, h);
    assert.equal(first.done.code, 1);
    server.routes[create] = oc;
    failing = 0;
    const second = await revoke(importId, h);
    assert.equal(second.done.code, 0, second.done.stderr);
    assert.equal(faqsAsking(server, '撞号的问题').length, 1);
  });
});

test('试写建好的文件被同事删了——续跑重建它，不会一直卡在试写', async () => {
  await withServer({ failOn: { 'POST /api/knowledge-base/file/manual-create-paragraph': [1] } }, async (server, h) => {
    const r = await confirmImport(writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元', '年卡 2999'])] }), h);
    assert.equal(r.code, 1);
    server.state.files = server.state.files.filter((f) => f.name !== '新价格表');
    const { done } = await resume(recordOf(r)[1], h);
    assert.equal(done.code, 0, done.stderr);
    const [d] = docsNamed(server, '新价格表');
    assert.deepEqual(server.state.paragraphs.filter((p) => p.fileId === d.id).map((p) => p.content), ['瑜伽月卡 399 元', '年卡 2999']);
  });
});

for (const [label, change, pattern] of [
  ['要删的 FAQ 被人审核了', (server) => { server.state.faqs.find((f) => f.id === 7004).isReviewed = true; }, /FAQ #7004/],
  ['要删的文件摘要被人改了', (server) => { server.state.files.find((f) => f.id === 601).abstract = '运营改过的摘要'; }, /文件 #601「旧价格表」/],
]) {
  test(`备份之后${label}——删旧的这一步停下、一条都不删（按旧备份重建会把它恢复错）`, async () => {
    await withServer({ readyAfter: 1e9 }, async (server, h) => {
      const pkg = { faqs: [faq('f1', '开课后多久能退', '开课七天内可以全额退。')], docs: [doc('d1', '退款说明', ['开课七天内可以全额退。'])], deletes: [{ type: 'faq', id: 7004, question: '课程可以退吗' }, { type: 'doc', id: 601, name: '旧价格表' }] };
      const r = await confirmImport(writePackage(pkg), h, { MD_KB_WAIT_S: '0.05' });
      assert.match(r.stderr, /停在「等向量化」/);
      change(server);
      server.state.paragraphs.forEach((p) => { p.status = 'ready'; });
      const { done } = await resume(recordOf(r)[1], h);
      assert.equal(done.code, 1);
      assert.match(done.stderr, new RegExp(`停在「删旧的」：要删的内容在备份之后被人改过：[^\\n]*${pattern.source}`));
      assert.equal(server.state.faqs.some((f) => f.id === 7004), true);
      assert.equal(server.state.files.some((f) => f.id === 601), true);
    });
  });
}

test('导入包只多了一个换行（内容一样）——还是算同一个包，没撤回不能再导', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])] });
    const r1 = await confirmImport(dir, h);
    assert.equal(r1.code, 0, r1.stderr);
    appendFileSync(join(dir, 'docs.jsonl'), '\n');
    const p = await runCli(['kb', 'import', dir], { home: h });
    assert.equal(p.code, 1);
    assert.match(p.stderr, /这个导入包在这个库上已经导入过/);
    assert.equal(docsNamed(server, '新价格表').length, 1);
  });
});

test('续跑之前同事加了一条和还没发的新 FAQ 一样的问题——续跑预演拦下（和导入时的闸门一样）', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [2] } }, async (server, h) => {
    const r = await confirmImport(writePackage({ faqs: [faq('f1', '新问题一'), faq('f2', '新问题二')] }), h);
    assert.equal(r.code, 1);
    server.state.faqs.push({ id: 6100, kb: KB_FAQ, question: '新问题二', answer: '同事写的', isReviewed: true });
    const p = await runCli(['kb', 'import', '--resume', recordOf(r)[1]], { home: h });
    assert.equal(p.code, 1);
    assert.doesNotMatch(p.stdout, /计划码/);
    assert.match(p.stderr, /新 FAQ「新问题二」（f2）和库里 #6100 完全一样/);
  });
});

for (const [label, stallAt] of [['读完死锁、还没抢到接管标记时被挂起', 'takeover'], ['抢到接管标记、还没删死锁时被挂起', 'remove']]) {
  test(`锁：上次被杀留下死锁，两个进程同时来接管，其中一个${label}——只有一个拿到锁`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'md-lock-'));
    const kbId = `aaaa0001${'0'.repeat(24)}`;
    const lock = join(home, 'kb-imports', 'k1', kbId.slice(0, 8), '.lock');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, what: '被杀掉的导入', at: new Date().toISOString() }));
    const run = (name, env) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', '--loader', LOADER_URL, join(REPO, 'test', 'helpers', 'lock-race-child.mjs')], {
        env: { PATH: process.env.PATH ?? '', MD_HOME: home, MD_TEST_KB: kbId, NAME: name, ...env },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
    });
    const slow = run('C', { NODE_OPTIONS: `--import ${join(REPO, 'test', 'helpers', 'lock-race-preload.mjs')}`, MD_TEST_STALL_AT: stallAt, MD_TEST_STALL_MS: '1200', HOLD: '1500' });
    await sleep(400);
    const fast = run('B', { HOLD: '1500' });
    const outs = await Promise.all([slow, fast]);
    assert.equal(outs.filter((o) => o.includes('拿到锁')).length, 1, outs.join(' | '));
  });
}

test('这次导入建的文件在停下期间被人改了（段落和要写的对不上）——续跑停下列出来，不删它、不往里写（改动不丢）', async () => {
  await withServer({ failOn: { 'POST /api/knowledge-base/file/manual-create-paragraph': [3] } }, async (server, h) => {
    const r = await confirmImport(writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元']), doc('d2', '年卡说明', ['年卡 2999', '年卡可以转让'])] }), h);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「建文件和段落」/);
    const [mine] = docsNamed(server, '年卡说明');
    server.state.paragraphs.find((p) => p.fileId === mine.id).content = '运营改过：年卡 2599';
    const { done } = await resume(recordOf(r)[1], h);
    assert.equal(done.code, 1);
    assert.match(done.stderr, new RegExp(`停在「建文件和段落」：文件「年卡说明」（#${mine.id}）里的段落和要写的对不上`));
    assert.deepEqual(touched(server, mine.id).filter((q) => q.path.endsWith('/file/delete')), []);
    assert.deepEqual(server.state.paragraphs.filter((p) => p.fileId === mine.id).map((p) => p.content), ['运营改过：年卡 2599']);
  });
});
