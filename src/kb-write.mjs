// 知识库的写接口（spec 3b §2.1），以及备份要用的原始读取。只有 md kb import / revoke 用它：查 case 的命令一个都不 import 这里。
// 参数照 09-25 从控制台前端代码（1.18.4）核对的来。两个「新建」都不返回 id：调用方按快照对账找回 id（3b §2.1）。
import { request } from './http.mjs';
import { FAQ_FILTER, PAGE_SIZE, allPages, pageOf } from './kb.mjs';

export const WRITE_BATCH = 50; // 每批不超过 50 条，串行（接口文档的建议）
const DOWNLOAD_TIMEOUT_MS = 120_000;

const post = (identity, orgId, path, body) => request(identity, path, { method: 'POST', query: { orgId }, body });

export async function createFaqs(identity, orgId, kbId, items) {
  await post(identity, orgId, '/api/qa/batch-create', {
    knowledgeBaseId: kbId,
    qaList: items.map((q) => ({ question: q.question, answer: q.answer, materialList: [], mhMaterialIds: [] })),
  });
}

export async function reviewFaqs(identity, orgId, kbId, ids) {
  await post(identity, orgId, '/api/qa/batch-review', { knowledgeBaseId: kbId, ids });
}

export async function deleteFaqs(identity, orgId, kbId, ids) {
  await post(identity, orgId, '/api/qa/batch-delete', { knowledgeBaseId: kbId, ids });
}

export async function createManualDoc(identity, orgId, kbId, name) {
  await post(identity, orgId, '/api/knowledge-base/file/manual-create', { knowledgeBaseId: kbId, name });
}

export async function createParagraph(identity, orgId, kbId, docId, content) {
  await post(identity, orgId, '/api/knowledge-base/file/manual-create-paragraph', { knowledgeBaseId: kbId, docId, content });
}

export async function deleteDoc(identity, orgId, kbId, docId) {
  await post(identity, orgId, '/api/knowledge-base/file/delete', { knowledgeBaseId: kbId, id: docId });
}

export async function updateAbstract(identity, orgId, kbId, docId, abstract) {
  await post(identity, orgId, '/api/knowledge-base/file/update-abstract', { knowledgeBaseId: kbId, docId, abstract });
}

// 备份用：FAQ 的原始行（带素材字段），全部分页
export async function listFaqRows(identity, orgId, kbId) {
  return allPages(async (current) => pageOf(await request(identity, '/api/qa/list', {
    method: 'POST',
    query: { orgId },
    body: { knowledgeBaseId: kbId, current, pageSize: PAGE_SIZE, filterType: FAQ_FILTER.ALL, sortType: 'DEFAULT' },
  })));
}

// 备份用：文件详情的原始字段（原文件地址 docUrl、标签、摘要、段落数）
export async function docDetailRaw(identity, orgId, kbId, docId) {
  return (await request(identity, '/api/knowledge-base/file/details', { query: { orgId, knowledgeBaseId: kbId, docId } }))?.data ?? {};
}

// 备份用：一个文件的全部段落原样
export async function listParagraphRows(identity, orgId, kbId, docId) {
  return allPages(async (current) => pageOf(await request(identity, '/api/knowledge-base/file/paragraphs', {
    query: { orgId, knowledgeBaseId: kbId, id: String(docId), current, pageSize: PAGE_SIZE },
  })));
}

// 下载原文件：地址在对象存储上，不带身份（绝不能把 token 带给别的主机）
export async function downloadOriginal(url, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`下载原文件失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

