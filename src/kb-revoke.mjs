// md kb revoke 的引擎（spec 3b §5）：把一次导入撤回——从备份重建这次删掉的，再删掉这次建的；先加后删，和导入同理。
// 「这次建的」「这次删的」都以导入记录为准（kb-ops 自动认下的，或者用户确认过的），别人建的、别人删的，撤回一律不碰。
// 导入停下时认不清的（一模一样但晚出现的、一模一样不止一条的、可疑的），撤回不删，列出来交给人；撤回做完也不说「干净了」。
// 删这次建的之前，先把它们当时的内容存进本机（revoke-backup/）：导入后被人改过的，改动也找得回来。
// 任何一条重建连续失败两次（认不上、核对不过、段落写不进去、一直向量化不好、审核不上，不管是什么错）：预演给出选择——
// 接着重试，或者加 --skip-rebuild 跳过它的重建、先删这次建的（用户选）。认不清的（一模一样不止一条、可疑两次）只能跳过，不能再重发。
// 跳过的那几条，撤回自己在请求刚发完时认下的、还是自己写的半成品，一起删掉（晚出现的不认、不删，预演列出每一个要删的）。
// 重建的范围在第一次确认时定下来写进状态（之后续做不再变）。
// 被删的文件只能重建成同名手工文件（spec §2.3）：段落和摘要原样写回，原文件留在本机备份里。
import { EXIT, MdError } from './errors.mjs';
import { listFaqs, listFiles, normalizeFaq } from './kb.mjs';
import { readBackupDocs, readBackupFaqs, saveBackupDoc, saveBackupFaqs } from './kb-import-store.mjs';
import { textKey } from './kb-package.mjs';
import { WRITE_BATCH, docDetailRaw, listFaqRows, updateAbstract } from './kb-write.mjs';
import { applySettle, batchesOf, createTracked, deleteTracked, doubtRows, log, orphanRows, paragraphsOf, pastRows, save, settleOpen, trimmed, writeDoc } from './kb-ops.mjs';
import { itemsByType, reviewAll, verifyContent, waitIndexed } from './kb-import-run.mjs';
import { out } from './output.mjs';

export const REVOKE_STEPS = ['rebuild_faqs', 'rebuild_docs', 'verify', 'review', 'index', 'delete'];
export const REVOKE_NAMES = {
  rebuild_faqs: '重建删掉的 FAQ', rebuild_docs: '重建删掉的文件', verify: '核对重建的内容',
  review: '审核重建的 FAQ', index: '等向量化', delete: '删掉这次建的',
};
const NAME_MAX = 30;
const TYPES = ['faq', 'doc'];
const SKIP_AFTER = 2; // 同一条重建失败几次之后给出跳过
const none = () => ({ faq: [], doc: [] });

// 把重新认意图的结果先算进来（只读）：认下的 id、删掉的 id。claimLate：晚出现的一模一样的也算（撤回自己的重建，确认就认）
function settledBook(book, s, { claimLate = false } = {}) {
  const ids = {
    faqIds: { ...book.faqIds }, docIds: { ...book.docIds },
    deleted: { faq: [...(book.deleted?.faq ?? [])], doc: [...(book.deleted?.doc ?? [])] },
  };
  if (s?.open.op === 'create') {
    const map = s.open.type === 'faq' ? ids.faqIds : ids.docIds;
    Object.assign(map, s.claimed);
    if (claimLate && s.open.type === 'faq') for (const [k, r] of Object.entries(s.late)) map[k] = r.id;
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
    // 备份里原来就不是 ready 的段落（比如一直没向量化成功的乱码段），重建之后也不等它
    return {
      key: String(d.detail.id), name: [...full].slice(0, NAME_MAX).join(''), full, abstract: trimmed(d.detail.abstract),
      paragraphs: d.paragraphs.map((p) => trimmed(p.content)), mustReady: d.paragraphs.map((p) => String(p.status ?? 'ready') === 'ready'), originalFile: d.originalFile,
    };
  });
  return { faqItems, docItems, byType: { faq: Object.fromEntries(faqItems.map((f) => [f.key, f])), doc: Object.fromEntries(docItems.map((d) => [d.key, d])) } };
}

// 导入停下时认不清的：一模一样但晚出现的、一模一样不止一条的、可疑的（撤回不删，列出来）
function doubtOf(s) {
  if (s?.open.op !== 'create' || !s.unresolved.length) return null;
  const rows = [...Object.values(s.late), ...Object.values(s.ambiguous).flat(), ...s.suspects, ...s.past];
  return rows.length ? { type: s.open.type, rows } : null;
}

const union = (...lists) => [...new Set(lists.flat())];

// 认不清的可能 FAQ、文件都有：{ rows: [{ type, row }] }
function mergeDoubt(doubt, extra) {
  const rows = [...(doubt ? doubt.rows.map((row) => ({ type: doubt.type, row })) : []), ...extra];
  const seen = new Set();
  return { mixed: rows.filter(({ type, row }) => (seen.has(`${type}#${row.id}`) ? false : seen.add(`${type}#${row.id}`))) };
}

// 撤回要做什么（只读）：要重建的（从备份）、跳过重建的、要删的（这次建的、还在库里的）、
// 导入后被人改过的、认不清的、库里已经有一样的、删之前就被别人删了的
export async function revokePlan(ctx, rec, { skipRebuild = false } = {}) {
  const { state, pkg } = rec;
  const importSettle = await settleOpen(ctx, state, itemsByType(pkg));
  const ours = settledBook(state, importSettle);
  const scope = state.revoke?.scope ?? { faqs: [...ours.deleted.faq], docs: [...ours.deleted.doc] };
  const { faqItems, docItems, byType } = rebuildItems(rec.dir, scope);
  const revokeSettle = state.revoke ? await settleOpen(ctx, state.revoke, byType) : null;
  // 跳过重建：只能跳过的（撤回自己开着的意图里一模一样不止一条的、可疑两次的——再发会多出副本）、可以跳过的（同一条失败两次的）。
  // 用户加了 --skip-rebuild 才跳过；已经跳过的一直跳过
  const failures = state.revoke?.failures ?? { faq: {}, doc: {} };
  const mustSkip = {};
  const maySkip = {};
  const skip = {};
  for (const t of TYPES) {
    const open = revokeSettle?.open.op === 'create' && revokeSettle.open.type === t ? revokeSettle : null;
    const already = state.revoke?.skipped?.[t] ?? [];
    mustSkip[t] = union(open ? Object.keys(open.ambiguous) : [], open ? open.stuck.filter((k) => !(open.late[k] && t === 'faq')) : []).filter((k) => !already.includes(k));
    maySkip[t] = Object.entries(failures[t] ?? {}).filter(([k, n]) => n >= SKIP_AFTER && !already.includes(k) && !mustSkip[t].includes(k)).map(([k]) => k);
    skip[t] = union(already, skipRebuild ? [...mustSkip[t], ...maySkip[t]] : []);
  }
  // 撤回自己的重建：晚出现、一模一样的 FAQ 确认就认（要跳过的那几条不认）
  const rebuiltNow = state.revoke ? settledBook(state.revoke, revokeSettle ? { ...revokeSettle, late: Object.fromEntries(Object.entries(revokeSettle.late ?? {}).filter(([k]) => !skip[revokeSettle.open.type]?.includes(k))) } : null, { claimLate: true }) : { faqIds: {}, docIds: {} };

  const faqsNow = await listFaqs(ctx.identity, ctx.orgId, ctx.kbId, { checked: true });
  const docsNow = await listFiles(ctx.identity, ctx.orgId, ctx.kbId, { checked: true });
  const faqById = new Map(faqsNow.map((f) => [f.id, f]));
  const docById = new Map(docsNow.map((d) => [d.id, d]));
  // 跳过重建的那几条，撤回自己在请求刚发完时认下的半成品（晚出现后才认的不算）：还是自己写的内容才删，被人改过的留着列出来
  const partial = await partialRebuilds(ctx, state.revoke, rebuiltNow, skip, faqItems, docItems, faqById, docById);
  const deleteFaqs = union(Object.values(ours.faqIds), partial.del.faq).filter((id) => faqById.has(id)).map((id) => faqById.get(id));
  const deleteDocs = union(Object.values(ours.docIds), partial.del.doc).filter((id) => docById.has(id)).map((id) => docById.get(id));

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
  const mine = new Set([...Object.values(ours.faqIds), ...Object.values(ours.docIds), ...Object.values(rebuiltNow.faqIds), ...Object.values(rebuiltNow.docIds)]);
  const dupes = [
    ...faqItems.filter((it) => !rebuiltNow.faqIds[it.key] && !skip.faq.includes(it.key)).flatMap((it) => faqsNow.filter((f) => !mine.has(f.id) && textKey(f.question) === textKey(it.question)).map((f) => `FAQ「${it.question}」（库里已经有 #${f.id}）`)),
    ...docItems.filter((it) => !rebuiltNow.docIds[it.key] && !skip.doc.includes(it.key)).flatMap((it) => docsNow.filter((d) => !mine.has(d.id) && textKey(d.name) === textKey(it.name)).map((d) => `文件「${it.name}」（库里已经有 #${d.id}）`)),
  ];

  // 要删的旧内容在 md 删之前就被人删了：不是这次删的，撤回不重建（免得复活别人删掉的），备份里有
  const backupFaq = new Map(readBackupFaqs(rec.dir).map((r) => [Number(r.id), r]));
  const backupDoc = new Map(readBackupDocs(rec.dir).map((d) => [Number(d.detail.id), d]));
  const goneBefore = [
    ...(state.goneBefore?.faq ?? []).map((id) => `FAQ #${id}「${trimmed(backupFaq.get(id)?.question ?? '')}」`),
    ...(state.goneBefore?.doc ?? []).map((id) => `文件 #${id}「${trimmed(backupDoc.get(id)?.detail?.name ?? '')}」`),
  ];
  // 导入时晚出现、一模一样、没认下的（可能是这次晚落库的）：也列进认不清的
  const orphans = await orphanRows(ctx, state);
  const doubt = doubtOf(importSettle);
  const merged = orphans.length ? mergeDoubt(doubt, orphans) : doubt;
  return { scope, skip, mustSkip, maySkip, partial, importSettle, revokeSettle, faqItems, docItems, deleteFaqs, deleteDocs, changed, doubt: merged, dupes, goneBefore };
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

// 跳过重建的那几条，撤回自己已经建了的（一半的文件、核对不过的 FAQ）：只看请求刚发完时认下的（晚出现后才认的不算），
// 还是自己写的内容才删，被人改过的留着列出来（只读）
async function partialRebuilds(ctx, book, rebuilt, skip, faqItems, docItems, faqById, docById) {
  const del = { faq: [], doc: [] };
  const keep = [];
  if (!book) return { del, keep };
  const late = (type, key) => (book.lateClaimed?.[type] ?? []).includes(key);
  for (const key of skip.faq) {
    const id = rebuilt.faqIds[key];
    const it = faqItems.find((x) => x.key === key);
    const row = id && faqById.get(id);
    if (!row || !it || late('faq', key)) continue;
    if (textKey(row.question) === textKey(it.question) && textKey(row.answer) === textKey(it.answer)) del.faq.push(id);
    else keep.push(`FAQ #${id}「${trimmed(row.question)}」`);
  }
  for (const key of skip.doc) {
    const id = rebuilt.docIds[key];
    const it = docItems.find((x) => x.key === key);
    if (!id || !it || !docById.has(id) || late('doc', key)) continue;
    const have = await paragraphsOf(ctx, id);
    if (have.length <= it.paragraphs.length && have.every((p, i) => trimmed(p.content) === it.paragraphs[i])) del.doc.push(id);
    else keep.push(`文件 #${id}「${it.name}」`);
  }
  return { del, keep };
}

const STEPS = {
  async rebuild_faqs(ctx, plan) {
    const items = kept(plan.faqItems, ctx.revoke.skipped.faq);
    if (!items.length) return '没有要重建的 FAQ';
    let rows;
    for (const batch of batchesOf(items.filter((f) => !ctx.revoke.faqIds[f.key]), WRITE_BATCH, (f) => textKey(f.question))) rows = await createTracked(ctx, ctx.revoke, 'faq', batch, rows);
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
    const cut = items.filter((d) => d.name !== d.full);
    return `${items.length} 个手工文件、${items.reduce((n, d) => n + d.paragraphs.length, 0)} 段${cut.length ? `（名字超过 30 字截短了：${cut.map((d) => `「${d.name}」`).join('、')}）` : ''}`;
  },

  async verify(ctx, plan) {
    const faqItems = kept(plan.faqItems, ctx.revoke.skipped.faq);
    const docItems = kept(plan.docItems, ctx.revoke.skipped.doc);
    const problems = await verifyContent(ctx, faqItems, ctx.revoke.faqIds, docItems, ctx.revoke.docIds);
    if (problems.length) {
      const error = new MdError('kb_verify_failed', `重建的读回来和备份不一样：${problems.slice(0, 10).map((p) => p.text).join('；')}`);
      error.items = problems.map((p) => ({ type: p.type, key: p.key }));
      throw error;
    }
    return `${faqItems.length} 条 FAQ、${docItems.length} 个文件和备份逐字一致`;
  },

  async review(ctx, plan) {
    const items = kept(plan.faqItems, ctx.revoke.skipped.faq).filter((f) => f.reviewed);
    const ids = items.map((f) => ctx.revoke.faqIds[f.key]);
    try {
      await reviewAll(ctx, ids);
    } catch (error) {
      if (error.left) error.items = items.filter((f) => error.left.includes(ctx.revoke.faqIds[f.key])).map((f) => ({ type: 'faq', key: f.key }));
      throw error;
    }
    return ids.length ? `${ids.length} 条（原来就是已审核的）` : '没有要审核的';
  },

  async index(ctx, plan) {
    const faqItems = kept(plan.faqItems, ctx.revoke.skipped.faq).filter((f) => f.reviewed);
    await waitIndexed(ctx, faqItems, ctx.revoke.faqIds, kept(plan.docItems, ctx.revoke.skipped.doc), ctx.revoke.docIds, ctx.revoke.indexed);
    return '重建的段落全部 ready，重建的 FAQ 都能用自己的问题搜到';
  },

  // 只删导入记录里认下的（还在库里的），加上跳过重建的那几条撤回自己建了一半的（预演里已经列出来）；删之前先备份到本机，删掉的读回确认已经不在
  async delete(ctx, plan) {
    ctx.revoke.partialKept = plan.partial.keep;
    const faqIds = union(Object.values(ctx.state.faqIds), plan.partial.del.faq);
    const docIds = union(Object.values(ctx.state.docIds), plan.partial.del.doc);
    const presentFaqs = new Set((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId, { checked: true })).map((f) => f.id));
    const presentDocs = new Set((await listFiles(ctx.identity, ctx.orgId, ctx.kbId, { checked: true })).map((d) => d.id));
    await backupBeforeDelete(ctx, faqIds.filter((id) => presentFaqs.has(id)), docIds.filter((id) => presentDocs.has(id)));
    await deleteTracked(ctx, ctx.revoke, 'faq', faqIds, { record: true });
    await deleteTracked(ctx, ctx.revoke, 'doc', docIds, { record: true });
    return `删了 FAQ ${ctx.revoke.deleted.faq.length} 条、文件 ${ctx.revoke.deleted.doc.length} 个，读回确认已经不在（删之前的内容在 ${ctx.dir}/revoke-backup）`;
  },
};

// 撤回做完之后，还有没有要人看一眼的：导入时认不清的（意图留着）、晚出现没认下的、撤回跳过重建的几条留下的可疑的
export const tracking = (state) => state.status === 'revoked' && !state.revoke?.leftoversDone
  && (Boolean(state.open) || TYPES.some((t) => (state.revoke?.skipped?.[t] ?? []).length || (state.orphans?.[t] ?? []).length || (state.revoke?.orphans?.[t] ?? []).length));

// 还在库里的认不清的：[{ type, row }]
export async function leftovers(ctx) {
  const rows = [];
  if (ctx.state.open) rows.push(...await doubtRows(ctx, ctx.state, itemsByType(ctx.pkg)));
  rows.push(...await orphanRows(ctx, ctx.state), ...await orphanRows(ctx, ctx.state.revoke));
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

// 这一步失败是哪几条重建的问题（能归到具体哪几条的都算，不管是什么错：一直失败的，用户可以选择跳过）
function failedItems(error) {
  if (error.items) return error.items;
  if (error.item) return error.item.keys.map((key) => ({ type: error.item.type, key }));
  return [];
}

// 第一次确认时把撤回的范围写进状态；之后从第一个没做完的步骤接着做。返回认不清、没删、还在库里的
export async function runRevoke(ctx, plan) {
  const { state } = ctx;
  const id = state.importId;
  applySettle(ctx, state, plan.importSettle, { keep: true });
  state.revoke ??= { scope: plan.scope, steps: {}, stopped: null, faqIds: {}, docIds: {}, deleted: none(), indexed: none(), open: null, attempts: { faq: {}, doc: {} }, failures: { faq: {}, doc: {} }, skipped: none() };
  state.revoke.failures ??= { faq: {}, doc: {} };
  applySettle(ctx, state.revoke, plan.revokeSettle, { claimLate: true, skip: plan.skip[plan.revokeSettle?.open.type] ?? [] });
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
      for (const { type, key } of failedItems(error)) state.revoke.failures[type][key] = (state.revoke.failures[type][key] ?? 0) + 1;
      state.revoke.stopped = { step, reason: error.message, at: new Date().toISOString() };
      save(ctx);
      const again = `查明原因后再运行一次 md kb revoke ${id}，会从这一步接着做；同一条重建失败两次，预演会给出跳过它`;
      const hint = error.code === 'kb_write_ambiguous'
        ? `库里有不止一条和要重建的一模一样的，分不清哪条是撤回建的：请用户在秒懂上看一眼；再运行一次 md kb revoke ${id}，预演会给出跳过它的重建`
        : error.code === 'kb_write_doubt'
        ? `请用户在秒懂上看一眼上面列的：是撤回重建出来的（秒懂改写了内容），就手动删掉它们，再运行一次 md kb revoke ${id}；不是，就直接再运行一次（预演会再列一遍，确认就是认定它们不是撤回建的）。同一条两次都对不上，预演会给出跳过它的重建`
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
