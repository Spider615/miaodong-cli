// 3b 整支审查的修复（C1、C2、I1-I5）：导入、续跑、撤回只认「自己的请求前后多出来、内容对得上」的条目，别人的一律不碰；
// 写进去、回复丢了的认得回来，不重复建；认不出的不删、列出来，撤回不假装做干净了；同一个库同一时间只有一个 md 在写
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ok } from './helpers/fake-miaodong.mjs';
import { runCli } from './helpers/run-cli.mjs';
import { KB_FAQ } from './helpers/kb-fixtures.mjs';
import { doc, faq, writePackage } from './helpers/kb-import-fixtures.mjs';
import { goodPackage, importFileRows } from './helpers/kb-import-data.mjs';
import { codeOf, confirmImport, previewCode, recordOf, resume, revoke, withServer } from './helpers/kb-import-cli.mjs';

const sixty = () => ({ faqs: Array.from({ length: 60 }, (_, i) => faq(`f${i + 1}`, `批量问题${i + 1}`)) });
const lockPath = (h) => join(h, 'md', 'kb-imports', 'k1', KB_FAQ.slice(0, 8), '.lock');
const colleagueDoc = (id, name, content) => ({
  file: { id, kb: KB_FAQ, name, extension: '', status: 'ready', manual: true, tags: [], abstract: '', original: '' },
  paragraph: { id: id * 10 + 1, fileId: id, index: 0, content, wordCount: [...content].length, status: 'ready' },
});
const touched = (server, docId) => server.requests.filter((q) => (q.path === '/api/knowledge-base/file/manual-create-paragraph' && q.body.docId === docId)
  || (q.path === '/api/knowledge-base/file/delete' && q.body.id === docId));

test('试写：建文件的请求回了成功、库里却没有，同一时间同事传了一个文件——不往它里面写、不删它；停下并把它列出来', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])] });
    const code = await previewCode(dir, h);
    const route = 'POST /api/knowledge-base/file/manual-create';
    const orig = server.routes[route];
    let first = true;
    server.routes[route] = async (rec) => {
      if (!first) return orig(rec);
      first = false;
      const c = colleagueDoc(7777, '同事刚上传的售后手册.pdf', '同事的第一段');
      server.state.files.push(c.file);
      server.state.paragraphs.push(c.paragraph);
      return ok(null);
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「试写一条」/);
    assert.match(r.stderr, /#7777「同事刚上传的售后手册\.pdf」/);
    assert.deepEqual(touched(server, 7777), []);
    assert.deepEqual(server.state.paragraphs.filter((p) => p.fileId === 7777).map((p) => p.content), ['同事的第一段']);
  });
});

test('续跑：导入停下之后同事建了一个同名文件——续跑不认它、不写它、不删它，另建自己的；撤回也只删自己建的', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [2] } }, async (server, h) => {
    const dir = writePackage({ faqs: [faq('f1', '新问题一'), faq('f2', '新问题二')], docs: [doc('d1', '价格表一', ['一']), doc('d2', '价格表二', ['二'])] });
    const r = await confirmImport(dir, h);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「建 FAQ」/);
    const importId = recordOf(r)[1];
    const c = colleagueDoc(8888, '价格表二', '同事自己写的价格：月卡 499');
    server.state.files.push(c.file);
    server.state.paragraphs.push(c.paragraph);

    const { done } = await resume(importId, h);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(touched(server, 8888), []);
    assert.deepEqual(server.state.paragraphs.filter((p) => p.fileId === 8888).map((p) => p.content), ['同事自己写的价格：月卡 499']);
    const mine = server.state.files.filter((f) => f.name === '价格表二' && f.id !== 8888);
    assert.equal(mine.length, 1);
    assert.deepEqual(server.state.paragraphs.filter((p) => p.fileId === mine[0].id).map((p) => p.content), ['二']);

    const rv = await revoke(importId, h);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.equal(server.state.files.some((f) => f.id === 8888), true);
    assert.equal(server.state.files.some((f) => f.id === mine[0].id || f.name === '价格表一'), false);
  });
});

test('撤回：这次导入什么都没建成，之后另一次导入建了一模一样的 FAQ——撤回这次不能把它认成自己的', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [1] } }, async (server, h) => {
    const r1 = await confirmImport(writePackage({ faqs: [faq('f1', '课程怎么退款呀', '答案一')] }), h);
    assert.equal(r1.code, 1);
    const first = recordOf(r1)[1];
    const r2 = await confirmImport(writePackage({ faqs: [faq('f1', '课程怎么退款呀', '答案一'), faq('f2', '另一个问题')] }), h);
    assert.equal(r2.code, 0, r2.stderr);
    const theirs = server.state.faqs.find((f) => f.question === '课程怎么退款呀');

    const rv = await revoke(first, h);
    assert.match(rv.preview.stdout, /要删（这次建的，还在库里的）：没有/);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.equal(server.state.faqs.some((f) => f.id === theirs.id), true);
  });
});

test('撤回：这次导入什么都没建成，运营之后手工加了同一个问题（答案不一样）——撤回不删它', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [1] } }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h);
    assert.equal(r.code, 1);
    server.state.faqs.push({ id: 5555, kb: KB_FAQ, question: '课程怎么退款呀', answer: '运营手写的答案', isReviewed: true });
    const rv = await revoke(recordOf(r)[1], h);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.equal(server.state.faqs.some((f) => f.id === 5555), true);
  });
});

test('秒懂改写了第 2 条的问题（全角括号变半角）——停下，不重复建；撤回删掉认得出的，认不出的不删、列出来、退出码 1；人删掉之后再撤回一次就干净了', async () => {
  await withServer({ mangle: (s) => s.replace(/（/g, '(').replace(/）/g, ')') }, async (server, h) => {
    const r = await confirmImport(writePackage({ faqs: [faq('f1', '课程怎么退款呀', '答案一'), faq('f2', '退款（部分）怎么算', '答案二')] }), h);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /停在「建 FAQ」：[^\n]*「退款（部分）怎么算」/);
    assert.match(r.stderr, /#90002「退款\(部分\)怎么算」/);
    const importId = recordOf(r)[1];

    const p = await runCli(['kb', 'import', '--resume', importId], { home: h });
    assert.equal(p.code, 0, p.stderr);
    assert.match(p.stdout, /#90002「退款\(部分\)怎么算」/);
    assert.equal(server.state.faqs.filter((f) => f.question.startsWith('退款(部分)')).length, 1);

    const rv = await revoke(importId, h);
    assert.match(rv.preview.stdout, /分不清是不是这次建的[^\n]*#90002「退款\(部分\)怎么算」/);
    assert.equal(rv.done.code, 1);
    assert.match(rv.done.stdout, /撤回做完了，但还有 1 条分不清是不是这次建的，没删：#90002「退款\(部分\)怎么算」/);
    assert.equal(server.state.faqs.some((f) => f.question === '课程怎么退款呀'), false);
    assert.equal(server.state.faqs.filter((f) => f.question.startsWith('退款(部分)')).length, 1);

    server.state.faqs = server.state.faqs.filter((f) => f.id !== 90002);
    const again = await runCli(['kb', 'revoke', importId], { home: h });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /这次导入已经撤回了/);
    assert.match(again.stdout, /分不清是不是这次建的那 1 条已经不在了/);
  });
});

for (const route of ['POST /api/qa/batch-create', 'POST /api/knowledge-base/file/manual-create']) {
  test(`试写的请求写进去了、回复丢了（${route}）——认得回来，接着做完，不重复建`, async () => {
    await withServer({ failOn: { [route]: [{ n: 1, applied: true }] } }, async (server, h) => {
      const r = await confirmImport(writePackage(goodPackage()), h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(server.state.faqs.filter((f) => f.question === '课程怎么退款呀').length, 1);
      assert.equal(server.state.files.filter((f) => f.name === '新价格表').length, 1);
    });
  });
}

test('撤回重建文件的请求写进去了、回复丢了——认得回来，接着做完，不重复建', async () => {
  await withServer({ failOn: { 'POST /api/knowledge-base/file/manual-create': [{ n: 2, applied: true }] } }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h);
    assert.equal(r.code, 0, r.stderr);
    const rv = await revoke(recordOf(r)[1], h);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.equal(server.state.files.filter((f) => f.name === '旧价格表').length, 1);
    assert.equal(server.state.files.some((f) => f.name === '新价格表'), false);
  });
});

test('两个续跑同时确认——同一个库同一时间只有一个 md 在写，不重复建', async () => {
  await withServer({ failOn: { 'POST /api/qa/batch-create': [3] } }, async (server, h) => {
    const r = await confirmImport(writePackage(sixty()), h);
    assert.equal(r.code, 1);
    const importId = recordOf(r)[1];
    const code = codeOf(await runCli(['kb', 'import', '--resume', importId], { home: h }));
    const both = await Promise.all([1, 2].map(() => runCli(['kb', 'import', '--resume', importId, '--confirm', code], { home: h })));
    assert.ok(both.some((x) => x.code === 0), both.map((x) => x.stderr).join('\n'));
    for (const x of both.filter((y) => y.code !== 0)) {
      assert.equal(x.code, 5);
      assert.match(x.stderr, /另一个 md 进程（pid \d+）正在写这个库/);
    }
    assert.equal(server.state.faqs.filter((f) => f.kb === KB_FAQ && f.question.startsWith('批量问题')).length, 60);
  });
});

test('库被别的 md 进程锁着——确认直接停（退出码 5），一个写请求都不发；锁的主人已经不在了就接过来', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage(goodPackage());
    const code = await previewCode(dir, h);
    mkdirSync(dirname(lockPath(h)), { recursive: true });
    writeFileSync(lockPath(h), JSON.stringify({ pid: process.pid, importId: '别的导入', at: new Date().toISOString() }));
    const locked = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(locked.code, 5);
    assert.match(locked.stderr, new RegExp(`另一个 md 进程（pid ${process.pid}）正在写这个库`));
    assert.deepEqual(server.writes(), []);

    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(lockPath(h), JSON.stringify({ pid: gone, importId: '别的导入', at: new Date().toISOString() }));
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 0, r.stderr);
  });
});

test('确认那一次运行里导入包被改了——按确认时对过计划码的那一份写，记录里拷的也是那一份', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage(goodPackage());
    const original = readFileSync(join(dir, 'faqs.jsonl'), 'utf-8');
    const code = await previewCode(dir, h);
    const route = 'GET /api/canvas/get';
    const orig = server.routes[route];
    let armed = true;
    server.routes[route] = async (rec) => {
      if (armed) {
        armed = false;
        writeFileSync(join(dir, 'deletes.jsonl'), [
          { type: 'faq', id: 7002, question: '退款多久到账' }, { type: 'doc', id: 601, name: '旧价格表' },
          { type: 'doc', id: 602, name: '带标签的文件' }, { type: 'faq', id: 7010, question: '带图的问题' },
        ].map((x) => JSON.stringify(x)).join('\n'));
        writeFileSync(join(dir, 'faqs.jsonl'), JSON.stringify(faq('f1', '课程怎么退款呀', '用户从没看过的答案')));
      }
      return orig(rec);
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(server.state.faqs.find((f) => f.question === '课程怎么退款呀').answer, '在订单详情页申请，七个工作日内到账。');
    assert.equal(server.state.files.some((f) => f.id === 602), true);
    assert.equal(server.state.faqs.some((f) => f.id === 7010), true);
    assert.equal(readFileSync(join(recordOf(r)[2], 'package', 'faqs.jsonl'), 'utf-8'), original);
  });
});

test('同一个导入包在同一个库上已经导入过、没撤回——预演闸门拦下，同一个计划码也用不了第二次', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ docs: [doc('d1', '新价格表', ['瑜伽月卡 399 元'])] });
    const code = await previewCode(dir, h);
    const r1 = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r1.code, 0, r1.stderr);
    const importId = recordOf(r1)[1];
    const again = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.notEqual(again.code, 0);
    assert.match(again.stderr, new RegExp(`这个导入包在这个库上已经导入过：${importId}（已完成）`));
    const p = await runCli(['kb', 'import', dir], { home: h });
    assert.equal(p.code, 1);
    assert.doesNotMatch(p.stdout, /计划码/);
    assert.equal(server.state.files.filter((f) => f.name === '新价格表').length, 1);
    // 撤回之后可以重新导入
    const rv = await revoke(importId, h);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.equal((await confirmImport(dir, h)).code, 0);
  });
});

test('备份之后有人给要删的 FAQ 配了图、给要删的文件打了标签——续跑预演列出还要删的；删旧的这一步停下，一条都不删', async () => {
  await withServer({ readyAfter: 1e9 }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h, { MD_KB_WAIT_S: '0.05' });
    assert.match(r.stderr, /停在「等向量化」/);
    server.state.faqs.find((f) => f.id === 7002).materials = [{ url: 'https://x/b.png', type: 'image' }];
    server.state.files.find((f) => f.id === 601).tags = [{ id: 't9', name: '价格' }];
    server.state.paragraphs.forEach((p) => { p.status = 'ready'; });
    const { preview, done } = await resume(recordOf(r)[1], h);
    assert.match(preview.stdout, /还要删：FAQ #7002「退款多久到账」、文件 #601「旧价格表」/);
    assert.equal(done.code, 1);
    assert.match(done.stderr, /停在「删旧的」：[^\n]*FAQ #7002 带图片或素材[^\n]*文件 #601「旧价格表」带知识标签/);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), true);
    assert.equal(server.state.files.some((f) => f.id === 601), true);
    assert.equal(server.writes().filter((q) => q.path === '/api/qa/batch-delete' || q.path === '/api/knowledge-base/file/delete').length, 0);
  });
});

test('预演：要删的 FAQ 带知识标签——闸门没过（撤回时恢复不了标签）', async () => {
  await withServer({}, async (server, h) => {
    server.state.faqs.find((f) => f.id === 7002).tags = [{ id: 't1', name: '售后' }];
    const r = await runCli(['kb', 'import', writePackage(goodPackage())], { home: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /要删的 FAQ #7002 带知识标签，md 恢复不了标签，不能删/);
  });
});

test('要删的在备份之后被别人删了——导入照样做完、说明不是这次删的；撤回不把它复活', async () => {
  await withServer({ readyAfter: 1e9 }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h, { MD_KB_WAIT_S: '0.05' });
    assert.match(r.stderr, /停在「等向量化」/);
    server.state.faqs = server.state.faqs.filter((f) => f.id !== 7002);
    server.state.paragraphs.forEach((p) => { p.status = 'ready'; });
    const importId = recordOf(r)[1];
    const { done } = await resume(importId, h);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /FAQ #7002 在删之前已经不在了（不是这次删的，撤回时也不会重建）/);
    const tick = setInterval(() => server.state.paragraphs.forEach((p) => { p.status = 'ready'; }), 5);
    const rv = await revoke(importId, h).finally(() => clearInterval(tick));
    assert.match(rv.preview.stdout, /要重建（这次删的，从备份）：FAQ 0 条 · 文件 1 个/);
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.equal(server.state.faqs.some((f) => f.question === '退款多久到账'), false);
  });
});

test('要删的旧文件一段都没有（比如解析失败的）——撤回照样做完，不会一直等向量化', async () => {
  const failed = { id: 603, kb: KB_FAQ, name: '解析失败的旧文件', extension: 'pdf', status: 'failed' };
  await withServer({ fileRows: [...importFileRows(), failed] }, async (server, h) => {
    const r = await confirmImport(writePackage({ ...goodPackage(), deletes: [{ type: 'doc', id: 603, name: '解析失败的旧文件' }] }), h);
    assert.equal(r.code, 0, r.stderr);
    const rv = await revoke(recordOf(r)[1], h, { MD_KB_WAIT_S: '0.5' });
    assert.equal(rv.done.code, 0, rv.done.stderr);
    assert.equal(server.state.files.filter((f) => f.name === '解析失败的旧文件').length, 1);
  });
});

test('Finder 在导入记录里留下 .DS_Store——撤回、续跑、列记录照常', async () => {
  await withServer({}, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h);
    const [, importId, recDir] = recordOf(r);
    writeFileSync(join(recDir, 'backup', 'docs', '.DS_Store'), 'x');
    writeFileSync(join(dirname(dirname(recDir)), '.DS_Store'), 'x');
    writeFileSync(join(h, 'md', 'kb-imports', '.DS_Store'), 'x');
    const listed = await runCli(['kb', 'imports'], { home: h });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(importId));
    const rv = await revoke(importId, h);
    assert.equal(rv.done.code, 0, rv.done.stderr);
  });
});

test('md kb import --resume 不接导入包目录（两个都给就报用法错，不悄悄忽略）', async () => {
  await withServer({}, async (server, h) => {
    const r = await runCli(['kb', 'import', writePackage(goodPackage()), '--resume', '20260925-000000-abcd'], { home: h });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--resume 不用再给导入包目录/);
  });
});

test('确认过「多出来的不是这次建的」、重发了一次，又对不上——不许再续跑（多半是秒懂改写了内容）：改写过的副本最多多出一份', async () => {
  await withServer({ mangle: (s) => s.replace(/（/g, '(').replace(/）/g, ')') }, async (server, h) => {
    const r = await confirmImport(writePackage({ faqs: [faq('f1', '课程怎么退款呀', '答案一'), faq('f2', '退款（部分）怎么算', '答案二')] }), h);
    assert.equal(r.code, 1);
    const importId = recordOf(r)[1];
    const first = await resume(importId, h); // 用户（判断错了）确认续跑：重发一次，又对不上
    assert.equal(first.done.code, 1);
    assert.match(first.done.stderr, /#90003「退款\(部分\)怎么算」/);
    const again = await runCli(['kb', 'import', '--resume', importId], { home: h });
    assert.equal(again.code, 1);
    assert.doesNotMatch(again.stdout, /计划码/);
    assert.match(again.stderr, /两次都对不上，多半是秒懂改写了这几条的内容，不能再续跑/);
    assert.equal(server.state.faqs.filter((f) => f.question === '退款(部分)怎么算').length, 2);
  });
});

test('撤回之后认不清的那条其实是同事加的——复查时用户确认，md 不再追踪它（秒懂上什么都不动）', async () => {
  await withServer({}, async (server, h) => {
    const dir = writePackage({ faqs: [faq('f1', '课程怎么退款呀', '答案一')] });
    const code = await previewCode(dir, h);
    // 试写建 FAQ 的请求回了成功、库里却没有；同一时间同事加了一条
    const route = 'POST /api/qa/batch-create';
    const orig = server.routes[route];
    let first = true;
    server.routes[route] = async (rec) => {
      if (!first) return orig(rec);
      first = false;
      server.state.faqs.push({ id: 6666, kb: KB_FAQ, question: '同事刚加的问题', answer: '同事的答案', isReviewed: true });
      return ok(null);
    };
    const r = await runCli(['kb', 'import', dir, '--confirm', code], { home: h });
    assert.equal(r.code, 1);
    const importId = recordOf(r)[1];
    const rv = await revoke(importId, h);
    assert.equal(rv.done.code, 1);
    assert.match(rv.done.stdout, /还有 1 条分不清是不是这次建的，没删：#6666「同事刚加的问题」/);
    const listed = await runCli(['kb', 'imports'], { home: h });
    assert.match(listed.stdout, new RegExp(`${importId}  .*  已撤回（有 1 条分不清是不是这次建的，要人看一眼）`));

    const check = await runCli(['kb', 'revoke', importId], { home: h });
    assert.equal(check.code, 1);
    assert.match(check.stdout, /md 不再追踪它们，秒懂上什么都不动/);
    const dismissed = await runCli(['kb', 'revoke', importId, '--confirm', codeOf(check)], { home: h });
    assert.equal(dismissed.code, 0, dismissed.stderr);
    assert.match(dismissed.stdout, /不再追踪：#6666「同事刚加的问题」/);
    assert.equal(server.state.faqs.some((f) => f.id === 6666), true);
    const after = await runCli(['kb', 'revoke', importId], { home: h });
    assert.equal(after.code, 0);
    assert.match(after.stdout, /这次导入已经撤回了/);
  });
});

test('备份之后要删的文件被人改了名——删旧的这一步停下、一条都不删（撤回会按旧名字重建，改名就丢了）', async () => {
  await withServer({ readyAfter: 1e9 }, async (server, h) => {
    const r = await confirmImport(writePackage(goodPackage()), h, { MD_KB_WAIT_S: '0.05' });
    assert.match(r.stderr, /停在「等向量化」/);
    server.state.files.find((f) => f.id === 601).name = '旧价格表（留着）';
    server.state.paragraphs.forEach((p) => { p.status = 'ready'; });
    const { done } = await resume(recordOf(r)[1], h);
    assert.equal(done.code, 1);
    assert.match(done.stderr, /停在「删旧的」：要删的内容在备份之后被人改过：文件 #601「旧价格表（留着）」/);
    assert.equal(server.state.files.some((f) => f.id === 601), true);
    assert.equal(server.state.faqs.some((f) => f.id === 7002), true);
  });
});

test('预演：要删的文件里有超过 1000 字的段落——提醒撤回时可能写不回去（不拦）', async () => {
  await withServer({}, async (server, h) => {
    server.state.paragraphs.find((p) => p.id === 9102).content = '长'.repeat(1001);
    const r = await runCli(['kb', 'import', writePackage(goodPackage())], { home: h });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /要删的文件里有超过 1000 字或空的段落（撤回时要原样写回，秒懂接不接受还没实测，可能撤不回去）：#601「旧价格表」1 段/);
  });
});
