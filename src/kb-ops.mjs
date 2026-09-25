// md kb import / revoke 写知识库的每一个「建」和「删」都走这里（spec 3b §2.1，整支审查 C1、C2 之后重写）。
// 新建接口不返回 id，只能靠列表比对认 id；而知识库是共用的，别人随时可能在加、在删。规矩：
// 1. 发请求之前，先把「要发什么、发之前库里有哪些 id」记进导入记录（open，意图），再发；发完不管成败都再列一遍（after）。
//    请求前后多出来的（窗口里的），才可能是这次建的。本机导入记录（这一条和别的）已经认下的，一律不算。
// 2. 认要内容对得上：FAQ 在窗口里按问题认；窗口之后才出现的（请求当时没落库、后来才落库），问题和答案都一样才认。
//    文件只有名字可比，只认窗口里的同名文件：窗口之后才出现的同名文件多半是别人建的（审查 C1 复现 3）。
//    一个 key 对上不止一条，也不认。
// 3. 认不上的不删、不往里写、不重发：意图开着，停下；窗口里多出来、对不上的列出来交给人判断（可能是秒懂改写了内容的
//    这次写的，也可能是同一时间别人加的，审查 C2）。续跑、撤回开头按当时的库再认一次（settleOpen）。
// 4. 删也先记意图：请求前在、请求后不在了的，才是这次删的；撤回只重建这些，别人删的不复活（审查 M5）。
import { EXIT, MdError } from './errors.mjs';
import { listFaqs, listFiles } from './kb.mjs';
import { appendLog, claimedIds, saveState } from './kb-import-store.mjs';
import { textKey } from './kb-package.mjs';
import { WRITE_BATCH, createFaqs, createManualDoc, createParagraph, deleteDoc, deleteFaqs, listParagraphRows } from './kb-write.mjs';

const OPS = { faq: { create: 'batch-create', delete: 'batch-delete' }, doc: { create: 'manual-create', delete: 'file-delete' } };
const SHOW = 10;
export const trimmed = (s) => String(s ?? '').trim();
export const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
export const mapOf = (book, type) => (type === 'faq' ? book.faqIds : book.docIds);

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

// 本机导入记录已经认下的 id（磁盘上的全部记录，加上这一条内存里最新的）
function excluded(ctx, type) {
  const ids = claimedIds(ctx.regionKey, ctx.kbId)[type];
  for (const book of [ctx.state, ctx.state.revoke].filter(Boolean)) {
    for (const id of Object.values(mapOf(book, type))) ids.add(id);
  }
  return ids;
}

// 按意图认 id（纯函数）：rows 是现在库里的，itemsByKey 是这次要建的内容。
// 返回认上的 key → id、没认上的 key、窗口里多出来又没认上的（after 不知道时，是请求之后多出来的全部）
export function settleCreate(open, rows, itemsByKey, exclude) {
  const before = new Set(open.before);
  const after = Array.isArray(open.after) ? new Set(open.after) : null;
  const inWindow = (r) => after !== null && after.has(r.id);
  const fresh = rows.filter((r) => !before.has(r.id) && !exclude.has(r.id));
  const fits = (it, r) => {
    if (open.type === 'doc') return inWindow(r) && textKey(r.name) === textKey(it.name);
    if (textKey(r.question) !== textKey(it.question)) return false;
    return inWindow(r) || textKey(r.answer) === textKey(it.answer);
  };
  const claimed = {};
  const used = new Set();
  const unresolved = [];
  for (const key of open.keys) {
    const it = itemsByKey[key];
    const hits = it ? fresh.filter((r) => !used.has(r.id) && fits(it, r)) : [];
    if (hits.length === 1) {
      claimed[key] = hits[0].id;
      used.add(hits[0].id);
    } else unresolved.push(key);
  }
  const others = fresh.filter((r) => !used.has(r.id) && (after === null || inWindow(r)));
  return { claimed, unresolved, others };
}

// 一批里问题（去掉空白后）不重复：同一个请求里两条一样的问题，窗口里就分不清谁是谁（撤回重建时库里原来就可能有重复的问题）
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

function doubt(type, items, others, failure) {
  const what = type === 'faq' ? `${items.length} 条 FAQ ` : `文件「${items[0].name}」`;
  const first = type === 'faq' ? `（${items.length > 1 ? '第一条：' : ''}「${items[0].question}」）` : '';
  const cause = failure ? `（请求本身报错：${failure.message}）` : '';
  if (others.length) {
    return new MdError('kb_write_doubt', `${what}发出去了，但在库里对不上${first}${cause}；写的时候库里多出来 ${others.length} 条对不上的：${describe(type, others)}——可能是秒懂改写了内容的这次写的，也可能是同一时间别人加的，md 不会动它们`);
  }
  return new MdError(failure?.code ?? 'kb_write_lost', `${what}发出去了，但在库里找不到${first}${cause}`, { exitCode: failure?.exitCode ?? EXIT.ERROR });
}

// 建一批 FAQ（items 是 {key, question, answer}）或一个文件（items 是 [{key, name}]）。认上的记进 book；
// 有没认上的就把意图留着、抛错停下。beforeRows 可以传上一次请求之后列出来的（中间没发别的请求），省一次列表
export async function createTracked(ctx, book, type, items, beforeRows) {
  const byKey = Object.fromEntries(items.map((it) => [it.key, it]));
  const before = beforeRows ?? await rowsOf(ctx, type);
  const keys = items.map((it) => it.key);
  book.open = { op: 'create', type, keys, before: before.map((r) => r.id), after: null, at: new Date().toISOString() };
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
  let after;
  try {
    after = await rowsOf(ctx, type);
  } catch (error) {
    throw failure ?? error; // 列不出来就认不了：意图开着，续跑、撤回时再认
  }
  book.open.after = after.map((r) => r.id);
  const s = settleCreate(book.open, after, byKey, excluded(ctx, type));
  Object.assign(mapOf(book, type), s.claimed);
  log(ctx, { op: OPS[type].create, phase: 'settled', claimed: s.claimed, unresolved: s.unresolved, others: s.others.map((r) => r.id), error: failure?.code });
  if (!s.unresolved.length) {
    book.open = null; // 回复丢了也没关系：都认上了
    save(ctx);
    return after;
  }
  book.open.keys = s.unresolved;
  save(ctx);
  throw doubt(type, s.unresolved.map((k) => byKey[k]), s.others, failure);
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
    if (still.length) throw failure ?? new MdError('kb_delete_incomplete', `删了之后读回来还在：${still.map((id) => `${type === 'faq' ? 'FAQ' : '文件'} #${id}`).join('、')}`);
  }
  return { gone, absent };
}

function addDeleted(book, type, ids) {
  book.deleted[type] = [...new Set([...book.deleted[type], ...ids])];
}

// 上次停下时还开着的意图，按现在的库再认一次（只读，不改状态）。没有开着的意图返回 null。
// repeat：没认上、又有对不上的，而且这几条已经被人确认过「不是这次建的」重发过一次——又对不上，多半是秒懂在改写内容，
// 不能再重发（不然每确认一次就多一份改写过的，审查 C2）
export async function settleOpen(ctx, book, itemsByKey) {
  const open = book?.open;
  if (!open) return null;
  const rows = await rowsOf(ctx, open.type);
  if (open.op === 'delete') {
    const present = new Set(rows.map((r) => r.id));
    return { open, gone: open.ids.filter((id) => !present.has(id)) };
  }
  const s = settleCreate(open, rows, itemsByKey, excluded(ctx, open.type));
  const repeat = s.others.length ? s.unresolved.filter((k) => (book.resent ?? []).includes(k)) : [];
  return { open, ...s, repeat };
}

// 用户确认之后把重新认的结果写进 book。没认上的：意图关掉，步骤里会重发（没多出来别的，就是没建成；多出来的已经给人看过，
// 确认就是认定它们不是这次建的——记进 resent，再对不上就不许重发了）。
// keep：没认上、又有对不上的，意图留着（撤回用：以后再运行 revoke 时复查它们还在不在）
export function applySettle(ctx, book, s, { keep = false } = {}) {
  if (!s) return;
  const { open } = s;
  if (open.op === 'delete') {
    if (open.record) addDeleted(book, open.type, s.gone);
    book.open = null;
    log(ctx, { op: OPS[open.type].delete, phase: 'resettled', gone: s.gone });
    return;
  }
  Object.assign(mapOf(book, open.type), s.claimed);
  const judged = s.unresolved.length && s.others.length;
  book.open = keep && judged ? { ...open, keys: s.unresolved, others: s.others.map((r) => r.id) } : null;
  if (judged && !keep) book.resent = [...new Set([...(book.resent ?? []), ...s.unresolved])];
  log(ctx, { op: OPS[open.type].create, phase: 'resettled', claimed: s.claimed, unresolved: s.unresolved, others: s.others.map((r) => r.id), kept: Boolean(book.open) });
}

// 建一个文件并逐段写入（只往自己建的文件里写）。续跑时：自己建的文件被人删了就重建；段落是要写的前缀就接着写；
// 对不上（多了、错了）就删掉这个自己建的文件重建
export async function writeDoc(ctx, book, item) {
  const docs = mapOf(book, 'doc');
  if (docs[item.key] && !(await rowsOf(ctx, 'doc')).some((d) => d.id === docs[item.key])) {
    delete docs[item.key];
    save(ctx);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!docs[item.key]) await createTracked(ctx, book, 'doc', [item]);
    const docId = docs[item.key];
    const have = await paragraphsOf(ctx, docId);
    const prefix = have.length <= item.paragraphs.length && have.every((p, i) => trimmed(p.content) === item.paragraphs[i]);
    if (!prefix) {
      await deleteTracked(ctx, book, 'doc', [docId], { record: false });
      delete docs[item.key];
      save(ctx);
      continue;
    }
    for (let i = have.length; i < item.paragraphs.length; i++) {
      log(ctx, { op: 'manual-create-paragraph', phase: 'send', docId, index: i });
      await createParagraph(ctx.identity, ctx.orgId, ctx.kbId, docId, item.paragraphs[i]);
    }
    return docId;
  }
  throw new MdError('kb_write_lost', `文件「${item.name}」重建之后段落还是对不上`);
}
