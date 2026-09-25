// md kb import 的执行和续跑（spec 3b §4.2、§4.3）。每一步做完写进导入记录；哪一步失败就停在哪一步，--resume 从那里接着做。
// 每一步都能重复执行：「新建」之前先按快照对账（不在快照里、问题或文件名一致的，就是这次建的），已经建好的不会再建。
// 顺序是安全的关键：先备份（全部读操作）再写；先试写一条读回核对；新 FAQ 审核之前检索不到；新内容全部就绪之后才删旧的。
import { EXIT, MdError } from './errors.mjs';
import { SEARCH_SIZE, listFaqs, listFiles, searchFaqs } from './kb.mjs';
import { mapPool } from './kb-import-plan.mjs';
import { appendLog, readBackupDocs, readBackupFaqs, saveBackupDoc, saveBackupFaqs, saveSnapshot, saveState } from './kb-import-store.mjs';
import { textKey } from './kb-package.mjs';
import { WRITE_BATCH, createFaqs, createManualDoc, createParagraph, deleteDoc, deleteFaqs, docDetailRaw, downloadOriginal, listFaqRows, listParagraphRows, reviewFaqs } from './kb-write.mjs';
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
export const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const trimmed = (s) => String(s ?? '').trim();

export function save(ctx) {
  saveState(ctx.dir, ctx.state);
}
export function log(ctx, entry) {
  appendLog(ctx.dir, entry);
}

// 按「不在 exclude 里、问题一致」找回新建 FAQ 的 id（新建接口不返回 id，3b §2.1）。known 是 key → id，会被补上
export async function reconcileFaqs(ctx, items, known, exclude) {
  const current = await listFaqs(ctx.identity, ctx.orgId, ctx.kbId);
  const taken = new Set(Object.values(known));
  for (const it of items) {
    if (known[it.key]) continue;
    const hits = current.filter((f) => !exclude.has(f.id) && !taken.has(f.id) && textKey(f.question) === textKey(it.question));
    if (hits.length > 1) throw new MdError('kb_import_ambiguous', `「${it.question}」在库里对上了 ${hits.length} 条新 FAQ（#${hits.map((h) => h.id).join('、#')}），分不清哪条是这次建的`, { hint: '先在秒懂上看一眼是不是有人同时在加同样的问题' });
    if (hits.length === 1) {
      known[it.key] = hits[0].id;
      taken.add(hits[0].id);
    }
  }
  return current;
}

// 按「不在 exclude 里、文件名一致」找回新建文件的 id
export async function reconcileDocs(ctx, items, known, exclude) {
  const current = await listFiles(ctx.identity, ctx.orgId, ctx.kbId);
  const taken = new Set(Object.values(known));
  for (const it of items) {
    if (known[it.key]) continue;
    const hits = current.filter((d) => !exclude.has(d.id) && !taken.has(d.id) && d.name.trim() === it.name);
    if (hits.length > 1) throw new MdError('kb_import_ambiguous', `文件名「${it.name}」在库里对上了 ${hits.length} 个新文件，分不清哪个是这次建的`, { hint: '先在秒懂上看一眼是不是有人同时在建同名文件' });
    if (hits.length === 1) {
      known[it.key] = hits[0].id;
      taken.add(hits[0].id);
    }
  }
  return current;
}

export async function paragraphsOf(ctx, docId) {
  return (await listParagraphRows(ctx.identity, ctx.orgId, ctx.kbId, docId)).slice().sort((a, b) => Number(a.index) - Number(b.index));
}

// 建一个文件并逐段写入。已经建了一部分的：段落和要写的对得上（是前缀）就接着写；对不上就删掉重建（这个文件是自己建的）
export async function writeDoc(ctx, item, known, exclude) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!known[item.key]) {
      await createManualDoc(ctx.identity, ctx.orgId, ctx.kbId, item.name);
      log(ctx, { op: 'manual-create', count: 1 });
      await reconcileDocs(ctx, [item], known, exclude);
      if (!known[item.key]) throw new MdError('kb_import_lost', `文件「${item.name}」建了之后在库里找不到`);
      save(ctx);
    }
    const docId = known[item.key];
    const have = await paragraphsOf(ctx, docId);
    const prefix = have.length <= item.paragraphs.length && have.every((p, i) => trimmed(p.content) === item.paragraphs[i]);
    if (!prefix) {
      await deleteDoc(ctx.identity, ctx.orgId, ctx.kbId, docId);
      log(ctx, { op: 'file-delete', ids: [docId], reason: '段落和要写的对不上，删掉重建' });
      delete known[item.key];
      save(ctx);
      continue;
    }
    for (let i = have.length; i < item.paragraphs.length; i++) {
      await createParagraph(ctx.identity, ctx.orgId, ctx.kbId, docId, item.paragraphs[i]);
    }
    if (item.paragraphs.length > have.length) log(ctx, { op: 'manual-create-paragraph', docId, count: item.paragraphs.length - have.length });
    return docId;
  }
  throw new MdError('kb_import_lost', `文件「${item.name}」重建之后段落还是对不上`);
}

// 核对：FAQ 的问题、答案，文件的每一段，都要和期望的逐字一致（比较前去掉首尾空白）
export async function verifyContent(ctx, faqItems, faqIds, docItems, docIds) {
  const problems = [];
  if (faqItems.length) {
    const byId = new Map((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId)).map((f) => [f.id, f]));
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
    await reviewFaqs(ctx.identity, ctx.orgId, ctx.kbId, batch);
    log(ctx, { op: 'batch-review', count: batch.length, ids: batch });
  }
  if (!ids.length) return;
  const byId = new Map((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId)).map((f) => [f.id, f]));
  const left = ids.filter((id) => byId.get(id)?.reviewed !== true);
  if (left.length) throw new MdError('kb_review_failed', `审核之后还有 ${left.length} 条不是已审核（#${left.slice(0, 10).join('、#')}）`);
}

// 等向量化：段落全部 ready；FAQ 用自己的问题做语义搜索要搜到自己。done 记已确认的 key（写进状态，续跑时不重查）
export async function waitIndexed(ctx, faqItems, faqIds, docItems, docIds, done) {
  const deadline = Date.now() + waitMs();
  for (;;) {
    for (const d of docItems.filter((x) => !done.doc.includes(x.key))) {
      const have = await paragraphsOf(ctx, docIds[d.key]);
      if (have.length && have.every((p) => p.status === 'ready')) done.doc.push(d.key);
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

// ---- 导入的各步 ----

const STEPS = {
  async snapshot(ctx) {
    const faqs = await listFaqs(ctx.identity, ctx.orgId, ctx.kbId);
    const docs = await listFiles(ctx.identity, ctx.orgId, ctx.kbId);
    ctx.snapshot = { at: new Date().toISOString(), faqIds: faqs.map((f) => f.id), docIds: docs.map((d) => d.id) };
    saveSnapshot(ctx.dir, ctx.snapshot);
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
      saveBackupFaqs(ctx.dir, rows);
    }
    let paragraphs = 0;
    let originals = 0;
    for (const t of docTargets) {
      const detail = await docDetailRaw(ctx.identity, ctx.orgId, ctx.kbId, t.id);
      if (!detail?.id) throw incomplete(`要删的文件 #${t.id}「${t.name}」读不到详情`);
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

  async canary(ctx) {
    const exclude = new Set(ctx.snapshot.faqIds);
    const done = [];
    const f = ctx.pkg.faqs[0];
    if (f && !ctx.state.faqIds[f.key]) {
      await createFaqs(ctx.identity, ctx.orgId, ctx.kbId, [f]);
      log(ctx, { op: 'batch-create', count: 1, canary: true });
      const current = await reconcileFaqs(ctx, [f], ctx.state.faqIds, exclude);
      // 按问题对不上：秒懂可能改了内容。试写只建了一条，快照之后新出现的正好一条就是它——先记下（断了也能撤回），再比对、删掉
      if (!ctx.state.faqIds[f.key]) {
        const fresh = current.filter((r) => !exclude.has(r.id));
        if (fresh.length === 1) ctx.state.faqIds[f.key] = fresh[0].id;
        else if (fresh.length > 1) throw new MdError('kb_canary_failed', `试写之后库里多了 ${fresh.length} 条 FAQ（#${fresh.map((r) => r.id).join('、#')}），可能有人同时在加，分不清哪条是试写的，没有删`, { hint: '在秒懂上看一眼，手动删掉试写的那条' });
      }
      save(ctx);
      const id = ctx.state.faqIds[f.key];
      if (!id) throw new MdError('kb_canary_failed', `试写的 FAQ「${f.question}」写进去之后在库里找不到`);
      const row = current.find((r) => r.id === id);
      if (trimmed(row.question) !== f.question || trimmed(row.answer) !== f.answer) {
        await deleteFaqs(ctx.identity, ctx.orgId, ctx.kbId, [id]);
        log(ctx, { op: 'batch-delete', ids: [id], reason: '试写的读回来不一样' });
        delete ctx.state.faqIds[f.key];
        save(ctx);
        throw new MdError('kb_canary_failed', `试写的 FAQ 读回来和包里的不一样（秒懂改了内容），已经把它删了，别的一条都没写`);
      }
      done.push(`FAQ「${f.question}」`);
    }
    const d = ctx.pkg.docs[0];
    if (d && !ctx.state.docIds[d.key]) {
      const exDocs = new Set(ctx.snapshot.docIds);
      await createManualDoc(ctx.identity, ctx.orgId, ctx.kbId, d.name);
      log(ctx, { op: 'manual-create', count: 1, canary: true });
      const currentDocs = await reconcileDocs(ctx, [d], ctx.state.docIds, exDocs);
      if (!ctx.state.docIds[d.key]) {
        const fresh = currentDocs.filter((x) => !exDocs.has(x.id));
        if (fresh.length === 1) ctx.state.docIds[d.key] = fresh[0].id;
        else if (fresh.length > 1) throw new MdError('kb_canary_failed', `试写之后库里多了 ${fresh.length} 个文件，可能有人同时在建，分不清哪个是试写的，没有删`, { hint: '在秒懂上看一眼，手动删掉试写的那个' });
      }
      save(ctx);
      const docId = ctx.state.docIds[d.key];
      if (!docId) throw new MdError('kb_canary_failed', `试写的文件「${d.name}」建了之后在库里找不到`);
      await createParagraph(ctx.identity, ctx.orgId, ctx.kbId, docId, d.paragraphs[0]);
      log(ctx, { op: 'manual-create-paragraph', docId, count: 1, canary: true });
      const have = await paragraphsOf(ctx, docId);
      if (have.length !== 1 || trimmed(have[0].content) !== d.paragraphs[0]) {
        await deleteDoc(ctx.identity, ctx.orgId, ctx.kbId, docId);
        log(ctx, { op: 'file-delete', ids: [docId], reason: '试写的读回来不一样' });
        delete ctx.state.docIds[d.key];
        save(ctx);
        throw new MdError('kb_canary_failed', `试写的文件「${d.name}」第 1 段读回来和包里的不一样（秒懂改了内容），已经把它删了，别的一条都没写`);
      }
      done.push(`文件「${d.name}」的第 1 段`);
    }
    return done.length ? `${done.join('和')}，读回一致` : '没有要加的（这次只删）';
  },

  async faqs(ctx) {
    const exclude = new Set(ctx.snapshot.faqIds);
    const items = ctx.pkg.faqs;
    if (!items.length) return '没有要加的 FAQ';
    await reconcileFaqs(ctx, items, ctx.state.faqIds, exclude); // 续跑：上次发出去、没收到回复的，先找回来
    save(ctx);
    const todo = items.filter((f) => !ctx.state.faqIds[f.key]);
    for (const batch of chunks(todo, WRITE_BATCH)) {
      await createFaqs(ctx.identity, ctx.orgId, ctx.kbId, batch);
      log(ctx, { op: 'batch-create', count: batch.length });
    }
    await reconcileFaqs(ctx, items, ctx.state.faqIds, exclude);
    save(ctx);
    const lost = items.filter((f) => !ctx.state.faqIds[f.key]);
    if (lost.length) throw new MdError('kb_import_lost', `有 ${lost.length} 条 FAQ 发出去了，但在库里找不到（第一条：「${lost[0].question}」）`);
    return `共 ${items.length} 条（这次新建 ${todo.length} 条，每批不超过 ${WRITE_BATCH} 条）`;
  },

  async docs(ctx) {
    const items = ctx.pkg.docs;
    if (!items.length) return '没有要加的文件';
    const exclude = new Set(ctx.snapshot.docIds);
    await reconcileDocs(ctx, items, ctx.state.docIds, exclude);
    save(ctx);
    for (const d of items) {
      await writeDoc(ctx, d, ctx.state.docIds, exclude);
      save(ctx);
    }
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

  async delete(ctx) {
    const faqTargets = ctx.pkg.deletes.filter((t) => t.type === 'faq').map((t) => t.id);
    const docTargets = ctx.pkg.deletes.filter((t) => t.type === 'doc').map((t) => t.id);
    if (!faqTargets.length && !docTargets.length) return '没有要删的';
    // 删之前和备份逐条比对：备份之后被人改过的，按旧备份删掉会丢掉改动（撤回也只能恢复旧的），所以一条都不删
    const backFaqs = new Map(readBackupFaqs(ctx.dir).map((r) => [Number(r.id), r]));
    const backDocs = new Map(readBackupDocs(ctx.dir).map((d) => [Number(d.detail.id), d]));
    const nowFaqs = new Map((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId)).map((f) => [f.id, f]));
    const changed = [];
    for (const id of faqTargets) {
      const row = nowFaqs.get(id);
      const b = backFaqs.get(id);
      if (row && b && (trimmed(row.question) !== trimmed(b.question) || trimmed(row.answer) !== trimmed(b.answer))) changed.push(`FAQ #${id}`);
    }
    const nowDocs = new Map((await listFiles(ctx.identity, ctx.orgId, ctx.kbId)).map((d) => [d.id, d]));
    for (const id of docTargets.filter((x) => nowDocs.has(x))) {
      const b = backDocs.get(id);
      const have = await paragraphsOf(ctx, id);
      if (!b || have.length !== b.paragraphs.length || have.some((p, i) => trimmed(p.content) !== trimmed(b.paragraphs[i].content))) changed.push(`文件 #${id}「${nowDocs.get(id).name}」`);
    }
    if (changed.length) {
      throw new MdError('kb_target_changed', `要删的内容在备份之后被人改过：${changed.join('、')}。按旧备份删掉会丢掉这些改动，所以一条都没删`, { hint: `新内容已经写进去了；要撤回就运行 md kb revoke ${ctx.state.importId}，再按改过的内容重新生成导入包` });
    }
    if (faqTargets.length) {
      const present = new Set(nowFaqs.keys());
      const todo = faqTargets.filter((id) => present.has(id));
      for (const batch of chunks(todo, WRITE_BATCH)) {
        await deleteFaqs(ctx.identity, ctx.orgId, ctx.kbId, batch);
        log(ctx, { op: 'batch-delete', count: batch.length, ids: batch });
      }
    }
    const presentDocs = new Set((await listFiles(ctx.identity, ctx.orgId, ctx.kbId)).map((d) => d.id));
    for (const id of docTargets.filter((x) => presentDocs.has(x))) {
      await deleteDoc(ctx.identity, ctx.orgId, ctx.kbId, id);
      log(ctx, { op: 'file-delete', ids: [id] });
    }
    const leftFaqs = new Set((await listFaqs(ctx.identity, ctx.orgId, ctx.kbId)).map((f) => f.id));
    const leftDocs = new Set((await listFiles(ctx.identity, ctx.orgId, ctx.kbId)).map((d) => d.id));
    ctx.state.deleted = { faq: faqTargets.filter((id) => !leftFaqs.has(id)), doc: docTargets.filter((id) => !leftDocs.has(id)) };
    save(ctx);
    const still = [...faqTargets.filter((id) => leftFaqs.has(id)).map((id) => `FAQ #${id}`), ...docTargets.filter((id) => leftDocs.has(id)).map((id) => `文件 #${id}`)];
    if (still.length) throw new MdError('kb_delete_incomplete', `删了之后读回来还在：${still.join('、')}`);
    return `删了 FAQ ${faqTargets.length} 条、文件 ${docTargets.length} 个，读回确认已经不在`;
  },
};

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
      const fatal = error.code === 'kb_canary_failed' || error.code === 'kb_verify_failed';
      throw new MdError(error.code ?? 'kb_import_failed', `停在「${STEP_NAMES[step]}」：${error.message}`, {
        exitCode: error.exitCode ?? EXIT.ERROR,
        hint: fatal
          ? `导入包的内容写进秒懂之后会变样，接着做也没用；要撤回已经写进去的：md kb revoke ${id}`
          : `查明原因后接着做：md kb import --resume ${id}；不要了就撤回：md kb revoke ${id}`,
      });
    }
    ctx.state.steps[step] = new Date().toISOString();
    save(ctx);
    out(`${STEP_NAMES[step]}：${summary}`);
  }
  ctx.state.status = 'done';
  save(ctx);
  out(`完成。要撤回就运行：md kb revoke ${id}`);
}
