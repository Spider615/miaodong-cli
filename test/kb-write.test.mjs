// 知识库写接口的封装（spec 3b §2.1）：参数照 09-25 从控制台前端代码核对的来；备份用的原始读取；下载原文件不带身份
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createFaqs, createManualDoc, createParagraph, deleteDoc, deleteFaqs, docDetailRaw, downloadOriginal, listFaqRows, listParagraphRows, reviewFaqs, updateAbstract } from '../src/kb-write.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ, KB_FILE } from './helpers/kb-fixtures.mjs';

let server;
before(async () => { server = await startKbServer({ writable: true }); });
after(() => server.close());
const who = () => ({ key: 'k1', label: '测试区', origin: server.origin, token: 'secret-token', orgs: [{ id: 'org-1', name: '兴趣岛平台' }] });
const last = (path) => server.requests.filter((r) => r.path === path).at(-1);

test('kb write：批量新建 FAQ 的参数（带 orgId，素材字段传空）；新 FAQ 默认未审核；审核、删除按 id', async () => {
  await createFaqs(who(), 'org-1', KB_FAQ, [{ question: '新问题', answer: '新答案' }]);
  const r = last('/api/qa/batch-create');
  assert.equal(r.query.orgId, 'org-1');
  assert.deepEqual(r.body, { knowledgeBaseId: KB_FAQ, qaList: [{ question: '新问题', answer: '新答案', materialList: [], mhMaterialIds: [] }] });
  const created = server.state.faqs.find((f) => f.question === '新问题');
  assert.equal(created.isReviewed, false);
  await reviewFaqs(who(), 'org-1', KB_FAQ, [created.id]);
  assert.deepEqual(last('/api/qa/batch-review').body, { knowledgeBaseId: KB_FAQ, ids: [created.id] });
  assert.equal(server.state.faqs.find((f) => f.id === created.id).isReviewed, true);
  await deleteFaqs(who(), 'org-1', KB_FAQ, [created.id]);
  assert.deepEqual(last('/api/qa/batch-delete').body, { knowledgeBaseId: KB_FAQ, ids: [created.id] });
  assert.equal(server.state.faqs.some((f) => f.id === created.id), false);
});

test('kb write：手工建文件、加段落、改摘要、删文件的参数', async () => {
  await createManualDoc(who(), 'org-1', KB_FILE, '价格表');
  assert.deepEqual(last('/api/knowledge-base/file/manual-create').body, { knowledgeBaseId: KB_FILE, name: '价格表' });
  const doc = server.state.files.find((f) => f.name === '价格表');
  await createParagraph(who(), 'org-1', KB_FILE, doc.id, '第一段');
  assert.deepEqual(last('/api/knowledge-base/file/manual-create-paragraph').body, { knowledgeBaseId: KB_FILE, docId: doc.id, content: '第一段' });
  await updateAbstract(who(), 'org-1', KB_FILE, doc.id, '摘要');
  assert.deepEqual(last('/api/knowledge-base/file/update-abstract').body, { knowledgeBaseId: KB_FILE, docId: doc.id, abstract: '摘要' });
  await deleteDoc(who(), 'org-1', KB_FILE, doc.id);
  assert.deepEqual(last('/api/knowledge-base/file/delete').body, { knowledgeBaseId: KB_FILE, id: doc.id });
  assert.equal(server.state.files.some((f) => f.id === doc.id), false);
});

test('kb write：备份用的原始读取——FAQ 原始行带素材字段，文件详情带原文件地址、标签、摘要，段落原样', async () => {
  const rows = await listFaqRows(who(), 'org-1', KB_FAQ);
  assert.deepEqual(Object.keys(rows[0]).includes('materials') && Object.keys(rows[0]).includes('mhMaterialIds'), true);
  const d = await docDetailRaw(who(), 'org-1', KB_FILE, 501);
  assert.equal(d.name, '手册.pdf');
  assert.match(d.docUrl, /\/files\/501\//);
  assert.deepEqual([d.tags, d.abstract, d.paragraphCount], [[], '', 2]);
  const ps = await listParagraphRows(who(), 'org-1', KB_FILE, 501);
  assert.deepEqual(ps.map((p) => [p.id, p.index, p.content]), [[9001, 0, '课程退款规则：开课七天内全额退款。'], [9002, 1, '发票在订单完成后可以申请。']]);
});

test('kb write：下载原文件不带身份（原文件在对象存储上，不能把 token 带给别的主机）', async () => {
  const d = await docDetailRaw(who(), 'org-1', KB_FILE, 501);
  const buf = await downloadOriginal(d.docUrl);
  assert.equal(buf.toString('utf-8'), '手册.pdf 的原文件内容');
  const r = server.requests.filter((x) => x.path.startsWith('/files/')).at(-1);
  assert.equal(r.auth, null);
});

test('kb write：秒懂报错时照实抛出（不吞）', async () => {
  await assert.rejects(() => reviewFaqs(who(), 'org-1', KB_FAQ, [123456]), (e) => e.code === 'upstream' && /batch-review/.test(e.message));
});

test('kb write：写流程用的列表必须完整——翻页不稳（有重复、有漏的）就报 kb_list_unstable，不拿半截列表去认 id', async () => {
  const flaky = await startKbServer({ writable: true, pageCap: 2, overlap: 1 });
  try {
    const me = { ...who(), origin: flaky.origin };
    await assert.rejects(listFaqRows(me, 'org-1', KB_FAQ), (e) => e.code === 'kb_list_unstable' && /翻页不稳/.test(e.message));
    const { listFaqs, listFiles } = await import('../src/kb.mjs');
    await assert.rejects(listFaqs(me, 'org-1', KB_FAQ, { checked: true }), (e) => e.code === 'kb_list_unstable');
    assert.ok((await listFaqs(me, 'org-1', KB_FAQ)).length > 0); // 查 case 的读命令不受影响
    assert.ok(Array.isArray(await listFiles(me, 'org-1', KB_FILE, { checked: true })));
  } finally {
    await flaky.close();
  }
});
