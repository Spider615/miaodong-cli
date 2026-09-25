// md kb find（spec 3a §3.4）：文字命中（含未审核）、语义最像（不含未审核、只回 0.8 以上的、带分数）、问题相似（含未审核）；文件库查段落；--local 不发请求
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ, faqs, kbList } from './helpers/kb-fixtures.mjs';

let server;
before(async () => { server = await startKbServer(); });
after(() => server.close());
function home(origin = server.origin) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const semanticPart = (stdout) => stdout.split('语义最像')[1].split('问题相似')[0];

test('md kb find：文字命中含未审核；语义最像不含未审核；问题相似列出未审核的', async () => {
  const r = await md(['kb', 'find', '售后 FAQ', '课程可以退吗']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], '测试区 / 兴趣岛平台 / 售后 FAQ (aaaa0001)');
  assert.match(r.stdout, /文字命中：FAQ 1 条、段落 0 条\n  #7004 课程可以退吗 \[未审核\]/);
  // 7004 和这句话一字不差，但未审核、不在语义索引里；7001 只有 0.2，低于 0.8 语义搜索不返回
  assert.equal(semanticPart(r.stdout), '（前 0 条；只返回相似度 0.8 以上的，未审核的不在语义索引里）：\n');
  assert.match(r.stdout.split('问题相似')[1], /#7004 课程可以退吗 \[未审核\] 1\.000/);
});

test('md kb find：语义最像带分数（就是大模型知识库工具的分数，spec §2.3）', async () => {
  const r = await md(['kb', 'find', '售后 FAQ', '课程怎么退']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(semanticPart(r.stdout), /（前 1 条；.*）：\n  #7001 课程怎么退款 \[已审核\] 0\.889\n/);
});

test('md kb find：答案只显示前 60 个字', async () => {
  const long = '很长的答案'.repeat(20);
  const s = await startKbServer({ faqRows: [...faqs(), { id: 7005, kb: KB_FAQ, question: '长答案', answer: long, isReviewed: true }] });
  try {
    const r = await runCli(['kb', 'find', '售后 FAQ', '长答案'], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`答：${long.slice(0, 60)}…`));
    assert.ok(!r.stdout.includes(long.slice(0, 61)));
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb find：只有文件的库查段落文字，并说明没有语义搜索', async () => {
  const r = await md(['kb', 'find', '产品手册', '退款']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /文字命中：FAQ 0 条、段落 1 条/);
  assert.match(r.stdout, /段落 #9001（手册\.pdf）\[ready\] 课程退款规则/);
  assert.match(r.stdout, /文件段落没有语义搜索接口，分数要用 md trial 看/);
});

test('md kb find --local：只在最近一次 pull 的副本里找、不发任何请求；没 pull 过就提示先 pull', async () => {
  const h = home();
  const none = await md(['kb', 'find', '售后 FAQ', '退款', '--local'], h);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /先 md kb pull 售后 FAQ/);
  await md(['kb', 'pull', '售后 FAQ'], h);
  const before = server.requests.length;
  const r = await md(['kb', 'find', '售后 FAQ', '退款', '--local'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /本机副本（.+）文字命中：FAQ 2 条、段落 0 条/);
  assert.equal(server.requests.length, before);
  assert.deepEqual(server.unexpected(), []);
});

test('md kb find：同一条 FAQ 在语义索引里占好几行时，语义最像里只列一次（分数取最高的那行）', async () => {
  const s = await startKbServer({ faqRows: faqs().map((f) => (f.id === 7001 ? { ...f, vectors: ['课程怎么退款呢'] } : f)) });
  try {
    const r = await runCli(['kb', 'find', '售后 FAQ', '课程怎么退款'], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(semanticPart(r.stdout), /^（前 1 条；.*）：\n  #7001 课程怎么退款 \[已审核\] 1\.000\n/);
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb find：平台没给各类条数时不当成 0——照样查 FAQ，列表里显示 ?（整支审查小问题 4）', async () => {
  const s = await startKbServer({ kbs: kbList().map(({ qaCount, fileCount, pageCount, videoCount, ...k }) => k) });
  try {
    const r = await runCli(['kb', 'find', '售后 FAQ', '课程怎么退'], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(semanticPart(r.stdout), /#7001 课程怎么退款 \[已审核\] 0\.889/);
    const l = await runCli(['kb', 'list'], { home: home(s.origin) });
    assert.match(l.stdout, /售后 FAQ \(aaaa0001\)\s+FAQ \? · 文件 \? · 网页 \? · 视频 \?/);
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb find：认不出审没审核的 FAQ 标成「审核状态认不出」，不标成未审核（整支审查小问题 4）', async () => {
  const s = await startKbServer({ omitFaqFields: ['isReviewed'] });
  try {
    const r = await runCli(['kb', 'find', '售后 FAQ', '课程可以退吗'], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /#7004 课程可以退吗 \[审核状态认不出\]/);
    assert.doesNotMatch(r.stdout, /未审核\]/);
  } finally {
    await s.close();
  }
});

test('md kb find：文字命中超过 20 条时照实报条数，只列前 20 条（整支审查小问题 6）', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: 7200 + i, kb: KB_FAQ, question: `退款问题${i + 1}`, answer: '看订单页。', isReviewed: true }));
  const s = await startKbServer({ faqRows: [...faqs(), ...many] });
  try {
    const r = await runCli(['kb', 'find', '售后 FAQ', '退款问题'], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /文字命中：FAQ 25 条、段落 0 条（只列前 20 条）/);
    const textPart = r.stdout.split('文字命中')[1].split('语义最像')[0];
    assert.equal((textPart.match(/^  #\d+ /gm) ?? []).length, 20);
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb find --local：最近一次 pull 写了一半（没有 meta.json）时，用之前完整的那份（整支审查小问题 8）', async () => {
  const h = home();
  const pulled = await md(['kb', 'pull', '售后 FAQ'], h);
  const dir = pulled.stdout.match(/已存：(\S+)/)[1];
  const partial = join(dirname(dir), '29991231-235959');
  mkdirSync(partial);
  writeFileSync(join(partial, 'faqs.jsonl'), '');
  const r = await md(['kb', 'find', '售后 FAQ', '退款', '--local'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /本机副本（.+）文字命中：FAQ 2 条、段落 0 条/);
});

test('md kb find：用法里写着 --region / --org（整支审查小问题 9）', async () => {
  const r = await md(['kb', 'find']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /md kb find <知识库> "<一句话>" \[--local\] \[--region <区>\] \[--org <企业>\]/);
});
