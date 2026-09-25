// 3b 最后一次核实的修复：「是不是自己建的」只在请求刚发完那一刻判断一次、记进意图；续跑、撤回按记下的来，不按现在的库重判
// （当时可疑的，后来被人改成一样也还是可疑；当时一模一样不止一条的，后来被删掉一条也还是分不清）。
// 撤回：跳过重建的那几条不认晚出现的、只删请求刚发完时认下的半成品；任何一条重建连续失败两次都能跳过（加 --skip-rebuild，用户选）；
// 备份里原来就没向量化成功的段落不等。建文件每次都晚落库，最多攒两个空文件就拒绝续跑。没有快照时查重复不误拦包里要删的
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './helpers/run-cli.mjs';
import { KB_FAQ } from './helpers/kb-fixtures.mjs';
import { doc, faq, writePackage } from './helpers/kb-import-fixtures.mjs';
import { goodPackage, importParagraphRows } from './helpers/kb-import-data.mjs';
import { codeOf, confirmImport, homeFor, previewCode, recordOf, resume, revoke, withServer } from './helpers/kb-import-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gatewayTimeout = { status: 504, body: { statusCode: 504, message: 'Gateway Timeout' } };
const faqsAsking = (server, q) => server.state.faqs.filter((f) => f.kb === KB_FAQ && f.question === q);
const docsNamed = (server, name) => server.state.files.filter((f) => f.kb === KB_FAQ && f.name === name);
const stateOf = (r) => JSON.parse(readFileSync(join(recordOf(r)[2], 'state.json'), 'utf-8'));

test('试写 FAQ 504 没落库，窗口里同事加了同一个问题（答案不同）；之后同事把答案改成和包里一样——续跑不认它（当时就是可疑的），撤回不删它', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ faqs: [faq('f1', '瑜伽课怎么请假', '在课表页点请假，每月限 2 次。')] });
    const code = await previewCode(dir, h);
    const route = 'POST /api/qa/batch-create';
    const orig = server.routes[route];
    let first = true;
    server.routes[route] = async (rec) => {
      if (!first) return orig(rec);
      first = false;
      server.state.faqs.push({ id: 6001, kb: KB_FAQ, question: '瑜伽课怎么请假', answer: '同事写的：提前 2 小时请假。', isReviewed: true });
      return gatewayTimeout;
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    server.state.faqs.find((f) => f.id === 6001).answer = '在课表页点请假，每月限 2 次。';
    const p = await runCli(['kb', 'import', '--resume', recordOf(r)[1]], { home: h });
    assert.doesNotMatch(p.stdout, /认下了/);
    assert.deepEqual(stateOf(r).faqIds, {});
    const rv = await revoke(recordOf(r)[1], h);
    assert.doesNotMatch(rv.preview.stdout.split('\n').find((l) => l.startsWith('要删')) ?? '', /6001/);
    assert.equal(server.state.faqs.some((f) => f.id === 6001), true);
  });
});

test('请求落了两次（排队的第一次和续跑重发的那次落在同一个窗口），停在「不止一条一模一样」；有人删掉一条之后——续跑还是拒绝（当时就分不清）；撤回也不删剩下那条', async () => {
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
    const importId = recordOf(r)[1];
    assert.equal((await resume(importId, h)).done.code, 1);
    const [keep, drop] = faqsAsking(server, '课程怎么退款呀').map((f) => f.id);
    server.state.faqs = server.state.faqs.filter((f) => f.id !== drop);
    const p = await runCli(['kb', 'import', '--resume', importId], { home: h });
    assert.equal(p.code, 1);
    assert.doesNotMatch(p.stdout, /计划码/);
    assert.deepEqual(stateOf(r).faqIds, {});
    const rv = await revoke(importId, h);
    assert.doesNotMatch(rv.preview.stdout.split('\n').find((l) => l.startsWith('要删')) ?? '', new RegExp(`${keep}`));
    assert.equal(server.state.faqs.some((f) => f.id === keep), true);
  });
});

test('撤回重建一直不落库、给了跳过；期间同事照原样手工恢复了旧 FAQ——跳过重建时不把同事恢复的当成半成品删掉；预演列出所有要删的', async () => {
  await withServer({}, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h);
    assert.equal(r.code, 0, r.stderr);
    const importId = recordOf(r)[1];
    const route = 'POST /api/qa/batch-create';
    const orig = server.routes[route];
    let swallow = 2;
    server.routes[route] = async (rec) => {
      if (rec.body.qaList.some((q) => q.question === '退款多久到账') && swallow > 0) {
        swallow--;
        return { status: 200, body: { code: 0, data: null } };
      }
      return orig(rec);
    };
    assert.equal((await revoke(importId, h)).done.code, 1);
    assert.equal((await revoke(importId, h)).done.code, 1);
    server.state.faqs.push({ id: 6300, kb: KB_FAQ, question: '退款多久到账', answer: '审核通过后三个工作日内原路退回。', isReviewed: true });
    const third = await revoke(importId, h, undefined, ['--skip-rebuild']);
    assert.doesNotMatch(third.preview.stdout.split('\n').filter((l) => l.startsWith('要删') || l.startsWith('  #')).join('\n'), /6300/);
    assert.equal(server.state.faqs.some((f) => f.id === 6300), true);
    assert.notEqual(stateOf(r).revoke.faqIds['7002'], 6300); // 跳过重建的那条不认晚出现的（同事恢复的不当成撤回重建的）
    assert.equal(faqsAsking(server, '课程怎么退款呀').length, 0);
    // 和备份里的旧内容一模一样的：它就是旧内容，别让人删；跳过的那条也不用再手工恢复
    assert.match(third.done.stdout, /#6300「退款多久到账」[^\n]*就是旧内容，留着就行/);
    assert.doesNotMatch(third.done.stdout, /#6300[^\n]*手动删掉/);
    assert.match(third.done.stdout, /FAQ #7002「退款多久到账」[^\n]*库里已经有一模一样的 #6300，不用再恢复/);
  });
});

test('撤回：旧文件里有一段原来就没向量化成功——重建之后不等它，撤回做得完', async () => {
  const BAD = '〓〓〓（扫描件解析出来的乱码段）';
  const paragraphRows = importParagraphRows().map((p) => (p.id === 9102 ? { ...p, content: BAD, status: 'failed' } : p));
  await withServer({ paragraphRows }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h);
    assert.equal(r.code, 0, r.stderr);
    const route = 'GET /api/knowledge-base/file/paragraphs';
    const orig = server.routes[route];
    server.routes[route] = async (rec) => {
      const reply = await orig(rec);
      for (const p of reply.body?.data ?? []) if (p.content === BAD) p.status = 'failed';
      return reply;
    };
    const rv = await revoke(recordOf(r)[1], h, { MD_KB_WAIT_S: '0.2' });
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.equal(faqsAsking(server, '课程怎么退款呀').length, 0);
    assert.equal(docsNamed(server, '新价格表').length, 0);
  });
});

test('撤回：重建文件的一段秒懂回 500（不是 4xx）——失败两次之后预演给出 --skip-rebuild；加上之后这次导入建的都删掉', async () => {
  const paragraphRows = importParagraphRows().map((p) => (p.id === 9102 ? { ...p, content: `价格说明：${'长'.repeat(1100)}` } : p));
  await withServer({ paragraphRows }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h);
    assert.equal(r.code, 0, r.stderr);
    const route = 'POST /api/knowledge-base/file/manual-create-paragraph';
    const orig = server.routes[route];
    server.routes[route] = async (rec) => ([...rec.body.content].length > 1000 ? { status: 500, body: { statusCode: 500, message: 'Internal Server Error' } } : orig(rec));
    const importId = recordOf(r)[1];
    assert.equal((await revoke(importId, h)).done.code, 1);
    assert.equal((await revoke(importId, h)).done.code, 1);
    const p = await runCli(['kb', 'revoke', importId], { home: h });
    assert.match(p.stdout, /--skip-rebuild/);
    const skipped = await revoke(importId, h, undefined, ['--skip-rebuild']);
    assert.match(skipped.preview.stdout, /重建不了[^\n]*文件 #601「旧价格表」/);
    assert.equal(skipped.done.code, 1);
    assert.equal(faqsAsking(server, '课程怎么退款呀').length, 0);
    assert.equal(docsNamed(server, '新价格表').length, 0);
  });
});

test('导入停在第一步「快照」；「删旧的、加同一个问题」的包续跑——不把包里要删的旧 FAQ 当成别人加的拦下，做得完、先备份再删', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ faqs: [faq('f1', '退款多久到账', '审核通过后一个工作日内原路退回。')], docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])], deletes: [{ type: 'faq', id: 7002, question: '退款多久到账' }] });
    const code = await previewCode(dir, h);
    const route = 'POST /api/qa/list';
    const orig = server.routes[route];
    let n = 0;
    server.routes[route] = async (rec) => (++n === 2 ? { status: 502, body: { statusCode: 502, message: 'Bad Gateway' } } : orig(rec));
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    server.routes[route] = orig;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「快照」/);
    const { preview, done } = await resume(recordOf(r)[1], h);
    assert.doesNotMatch(preview.stdout + preview.stderr, /问题一样/);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(faqsAsking(server, '退款多久到账').map((f) => f.answer), ['审核通过后一个工作日内原路退回。']);
    assert.ok(existsSync(join(recordOf(r)[2], 'backup', 'faqs.jsonl')));
  });
});

test('建文件每次都 504、过一会儿才落库——文件不在事后认；最多攒两个空文件就拒绝续跑（说清楚是列表或落库延迟），不会无限另建', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])] });
    const code = await previewCode(dir, h);
    const route = 'POST /api/knowledge-base/file/manual-create';
    const orig = server.routes[route];
    server.routes[route] = async (rec) => {
      setTimeout(() => orig(rec), 300);
      return gatewayTimeout;
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    const importId = recordOf(r)[1];
    let refused = null;
    for (let i = 0; i < 4 && !refused; i++) {
      await sleep(500);
      const p = await runCli(['kb', 'import', '--resume', importId], { home: h });
      if (!codeOf(p)) refused = p;
      else {
        assert.doesNotMatch(p.stdout, /就是没建成/);
        await runCli(['kb', 'import', '--resume', importId, '--confirm', codeOf(p)], { home: h });
      }
    }
    assert.ok(refused, '续跑一直没被拒绝');
    assert.match(refused.stderr, /延迟/);
    await sleep(500);
    assert.ok(docsNamed(server, '新价格表').length <= 2, `攒了 ${docsNamed(server, '新价格表').length} 个空文件`);
  });
});

test('这次导入做完了，但有晚出现、没认下的同名空文件（可能是这次晚落库的）——完成时就说出来，不等到撤回', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])] });
    const code = await previewCode(dir, h);
    const route = 'POST /api/knowledge-base/file/manual-create';
    const orig = server.routes[route];
    let first = true;
    server.routes[route] = async (rec) => {
      if (!first) return orig(rec);
      first = false;
      setTimeout(() => orig(rec), 300);
      return gatewayTimeout;
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    await sleep(600);
    const [late] = docsNamed(server, '新价格表');
    const { done } = await resume(recordOf(r)[1], h);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, new RegExp(`#${late.id}「新价格表」[^\\n]*可能是这次晚落库的`));
  });
});
