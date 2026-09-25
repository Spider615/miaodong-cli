// 知识库读接口（spec 3a §2.1、§2.2）：字段统一、按 total 分页读全、filterType 只传数字、段落带 knowledgeBaseId、qaId 统一成 id、只读
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { checkSimilarity, faqMetrics, fileDetails, firstPerFaq, kbDetails, listFaqs, listKbs, listParagraphs, normalizeFaq, normalizeKb, searchFaqs } from '../src/kb.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ, KB_FILE } from './helpers/kb-fixtures.mjs';

let server;
let capped;
before(async () => {
  server = await startKbServer();
  capped = await startKbServer({ pageCap: 1 });
});
after(async () => {
  await server.close();
  await capped.close();
});
const who = (s) => ({ key: 'k1', label: '测试区', origin: s.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }] });

test('kb api：服务端每页只给 1 条时，也按 page.total 把知识库和 FAQ 读全（Review Focus 1）', async () => {
  const kbs = await listKbs(who(capped), 'org-1');
  assert.deepEqual(kbs.map((k) => k.name), ['售后 FAQ', '产品手册', '财务 FAQ']);
  assert.deepEqual(kbs[0], { id: KB_FAQ, name: '售后 FAQ', faqCount: 4, fileCount: 0, webCount: 0, videoCount: 0, model: 'text-embedding-ada-002' });
  assert.equal((await listFaqs(who(capped), 'org-1', KB_FAQ)).length, 4);
});

test('kb api：FAQ 列表的 filterType 只传数字——传字符串时服务端只回未审核的（spec §2.2 第 1 条）', async () => {
  const all = await listFaqs(who(server), 'org-1', KB_FAQ);
  assert.deepEqual(all.map((f) => [f.id, f.reviewed]), [[7001, true], [7002, true], [7003, true], [7004, false]]);
  const bodies = server.requests.filter((r) => r.path === '/api/qa/list').map((r) => r.body);
  assert.ok(bodies.length > 0 && bodies.every((b) => typeof b.filterType === 'number'));
});

test('kb api：详情的字段名统一成列表那一套（knowledgeBaseId → id，docCount → fileCount）；FAQ 统计', async () => {
  assert.deepEqual(await kbDetails(who(server), 'org-1', KB_FILE), { id: KB_FILE, name: '产品手册', faqCount: 0, fileCount: 1, webCount: 0, videoCount: 0, model: 'text-embedding-ada-002' });
  assert.deepEqual(await faqMetrics(who(server), 'org-1', KB_FAQ), { total: 4, reviewed: 3, unreviewed: 1 });
});

test('kb api：语义搜索只回已审核、0.8 以上的，带分数；文字搜索含未审核；相似度检查的 qaId 统一成 id', async () => {
  const semantic = await searchFaqs(who(server), 'org-1', KB_FAQ, '课程怎么退款');
  assert.deepEqual(semantic.map((f) => [f.id, f.similarity]), [[7001, 1]]);
  const text = await searchFaqs(who(server), 'org-1', KB_FAQ, '课程可以退吗', { mode: 'text' });
  assert.deepEqual(text.map((f) => f.id), [7004]);
  const similar = await checkSimilarity(who(server), 'org-1', KB_FAQ, '课程可以退吗');
  assert.deepEqual(similar[0], { id: 7004, question: '课程可以退吗', answer: '开课七天内可以全额退。', reviewed: false, generated: false, duplicateStatus: 'normal', similarity: 1 });
});

test('kb api：段落列表同时带数字 id 和 knowledgeBaseId（缺了服务端回 400，spec §2.2 第 2 条）；文件详情', async () => {
  const ps = await listParagraphs(who(server), 'org-1', KB_FILE, 501);
  assert.deepEqual(ps.map((p) => [p.id, p.status]), [[9001, 'ready'], [9002, 'processing']]);
  const q = server.requests.filter((r) => r.path === '/api/knowledge-base/file/paragraphs').at(-1).query;
  assert.deepEqual([q.knowledgeBaseId, q.id], [KB_FILE, '501']);
  assert.deepEqual(await fileDetails(who(server), 'org-1', KB_FILE, 501), { id: 501, name: '手册.pdf', status: 'ready', paragraphCount: 2 });
});

test('kb api：只调读接口', () => {
  assert.deepEqual([...server.unexpected(), ...capped.unexpected()], []);
});

test('kb api：语义搜索一行一个向量，同一条 FAQ 可能占好几行；firstPerFaq 每条只留分数最高的那行（09-25 真机验收）', () => {
  const rows = [{ id: 1, similarity: 0.99 }, { id: 2, similarity: 0.95 }, { id: 1, similarity: 0.9 }, { id: 3, similarity: 0.85 }];
  assert.deepEqual(firstPerFaq(rows), [{ id: 1, similarity: 0.99 }, { id: 2, similarity: 0.95 }, { id: 3, similarity: 0.85 }]);
});

test('kb api：字段认不出时不猜——审核状态、各类条数缺了就是 null，不当成「未审核」「0 条」（整支审查小问题 4）', () => {
  assert.equal(normalizeFaq({ id: 1, question: 'q' }).reviewed, null);
  assert.equal(normalizeFaq({ id: 1, isReviewed: false }).reviewed, false);
  assert.equal(normalizeFaq({ qaId: 1, reviewed: true }).reviewed, true);
  assert.deepEqual(normalizeKb({ id: 'k', name: 'n' }), { id: 'k', name: 'n', faqCount: null, fileCount: null, webCount: null, videoCount: null, model: '' });
});
