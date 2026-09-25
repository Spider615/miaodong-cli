// md kb import / revoke 写知识库的每一个「建」和「删」都走这里（spec 3b §2.1；整支审查和两轮复审之后定下来的规矩）。
// 新建接口不返回 id，只能靠列表比对认 id；知识库是共用的，别人随时可能在加、在删、在改，也可能有人照同样的资料导同样的内容。
// 内容一模一样也证明不了是自己建的，所以：
// 1. 自动认：只认「这次请求刚发完那几次列表里（窗口里）、唯一一条和发出去的内容一模一样的」——FAQ 问题和答案都一样（去掉空白后）；
//    文件同名、是手工文件、而且还是空的。请求之前就在的、本机导入记录已经认下的，一律不算。
// 2. 窗口之后才出现的一模一样的（晚落库的，或者别人照同样内容建的）：不自动认，列出来（late）。FAQ（问题和答案都一样）
//    用户确认了才认；文件的证据太弱（同名的空文件谁都可能建），永远不在事后认，续跑另建一个。没认下的记进 orphans，
//    撤回时一直列出来（它们可能就是这次晚落库的）。一模一样的不止一条：分不清哪条是这次建的，一律不认、不删（ambiguous）。
// 3. 窗口里没认上的是「可疑的」：可能是秒懂改写了内容的这次写的，也可能是同一时间别人加的——只列出来，不删、不往里写。
//    窗口不知道时（发完之后一次列表都没成功），只把内容相近的算可疑，免得把不相干的都算进来。
// 4. 每个没认上的 key 记下每一次尝试：窗口里有可疑的、一模一样的不止一条、请求成功却没认上、或者之后才冒出一模一样的，
//    算「可疑的尝试」；请求本身失败（断网、5xx）又什么都没多出来，不算。可疑的尝试到两次，不再重发。
// 5. 窗口里的判断只在请求刚发完时做一次，记进意图（exact / same / suspectIds）；续跑、撤回按记下的来，不按现在的库重判——
//    当时可疑的，后来被人改成一样也还是可疑；当时一模一样不止一条的，后来被删掉一条也还是分不清（最后一次核实 Critical）。
// 6. 删也先记意图：请求前在、请求后不在了的，才是这次删的；撤回只重建这些，别人删的不复活。
// 7. 这里不删「自己的副本」：好几条一模一样的分不清是谁的，交给人。
import { EXIT, MdError } from './errors.mjs';
import { listFaqs, listFiles } from './kb.mjs';
import { appendLog, claimedIds, saveState } from './kb-import-store.mjs';
import { textKey } from './kb-package.mjs';
import { WRITE_BATCH, createFaqs, createManualDoc, createParagraph, deleteDoc, deleteFaqs, listParagraphRows } from './kb-write.mjs';

const OPS = { faq: { create: 'batch-create', delete: 'batch-delete' }, doc: { create: 'manual-create', delete: 'file-delete' } };
const SHOW = 10;
export const SETTLE_POLLS = 8; // 发完没认全，再列几次（间隔最多 1 秒：列表延迟 8 秒以内都认得上；都认上了就不再列）
const settleMs = () => Math.min(Number(process.env.MD_KB_POLL_MS) || 1000, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const trimmed = (s) => String(s ?? '').trim();
export const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
export const mapOf = (book, type) => (type === 'faq' ? book.faqIds : book.docIds);
export const label = (type) => (type === 'faq' ? 'FAQ' : '文件');
const idsOf = (rows) => rows.map((r) => r.id);
const DOUBTFUL = new Set(['doubt', 'unseen', 'late']);

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

// 本机导入记录已经认下的 id（磁盘上的全部记录，加上这一条内存里最新的）
function excluded(ctx, type) {
  const ids = claimedIds(ctx.regionKey, ctx.kbId)[type];
  for (const book of [ctx.state, ctx.state.revoke].filter(Boolean)) {
    for (const id of Object.values(mapOf(book, type))) ids.add(id);
  }
  return ids;
}

// 内容相近（窗口不知道时判断「可疑」用）：统一全角半角、去掉标点空白之后相等，或者一个包含另一个（被截断）
const loose = (s) => String(s ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
function related(type, it, r) {
  const a = loose(type === 'faq' ? it.question : it.name);
  const b = loose(type === 'faq' ? r.question : r.name);
  return Boolean(a && b) && (a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))));
}

// 按意图认 id（纯函数）。rows 是现在库里的，items 是这次要建的（key → 内容），empty 是一段都没有的文件 id。
// 返回：claimed 自动认下的（窗口里唯一一条一模一样的）、late 窗口之后才出现的唯一一条一模一样的（要用户确认）、
// ambiguous 一模一样的不止一条、unresolved 没自动认上的 key、suspects 可疑的（窗口里没认上的；窗口不知道时是内容相近的）
export function settleCreate(open, rows, items, exclude, empty = new Set()) {
  const before = new Set(open.before);
  const window = Array.isArray(open.after) ? new Set(open.after) : null;
  const fresh = rows.filter((r) => !before.has(r.id) && !exclude.has(r.id));
  const same = (it, r) => (open.type === 'faq'
    ? textKey(r.question) === textKey(it.question) && textKey(r.answer) === textKey(it.answer)
    : textKey(r.name) === textKey(it.name) && !r.extension && empty.has(r.id));
  const claimed = {};
  const late = {};
  const ambiguous = {};
  const seen = new Set();
  const unresolved = [];
  for (const key of open.keys) {
    const it = items[key];
    const hits = it ? fresh.filter((r) => same(it, r)) : [];
    hits.forEach((r) => seen.add(r.id));
    if (hits.length === 1 && window?.has(hits[0].id)) claimed[key] = hits[0].id;
    else {
      unresolved.push(key);
      if (hits.length === 1) late[key] = hits[0];
      if (hits.length > 1) ambiguous[key] = hits;
    }
  }
  const pending = unresolved.map((k) => items[k]).filter(Boolean);
  const suspects = fresh.filter((r) => !seen.has(r.id) && (window ? window.has(r.id) : pending.some((it) => related(open.type, it, r))));
  return { claimed, late, ambiguous, unresolved, suspects };
}

// 续跑、撤回时按请求刚发完时记下的来认（纯函数）：记下的「窗口里唯一一条一模一样的」还在就认；记下的「不止一条」还是分不清；
// 记下的可疑的还是可疑的；窗口之后才出现的一模一样的是 late（一条）或者分不清（不止一条）。
// 当时一次列表都没成功（窗口不知道）：没有记录，窗口之后的规则套到请求之后新出现的全部
export function resettle(open, rows, items, exclude, empty = new Set()) {
  if (!Array.isArray(open.after) || !open.exact) return settleCreate({ ...open, after: null }, rows, items, exclude, empty);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const before = new Set(open.before);
  const window = new Set(open.after);
  const same = (it, r) => (open.type === 'faq'
    ? textKey(r.question) === textKey(it.question) && textKey(r.answer) === textKey(it.answer)
    : textKey(r.name) === textKey(it.name) && !r.extension && empty.has(r.id));
  const outside = rows.filter((r) => !before.has(r.id) && !window.has(r.id) && !exclude.has(r.id));
  const claimed = {};
  const late = {};
  const ambiguous = {};
  const unresolved = [];
  for (const key of open.keys) {
    const exactId = open.exact[key];
    if (exactId && byId.has(exactId) && !exclude.has(exactId)) {
      claimed[key] = exactId;
      continue;
    }
    unresolved.push(key);
    const it = items[key];
    const hits = it ? outside.filter((r) => same(it, r)) : [];
    const was = (open.same?.[key] ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (was.length) ambiguous[key] = [...was, ...hits];
    else if (hits.length === 1) late[key] = hits[0];
    else if (hits.length > 1) ambiguous[key] = hits;
  }
  const suspects = (open.suspectIds ?? []).map((id) => byId.get(id)).filter(Boolean);
  return { claimed, late, ambiguous, unresolved, suspects };
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

async function settleRows(ctx, open, rows, items, { recorded = false } = {}) {
  const exclude = excluded(ctx, open.type);
  const empty = await emptyDocs(ctx, open, rows, items, exclude);
  return recorded ? resettle(open, rows, items, exclude, empty) : settleCreate(open, rows, items, exclude, empty);
}

const attemptsOf = (book, type) => {
  book.attempts ??= { faq: {}, doc: {} };
  book.attempts[type] ??= {};
  return book.attempts[type];
};

// 这次尝试算什么：一模一样的不止一条、窗口里有可疑的 → doubt；请求本身失败、什么都没多出来 → failed（断网，不算可疑）；
// 请求成功却什么都没认上 → unseen（算可疑：可能是列表延迟很久，也可能是秒懂没建）
function outcomeOf(s, requestError) {
  if (Object.keys(s.ambiguous).length || s.suspects.length) return 'doubt';
  return requestError ? 'failed' : 'unseen';
}

// 没认上的 key 记一次尝试（同一个意图只记一次）；认上的 key 清掉以前的尝试（以前列过的可疑的，就不是这次建的了）
function noteAttempts(book, open, s) {
  const tries = attemptsOf(book, open.type);
  for (const key of Object.keys(s.claimed)) delete tries[key];
  const outcome = outcomeOf(s, open.requestError);
  const suspects = [...idsOf(s.suspects), ...Object.values(s.ambiguous).flat().map((r) => r.id)];
  for (const key of s.unresolved) {
    const list = (tries[key] ??= []);
    if (!list.some((a) => a.intentAt === open.at)) list.push({ intentAt: open.at, outcome, suspects, at: new Date().toISOString() });
  }
}

// 这几条以前的尝试留下的可疑的（现在还在、这次没列的）；可疑的尝试已经两次的 key。
// 现在冒出了一模一样的晚到的（lateKeys），这个意图的那次尝试也算可疑（请求其实落库了，只是晚）
function history(book, type, keys, rows, current, { lateKeys = new Set(), openAt = null } = {}) {
  const tries = attemptsOf(book, type);
  const shown = new Set(idsOf(current));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const past = [...new Set(keys.flatMap((k) => (tries[k] ?? []).flatMap((a) => a.suspects)))].filter((id) => byId.has(id) && !shown.has(id)).map((id) => byId.get(id));
  const doubtful = (k) => {
    const list = tries[k] ?? [];
    const n = list.filter((a) => DOUBTFUL.has(a.outcome) || (lateKeys.has(k) && a.intentAt === openAt)).length;
    return n + (lateKeys.has(k) && !list.some((a) => a.intentAt === openAt) ? 1 : 0);
  };
  const stuck = keys.filter((k) => doubtful(k) >= 2);
  return { past, stuck };
}

// 停下时的错误，带上是哪几条（撤回按条数失败次数，决定给不给跳过）
function stopped(type, items, s, failure) {
  const what = type === 'faq' ? `${items.length} 条 FAQ ` : `文件「${items[0].name}」`;
  const first = type === 'faq' ? `（${items.length > 1 ? '第一条：' : ''}「${items[0].question}」）` : '';
  const cause = failure ? `（请求本身报错：${failure.message}）` : '';
  const same = Object.values(s.ambiguous).flat();
  let error;
  if (same.length) {
    error = new MdError('kb_write_ambiguous', `${what}发出去了，库里有不止一条和它一模一样的：${describe(type, same)}${cause}——分不清哪条是这次建的（可能是这次的请求落了两次，也可能是有人同时导了同样的内容），md 一条都不认、不删`);
  } else if (s.suspects.length) {
    error = new MdError('kb_write_doubt', `${what}发出去了，但在库里没有一模一样的${first}${cause}；写的时候库里多出来 ${s.suspects.length} 条对不上的：${describe(type, s.suspects)}——可能是秒懂改写了内容的这次写的，也可能是同一时间别人加的，md 不会动它们`);
  } else {
    error = new MdError(failure?.code ?? 'kb_write_lost', `${what}发出去了，但在库里找不到${first}${cause}`, { exitCode: failure?.exitCode ?? EXIT.ERROR, status: failure?.status ?? null });
  }
  error.item = { type, keys: items.map((it) => it.key), content: outcomeOf(s, failure?.code ?? null) !== 'failed' };
  return error;
}

// 建一批 FAQ（items 是 {key, question, answer}）或一个文件（items 是 [{key, name}]）。自动认下的记进 book；
// 有没认上的就把意图留着、记下这次尝试、抛错停下。beforeRows 可以传上一次请求之后列出来的（中间没发别的请求），省一次列表
export async function createTracked(ctx, book, type, items, beforeRows) {
  const byKey = Object.fromEntries(items.map((it) => [it.key, it]));
  const before = beforeRows ?? await rowsOf(ctx, type);
  const keys = items.map((it) => it.key);
  const open = { op: 'create', type, keys, before: idsOf(before), after: null, requestError: null, at: new Date().toISOString() };
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
    open.requestError = error.code ?? 'error';
    save(ctx);
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
    s = await settleRows(ctx, open, rows, byKey);
    // 当时的判断记下来（先存再认）：续跑、撤回只按这份记录认，不按以后的库重判
    open.exact = { ...s.claimed };
    open.same = Object.fromEntries(Object.entries(s.ambiguous).map(([k, rs]) => [k, idsOf(rs)]));
    open.suspectIds = idsOf(s.suspects);
    save(ctx);
    if (!s.unresolved.length) break;
  }
  if (!s) throw failure ?? listError; // 一次都没列出来：认不了，意图开着（after 不知道），续跑、撤回时再认
  Object.assign(mapOf(book, type), s.claimed);
  noteAttempts(book, open, s);
  log(ctx, { op: OPS[type].create, phase: 'settled', claimed: s.claimed, unresolved: s.unresolved, suspects: idsOf(s.suspects), same: Object.values(s.ambiguous).flat().map((r) => r.id), error: failure?.code });
  if (!s.unresolved.length) {
    book.open = null; // 回复丢了也没关系：窗口里认上了
    save(ctx);
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
  const s = await settleRows(ctx, open, rows, items[open.type] ?? {}, { recorded: true });
  const lateKeys = new Set(Object.keys(s.late));
  return { open, ...s, ...history(book, open.type, s.unresolved, rows, [...s.suspects, ...Object.values(s.ambiguous).flat(), ...Object.values(s.late)], { lateKeys, openAt: open.at }) };
}

// 用户确认之后把重新认的结果写进 book。
// claimLate：窗口之后才出现、一模一样的那条，用户确认是这次建的，认下。
// 没认上的：意图关掉，步骤里会重发（没多出来别的，就是没建成；多出来的已经给人看过，确认就是认定它们不是这次建的——尝试还记着）。
// keep：还有认不清的（一模一样的、可疑的），意图留着（撤回用：以后再运行 revoke 时复查它们还在不在）
export function applySettle(ctx, book, s, { keep = false, claimLate = false, skip = [] } = {}) {
  if (!s) return;
  const { open } = s;
  if (open.op === 'delete') {
    if (open.record) addDeleted(book, open.type, s.gone);
    book.open = null;
    log(ctx, { op: OPS[open.type].delete, phase: 'resettled', gone: s.gone });
    return;
  }
  const takeLate = claimLate && open.type === 'faq';
  const lateTaken = takeLate ? Object.fromEntries(Object.entries(s.late).filter(([k]) => !skip.includes(k)).map(([k, r]) => [k, r.id])) : {};
  const claimed = { ...s.claimed, ...lateTaken };
  const unresolved = s.unresolved.filter((k) => !claimed[k]);
  const settled = { ...s, claimed, unresolved };
  Object.assign(mapOf(book, open.type), claimed);
  if (Object.keys(lateTaken).length) {
    book.lateClaimed ??= { faq: [], doc: [] };
    book.lateClaimed[open.type] = [...new Set([...(book.lateClaimed[open.type] ?? []), ...Object.keys(lateTaken)])];
  }
  noteAttempts(book, open, settled);
  // 晚出现、一模一样、没认下的：这个意图的那次尝试算可疑（请求其实落库了，只是晚）
  const tries = attemptsOf(book, open.type);
  for (const key of unresolved.filter((k) => s.late[k])) {
    const attempt = (tries[key] ?? []).find((a) => a.intentAt === open.at);
    if (attempt) attempt.outcome = 'late';
  }
  // 晚出现、一模一样、又没认下的：可能就是这次晚落库的，一直记着（撤回时列出来，不删）
  const orphans = unresolved.map((k) => s.late[k]).filter(Boolean).map((r) => r.id);
  if (orphans.length) {
    book.orphans ??= { faq: [], doc: [] };
    book.orphans[open.type] = [...new Set([...(book.orphans[open.type] ?? []), ...orphans])];
  }
  const doubtful = unresolved.some((k) => s.late[k] || s.ambiguous[k]) || s.suspects.length || s.past.length;
  book.open = keep && unresolved.length && doubtful ? { ...open, keys: unresolved } : null;
  log(ctx, { op: OPS[open.type].create, phase: 'resettled', claimed, unresolved, suspects: idsOf(s.suspects), past: idsOf(s.past), kept: Boolean(book.open) });
}

// 认不清、还在库里的（撤回做完之后复查用）：开着的意图里一模一样的、晚出现的、可疑的，以及这些 key 以前尝试留下的
export async function doubtRows(ctx, book, items) {
  const s = await settleOpen(ctx, book, items);
  if (!s || s.open.op !== 'create') return [];
  const rows = await rowsOf(ctx, s.open.type);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const claimedNow = Object.values(s.claimed).map((id) => byId.get(id)).filter(Boolean);
  return [...claimedNow, ...Object.values(s.late), ...Object.values(s.ambiguous).flat(), ...s.suspects, ...s.past].map((row) => ({ type: s.open.type, row }));
}

// 晚出现、一模一样、没认下的（可能是这次晚落库的），现在还在的
export async function orphanRows(ctx, book) {
  const rows = [];
  for (const type of ['faq', 'doc']) {
    const ids = book?.orphans?.[type] ?? [];
    if (!ids.length) continue;
    rows.push(...(await rowsOf(ctx, type)).filter((r) => ids.includes(r.id) && !Object.values(mapOf(book, type)).includes(r.id)).map((row) => ({ type, row })));
  }
  return rows;
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
  const tagged = (error) => Object.assign(error, { item: error.item ?? { type: 'doc', keys: [item.key], content: error.code === 'kb_doc_mismatch' || (error.status >= 400 && error.status < 500) } });
  if (docs[item.key] && !(await rowsOf(ctx, 'doc')).some((d) => d.id === docs[item.key])) {
    delete docs[item.key];
    save(ctx);
  }
  if (!docs[item.key]) await createTracked(ctx, book, 'doc', [item]);
  const docId = docs[item.key];
  const have = await paragraphsOf(ctx, docId);
  const prefix = have.length <= item.paragraphs.length && have.every((p, i) => trimmed(p.content) === item.paragraphs[i]);
  if (!prefix) {
    throw tagged(new MdError('kb_doc_mismatch', `文件「${item.name}」（#${docId}）里的段落和要写的对不上（${have.length} 段）：可能被人改过，也可能是秒懂改写了内容；md 不删它、也不再往里写`));
  }
  for (let i = have.length; i < item.paragraphs.length; i++) {
    log(ctx, { op: 'manual-create-paragraph', phase: 'send', docId, index: i });
    try {
      await createParagraph(ctx.identity, ctx.orgId, ctx.kbId, docId, item.paragraphs[i]);
    } catch (error) {
      throw tagged(error);
    }
  }
  return docId;
}
