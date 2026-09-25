// md kb revoke 的引擎（spec 3b §5）：把一次导入撤回——从备份重建这次删掉的，再删掉这次建的；先加后删，和导入同理。
// 重建的范围在第一次确认时定下来写进状态（之后续做不再变）：导入记下删掉的，加上「导入已经走到删除这一步、现在库里确实没有了」的
// （删的请求发出去了、回复丢了的也算进来）。库里已经有同样问题 / 同名文件的（可能有人手动恢复了），不重建，免得重复。
// 被删的文件只能重建成同名手工文件（spec §2.3）：段落和摘要原样写回，原文件留在本机备份里。
import { EXIT, MdError } from './errors.mjs';
import { listFaqs, listFiles } from './kb.mjs';
import { readBackupDocs, readBackupFaqs } from './kb-import-store.mjs';
import { textKey } from './kb-package.mjs';
import { WRITE_BATCH, createFaqs, deleteDoc, deleteFaqs, updateAbstract } from './kb-write.mjs';
import { chunks, log, paragraphsOf, reconcileFaqs, reviewAll, save, verifyContent, waitIndexed, writeDoc } from './kb-import-run.mjs';
import { out } from './output.mjs';

export const REVOKE_STEPS = ['snapshot', 'rebuild_faqs', 'rebuild_docs', 'verify', 'review', 'index', 'delete'];
export const REVOKE_NAMES = {
  snapshot: '快照', rebuild_faqs: '重建删掉的 FAQ', rebuild_docs: '重建删掉的文件', verify: '核对重建的内容',
  review: '审核重建的 FAQ', index: '等向量化', delete: '删掉这次建的',
};
const NAME_MAX = 30;
const trimmed = (s) => String(s ?? '').trim();

// 撤回要做什么：要重建的（从备份）、要删的（这次建的、还在库里的）、导入后被人改过的、不用重建的
export async function revokePlan(ctx, rec) {
  const { state, pkg } = rec;
  const faqsNow = await listFaqs(ctx.identity, ctx.orgId, ctx.kbId);
  const docsNow = await listFiles(ctx.identity, ctx.orgId, ctx.kbId);
  const faqById = new Map(faqsNow.map((f) => [f.id, f]));
  const docById = new Map(docsNow.map((d) => [d.id, d]));
  // 先对账：导入停下时，发出去了、还没记进状态的（比如第 2 批建好了、第 3 批失败），按「不在导入快照里、问题或文件名一致」找回来。
  // 撤回自己重建出来的不算（它们的问题可能和包里一样：删旧的重建同一个问题）
  const faqIds = { ...state.faqIds };
  const docIds = { ...state.docIds };
  const rebuilt = new Set([...Object.values(state.revoke?.rebuiltFaqIds ?? {}), ...Object.values(state.revoke?.rebuiltDocIds ?? {})]);
  if (rec.snapshot) {
    const snapFaq = new Set(rec.snapshot.faqIds);
    const snapDoc = new Set(rec.snapshot.docIds);
    const takenFaq = new Set(Object.values(faqIds));
    for (const f of pkg.faqs.filter((x) => !faqIds[x.key])) {
      const hits = faqsNow.filter((x) => !snapFaq.has(x.id) && !takenFaq.has(x.id) && !rebuilt.has(x.id) && textKey(x.question) === textKey(f.question));
      if (hits.length === 1) { faqIds[f.key] = hits[0].id; takenFaq.add(hits[0].id); }
    }
    const takenDoc = new Set(Object.values(docIds));
    for (const d of pkg.docs.filter((x) => !docIds[x.key])) {
      const hits = docsNow.filter((x) => !snapDoc.has(x.id) && !takenDoc.has(x.id) && !rebuilt.has(x.id) && x.name.trim() === d.name);
      if (hits.length === 1) { docIds[d.key] = hits[0].id; takenDoc.add(hits[0].id); }
    }
  }
  const createdFaq = new Set(Object.values(faqIds));
  const createdDoc = new Set(Object.values(docIds));

  let scope = state.revoke?.scope;
  const skipped = [];
  if (!scope) {
    const reachedDelete = Boolean(state.steps.index);
    const gone = (type, id) => state.deleted[type].includes(id) || (reachedDelete && !(type === 'faq' ? faqById : docById).has(id));
    const others = faqsNow.filter((f) => !createdFaq.has(f.id));
    const otherDocs = docsNow.filter((d) => !createdDoc.has(d.id));
    const faqIds = [];
    for (const r of readBackupFaqs(rec.dir).filter((x) => gone('faq', Number(x.id)))) {
      const same = others.find((f) => textKey(f.question) === textKey(r.question));
      if (same) skipped.push(`FAQ #${r.id}「${trimmed(r.question)}」（库里已经有 #${same.id}）`);
      else faqIds.push(Number(r.id));
    }
    const docIds = [];
    for (const d of readBackupDocs(rec.dir).filter((x) => gone('doc', Number(x.detail.id)))) {
      const same = otherDocs.find((x) => x.name.trim() === trimmed(d.detail.name));
      if (same) skipped.push(`文件 #${d.detail.id}「${trimmed(d.detail.name)}」（库里已经有 #${same.id}）`);
      else docIds.push(Number(d.detail.id));
    }
    scope = { faqs: faqIds, docs: docIds };
  }

  const faqItems = readBackupFaqs(rec.dir).filter((r) => scope.faqs.includes(Number(r.id)))
    .map((r) => ({ key: String(r.id), question: trimmed(r.question), answer: trimmed(r.answer), reviewed: r.isReviewed === true }));
  const docItems = readBackupDocs(rec.dir).filter((d) => scope.docs.includes(Number(d.detail.id))).map((d) => {
    const full = trimmed(d.detail.name);
    const name = [...full].slice(0, NAME_MAX).join('');
    return { key: String(d.detail.id), name, full, abstract: trimmed(d.detail.abstract), paragraphs: d.paragraphs.map((p) => trimmed(p.content)), originalFile: d.originalFile };
  });

  const deleteFaqIds = [...createdFaq].filter((id) => faqById.has(id));
  const deleteDocIds = [...createdDoc].filter((id) => docById.has(id));
  const changed = [];
  for (const f of pkg.faqs) {
    const row = faqById.get(faqIds[f.key]);
    if (row && (trimmed(row.question) !== f.question || trimmed(row.answer) !== f.answer)) changed.push({ key: f.key, text: `FAQ「${f.question}」` });
  }
  for (const d of pkg.docs) {
    const id = docIds[d.key];
    if (!id || !docById.has(id)) continue;
    const have = await paragraphsOf(ctx, id);
    // 段落是包里段落的前缀：只是没写完，不算被人改过
    if (have.length > d.paragraphs.length || have.some((p, i) => trimmed(p.content) !== d.paragraphs[i])) changed.push({ key: d.key, text: `文件「${d.name}」` });
  }
  return { scope, faqIds, docIds, faqItems, docItems, deleteFaqIds, deleteDocIds, changed, skipped };
}

const STEPS = {
  async snapshot(ctx) {
    const faqs = await listFaqs(ctx.identity, ctx.orgId, ctx.kbId);
    const docs = await listFiles(ctx.identity, ctx.orgId, ctx.kbId);
    ctx.revoke.snapshot = { faqIds: faqs.map((f) => f.id), docIds: docs.map((d) => d.id) };
    return `库里现有 FAQ ${faqs.length} 条、文件 ${docs.length} 个`;
  },

  async rebuild_faqs(ctx, plan) {
    const items = plan.faqItems;
    if (!items.length) return '没有要重建的 FAQ';
    const exclude = new Set(ctx.revoke.snapshot.faqIds);
    await reconcileFaqs(ctx, items, ctx.revoke.rebuiltFaqIds, exclude);
    save(ctx);
    const todo = items.filter((f) => !ctx.revoke.rebuiltFaqIds[f.key]);
    for (const batch of chunks(todo, WRITE_BATCH)) {
      await createFaqs(ctx.identity, ctx.orgId, ctx.kbId, batch);
      log(ctx, { op: 'batch-create', count: batch.length, revoke: true });
    }
    await reconcileFaqs(ctx, items, ctx.revoke.rebuiltFaqIds, exclude);
    save(ctx);
    const lost = items.filter((f) => !ctx.revoke.rebuiltFaqIds[f.key]);
    if (lost.length) throw new MdError('kb_revoke_lost', `有 ${lost.length} 条 FAQ 重建请求发出去了，但在库里找不到（第一条：「${lost[0].question}」）`);
    return `${items.length} 条（id 会变：${items.map((f) => `#${f.key} → #${ctx.revoke.rebuiltFaqIds[f.key]}`).join('、')}）`;
  },

  async rebuild_docs(ctx, plan) {
    const items = plan.docItems;
    if (!items.length) return '没有要重建的文件';
    const exclude = new Set(ctx.revoke.snapshot.docIds);
    for (const d of items) {
      const id = await writeDoc(ctx, d, ctx.revoke.rebuiltDocIds, exclude);
      save(ctx);
      if (d.abstract) {
        await updateAbstract(ctx.identity, ctx.orgId, ctx.kbId, id, d.abstract);
        log(ctx, { op: 'update-abstract', docId: id, revoke: true });
      }
    }
    const cut = items.filter((d) => d.name !== d.full);
    return `${items.length} 个手工文件、${items.reduce((n, d) => n + d.paragraphs.length, 0)} 段${cut.length ? `（名字超过 30 字截短了：${cut.map((d) => `「${d.name}」`).join('、')}）` : ''}`;
  },

  async verify(ctx, plan) {
    const problems = await verifyContent(ctx, plan.faqItems, ctx.revoke.rebuiltFaqIds, plan.docItems, ctx.revoke.rebuiltDocIds);
    if (problems.length) throw new MdError('kb_verify_failed', `重建的读回来和备份不一样：${problems.slice(0, 10).join('；')}`);
    return `${plan.faqItems.length} 条 FAQ、${plan.docItems.length} 个文件和备份逐字一致`;
  },

  async review(ctx, plan) {
    const ids = plan.faqItems.filter((f) => f.reviewed).map((f) => ctx.revoke.rebuiltFaqIds[f.key]);
    await reviewAll(ctx, ids);
    return ids.length ? `${ids.length} 条（原来就是已审核的）` : '没有要审核的';
  },

  async index(ctx, plan) {
    await waitIndexed(ctx, plan.faqItems.filter((f) => f.reviewed), ctx.revoke.rebuiltFaqIds, plan.docItems, ctx.revoke.rebuiltDocIds, ctx.revoke.indexed);
    return '重建的段落全部 ready，重建的 FAQ 都能用自己的问题搜到';
  },

  async delete(ctx) {
    const faqIds = Object.values(ctx.state.faqIds);
    const docIds = Object.values(ctx.state.docIds);
    const presentFaqs = new Set((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId)).map((f) => f.id));
    for (const batch of chunks(faqIds.filter((id) => presentFaqs.has(id)), WRITE_BATCH)) {
      await deleteFaqs(ctx.identity, ctx.orgId, ctx.kbId, batch);
      log(ctx, { op: 'batch-delete', count: batch.length, ids: batch, revoke: true });
    }
    const presentDocs = new Set((await listFiles(ctx.identity, ctx.orgId, ctx.kbId)).map((d) => d.id));
    for (const id of docIds.filter((x) => presentDocs.has(x))) {
      await deleteDoc(ctx.identity, ctx.orgId, ctx.kbId, id);
      log(ctx, { op: 'file-delete', ids: [id], revoke: true });
    }
    const leftFaqs = new Set((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId)).map((f) => f.id));
    const leftDocs = new Set((await listFiles(ctx.identity, ctx.orgId, ctx.kbId)).map((d) => d.id));
    const still = [...faqIds.filter((id) => leftFaqs.has(id)).map((id) => `FAQ #${id}`), ...docIds.filter((id) => leftDocs.has(id)).map((id) => `文件 #${id}`)];
    if (still.length) throw new MdError('kb_delete_incomplete', `删了之后读回来还在：${still.join('、')}`);
    return `删了 FAQ ${faqIds.filter((id) => presentFaqs.has(id)).length} 条、文件 ${docIds.filter((id) => presentDocs.has(id)).length} 个，读回确认已经不在`;
  },
};

// 第一次确认时把撤回的范围写进状态；之后从第一个没做完的步骤接着做
export async function runRevoke(ctx, plan) {
  const { state } = ctx;
  const id = state.importId;
  if (!state.revoke) {
    state.revoke = { scope: plan.scope, steps: {}, stopped: null, snapshot: null, rebuiltFaqIds: {}, rebuiltDocIds: {}, indexed: { faq: [], doc: [] } };
  }
  ctx.revoke = state.revoke;
  // 对账找回的（发出去了、导入时没来得及记下的）先写进状态，删的时候一起删
  state.faqIds = plan.faqIds;
  state.docIds = plan.docIds;
  state.status = 'revoking';
  state.revoke.stopped = null;
  save(ctx);
  for (const step of REVOKE_STEPS) {
    if (state.revoke.steps[step]) continue;
    let summary;
    try {
      summary = await STEPS[step](ctx, plan);
    } catch (error) {
      state.revoke.stopped = { step, reason: error.message, at: new Date().toISOString() };
      save(ctx);
      throw new MdError(error.code ?? 'kb_revoke_failed', `停在「${REVOKE_NAMES[step]}」：${error.message}`, {
        exitCode: error.exitCode ?? EXIT.ERROR,
        hint: `查明原因后再运行一次 md kb revoke ${id}，会从这一步接着做`,
      });
    }
    state.revoke.steps[step] = new Date().toISOString();
    save(ctx);
    out(`${REVOKE_NAMES[step]}：${summary}`);
  }
  state.status = 'revoked';
  state.revoke.done = new Date().toISOString();
  save(ctx);
  out(`撤回完成：这次导入建的都删了，删掉的都按备份重建了。`);
}
