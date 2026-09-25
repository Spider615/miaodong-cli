// 3b 复核（第三轮）的修复：内容一模一样不等于是自己建的。只有「这次请求刚发完那几次列表里、唯一一条一模一样的」才自动认；
// 之后才出现的一模一样的，要用户确认才认；好几条一模一样的，一律不认、不删（没有「自动删副本」了）。
// 删自己的东西之前再核对一次：被人改过的不删。续跑查重复只看导入开始之后才出现的、不是自己的。
// 撤回里任何一条重建连续失败（认不上、核对不过、段落写不进去）都给出跳过；断网不算「可疑」
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './helpers/run-cli.mjs';
import { KB_FAQ } from './helpers/kb-fixtures.mjs';
import { doc, faq, writePackage } from './helpers/kb-import-fixtures.mjs';
import { goodPackage, importFaqRows, importParagraphRows } from './helpers/kb-import-data.mjs';
import { codeOf, confirmImport, homeFor, previewCode, recordOf, resume, revoke, withServer } from './helpers/kb-import-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const badGateway = { status: 502, body: { statusCode: 502, message: 'Bad Gateway' } };
const gatewayTimeout = { status: 504, body: { statusCode: 504, message: 'Gateway Timeout' } };
const faqsAsking = (server, q) => server.state.faqs.filter((f) => f.kb === KB_FAQ && f.question === q);
const deletes = (server, path) => server.writes().filter((q) => q.path === path);
const stateOf = (r) => JSON.parse(readFileSync(join(recordOf(r)[2], 'state.json'), 'utf-8'));

test('「删旧的、加同一个问题的新 FAQ」试写时断网：续跑不把包里要删的旧 FAQ 当成「别人加的」拦下，做得完；撤回恢复旧的', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [1] } }, async (server, h) => {
    const pkg = { faqs: [faq('f1', '退款多久到账', '审核通过后一个工作日内原路退回。')], docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])], deletes: [{ type: 'faq', id: 7002, question: '退款多久到账' }] };
    const r = await confirmImport(writePackage(pkg), h);
    assert.equal(r.code, 1);
    const importId = recordOf(r)[1];
    const { preview, done } = await resume(importId, h);
    assert.doesNotMatch(preview.stdout + preview.stderr, /完全一样/);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(faqsAsking(server, '退款多久到账').map((f) => f.answer), ['审核通过后一个工作日内原路退回。']);
    const rv = await revoke(importId, h);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.deepEqual(faqsAsking(server, '退款多久到账').map((f) => f.answer), ['审核通过后三个工作日内原路退回。']);
  });
});

test('要删的旧 FAQ 在 md 删之前被人删了：撤回不复活它，但要说清楚没恢复它、备份在哪，不说「删掉的都按备份重建了」', async () => {
  await withServer({ readyAfter: 1e9 }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h, { MD_KB_WAIT_S: '0.05' });
    assert.match(r.stderr, /停在「等向量化」/);
    server.state.faqs = server.state.faqs.filter((f) => f.id !== 7002);
    server.state.paragraphs.forEach((p) => { p.status = 'ready'; });
    const importId = recordOf(r)[1];
    const { done } = await resume(importId, h);
    assert.equal(done.code, 0, done.stderr);
    const tick = setInterval(() => server.state.paragraphs.forEach((p) => { p.status = 'ready'; }), 5);
    const rv = await revoke(importId, h).finally(() => clearInterval(tick));
    assert.match(rv.preview.stdout, /在 md 删之前就被人删了[^\n]*FAQ #7002「退款多久到账」[^\n]*backup/);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.doesNotMatch(rv.done.stdout, /删掉的都按备份重建了/);
    assert.match(rv.done.stdout, /FAQ #7002「退款多久到账」[^\n]*没有重建/);
  });
});

test('A 试写断网停下；同事 B 在另一台电脑把同一个包导完了——A 续跑不自动认 B 的（要用户确认）；A 撤回不删 B 的', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [1] } }, async (server, hA) => {
    const hB = homeFor(server);
    const pkg = { faqs: [faq('f1', '瑜伽课怎么请假', '在课表页点请假，每月限 2 次。'), faq('f2', '瑜伽课能转让吗', '可以转让一次。')] };
    const a = await confirmImport(writePackage(pkg), hA);
    assert.equal(a.code, 1);
    const b = await confirmImport(writePackage(pkg), hB);
    assert.equal(b.code, 0, b.stderr);
    const theirs = Object.values(stateOf(b).faqIds);
    // f1 发出去过：B 建的一模一样的那条只能让用户判断；f2 没发过：库里已经有同一个问题，续跑拦下（再建就重复了）
    const p = await runCli(['kb', 'import', '--resume', recordOf(a)[1]], { home: hA });
    assert.equal(p.code, 1);
    assert.match(p.stdout, new RegExp(`#${theirs[0]}「瑜伽课怎么请假」[^\\n]*也可能是别人按同样的内容建的`));
    assert.match(p.stderr, new RegExp(`新 FAQ「瑜伽课能转让吗」（f2）和库里 #${theirs[1]} 问题一样`));
    assert.deepEqual(stateOf(a).faqIds, {});
    const rv = await revoke(recordOf(a)[1], hA);
    assert.doesNotMatch(rv.preview.stdout.split('\n').find((l) => l.startsWith('要删')) ?? '', new RegExp(`${theirs[0]}`));
    assert.equal(rv.done.code, 1);
    for (const id of theirs) assert.equal(server.state.faqs.some((f) => f.id === id), true);
  });
});

for (const confirm of [false, true]) {
  test(`建文件的请求 504 没落库；停下期间同事新建了同名的空手工文件——文件永远不在事后认：${confirm ? '用户确认续跑，md 另建一个，不往它里面写' : '撤回不碰它'}`, async () => {
    await withServer({}, async (server, h) => {
      const dir = writePackage({ docs: [doc('d1', '价格表', ['瑜伽月卡 399 元', '瑜伽年卡 2999 元'])] });
      const code = await previewCode(dir, h);
      const route = 'POST /api/knowledge-base/file/manual-create';
      const orig = server.routes[route];
      let first = true;
      server.routes[route] = async (rec) => {
        if (!first) return orig(rec);
        first = false;
        return gatewayTimeout;
      };
      const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
      assert.equal(r.code, 1);
      server.state.files.push({ id: 7777, kb: KB_FAQ, name: '价格表', extension: '', status: 'ready', manual: true, tags: [], abstract: '', original: '' });
      const touched7777 = () => server.requests.some((q) => (q.path.endsWith('manual-create-paragraph') && q.body.docId === 7777) || (q.path.endsWith('/file/delete') && q.body.id === 7777));
      const p = await runCli(['kb', 'import', '--resume', recordOf(r)[1]], { home: h });
      assert.equal(p.code, 0, p.stderr);
      assert.match(p.stdout, /#7777「价格表」（空的手工文件）[^\n]*md 不认它、也不往里写/);
      if (confirm) {
        const done = await runCli(['kb', 'import', '--resume', recordOf(r)[1], '--confirm', codeOf(p)], { home: h });
        assert.equal(done.code, 0, done.stderr);
        assert.notEqual(stateOf(r).docIds.d1, 7777);
      }
      const rv = await revoke(recordOf(r)[1], h);
      assert.match(rv.preview.stdout, /分不清是不是这次建的[^\n]*#7777/);
      assert.equal(rv.done.code, 1);
      assert.equal(server.state.files.some((f) => f.id === 7777), true);
      assert.equal(touched7777(), false);
    });
  });
}

test('两台电脑同一时间把同一个包导进同一个库：谁都不删别人的；两边不会认下同一条', async () => {
  await withServer({}, async (server, hA) => {
    const hB = homeFor(server);
    const pkg = { faqs: [faq('f1', '瑜伽课怎么请假', '在课表页点请假，每月限 2 次。')] };
    const dirA = writePackage(pkg);
    const dirB = writePackage(pkg);
    const codeA = await previewCode(dirA, hA);
    const codeB = await previewCode(dirB, hB);
    const route = 'POST /api/qa/batch-create';
    const orig = server.routes[route];
    server.routes[route] = async (rec) => {
      await sleep(300);
      return orig(rec);
    };
    const [a, b] = await Promise.all([
      runCli(['kb', 'import', dirA, '--confirm', codeA], { home: hA }),
      runCli(['kb', 'import', dirB, '--confirm', codeB], { home: hB }),
    ]);
    assert.deepEqual(deletes(server, '/api/qa/batch-delete'), []);
    const ida = Object.values(stateOf(a).faqIds);
    const idb = Object.values(stateOf(b).faqIds);
    assert.deepEqual(ida.filter((id) => idb.includes(id)), []);
    assert.equal(faqsAsking(server, '瑜伽课怎么请假').length, 2);
  });
});

for (const [label, failOn, edit, gone] of [
  ['试写 FAQ 被运营改了答案', { 'POST /api/knowledge-base/file/manual-create': [1] },
    (s) => { s.state.faqs.find((x) => x.question === '瑜伽课怎么请假').answer = '运营改过：在小程序里请假。'; },
    (s) => !s.state.faqs.some((x) => x.answer.startsWith('运营改过'))],
  ['试写文件唯一的一段被运营改了', { 'POST /api/knowledge-base/file/manual-create-paragraph': [{ n: 1, applied: true }] },
    (s) => { const f = s.state.files.find((x) => x.name === '请假规则'); s.state.paragraphs.find((x) => x.fileId === f.id).content = '运营改过：每月限 3 次。'; },
    (s) => !s.state.paragraphs.some((x) => x.content.startsWith('运营改过'))],
]) {
  test(`${label}（停下期间）：续跑不删它、停下列出来`, async () => {
    await withServer({ failOn }, async (server, h) => {
      const r = await confirmImport(writePackage({ faqs: [faq('f1', '瑜伽课怎么请假', '在课表页点请假。')], docs: [doc('d1', '请假规则', ['每月限 2 次。', '提前 2 小时。'])] }), h);
      assert.equal(r.code, 1);
      edit(server);
      const { done } = await resume(recordOf(r)[1], h);
      assert.equal(done.code, 1);
      assert.match(done.stderr, /停在「试写一条」[^\n]*被人改过/);
      assert.equal(gone(server), false);
      assert.deepEqual(deletes(server, '/api/qa/batch-delete').concat(deletes(server, '/api/knowledge-base/file/delete')), []);
    });
  });
}

for (const [label, rows, route, mangle] of [
  ['重建的 FAQ 只差空白（核对不过）', importFaqRows().map((f) => (f.id === 7002 ? { ...f, answer: '审核通过后  三个工作日内原路退回。' } : f)), 'POST /api/qa/batch-create',
    (b) => ({ ...b, qaList: b.qaList.map((q) => ({ ...q, answer: q.answer.replace(/\s+/g, ' ') })) })],
  ['重建的文件段落被改写（核对不过）', importFaqRows(), 'POST /api/knowledge-base/file/manual-create-paragraph', (b) => ({ ...b, content: b.content.replace(/元/g, '元整') })],
]) {
  test(`撤回：${label}——失败两次之后预演给出跳过，确认后这次导入建的都删掉`, async () => {
    await withServer({ faqRows: rows }, async (server, h) => {
      const r = await confirmImport(writePackage(goodPackage()), h);
      assert.equal(r.code, 0, r.stderr);
      const orig = server.routes[route];
      server.routes[route] = async (rec) => orig({ ...rec, body: mangle(rec.body) });
      const importId = recordOf(r)[1];
      assert.equal((await revoke(importId, h)).done.code, 1);
      assert.equal((await revoke(importId, h)).done.code, 1);
      const third = await revoke(importId, h);
      assert.match(third.preview.stdout, /重建不了/);
      assert.equal(third.done.code, 1);
      assert.equal(faqsAsking(server, '课程怎么退款呀').length, 0);
      assert.equal(server.state.files.some((f) => f.name === '新价格表'), false);
    });
  });
}

test('撤回：要删的旧文件有一段超过 1000 字，秒懂拒收——失败两次之后给出跳过；确认后这次建的删掉，重建了一半的也删掉', async () => {
  const paragraphRows = importParagraphRows().map((p) => (p.id === 9102 ? { ...p, content: `价格说明：${'长'.repeat(1100)}` } : p));
  await withServer({ paragraphRows }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h);
    assert.equal(r.code, 0, r.stderr);
    const route = 'POST /api/knowledge-base/file/manual-create-paragraph';
    const orig = server.routes[route];
    server.routes[route] = async (rec) => ([...rec.body.content].length > 1000 ? { status: 400, body: { statusCode: 400, message: 'content too long' } } : orig(rec));
    const importId = recordOf(r)[1];
    assert.equal((await revoke(importId, h)).done.code, 1);
    assert.equal((await revoke(importId, h)).done.code, 1);
    const third = await revoke(importId, h);
    assert.match(third.preview.stdout, /重建不了[^\n]*文件 #601「旧价格表」/);
    assert.equal(third.done.code, 1);
    assert.equal(server.state.files.some((f) => f.name === '新价格表'), false);
    assert.equal(server.state.files.some((f) => f.name === '旧价格表'), false);
    assert.equal(faqsAsking(server, '课程怎么退款呀').length, 0);
  });
});

function outage(server) {
  const create = 'POST /api/qa/batch-create';
  const list = 'POST /api/qa/list';
  const oc = server.routes[create];
  const ol = server.routes[list];
  const net = { down: true, failLists: 0 };
  server.routes[create] = async (rec) => {
    if (net.down) {
      net.failLists = 4;
      return badGateway;
    }
    return oc(rec);
  };
  server.routes[list] = async (rec) => {
    if (net.failLists > 0 && !rec.body.searchMode) {
      net.failLists--;
      return badGateway;
    }
    return ol(rec);
  };
  return net;
}

for (const colleague of [false, true]) {
  test(`断了几次网（请求 502、之后的列表也都失败）${colleague ? '，期间同事加了一条不相干的 FAQ' : ''}——不算可疑、不拒绝续跑；不相干的不列出来`, async () => {
    await withServer({}, async (server, h) => {
      const dir = writePackage({ faqs: [faq('f1', '瑜伽课怎么请假', '在课表页点请假。')] });
      const code = await previewCode(dir, h);
      const net = outage(server);
      const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
      assert.equal(r.code, 1);
      if (colleague) server.state.faqs.push({ id: 6200, kb: KB_FAQ, question: '会员卡怎么续费', answer: '同事写的：在会员中心续费。', isReviewed: true });
      const importId = recordOf(r)[1];
      for (let i = 0; i < 2; i++) assert.equal((await resume(importId, h)).done.code, 1);
      const p = await runCli(['kb', 'import', '--resume', importId], { home: h });
      assert.equal(p.code, 0, p.stderr);
      assert.doesNotMatch(p.stdout, /6200/);
      net.down = false;
      const { done } = await resume(importId, h);
      assert.equal(done.code, 0, done.stderr);
      assert.equal(faqsAsking(server, '瑜伽课怎么请假').length, 1);
    });
  });
}
