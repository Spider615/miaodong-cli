// md kb import 的预演（spec 3b §4.1）：只读。找目标库、核对要删的、查重复、扫引用这个库的智能体、给计划码。
// 闸门没过（blockers 不空）就一条都不写：包过时了（要删的不在、名字对不上）、要删的东西恢复不了（带素材或标签的 FAQ、
// 认不出审核状态的 FAQ、带知识标签的文件）、新 FAQ 和库里原有又不删的 FAQ 完全一样（重复会互相挤占名次）。
import { getCanvas, listVersions } from './api.mjs';
import { hashOf } from './canvas.mjs';
import { confirmCode } from './confirm.mjs';
import { EXIT, MdError } from './errors.mjs';
import { checkSimilarity, listFiles, listKbs, normalizeFaq } from './kb.mjs';
import { LIMITS, textKey } from './kb-package.mjs';
import { kbRefs } from './kb-refs.mjs';
import { orgEntries } from './kb-target.mjs';
import { docDetailRaw, listFaqRows, listParagraphRows } from './kb-write.mjs';
import { filterEntries, loadBotDirectory } from './target.mjs';

export const SIMILAR_THRESHOLD = 0.9; // 很像的 FAQ 只提醒，不拦
const SIMILARITY_CONCURRENCY = 4;
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// 删了之后撤回恢复不了的（撤回只能重建问题、答案、审核状态，文件只能重建段落和摘要，spec 3b §2.3）。
// 预演、备份、删之前都查一遍：备份之后才有人配图、打标签的，也要拦下（审查 I3）。返回 { reason, why }，恢复得了是 null
export function unrestorable(type, row) {
  if (type === 'faq') {
    if (arr(row.materials).length || arr(row.materialList).length || arr(row.mhMaterialIds).length) return { reason: '带图片或素材', why: 'md 恢复不了它' };
    if (arr(row.tags).length) return { reason: '带知识标签', why: 'md 恢复不了标签' };
    if (normalizeFaq(row).reviewed === null) return { reason: '认不出是不是已审核', why: 'md 没法照原样恢复它' };
    return null;
  }
  if (arr(row.tags).length) return { reason: '带知识标签', why: 'md 恢复不了标签' };
  return null;
}

// 并发跑 fn，最多 n 个同时在跑，结果按原顺序
export async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// 在本机身份能看到的企业里按 id 找目标库
export async function findKbById(kbId, { region, org } = {}) {
  const hits = [];
  for (const target of filterEntries(orgEntries(), { region, org })) {
    const kb = (await listKbs(target.identity, target.orgId)).find((k) => k.id === kbId);
    if (kb) hits.push({ target, kb });
  }
  if (!hits.length) throw new MdError('kb_not_found', `本机身份能看到的企业里都没有知识库 ${kbId}`, { exitCode: EXIT.TARGET, hint: '核对 manifest.json 里的 kb.id；md kb list 看各企业有哪些库' });
  if (hits.length > 1) {
    const lines = hits.map((h) => `  - ${h.target.regionLabel} / ${h.target.orgName}`).join('\n');
    throw new MdError('kb_ambiguous', `知识库 ${kbId} 在 ${hits.length} 个企业里都有：\n${lines}`, { exitCode: EXIT.TARGET, hint: '加 --region 或 --org 指定' });
  }
  return hits[0];
}

// 这个企业里，线上版和草稿里有节点引用这个库的智能体
export async function affectedBots(target, kbId) {
  const bots = (await loadBotDirectory()).filter((b) => b.identityKey === target.identityKey && b.orgId === target.orgId);
  const nodesOf = (canvas) => [...new Set(kbRefs(canvas.rawCanvas).filter((r) => r.kbIds.includes(kbId)).map((r) => r.nodeName))];
  const found = [];
  for (const b of bots) {
    try {
      const draft = await getCanvas(target.identity, target.orgId, b.botId);
      const online = (await listVersions(target.identity, target.orgId, draft.canvasId)).find((v) => v.versionType === 'online');
      const onlineNodes = online ? nodesOf(await getCanvas(target.identity, target.orgId, b.botId, online.canvasId)) : [];
      const draftNodes = nodesOf(draft);
      if (onlineNodes.length || draftNodes.length) found.push({ botId: b.botId, botName: b.botName, onlineVersion: online?.version ?? null, onlineNodes, draftNodes });
    } catch (error) {
      if (error instanceof MdError && error.code === 'auth_expired') throw error;
      found.push({ botId: b.botId, botName: b.botName, error: error.message });
    }
  }
  return found;
}

// 预演：全部检查只读。返回闸门结论、提醒、要删对象的现状（进计划码）、增删条数
export async function planImport({ target, kb, pkg }) {
  const { identity, orgId } = target;
  const faqRows = await listFaqRows(identity, orgId, kb.id);
  const faqById = new Map(faqRows.map((r) => [Number(r.id), r]));
  const docs = await listFiles(identity, orgId, kb.id, { checked: true });
  const docById = new Map(docs.map((d) => [d.id, d]));
  const blockers = [];
  const targets = [];

  for (const t of pkg.deletes) {
    if (t.type === 'faq') {
      const row = faqById.get(t.id);
      if (!row) { blockers.push(`要删的 FAQ #${t.id} 在库里找不到（可能已经被删了，或者 id 写错了）`); continue; }
      const question = String(row.question ?? '').trim();
      if (question !== t.question) { blockers.push(`要删的 FAQ #${t.id} 的问题和包里写的不一样：库里是「${question}」，包里是「${t.question}」`); continue; }
      const u = unrestorable('faq', row);
      if (u) { blockers.push(`要删的 FAQ #${t.id} ${u.reason}，${u.why}，不能删`); continue; }
      targets.push({ type: 'faq', id: t.id, question, answer: String(row.answer ?? ''), reviewed: normalizeFaq(row).reviewed });
    } else {
      const d = docById.get(t.id);
      if (!d) { blockers.push(`要删的文件 #${t.id} 在库里找不到（可能已经被删了，或者 id 写错了）`); continue; }
      if (d.name.trim() !== t.name) { blockers.push(`要删的文件 #${t.id} 的名字和包里写的不一样：库里是「${d.name}」，包里是「${t.name}」`); continue; }
      const detail = await docDetailRaw(identity, orgId, kb.id, t.id);
      const u = unrestorable('doc', detail);
      if (u) { blockers.push(`要删的文件 #${t.id}「${t.name}」${u.reason}，${u.why}，不能删`); continue; }
      // 撤回时段落要原样写回：超过新段落上限的、空的，秒懂接不接受还没实测（spec 3b §10），先提醒
      const odd = (await listParagraphRows(identity, orgId, kb.id, t.id)).filter((p) => !String(p.content ?? '').trim() || [...String(p.content).trim()].length > LIMITS.paragraph).length;
      targets.push({ type: 'doc', id: t.id, name: d.name, paragraphCount: num(detail.paragraphCount), hasOriginal: Boolean(detail.docUrl), odd });
    }
  }

  const deletingFaq = new Set(pkg.deletes.filter((t) => t.type === 'faq').map((t) => t.id));
  const deletingDoc = new Set(pkg.deletes.filter((t) => t.type === 'doc').map((t) => t.id));
  const existing = new Map();
  for (const r of faqRows) {
    const k = textKey(r.question);
    if (!deletingFaq.has(Number(r.id)) && !existing.has(k)) existing.set(k, Number(r.id));
  }
  for (const f of pkg.faqs) {
    const hit = existing.get(textKey(f.question));
    if (hit) blockers.push(`新 FAQ「${f.question}」（${f.key}）和库里 #${hit} 完全一样：要替换就把 #${hit} 写进 deletes.jsonl，要保留就从包里去掉`);
  }

  // 提醒：很像的 FAQ（相似度检查，未审核的也算）、同名的文件、名字超过 30 字的要删文件（撤回时重建成手工文件，名字可能被截断）
  const similar = (await mapPool(pkg.faqs, SIMILARITY_CONCURRENCY, async (f) => (await checkSimilarity(identity, orgId, kb.id, f.question))
    .filter((r) => typeof r.similarity === 'number' && r.similarity >= SIMILAR_THRESHOLD && !deletingFaq.has(r.id) && textKey(r.question) !== textKey(f.question))
    .map((r) => ({ question: f.question, id: r.id, existing: r.question, similarity: r.similarity, reviewed: r.reviewed })))).flat();
  const sameName = pkg.docs.flatMap((d) => docs.filter((x) => !deletingDoc.has(x.id) && x.name.trim() === d.name).map((x) => ({ name: d.name, id: x.id })));
  const longNames = targets.filter((t) => t.type === 'doc' && [...t.name].length > 30);
  const oddParagraphs = targets.filter((t) => t.type === 'doc' && t.odd);

  const deleteFaqs = targets.filter((t) => t.type === 'faq');
  const deleteDocs = targets.filter((t) => t.type === 'doc');
  const counts = {
    addFaqs: pkg.faqs.length,
    addDocs: pkg.docs.length,
    addParagraphs: pkg.docs.reduce((n, d) => n + d.paragraphs.length, 0),
    deleteFaqs: deleteFaqs.length,
    deleteDocs: deleteDocs.length,
    deleteParagraphs: deleteDocs.reduce((n, d) => n + d.paragraphCount, 0),
    originals: deleteDocs.filter((d) => d.hasOriginal).length,
  };
  return { blockers, targets, counts, similar, sameName, longNames, oddParagraphs };
}

// 计划码绑定：库、包指纹、要删对象的现状、增删条数。之后任何一样变了，确认就对不上
export function importCode(kb, pkg, plan) {
  return confirmCode({
    kind: 'kb-import',
    kbId: kb.id,
    fingerprint: pkg.fingerprint,
    targets: plan.targets.map((t) => (t.type === 'faq'
      ? { type: 'faq', id: t.id, question: t.question, answer: hashOf(t.answer), reviewed: t.reviewed }
      : { type: 'doc', id: t.id, name: t.name, paragraphCount: t.paragraphCount })),
    counts: plan.counts,
  });
}
