// md kb import / revoke 写知识库的每一个「建」和「删」都走这里（spec 3b §2.1；整支审查 C1、C2 和复审之后重写）。
// 新建接口不返回 id，只能靠列表比对认 id；而知识库是共用的，别人随时可能在加、在删、在改。规矩：
// 1. 只有内容完全对得上才认成这次建的：FAQ 问题和答案都一样；文件同名、是手工文件、而且还是空的（刚建出来一定是 0 段）。
//    只比问题或只比名字会把同一时间别人建的认成自己的，之后往里写、当成自己的删掉（复审 Critical）。
//    发请求之前在的、本机导入记录（这一条和别的）已经认下的，一律不算。一个 key 对上好几条一模一样的：认一条，其余是自己的副本，删掉。
// 2. 发请求之前先把「要发什么、发之前库里有哪些 id」记进导入记录（open，意图），再发；发完不管成败都再列，
//    没认全就隔一会儿再列几次（列表可能有延迟、请求可能晚落库）。请求前后多出来、没认上的（窗口里的）是「可疑的」：
//    可能是秒懂改写了内容的这次写的，也可能是同一时间别人加的——只列出来交给人，不删、不往里写。
// 3. 没认上的 key 记下每一次尝试（attempts）：窗口里有可疑的、或者请求成功却没认上，算一次「可疑的尝试」；
//    同一条可疑的尝试到了两次，多半是秒懂在改写内容，不再重发（导入拒绝续跑、撤回给「跳过它的重建」）。
//    列可疑的时候，把这条每一次尝试留下的都列上，用户确认过「不是这次建的」那几条也不忘（复审 Important 3）。
// 4. 删也先记意图：请求前在、请求后不在了的，才是这次删的；撤回只重建这些，别人删的不复活。
// 5. 自己建的东西，只有能证明还是自己写的内容才删（副本、只写了一段的试写文件）；对不上就停下列出来。
import { EXIT, MdError } from './errors.mjs';
import { listFaqs, listFiles } from './kb.mjs';
import { appendLog, claimedIds, saveState } from './kb-import-store.mjs';
import { textKey } from './kb-package.mjs';
import { WRITE_BATCH, createFaqs, createManualDoc, createParagraph, deleteDoc, deleteFaqs, listParagraphRows } from './kb-write.mjs';

const OPS = { faq: { create: 'batch-create', delete: 'batch-delete' }, doc: { create: 'manual-create', delete: 'file-delete' } };
const SHOW = 10;
export const SETTLE_POLLS = 3; // 发完没认全，再列几次
const settleMs = () => Math.min(Number(process.env.MD_KB_POLL_MS) || 1000, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const trimmed = (s) => String(s ?? '').trim();
export const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
export const mapOf = (book, type) => (type === 'faq' ? book.faqIds : book.docIds);
export const label = (type) => (type === 'faq' ? 'FAQ' : '文件');
const idsOf = (rows) => rows.map((r) => r.id);
const DOUBTFUL = new Set(['doubt', 'unseen']);

export function save(ctx) {
  saveState(ctx.dir, ctx.state);
}
export function log(ctx, entry) {
  appendLog(ctx.dir, entry);
}

// 写流程里认 id 用的列表：翻页不完整就报错（kb_list_unstable），不拿半截列表去认
export async function rowsOf(ctx, type) {
  return type === 'faq'
    ? listFaqs(ctx.identity, ctx.orgId, ctx.kbId, { checked: true })
    : listFiles(ctx.identity, ctx.orgId, ctx.kbId, { checked: true });
}

export async function paragraphsOf(ctx, docId) {
  return (await listParagraphRows(ctx.identity, ctx.orgId, ctx.kbId, docId)).slice().sort((a, b) => Number(a.index) - Number(b.index));
}

// 「#id「问题 / 文件名」」，最多列 10 条
export function describe(type, rows) {
  const shown = rows.slice(0, SHOW).map((r) => `#${r.id}「${type === 'faq' ? r.question : r.name}」`).join('、');
  return rows.length > SHOW ? `${shown}……共 ${rows.length} 条` : shown;
}

// 本机导入记录已经认下的 id（磁盘上的全部记录，加上这一条内存里最新的），包括自己的副本
function excluded(ctx, type) {
  const ids = claimedIds(ctx.regionKey, ctx.kbId)[type];
  for (const book of [ctx.state, ctx.state.revoke].filter(Boolean)) {
    for (const id of Object.values(mapOf(book, type))) ids.add(id);
    for (const id of book.extras?.[type] ?? []) ids.add(id);
  }
  return ids;
}

// 按意图认 id（纯函数）。rows 是现在库里的，items 是这次要建的（key → 内容），empty 是一段都没有的文件 id。
// 返回认上的 key → id、自己的副本、没认上的 key、窗口里没认上的（可疑的；after 不知道时是请求之后新出现的全部）
export function settleCreate(open, rows, items, exclude, empty = new Set()) {
  const before = new Set(open.before);
  const after = Array.isArray(open.after) ? new Set(open.after) : null;
  const fresh = rows.filter((r) => !before.has(r.id) && !exclude.has(r.id));
  const exact = (it, r) => (open.type === 'faq'
    ? textKey(r.question) === textKey(it.question) && textKey(r.answer) === textKey(it.answer)
    : textKey(r.name) === textKey(it.name) && !r.extension && empty.has(r.id));
  const claimed = {};
  const extras = [];
  const used = new Set();
  const unresolved = [];
  for (const key of open.keys) {
    const it = items[key];
    const hits = it ? fresh.filter((r) => !used.has(r.id) && exact(it, r)).sort((a, b) => a.id - b.id) : [];
    if (!hits.length) {
      unresolved.push(key);
      continue;
    }
    claimed[key] = hits[0].id;
    for (const h of hits) used.add(h.id);
    extras.push(...hits.slice(1).map((h) => h.id));
  }
  const suspects = fresh.filter((r) => !used.has(r.id) && (after === null || after.has(r.id)));
  return { claimed, extras, unresolved, suspects };
}

// 一批里问题（去掉空白后）不重复：同一个请求里两条一样的问题，分不清谁是谁（撤回重建时库里原来就可能有重复的问题）
export function batchesOf(items, size, keyOf) {
  const batches = [];
  for (const it of items) {
    const k = keyOf(it);
    let b = batches.find((x) => x.items.length < size && !x.keys.has(k));
    if (!b) {
      b = { items: [], keys: new Set() };
      batches.push(b);
    }
    b.items.push(it);
    b.keys.add(k);
  }
  return batches.map((b) => b.items);
}

// 认文件要知道候选是不是一段都没有：只查同名、手工、请求之后才出现的
async function emptyDocs(ctx, open, rows, items, exclude) {
  if (open.type !== 'doc') return new Set();
  const before = new Set(open.before);
  const names = new Set(open.keys.map((k) => items[k]).filter(Boolean).map((it) => textKey(it.name)));
  const empty = new Set();
  for (const r of rows.filter((x) => !before.has(x.id) && !exclude.has(x.id) && !x.extension && names.has(textKey(x.name)))) {
    if (!(await paragraphsOf(ctx, r.id)).length) empty.add(r.id);
  }
  return empty;
}

async function settleRows(ctx, open, rows, items) {
  const exclude = excluded(ctx, open.type);
  return settleCreate(open, rows, items, exclude, await emptyDocs(ctx, open, rows, items, exclude));
}

const attemptsOf = (book, type) => {
  book.attempts ??= { faq: {}, doc: {} };
  book.attempts[type] ??= {};
  return book.attempts[type];
};

// 没认上的 key 记一次尝试；认上的 key 清掉以前的尝试（以前列过的可疑的，就不是这次建的了）
function noteAttempts(book, open, s, failure) {
  const tries = attemptsOf(book, open.type);
  for (const key of Object.keys(s.claimed)) delete tries[key];
  const outcome = s.suspects.length ? 'doubt' : failure ? 'failed' : 'unseen';
  for (const key of s.unresolved) {
    const list = (tries[key] ??= []);
    if (!list.some((a) => a.intentAt === open.at)) list.push({ intentAt: open.at, outcome, suspects: idsOf(s.suspects), at: new Date().toISOString() });
  }
}

// 这几条以前的尝试留下的可疑的（现在还在、这次没列的）；可疑的尝试到了两次的 key
function history(book, type, keys, rows, current) {
  const tries = attemptsOf(book, type);
  const shown = new Set(idsOf(current));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const past = [...new Set(keys.flatMap((k) => (tries[k] ?? []).flatMap((a) => a.suspects)))].filter((id) => byId.has(id) && !shown.has(id)).map((id) => byId.get(id));
  const stuck = keys.filter((k) => (tries[k] ?? []).filter((a) => DOUBTFUL.has(a.outcome)).length >= 2);
  return { past, stuck };
}

function claimInto(book, type, s) {
  Object.assign(mapOf(book, type), s.claimed);
  if (s.extras.length) {
    book.extras ??= { faq: [], doc: [] };
    book.extras[type] = [...new Set([...(book.extras[type] ?? []), ...s.extras])];
  }
}

function stopped(type, items, s, failure) {
  const what = type === 'faq' ? `${items.length} 条 FAQ ` : `文件「${items[0].name}」`;
  const first = type === 'faq' ? `（${items.length > 1 ? '第一条：' : ''}「${items[0].question}」）` : '';
  const cause = failure ? `（请求本身报错：${failure.message}）` : '';
  if (s.suspects.length) {
    return new MdError('kb_write_doubt', `${what}发出去了，但在库里没有一模一样的${first}${cause}；写的时候库里多出来 ${s.suspects.length} 条对不上的：${describe(type, s.suspects)}——可能是秒懂改写了内容的这次写的，也可能是同一时间别人加的，md 不会动它们`);
  }
  return new MdError(failure?.code ?? 'kb_write_lost', `${what}发出去了，但在库里找不到${first}${cause}`, { exitCode: failure?.exitCode ?? EXIT.ERROR });
}

// 建一批 FAQ（items 是 {key, question, answer}）或一个文件（items 是 [{key, name}]）。认上的记进 book；
// 有没认上的就把意图留着、记下这次尝试、抛错停下。beforeRows 可以传上一次请求之后列出来的（中间没发别的请求），省一次列表
export async function createTracked(ctx, book, type, items, beforeRows) {
  const byKey = Object.fromEntries(items.map((it) => [it.key, it]));
  const before = beforeRows ?? await rowsOf(ctx, type);
  const keys = items.map((it) => it.key);
  const open = { op: 'create', type, keys, before: idsOf(before), after: null, at: new Date().toISOString() };
  book.open = open;
  save(ctx);
  log(ctx, { op: OPS[type].create, phase: 'send', count: items.length, keys });
  let failure = null;
  try {
    if (type === 'faq') await createFaqs(ctx.identity, ctx.orgId, ctx.kbId, items);
    else await createManualDoc(ctx.identity, ctx.orgId, ctx.kbId, items[0].name);
  } catch (error) {
    if (error.code === 'auth_expired') {
      // 身份失效：请求没被受理，什么都没建
      book.open = null;
      save(ctx);
      log(ctx, { op: OPS[type].create, phase: 'refused', keys, error: error.code });
      throw error;
    }
    failure = error;
  }
  let s = null;
  let rows = null;
  let listError = null;
  for (let i = 0; i <= SETTLE_POLLS; i++) {
    if (i) await sleep(settleMs());
    try {
      rows = await rowsOf(ctx, type);
    } catch (error) {
      listError = error;
      continue;
    }
    open.after = idsOf(rows);
    save(ctx);
    s = await settleRows(ctx, open, rows, byKey);
    if (!s.unresolved.length) break;
  }
  if (!s) throw failure ?? listError; // 一次都没列出来：认不了，意图开着，续跑、撤回时再认
  claimInto(book, type, s);
  noteAttempts(book, open, s, failure);
  log(ctx, { op: OPS[type].create, phase: 'settled', claimed: s.claimed, extras: s.extras, unresolved: s.unresolved, suspects: idsOf(s.suspects), error: failure?.code });
  if (!s.unresolved.length) {
    book.open = null; // 回复丢了也没关系：都认上了
    save(ctx);
    await dropExtras(ctx, book, type);
    return rows;
  }
  open.keys = s.unresolved;
  save(ctx);
  throw stopped(type, s.unresolved.map((k) => byKey[k]), s, failure);
}

// 删（FAQ 每批不超过 50 条，文件一次一个）。只删现在还在的；每一批发之前记意图，发完列一遍，请求前在、之后不在的才算这次删的，
// record 时记进 book.deleted（撤回按它重建）。返回这次删掉的、开始之前就已经不在的
export async function deleteTracked(ctx, book, type, ids, { record }) {
  const present = new Set((await rowsOf(ctx, type)).map((r) => r.id));
  const absent = ids.filter((id) => !present.has(id));
  const gone = [];
  for (const batch of type === 'faq' ? chunks(ids.filter((id) => present.has(id)), WRITE_BATCH) : ids.filter((id) => present.has(id)).map((id) => [id])) {
    book.open = { op: 'delete', type, ids: batch, record, at: new Date().toISOString() };
    save(ctx);
    log(ctx, { op: OPS[type].delete, phase: 'send', ids: batch });
    let failure = null;
    try {
      if (type === 'faq') await deleteFaqs(ctx.identity, ctx.orgId, ctx.kbId, batch);
      else await deleteDoc(ctx.identity, ctx.orgId, ctx.kbId, batch[0]);
    } catch (error) {
      if (error.code === 'auth_expired') {
        book.open = null;
        save(ctx);
        throw error;
      }
      failure = error;
    }
    let now;
    try {
      now = new Set((await rowsOf(ctx, type)).map((r) => r.id));
    } catch (error) {
      throw failure ?? error;
    }
    const done = batch.filter((id) => !now.has(id));
    if (record) addDeleted(book, type, done);
    book.open = null;
    save(ctx);
    log(ctx, { op: OPS[type].delete, phase: 'settled', gone: done, error: failure?.code });
    gone.push(...done);
    const still = batch.filter((id) => now.has(id));
    if (still.length) throw failure ?? new MdError('kb_delete_incomplete', `删了之后读回来还在：${still.map((id) => `${label(type)} #${id}`).join('、')}`);
  }
  return { gone, absent };
}

function addDeleted(book, type, ids) {
  book.deleted[type] = [...new Set([...book.deleted[type], ...ids])];
}

// 自己的副本（一模一样的多建出来的）删掉：内容和这次发的完全一样，能证明是自己的
export async function dropExtras(ctx, book, type) {
  const ids = book.extras?.[type] ?? [];
  if (!ids.length) return;
  const { gone, absent } = await deleteTracked(ctx, book, type, ids, { record: false });
  const done = new Set([...gone, ...absent]);
  book.extras[type] = ids.filter((id) => !done.has(id));
  save(ctx);
}

// 上次停下时还开着的意图，按现在的库再认一次（只读，不改状态）。没有开着的意图返回 null。
// items 按类型分开：{ faq: {key: 内容}, doc: {key: 内容} }（撤回时 FAQ 和文件的 key 可能撞号）。
// past：这几条以前的尝试留下的、现在还在的可疑的；stuck：可疑的尝试已经两次的 key，不能再重发
export async function settleOpen(ctx, book, items) {
  const open = book?.open;
  if (!open) return null;
  const rows = await rowsOf(ctx, open.type);
  if (open.op === 'delete') {
    const present = new Set(rows.map((r) => r.id));
    return { open, gone: open.ids.filter((id) => !present.has(id)) };
  }
  const s = await settleRows(ctx, open, rows, items[open.type] ?? {});
  return { open, ...s, ...history(book, open.type, s.unresolved, rows, s.suspects) };
}

// 用户确认之后把重新认的结果写进 book。没认上的：意图关掉，步骤里会重发（没多出来别的，就是没建成；多出来的已经给人看过，
// 确认就是认定它们不是这次建的——尝试还记着，再对不上就不许重发了）。
// keep：没认上、又有可疑的，意图留着（撤回用：以后再运行 revoke 时复查它们还在不在）
export function applySettle(ctx, book, s, { keep = false } = {}) {
  if (!s) return;
  const { open } = s;
  if (open.op === 'delete') {
    if (open.record) addDeleted(book, open.type, s.gone);
    book.open = null;
    log(ctx, { op: OPS[open.type].delete, phase: 'resettled', gone: s.gone });
    return;
  }
  claimInto(book, open.type, s);
  noteAttempts(book, open, s, null);
  book.open = keep && s.unresolved.length && (s.suspects.length || s.past.length) ? { ...open, keys: s.unresolved } : null;
  log(ctx, { op: OPS[open.type].create, phase: 'resettled', claimed: s.claimed, extras: s.extras, unresolved: s.unresolved, suspects: idsOf(s.suspects), past: idsOf(s.past), kept: Boolean(book.open) });
}

// 认不清、还在库里的（撤回做完之后复查用）：开着的意图窗口里的可疑的、这些 key 以前尝试留下的、后来才对上的（晚落库的自己的）
export async function doubtRows(ctx, book, items) {
  const s = await settleOpen(ctx, book, items);
  if (!s || s.open.op !== 'create') return [];
  const late = Object.values(s.claimed).concat(s.extras);
  const rows = await rowsOf(ctx, s.open.type);
  return [...s.suspects, ...s.past, ...rows.filter((r) => late.includes(r.id))].map((row) => ({ type: s.open.type, row }));
}

// 某些 key 以前尝试留下的、现在还在的可疑的（撤回跳过重建的那几条用）
export async function pastRows(ctx, book, type, keys) {
  if (!keys.length) return [];
  const rows = await rowsOf(ctx, type);
  return history(book, type, keys, rows, []).past.map((row) => ({ type, row }));
}

// 建一个文件并逐段写入（只往自己建的文件里写）。续跑时：自己建的文件被人删了就重建；段落是要写的前缀就接着写；
// 对不上（多了、错了：被人改过，或者秒懂改写了内容）就停下列出来——不删、不往里写
export async function writeDoc(ctx, book, item) {
  const docs = mapOf(book, 'doc');
  if (docs[item.key] && !(await rowsOf(ctx, 'doc')).some((d) => d.id === docs[item.key])) {
    delete docs[item.key];
    save(ctx);
  }
  if (!docs[item.key]) await createTracked(ctx, book, 'doc', [item]);
  const docId = docs[item.key];
  const have = await paragraphsOf(ctx, docId);
  const prefix = have.length <= item.paragraphs.length && have.every((p, i) => trimmed(p.content) === item.paragraphs[i]);
  if (!prefix) {
    throw new MdError('kb_doc_mismatch', `文件「${item.name}」（#${docId}）里的段落和要写的对不上（${have.length} 段）：可能被人改过，也可能是秒懂改写了内容；md 不删它、也不再往里写`);
  }
  for (let i = have.length; i < item.paragraphs.length; i++) {
    log(ctx, { op: 'manual-create-paragraph', phase: 'send', docId, index: i });
    await createParagraph(ctx.identity, ctx.orgId, ctx.kbId, docId, item.paragraphs[i]);
  }
  return docId;
}

