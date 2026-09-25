// md kb revoke 的引擎（spec 3b §5）：把一次导入撤回——从备份重建这次删掉的，再删掉这次建的；先加后删，和导入同理。
// 「这次建的」「这次删的」都以导入记录为准（kb-ops 认下的：内容完全对得上的才算），别人建的、别人删的，撤回一律不碰。
// 删这次建的之前，先把它们当时的内容存进本机（revoke-backup/）：导入后被人改过的，改动也找得回来。
// 导入停下时认不清的（发出去了、库里没有一模一样的，又多出来对不上的），撤回不删，列出来交给人；撤回做完也不说「干净了」。
// 重建一直过不去（同一条两次都对不上，多半是秒懂在改写内容）：预演里给出「跳过它的重建、先删这次建的」，用户确认了才跳过。
// 重建的范围在第一次确认时定下来写进状态（之后续做不再变）。
// 被删的文件只能重建成同名手工文件（spec §2.3）：段落和摘要原样写回，原文件留在本机备份里。
import { EXIT, MdError } from './errors.mjs';
import { listFaqs, listFiles, normalizeFaq } from './kb.mjs';
import { readBackupDocs, readBackupFaqs, saveBackupDoc, saveBackupFaqs } from './kb-import-store.mjs';
import { textKey } from './kb-package.mjs';
import { WRITE_BATCH, docDetailRaw, listFaqRows, updateAbstract } from './kb-write.mjs';
import { applySettle, batchesOf, createTracked, deleteTracked, doubtRows, dropExtras, log, paragraphsOf, pastRows, save, settleOpen, trimmed, writeDoc } from './kb-ops.mjs';
import { itemsByType, reviewAll, verifyContent, waitIndexed } from './kb-import-run.mjs';
import { out } from './output.mjs';

export const REVOKE_STEPS = ['rebuild_faqs', 'rebuild_docs', 'verify', 'review', 'index', 'delete'];
export const REVOKE_NAMES = {
  rebuild_faqs: '重建删掉的 FAQ', rebuild_docs: '重建删掉的文件', verify: '核对重建的内容',
  review: '审核重建的 FAQ', index: '等向量化', delete: '删掉这次建的',
};
const NAME_MAX = 30;
const TYPES = ['faq', 'doc'];
const none = () => ({ faq: [], doc: [] });

// 把重新认意图的结果先算进来（只读）：认下的 id、自己的副本、删掉的 id
function settledBook(book, s) {
  const ids = {
    faqIds: { ...book.faqIds }, docIds: { ...book.docIds },
    deleted: { faq: [...(book.deleted?.faq ?? [])], doc: [...(book.deleted?.doc ?? [])] },
    extras: { faq: [...(book.extras?.faq ?? [])], doc: [...(book.extras?.doc ?? [])] },
  };
  if (s?.open.op === 'create') {
    Object.assign(s.open.type === 'faq' ? ids.faqIds : ids.docIds, s.claimed);
    ids.extras[s.open.type].push(...s.extras);
  }
  if (s?.open.op === 'delete' && s.open.record) ids.deleted[s.open.type] = [...new Set([...ids.deleted[s.open.type], ...s.gone])];
  return ids;
}

// 要重建的：备份里的（key 是秒懂原来的 id，FAQ 和文件分开放，两张表的 id 可能撞号）
function rebuildItems(dir, scope) {
  const faqItems = readBackupFaqs(dir).filter((r) => scope.faqs.includes(Number(r.id)))
    .map((r) => ({ key: String(r.id), question: trimmed(r.question), answer: trimmed(r.answer), reviewed: normalizeFaq(r).reviewed === true }));
  const docItems = readBackupDocs(dir).filter((d) => scope.docs.includes(Number(d.detail.id))).map((d) => {
    const full = trimmed(d.detail.name);
    return { key: String(d.detail.id), name: [...full].slice(0, NAME_MAX).join(''), full, abstract: trimmed(d.detail.abstract), paragraphs: d.paragraphs.map((p) => trimmed(p.content)), originalFile: d.originalFile };
  });
  return { faqItems, docItems, byType: { faq: Object.fromEntries(faqItems.map((f) => [f.key, f])), doc: Object.fromEntries(docItems.map((d) => [d.key, d])) } };
}

const doubtOf = (s) => (s?.open.op === 'create' && s.unresolved.length && (s.suspects.length || s.past.length) ? { type: s.open.type, rows: [...s.suspects, ...s.past] } : null);

// 撤回要做什么（只读）：要重建的（从备份）、跳过重建的（两次都对不上）、要删的（这次建的、还在库里的）、
// 导入后被人改过的、认不清的、库里已经有一样的
export async function revokePlan(ctx, rec) {
  const { state, pkg } = rec;
  const importSettle = await settleOpen(ctx, state, itemsByType(pkg));
  const ours = settledBook(state, importSettle);
  const scope = state.revoke?.scope ?? { faqs: [...ours.deleted.faq], docs: [...ours.deleted.doc] };
  const { faqItems, docItems, byType } = rebuildItems(rec.dir, scope);
  const revokeSettle = state.revoke ? await settleOpen(ctx, state.revoke, byType) : null;
  const rebuilt = state.revoke ? settledBook(state.revoke, revokeSettle) : { faqIds: {}, docIds: {} };
  const skip = { faq: [...(state.revoke?.skipped?.faq ?? [])], doc: [...(state.revoke?.skipped?.doc ?? [])] };
  if (revokeSettle?.stuck?.length) skip[revokeSettle.open.type] = [...new Set([...skip[revokeSettle.open.type], ...revokeSettle.stuck])];

  const faqsNow = await listFaqs(ctx.identity, ctx.orgId, ctx.kbId, { checked: true });
  const docsNow = await listFiles(ctx.identity, ctx.orgId, ctx.kbId, { checked: true });
  const faqById = new Map(faqsNow.map((f) => [f.id, f]));
  const docById = new Map(docsNow.map((d) => [d.id, d]));
  const deleteFaqs = [...new Set([...Object.values(ours.faqIds), ...ours.extras.faq])].filter((id) => faqById.has(id)).map((id) => faqById.get(id));
  const deleteDocs = [...new Set([...Object.values(ours.docIds), ...ours.extras.doc])].filter((id) => docById.has(id)).map((id) => docById.get(id));

  const changed = [];
  for (const f of pkg.faqs) {
    const row = faqById.get(ours.faqIds[f.key]);
    if (row && (trimmed(row.question) !== f.question || trimmed(row.answer) !== f.answer)) changed.push({ key: f.key, text: `FAQ「${f.question}」` });
  }
  for (const d of pkg.docs) {
    const id = ours.docIds[d.key];
    if (!id || !docById.has(id)) continue;
    const have = await paragraphsOf(ctx, id);
    // 段落是包里段落的前缀：只是没写完，不算被人改过
    if (have.length > d.paragraphs.length || have.some((p, i) => trimmed(p.content) !== d.paragraphs[i])) changed.push({ key: d.key, text: `文件「${d.name}」` });
  }

  // 库里已经有同一个问题 / 同名文件、又不是这次导入或撤回建的（可能有人手动恢复了）：照样重建，但先提醒会重复
  const mine = new Set([...Object.values(ours.faqIds), ...Object.values(ours.docIds), ...Object.values(rebuilt.faqIds), ...Object.values(rebuilt.docIds)]);
  const dupes = [
    ...faqItems.filter((it) => !rebuilt.faqIds[it.key] && !skip.faq.includes(it.key)).flatMap((it) => faqsNow.filter((f) => !mine.has(f.id) && textKey(f.question) === textKey(it.question)).map((f) => `FAQ「${it.question}」（库里已经有 #${f.id}）`)),
    ...docItems.filter((it) => !rebuilt.docIds[it.key] && !skip.doc.includes(it.key)).flatMap((it) => docsNow.filter((d) => !mine.has(d.id) && textKey(d.name) === textKey(it.name)).map((d) => `文件「${it.name}」（库里已经有 #${d.id}）`)),
  ];
  return { scope, skip, importSettle, revokeSettle, faqItems, docItems, deleteFaqs, deleteDocs, changed, doubt: doubtOf(importSettle), dupes };
}

const kept = (items, skipped) => items.filter((it) => !skipped.includes(it.key));

// 删之前把它们当时的内容存进本机：FAQ 原始行（和已经存过的合并，续做时不丢）、文件详情和全部段落
async function backupBeforeDelete(ctx, faqIds, docIds) {
  if (faqIds.length) {
    const want = new Set(faqIds);
    const rows = (await listFaqRows(ctx.identity, ctx.orgId, ctx.kbId)).filter((r) => want.has(Number(r.id)));
    const had = readBackupFaqs(ctx.dir, 'revoke-backup').filter((r) => !want.has(Number(r.id)));
    saveBackupFaqs(ctx.dir, [...had, ...rows], 'revoke-backup');
  }
  for (const id of docIds) {
    const detail = await docDetailRaw(ctx.identity, ctx.orgId, ctx.kbId, id);
    if (detail?.id) saveBackupDoc(ctx.dir, { detail, paragraphs: await paragraphsOf(ctx, id), original: null }, 'revoke-backup');
  }
}

const STEPS = {
  async rebuild_faqs(ctx, plan) {
    const items = kept(plan.faqItems, ctx.revoke.skipped.faq);
    if (!items.length) return '没有要重建的 FAQ';
    let rows;
    for (const batch of batchesOf(items.filter((f) => !ctx.revoke.faqIds[f.key]), WRITE_BATCH, (f) => textKey(f.question))) rows = await createTracked(ctx, ctx.revoke, 'faq', batch, rows);
    await dropExtras(ctx, ctx.revoke, 'faq');
    return `${items.length} 条（id 会变：${items.map((f) => `#${f.key} → #${ctx.revoke.faqIds[f.key]}`).join('、')}）`;
  },

  async rebuild_docs(ctx, plan) {
    const items = kept(plan.docItems, ctx.revoke.skipped.doc);
    if (!items.length) return '没有要重建的文件';
    for (const d of items) {
      const id = await writeDoc(ctx, ctx.revoke, d);
      save(ctx);
      if (d.abstract) {
        log(ctx, { op: 'update-abstract', phase: 'send', docId: id });
        await updateAbstract(ctx.identity, ctx.orgId, ctx.kbId, id, d.abstract);
      }
    }
    await dropExtras(ctx, ctx.revoke, 'doc');
    const cut = items.filter((d) => d.name !== d.full);
    return `${items.length} 个手工文件、${items.reduce((n, d) => n + d.paragraphs.length, 0)} 段${cut.length ? `（名字超过 30 字截短了：${cut.map((d) => `「${d.name}」`).join('、')}）` : ''}`;
  },

  async verify(ctx, plan) {
    const faqItems = kept(plan.faqItems, ctx.revoke.skipped.faq);
    const docItems = kept(plan.docItems, ctx.revoke.skipped.doc);
    const problems = await verifyContent(ctx, faqItems, ctx.revoke.faqIds, docItems, ctx.revoke.docIds);
    if (problems.length) throw new MdError('kb_verify_failed', `重建的读回来和备份不一样：${problems.slice(0, 10).join('；')}`);
    return `${faqItems.length} 条 FAQ、${docItems.length} 个文件和备份逐字一致`;
  },

  async review(ctx, plan) {
    const ids = kept(plan.faqItems, ctx.revoke.skipped.faq).filter((f) => f.reviewed).map((f) => ctx.revoke.faqIds[f.key]);
    await reviewAll(ctx, ids);
    return ids.length ? `${ids.length} 条（原来就是已审核的）` : '没有要审核的';
  },

  async index(ctx, plan) {
    const faqItems = kept(plan.faqItems, ctx.revoke.skipped.faq).filter((f) => f.reviewed);
    await waitIndexed(ctx, faqItems, ctx.revoke.faqIds, kept(plan.docItems, ctx.revoke.skipped.doc), ctx.revoke.docIds, ctx.revoke.indexed);
    return '重建的段落全部 ready，重建的 FAQ 都能用自己的问题搜到';
  },

  // 只删导入记录里认下的（还在库里的，包括自己的副本）；删之前先备份到本机，删掉的读回确认已经不在
  async delete(ctx) {
    const faqIds = [...new Set([...Object.values(ctx.state.faqIds), ...(ctx.state.extras?.faq ?? [])])];
    const docIds = [...new Set([...Object.values(ctx.state.docIds), ...(ctx.state.extras?.doc ?? [])])];
    const presentFaqs = new Set((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId, { checked: true })).map((f) => f.id));
    const presentDocs = new Set((await listFiles(ctx.identity, ctx.orgId, ctx.kbId, { checked: true })).map((d) => d.id));
    await backupBeforeDelete(ctx, faqIds.filter((id) => presentFaqs.has(id)), docIds.filter((id) => presentDocs.has(id)));
    await deleteTracked(ctx, ctx.revoke, 'faq', faqIds, { record: true });
    await deleteTracked(ctx, ctx.revoke, 'doc', docIds, { record: true });
    return `删了 FAQ ${ctx.revoke.deleted.faq.length} 条、文件 ${ctx.revoke.deleted.doc.length} 个，读回确认已经不在（删之前的内容在 ${ctx.dir}/revoke-backup）`;
  },
};

// 撤回做完之后，还有没有要人看一眼的：导入时认不清的（意图留着）、撤回跳过重建的几条留下的可疑的
export const tracking = (state) => state.status === 'revoked' && !state.revoke?.leftoversDone
  && (Boolean(state.open) || TYPES.some((t) => (state.revoke?.skipped?.[t] ?? []).length));

// 还在库里的认不清的：[{ type, row }]
export async function leftovers(ctx) {
  const rows = [];
  if (ctx.state.open) rows.push(...await doubtRows(ctx, ctx.state, itemsByType(ctx.pkg)));
  for (const type of TYPES) rows.push(...await pastRows(ctx, ctx.state.revoke ?? {}, type, ctx.state.revoke?.skipped?.[type] ?? []));
  const seen = new Set();
  return rows.filter(({ type, row }) => {
    const k = `${type}#${row.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 不再追踪（都不在了，或者用户确认都不是这次建的）：只改本机记录
export function closeLeftovers(ctx, how, rows = []) {
  const ids = rows.map(({ type, row }) => `${type}#${row.id}`);
  ctx.state.open = null;
  ctx.state.revoke.leftoversDone = { how, at: new Date().toISOString(), ids };
  save(ctx);
  log(ctx, { op: 'leftover-check', phase: how, ids });
}

// 第一次确认时把撤回的范围写进状态；之后从第一个没做完的步骤接着做。返回认不清、没删、还在库里的
export async function runRevoke(ctx, plan) {
  const { state } = ctx;
  const id = state.importId;
  applySettle(ctx, state, plan.importSettle, { keep: true });
  state.revoke ??= { scope: plan.scope, steps: {}, stopped: null, faqIds: {}, docIds: {}, deleted: none(), indexed: none(), open: null, attempts: { faq: {}, doc: {} }, extras: none(), skipped: none() };
  applySettle(ctx, state.revoke, plan.revokeSettle);
  state.revoke.skipped = plan.skip;
  ctx.revoke = state.revoke;
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
      const again = `查明原因后再运行一次 md kb revoke ${id}，会从这一步接着做`;
      const hint = error.code === 'kb_write_doubt'
        ? `在秒懂上看一眼上面列的：是撤回重建出来的（秒懂改写了内容），就手动删掉它们，再运行一次 md kb revoke ${id}；不是，就直接再运行一次（预演会再列一遍，确认就是认定它们不是撤回建的）。同一条两次都对不上，预演会给出跳过它的重建`
        : error.code?.startsWith('kb_') && error.hint ? error.hint : [error.hint, again].filter(Boolean).join('；');
      throw new MdError(error.code ?? 'kb_revoke_failed', `停在「${REVOKE_NAMES[step]}」：${error.message}`, { exitCode: error.exitCode ?? EXIT.ERROR, hint });
    }
    state.revoke.steps[step] = new Date().toISOString();
    save(ctx);
    out(`${REVOKE_NAMES[step]}：${summary}`);
  }
  state.status = 'revoked';
  state.revoke.done = new Date().toISOString();
  const left = tracking(state) ? await leftovers(ctx) : [];
  state.revoke.leftoverIds = left.map(({ type, row }) => `${type}#${row.id}`);
  if (tracking(state) && !left.length) closeLeftovers(ctx, 'gone');
  else save(ctx);
  return left;
}
