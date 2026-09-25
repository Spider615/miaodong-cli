// md kb import 的执行和续跑（spec 3b §4.2、§4.3）。每一步做完写进导入记录；哪一步失败就停在哪一步，--resume 从那里接着做。
// 每个「建」和「删」都走 kb-ops：发之前记意图，按请求前后的差集认 id——只认自己建的，别人的一律不碰；
// 认不清的不删、不重发，停下交给人判断。
// 顺序是安全的关键：先备份（全部读操作）再写；先试写一条读回核对；新 FAQ 审核之前检索不到；新内容全部就绪之后才删旧的。
import { EXIT, MdError } from './errors.mjs';
import { SEARCH_SIZE, listFaqs, listFiles, normalizeFaq, searchFaqs } from './kb.mjs';
import { mapPool, unrestorable } from './kb-import-plan.mjs';
import { readBackupDocs, readBackupFaqs, saveBackupDoc, saveBackupFaqs, saveSnapshot } from './kb-import-store.mjs';
import { textKey } from './kb-package.mjs';
import { WRITE_BATCH, createParagraph, docDetailRaw, downloadOriginal, listFaqRows, reviewFaqs } from './kb-write.mjs';
import { batchesOf, chunks, createTracked, deleteTracked, dropExtras, log, paragraphsOf, rowsOf, save, trimmed, writeDoc } from './kb-ops.mjs';
import { out } from './output.mjs';

export const IMPORT_STEPS = ['snapshot', 'backup', 'canary', 'faqs', 'docs', 'verify', 'review', 'index', 'delete'];
export const STEP_NAMES = {
  snapshot: '快照', backup: '备份要删的', canary: '试写一条', faqs: '建 FAQ', docs: '建文件和段落',
  verify: '核对内容', review: '审核 FAQ（生效）', index: '等向量化', delete: '删旧的',
};
export const SELF_SCORE = 0.99; // 用自己的问题做语义搜索，要搜到自己、分数不低于它
const INDEX_CONCURRENCY = 4;
const pollMs = () => Number(process.env.MD_KB_POLL_MS) || 5000;
const waitMs = () => (Number(process.env.MD_KB_WAIT_S) || 480) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 导入包里的 FAQ、文件按 key 查（认 id、重新认意图时用）。包里 FAQ 和文件的 key 共用一套、不会重复
export const itemsOf = (pkg) => Object.fromEntries([...pkg.faqs, ...pkg.docs].map((it) => [it.key, it]));
export const itemsByType = (pkg) => ({ faq: Object.fromEntries(pkg.faqs.map((f) => [f.key, f])), doc: Object.fromEntries(pkg.docs.map((d) => [d.key, d])) });

// 核对：FAQ 的问题、答案，文件的每一段，都要和期望的逐字一致（比较前去掉首尾空白）
export async function verifyContent(ctx, faqItems, faqIds, docItems, docIds) {
  const problems = [];
  if (faqItems.length) {
    const byId = new Map((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId, { checked: true })).map((f) => [f.id, f]));
    for (const f of faqItems) {
      const row = byId.get(faqIds[f.key]);
      if (!row) problems.push(`FAQ「${f.question}」不在库里了`);
      else if (trimmed(row.question) !== f.question || trimmed(row.answer) !== f.answer) problems.push(`FAQ「${f.question}」读回来和期望的不一样`);
    }
  }
  for (const d of docItems) {
    const have = docIds[d.key] ? await paragraphsOf(ctx, docIds[d.key]) : [];
    if (have.length !== d.paragraphs.length || have.some((p, i) => trimmed(p.content) !== d.paragraphs[i])) problems.push(`文件「${d.name}」的段落读回来和期望的不一样`);
  }
  return problems;
}

// 批量审核，读回确认都是已审核
export async function reviewAll(ctx, ids) {
  for (const batch of chunks(ids, WRITE_BATCH)) {
    log(ctx, { op: 'batch-review', phase: 'send', ids: batch });
    await reviewFaqs(ctx.identity, ctx.orgId, ctx.kbId, batch);
  }
  if (!ids.length) return;
  const byId = new Map((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId, { checked: true })).map((f) => [f.id, f]));
  const left = ids.filter((id) => byId.get(id)?.reviewed !== true);
  if (left.length) throw new MdError('kb_review_failed', `审核之后还有 ${left.length} 条不是已审核（#${left.slice(0, 10).join('、#')}）`);
}

// 等向量化：每个文件的段落数对得上、全部 ready（一段都没有的文件直接算好，审查 I4）；FAQ 用自己的问题做语义搜索要搜到自己。
// done 记已确认的 key（写进状态，续跑时不重查）
export async function waitIndexed(ctx, faqItems, faqIds, docItems, docIds, done) {
  const deadline = Date.now() + waitMs();
  for (;;) {
    for (const d of docItems.filter((x) => !done.doc.includes(x.key))) {
      const have = d.paragraphs.length ? await paragraphsOf(ctx, docIds[d.key]) : [];
      if (have.length === d.paragraphs.length && have.every((p) => p.status === 'ready')) done.doc.push(d.key);
    }
    const pending = faqItems.filter((f) => !done.faq.includes(f.key));
    const found = await mapPool(pending, INDEX_CONCURRENCY, async (f) => (await searchFaqs(ctx.identity, ctx.orgId, ctx.kbId, f.question, { mode: 'semantic', size: SEARCH_SIZE }))
      .some((r) => r.id === faqIds[f.key] && typeof r.similarity === 'number' && r.similarity >= SELF_SCORE));
    pending.forEach((f, i) => { if (found[i]) done.faq.push(f.key); });
    save(ctx);
    const docsLeft = docItems.filter((x) => !done.doc.includes(x.key)).length;
    const faqsLeft = faqItems.filter((x) => !done.faq.includes(x.key)).length;
    if (!docsLeft && !faqsLeft) return;
    if (Date.now() >= deadline) {
      const parts = [docsLeft ? `${docsLeft} 个文件的段落还没 ready` : '', faqsLeft ? `${faqsLeft} 条 FAQ 还搜不到自己` : ''].filter(Boolean);
      throw new MdError('kb_index_waiting', `向量化还没完成：${parts.join('、')}`);
    }
    await sleep(pollMs());
  }
}

// 要删的现在能不能删：备份之后被人改过的（按旧备份删会丢改动），或者现在恢复不了的（配了图、打了标签），一条都不删
async function deleteBlockers(ctx, faqTargets, docTargets) {
  const backFaqs = new Map(readBackupFaqs(ctx.dir).map((r) => [Number(r.id), r]));
  const backDocs = new Map(readBackupDocs(ctx.dir).map((d) => [Number(d.detail.id), d]));
  const rows = new Map((await listFaqRows(ctx.identity, ctx.orgId, ctx.kbId)).map((r) => [Number(r.id), r]));
  const nowDocs = new Map((await listFiles(ctx.identity, ctx.orgId, ctx.kbId, { checked: true })).map((d) => [d.id, d]));
  const changed = [];
  const stuck = [];
  // 撤回按备份重建：问题、答案、审核状态，文件名、段落、摘要，哪一样变了都会被恢复错
  for (const id of faqTargets.filter((x) => rows.has(x))) {
    const row = rows.get(id);
    const b = backFaqs.get(id);
    if (!b || trimmed(row.question) !== trimmed(b.question) || trimmed(row.answer) !== trimmed(b.answer) || normalizeFaq(row).reviewed !== normalizeFaq(b).reviewed) changed.push(`FAQ #${id}`);
    const u = unrestorable('faq', row);
    if (u) stuck.push(`FAQ #${id} ${u.reason}`);
  }
  for (const id of docTargets.filter((x) => nowDocs.has(x))) {
    const b = backDocs.get(id);
    const have = await paragraphsOf(ctx, id);
    const detail = await docDetailRaw(ctx.identity, ctx.orgId, ctx.kbId, id);
    const renamed = !b || trimmed(nowDocs.get(id).name) !== trimmed(b.detail.name) || trimmed(detail.abstract) !== trimmed(b.detail.abstract);
    if (renamed || have.length !== b.paragraphs.length || have.some((p, i) => trimmed(p.content) !== trimmed(b.paragraphs[i].content))) changed.push(`文件 #${id}「${nowDocs.get(id).name}」`);
    const u = unrestorable('doc', detail);
    if (u) stuck.push(`文件 #${id}「${nowDocs.get(id).name}」${u.reason}`);
  }
  const parts = [
    changed.length ? `要删的内容在备份之后被人改过：${changed.join('、')}。按旧备份删掉会丢掉这些改动` : '',
    stuck.length ? `要删的内容现在恢复不了：${stuck.join('、')}` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join('；')}，所以一条都没删` : null;
}

// ---- 导入的各步 ----

const STEPS = {
  // 只做记录（执行前库里有什么），认 id 不靠它
  async snapshot(ctx) {
    const faqs = await listFaqs(ctx.identity, ctx.orgId, ctx.kbId, { checked: true });
    const docs = await listFiles(ctx.identity, ctx.orgId, ctx.kbId, { checked: true });
    saveSnapshot(ctx.dir, { at: new Date().toISOString(), faqIds: faqs.map((f) => f.id), docIds: docs.map((d) => d.id) });
    return `库里原有 FAQ ${faqs.length} 条、文件 ${docs.length} 个`;
  },

  async backup(ctx) {
    const faqTargets = ctx.pkg.deletes.filter((t) => t.type === 'faq');
    const docTargets = ctx.pkg.deletes.filter((t) => t.type === 'doc');
    if (!faqTargets.length && !docTargets.length) return '没有要删的';
    const incomplete = (m) => new MdError('kb_backup_incomplete', `${m}：备份不全，一条都没写`, { hint: '查明原因后再预演、确认一次' });
    if (faqTargets.length) {
      const byId = new Map((await listFaqRows(ctx.identity, ctx.orgId, ctx.kbId)).map((r) => [Number(r.id), r]));
      const rows = faqTargets.map((t) => byId.get(t.id));
      const missing = faqTargets.filter((t, i) => !rows[i]);
      if (missing.length) throw incomplete(`要删的 FAQ #${missing.map((t) => t.id).join('、#')} 在库里找不到了`);
      const stuck = faqTargets.map((t, i) => [t, unrestorable('faq', rows[i])]).filter(([, u]) => u);
      if (stuck.length) throw incomplete(`要删的 FAQ 现在恢复不了（${stuck.map(([t, u]) => `#${t.id} ${u.reason}`).join('、')}）`);
      saveBackupFaqs(ctx.dir, rows);
    }
    let paragraphs = 0;
    let originals = 0;
    for (const t of docTargets) {
      const detail = await docDetailRaw(ctx.identity, ctx.orgId, ctx.kbId, t.id);
      if (!detail?.id) throw incomplete(`要删的文件 #${t.id}「${t.name}」读不到详情`);
      const u = unrestorable('doc', detail);
      if (u) throw incomplete(`要删的文件 #${t.id}「${t.name}」现在${u.reason}，删了恢复不了`);
      const rows = await paragraphsOf(ctx, t.id);
      if (rows.length !== Number(detail.paragraphCount)) throw incomplete(`文件「${t.name}」的段落只拉到 ${rows.length} 段，平台显示 ${detail.paragraphCount} 段`);
      let original = null;
      if (detail.docUrl) {
        try {
          original = await downloadOriginal(detail.docUrl);
        } catch (error) {
          throw incomplete(`文件「${t.name}」的原文件下载失败（${error.message}）`);
        }
        if (!original.length) throw incomplete(`文件「${t.name}」的原文件是空的`);
        originals++;
      }
      saveBackupDoc(ctx.dir, { detail, paragraphs: rows, original });
      paragraphs += rows.length;
    }
    log(ctx, { op: 'backup', faqs: faqTargets.length, docs: docTargets.length, paragraphs, originals });
    return `FAQ ${faqTargets.length} 条、文件 ${docTargets.length} 个（${paragraphs} 段，原文件 ${originals} 个）→ ${ctx.dir}/backup`;
  },

  // 试写：建 1 条 FAQ、1 个文件和它的第 1 段，读回核对。认上的一定和发出去的内容一样（去掉空白后）；
  // 读回来只差空白、或者文件第 1 段被改写（文件里只有自己写的这一段），能证明是自己的，删掉再停下；
  // 文件里还有别的段落，说明有人往里写过，不删，停下列出来。试写建好的被人删了，就重建
  async canary(ctx) {
    const done = [];
    const f = ctx.pkg.faqs[0];
    if (f) {
      const known = ctx.state.faqIds[f.key];
      let row = known ? (await rowsOf(ctx, 'faq')).find((r) => r.id === known) : null;
      if (known && !row) {
        delete ctx.state.faqIds[f.key];
        save(ctx);
      }
      if (!ctx.state.faqIds[f.key]) {
        await createTracked(ctx, ctx.state, 'faq', [f]);
        row = (await rowsOf(ctx, 'faq')).find((r) => r.id === ctx.state.faqIds[f.key]);
      }
      if (!row || trimmed(row.question) !== f.question || trimmed(row.answer) !== f.answer) {
        if (row) await deleteTracked(ctx, ctx.state, 'faq', [row.id], { record: false });
        delete ctx.state.faqIds[f.key];
        save(ctx);
        throw new MdError('kb_canary_failed', '试写的 FAQ 读回来和包里的不一样（秒懂改了空白），已经把它删了，别的一条都没写');
      }
      done.push(`FAQ「${f.question}」`);
    }
    const d = ctx.pkg.docs[0];
    if (d) {
      const known = ctx.state.docIds[d.key];
      if (known && !(await rowsOf(ctx, 'doc')).some((x) => x.id === known)) {
        delete ctx.state.docIds[d.key];
        save(ctx);
      }
      if (!ctx.state.docIds[d.key]) await createTracked(ctx, ctx.state, 'doc', [d]);
      const docId = ctx.state.docIds[d.key];
      let have = await paragraphsOf(ctx, docId);
      if (!have.length) {
        log(ctx, { op: 'manual-create-paragraph', phase: 'send', docId, index: 0 });
        await createParagraph(ctx.identity, ctx.orgId, ctx.kbId, docId, d.paragraphs[0]);
        have = await paragraphsOf(ctx, docId);
      }
      if (have.length > 1) {
        throw new MdError('kb_doc_mismatch', `试写的文件「${d.name}」（#${docId}）里有 ${have.length} 段，md 只写了 1 段：可能有人往里写过；md 不删它、也不再往里写`);
      }
      if (!have.length || trimmed(have[0].content) !== d.paragraphs[0]) {
        if (have.length) await deleteTracked(ctx, ctx.state, 'doc', [docId], { record: false });
        delete ctx.state.docIds[d.key];
        save(ctx);
        throw new MdError('kb_canary_failed', `试写的文件「${d.name}」第 1 段${have.length ? '读回来和包里的不一样（秒懂改了内容），已经把这个文件删了' : '写了之后读不回来'}，其余的都还没写`);
      }
      done.push(`文件「${d.name}」的第 1 段`);
    }
    await dropExtras(ctx, ctx.state, 'faq');
    await dropExtras(ctx, ctx.state, 'doc');
    return done.length ? `${done.join('和')}，读回一致` : '没有要加的（这次只删）';
  },

  async faqs(ctx) {
    const items = ctx.pkg.faqs;
    if (!items.length) return '没有要加的 FAQ';
    const todo = items.filter((f) => !ctx.state.faqIds[f.key]);
    let rows;
    for (const batch of batchesOf(todo, WRITE_BATCH, (f) => textKey(f.question))) rows = await createTracked(ctx, ctx.state, 'faq', batch, rows);
    await dropExtras(ctx, ctx.state, 'faq');
    return `共 ${items.length} 条（这次新建 ${todo.length} 条，每批不超过 ${WRITE_BATCH} 条）`;
  },

  async docs(ctx) {
    const items = ctx.pkg.docs;
    if (!items.length) return '没有要加的文件';
    for (const d of items) {
      await writeDoc(ctx, ctx.state, d);
      save(ctx);
    }
    await dropExtras(ctx, ctx.state, 'doc');
    return `${items.length} 个文件、${items.reduce((n, d) => n + d.paragraphs.length, 0)} 段`;
  },

  async verify(ctx) {
    const problems = await verifyContent(ctx, ctx.pkg.faqs, ctx.state.faqIds, ctx.pkg.docs, ctx.state.docIds);
    if (problems.length) throw new MdError('kb_verify_failed', `读回来和包里的不一样：${problems.slice(0, 10).join('；')}`);
    return `${ctx.pkg.faqs.length} 条 FAQ、${ctx.pkg.docs.length} 个文件逐字一致`;
  },

  async review(ctx) {
    const ids = ctx.pkg.faqs.map((f) => ctx.state.faqIds[f.key]);
    if (!ids.length) return '没有要审核的';
    await reviewAll(ctx, ids);
    return `${ids.length} 条 FAQ 已审核（开始生效）`;
  },

  async index(ctx) {
    await waitIndexed(ctx, ctx.pkg.faqs, ctx.state.faqIds, ctx.pkg.docs, ctx.state.docIds, ctx.state.indexed);
    return '新段落全部 ready，新 FAQ 都能用自己的问题搜到';
  },

  // 删之前再核对一遍（备份之后被人改过、现在恢复不了的，一条都不删）；只删现在还在的，删掉的才记成这次删的
  async delete(ctx) {
    const faqTargets = ctx.pkg.deletes.filter((t) => t.type === 'faq').map((t) => t.id);
    const docTargets = ctx.pkg.deletes.filter((t) => t.type === 'doc').map((t) => t.id);
    if (!faqTargets.length && !docTargets.length) return '没有要删的';
    const blocked = await deleteBlockers(ctx, faqTargets, docTargets);
    if (blocked) {
      throw new MdError('kb_target_changed', blocked, { hint: `新内容已经写进去了；要撤回就运行 md kb revoke ${ctx.state.importId}，再按现在的内容重新生成导入包` });
    }
    const f = await deleteTracked(ctx, ctx.state, 'faq', faqTargets, { record: true });
    const d = await deleteTracked(ctx, ctx.state, 'doc', docTargets, { record: true });
    const others = (type, ids) => ids.filter((id) => !ctx.state.deleted[type].includes(id));
    const before = [...others('faq', f.absent).map((id) => `FAQ #${id}`), ...others('doc', d.absent).map((id) => `文件 #${id}`)];
    const { faq, doc } = ctx.state.deleted;
    return `删了 FAQ ${faq.length} 条、文件 ${doc.length} 个，读回确认已经不在${before.length ? `；${before.join('、')} 在删之前已经不在了（不是这次删的，撤回时也不会重建）` : ''}`;
  },
};

// 停下时给什么提示：写进去会变样的，别续跑；认不清的，先让人看；步骤自己给了提示的（kb_ 开头），用它的；
// 别的（网络、积分、身份）在它自己的提示后面补上怎么续跑、怎么撤回
function stopHint(error, id) {
  if (error.code === 'kb_canary_failed' || error.code === 'kb_verify_failed') return `导入包的内容写进秒懂之后会变样，接着做也没用；要撤回已经写进去的：md kb revoke ${id}`;
  if (error.code === 'kb_write_doubt') {
    return `在秒懂上看一眼上面列的：是这次写进去的（秒懂改写了内容），就别续跑——先 md kb revoke ${id}，再在秒懂上手动删掉它们；不是，就 md kb import --resume ${id}（预演会再列一遍，确认就是认定它们不是这次建的）`;
  }
  if (error.code === 'kb_doc_mismatch') {
    return `在秒懂上看一眼这个文件；不要这次导入了就 md kb revoke ${id}（撤回会先把它现在的内容备份到本机，再删）`;
  }
  if (error.code?.startsWith('kb_') && error.hint) return error.hint;
  const next = `查明原因后接着做：md kb import --resume ${id}；不要了就撤回：md kb revoke ${id}`;
  return error.hint ? `${error.hint}；${next}` : next;
}

// 从第一个没做完的步骤接着做。失败时记下停在哪一步、为什么，抛出的错说明怎么接着做、怎么撤回
export async function runImport(ctx) {
  const id = ctx.state.importId;
  ctx.state.status = 'running';
  ctx.state.stopped = null;
  save(ctx);
  for (const step of IMPORT_STEPS) {
    if (ctx.state.steps[step]) continue;
    let summary;
    try {
      summary = await STEPS[step](ctx);
    } catch (error) {
      ctx.state.status = 'stopped';
      ctx.state.stopped = { step, reason: error.message, at: new Date().toISOString() };
      save(ctx);
      throw new MdError(error.code ?? 'kb_import_failed', `停在「${STEP_NAMES[step]}」：${error.message}`, { exitCode: error.exitCode ?? EXIT.ERROR, hint: stopHint(error, id) });
    }
    ctx.state.steps[step] = new Date().toISOString();
    save(ctx);
    out(`${STEP_NAMES[step]}：${summary}`);
  }
  ctx.state.status = 'done';
  save(ctx);
  out(`完成。要撤回就运行：md kb revoke ${id}`);
}
