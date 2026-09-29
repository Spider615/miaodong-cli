// md kb why（spec 3a §3.5）：这次执行为什么没召回那一条。只读、不花钱、不自动试跑。
// 主路径：大模型的知识库工具调用，用控制台语义搜索按原样重放（分数和当时一致，spec §2.3）；重放和记录对不上时提示「知识库改过」。
// 语义搜索只返回 0.8 以上的：更低的分数重放看不到，这时按门槛和这次召回的条数推断（kb-diagnose）。
// 次要路径：知识库查询节点，只能按配置和重放估计（它用加权重排）。
import { strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { EXEC_ID, locateExec } from '../exec-locate.mjs';
import { findExecNode, normalizeDetail } from '../exec-detail.mjs';
import { clip } from '../execs.mjs';
import { PAGE_SIZE, SEARCH_SIZE, SEMANTIC_FLOOR, checkSimilarity, firstPerFaq, listFaqs, listFiles, listKbs, listParagraphs, searchFaqs } from '../kb.mjs';
import { diagnose, drifted, sameText } from '../kb-diagnose.mjs';
import { retrievalsOf } from '../kb-retrieval.mjs';
import { DATA_NOTE, formatTime, out, shortId, targetLine } from '../output.mjs';

const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '?');
const unit = (t) => (typeof t === 'number' && t > 1 ? t / 100 : t); // 知识库查询节点的门槛写成 80，工具调用写成 0.8
const keyOf = (x) => `${x.nodeId}#${x.order}`;
const isFaqHit = (h) => h.type === 'qa';
const hitLine = (h) => (isFaqHit(h) ? `#${h.faqId} ${fmt(h.score)}` : `#${h.faqId ?? '?'}（${h.type}）${fmt(h.score)}`);
const hasT = (r) => typeof r.threshold === 'number';
const thresholdText = (r) => (hasT(r) ? `门槛 ${fmt(r.threshold)}` : '门槛没记录');
// FAQ 的上传时间晚于这次执行：执行的时候库里还没有它。上传时间或执行时间认不出就不下这个结论
const addedAfter = (faq, execAt) => typeof faq?.createdAt === 'number' && typeof execAt === 'number' && faq.createdAt > execAt;

// 这次执行里的检索，按节点的每一次运行归成一处：一处里可能有好几次工具调用
function groups({ calls, kbNodes, silent }) {
  const map = new Map();
  const at = (x) => {
    if (!map.has(keyOf(x))) map.set(keyOf(x), { nodeId: x.nodeId, nodeName: x.nodeName, order: x.order, calls: [], kbNode: null, silent: null });
    return map.get(keyOf(x));
  };
  for (const c of calls) at(c).calls.push(c);
  for (const n of kbNodes) at(n).kbNode = n;
  for (const s of silent) at(s).silent = s;
  return map;
}
const describe = (g) => (g.calls.length ? `调了 ${g.calls.length} 次知识库工具` : g.kbNode ? '知识库查询节点' : '挂了知识库工具但没调');
const nodeList = (gs) => gs.map((g) => `#${g.order} ${g.nodeName}`).join('、');

// 要看哪几处（spec §3.5 第 2 步）：真的检索只有一处时直接看它，挂了知识库工具、这次没调的节点只附一句；
// 真的检索有好几处时列出来，用 --node 指定；一处都没有时，挂了工具没调的节点逐个报「模型没调知识库工具」
function pick(norm, found, nodeQuery) {
  const map = groups(found);
  if (nodeQuery) {
    const n = findExecNode(norm, nodeQuery);
    const g = map.get(`${n.id}#${n.order}`);
    if (!g) throw new MdError('kb_no_retrieval', `「${n.name}」这次没有做知识库检索，也没挂知识库工具`, { exitCode: EXIT.TARGET });
    return { picked: [g], others: [] };
  }
  const all = [...map.values()];
  const real = all.filter((g) => g.calls.length || g.kbNode);
  const silent = all.filter((g) => !g.calls.length && !g.kbNode);
  if (real.length === 1) return { picked: real, others: silent };
  if (real.length > 1) {
    const lines = real.map((g) => `  - #${g.order} ${g.nodeName}：${describe(g)}`).join('\n');
    const tail = silent.length ? `\n  （另有挂了知识库工具、这次没调的：${nodeList(silent)}）` : '';
    throw new MdError('kb_many_retrievals', `这次执行有 ${real.length} 处知识库检索，用 --node 指定：\n${lines}${tail}`, { exitCode: EXIT.TARGET });
  }
  if (silent.length) return { picked: silent, others: [] };
  throw new MdError('kb_no_retrieval', '这次执行没有用到知识库：没有知识库工具调用，也没有跑知识库查询节点', {
    exitCode: EXIT.TARGET,
    hint: '知识库检索可能在同一条事件链的另一条执行里：md exec <执行id> 看事件链',
  });
}

async function kbsOf(ctx) {
  if (!ctx.kbs) ctx.kbs = new Map((await listKbs(ctx.identity, ctx.orgId)).map((k) => [k.id, k]));
  return ctx.kbs;
}
const kbName = (kbs, id) => kbs.get(id)?.name ?? `已不存在的库 ${shortId(id)}`;
// 企业里还在、而且有 FAQ 的库：只有它们能做语义搜索、相似度检查、列 FAQ。平台没给条数（null）时当作可能有（整支审查小问题 4）
const hasFaqs = (kbs, id) => kbs.has(id) && kbs.get(id).faqCount !== 0;

// 一个库的全部 FAQ，这次命令里只拉一次（一个节点调了好几次、跨库找 id 时会反复用到）
async function faqsOf(ctx, kbId) {
  if (!ctx.faqs.has(kbId)) ctx.faqs.set(kbId, await listFaqs(ctx.identity, ctx.orgId, kbId));
  return ctx.faqs.get(kbId);
}

// 重放不了的原因；能重放时是 null。有原因时不重放、不比「改过」、不推原因，只报查不出
function noReplayReason(kbs, kbIds, query, tags) {
  if (!String(query ?? '').trim()) return '这次检索的查询取不到';
  if (tags.length) return `模型这次按标签（${tags.join('、')}）过滤了，重放不带标签，结果不可比`;
  const live = kbIds.filter((id) => kbs.has(id));
  if (!live.length) return '查的库已经不在企业里了（执行之后被删了？）';
  if (!live.some((id) => hasFaqs(kbs, id))) return '查的库只有文件段落，没有语义搜索接口';
  return null;
}

// 用一段话在这些库里重做语义搜索，合在一起按分数排。只搜企业里还在、有 FAQ 的库；
// 秒懂报错就照实报错退出：当成「没有结果」会编出一个很肯定的原因（整支审查第 1 条）。
// 保留原样的行：同一条 FAQ 可能占好几行，名次按行算才和工具一致（工具取前 10 行再按 FAQ 去重，09-25 真机验收）。
// truncated：有库取满了 SEARCH_SIZE 行，后面可能还有 0.8 以上的
async function replay(ctx, kbIds, text) {
  if (!text) return { rows: [], truncated: false };
  const kbs = await kbsOf(ctx);
  const lists = await Promise.all(kbIds.filter((id) => hasFaqs(kbs, id)).map(async (kbId) => (await searchFaqs(ctx.identity, ctx.orgId, kbId, text, { size: SEARCH_SIZE })).map((f) => ({ ...f, kbId }))));
  return {
    rows: lists.flat().sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)),
    truncated: lists.some((l) => l.length >= SEARCH_SIZE),
  };
}

// 这一条在重放里的位置：名次按行算（它自己分数最高的那一行）；passing 是过了门槛的行数（门槛没记录时为 null）
function place(rep, faqId, threshold) {
  const { rows } = rep;
  const passing = typeof threshold === 'number' ? rows.filter((f) => typeof f.similarity === 'number' && f.similarity >= threshold).length : null;
  const i = rows.findIndex((f) => f.id === faqId);
  if (i >= 0) return { score: rows[i].similarity, rank: i + 1, passing };
  const scores = rows.map((f) => f.similarity).filter((s) => typeof s === 'number');
  return { floor: scores.length ? Math.min(...scores) : null, count: rows.length, passing, truncated: rep.truncated };
}

// --expect：FAQ 的 id，或者一段关键词。关键词先在这次检索的库里找（FAQ 文字搜索、文件段落逐段比对），再到企业的其他库里找 FAQ
async function resolveExpect(ctx, expect, kbIds) {
  const kbs = await kbsOf(ctx);
  // 关键词一次最多取 PAGE_SIZE 条：取满了就说「以上」，不把取到的当总数（整支审查小问题 6）
  const ambiguous = (hits, where) => new MdError('kb_expect_ambiguous', `「${expect}」在${where}里匹配到 ${hits.length >= PAGE_SIZE ? `${hits.length} 条以上` : `${hits.length} 条`}：\n${hits.slice(0, 10).map((h) => `  - #${h.id} ${clip(h.question ?? h.content, 40)}`).join('\n')}`, {
    exitCode: EXIT.TARGET,
    hint: '用 --expect <id> 指定',
  });
  if (/^\d+$/.test(expect)) {
    const id = Number(expect);
    for (const kbId of kbIds.filter((x) => hasFaqs(kbs, x))) {
      const faq = (await faqsOf(ctx, kbId)).find((f) => f.id === id);
      if (faq) return { kind: 'faq', item: faq, kbId, inQueriedKb: true };
    }
    // 不在这次查的库里：到企业的其他库里找到了，才算「不在查询的库里」（spec §3.5 判定表）；id 打错、FAQ 已删不能这么说
    for (const k of kbs.values()) {
      if (kbIds.includes(k.id) || !hasFaqs(kbs, k.id)) continue;
      const faq = (await faqsOf(ctx, k.id)).find((f) => f.id === id);
      if (faq) return { kind: 'faq', item: faq, kbId: k.id, inQueriedKb: false, otherKbName: k.name };
    }
    throw new MdError('kb_expect_not_found', `企业的知识库里都没有 FAQ #${id}`, { exitCode: EXIT.TARGET, hint: 'id 可能打错了，或者这条已经删了；去掉 --expect 看候选' });
  }
  for (const kbId of kbIds) {
    const k = kbs.get(kbId);
    if (k && hasFaqs(kbs, kbId)) {
      const hits = await searchFaqs(ctx.identity, ctx.orgId, kbId, expect, { mode: 'text', size: PAGE_SIZE });
      if (hits.length === 1) return { kind: 'faq', item: hits[0], kbId, inQueriedKb: true };
      if (hits.length > 1) throw ambiguous(hits, `「${kbName(kbs, kbId)}」`);
    }
    if (k && k.fileCount !== 0) {
      const hits = [];
      for (const f of await listFiles(ctx.identity, ctx.orgId, kbId)) {
        for (const p of await listParagraphs(ctx.identity, ctx.orgId, kbId, f.id)) if (p.content.includes(expect)) hits.push(p);
      }
      if (hits.length === 1) return { kind: 'paragraph', item: hits[0], kbId, inQueriedKb: true };
      if (hits.length > 1) throw ambiguous(hits, `「${kbName(kbs, kbId)}」的段落`);
    }
  }
  for (const k of kbs.values()) {
    if (kbIds.includes(k.id) || !hasFaqs(kbs, k.id)) continue;
    const hits = await searchFaqs(ctx.identity, ctx.orgId, k.id, expect, { mode: 'text', size: PAGE_SIZE });
    if (hits.length === 1) return { kind: 'faq', item: hits[0], kbId: k.id, inQueriedKb: false, otherKbName: k.name };
    if (hits.length > 1) throw ambiguous(hits, `「${k.name}」`);
  }
  throw new MdError('kb_expect_not_found', `企业的知识库里都没找到「${expect}」这段文字`, { exitCode: EXIT.TARGET, hint: '库里可能真的没有这一条；去掉 --expect 看候选' });
}

function targetText(t) {
  if (t.kind === 'paragraph') return `段落 #${t.item.id}「${clip(t.item.content, 60)}」 [${t.item.status}]`;
  const reviewed = t.item.reviewed === false ? ' [未审核]' : t.item.reviewed === true ? ' [已审核]' : ' [审核状态认不出]';
  const where = t.inQueriedKb ? '' : t.otherKbName ? `（在「${t.otherKbName}」里）` : '（不在这次查的库里）';
  return `FAQ #${t.item.id}${t.item.question ? `「${clip(t.item.question, 60)}」` : ''}${reviewed}${where}`;
}

// 没给 --expect：列候选（spec §3.5 第 4 步）——差一点过门槛的、过了门槛但没进前 limit 名的、问题很像但没审核的。
// 都按 FAQ 列（每条取它分数最高的那一行）；名次按行算，已经进了前 limit 名的 FAQ，它排在后面的其他行不算被挤出
async function candidates(ctx, r, kbIds, rows, userText) {
  if (r.noReplay) {
    out(`  ${r.noReplay}：候选和分数要用 md trial 看`);
    out('  看某一条为什么没召回：加 --expect <FAQ id 或一段文字>');
    return;
  }
  const kbs = await kbsOf(ctx);
  const scored = rows.filter((f) => typeof f.similarity === 'number');
  const near = hasT(r) ? firstPerFaq(scored).filter((f) => f.similarity < r.threshold).slice(0, 5) : [];
  const passed = hasT(r) ? scored.filter((f) => f.similarity >= r.threshold) : scored;
  const seen = new Set(passed.slice(0, r.limit).map((f) => f.id));
  const crowded = [];
  passed.forEach((f, i) => {
    if (i < r.limit || seen.has(f.id)) return;
    seen.add(f.id);
    crowded.push({ ...f, rank: i + 1 });
  });
  if (near.length) {
    out(`  差一点的（重放时没过门槛 ${fmt(r.threshold)}，前 ${near.length} 条）：`);
    for (const f of near) out(`    #${f.id} ${clip(f.question, 60)} ${fmt(f.similarity)}`);
  } else if (!hasT(r)) {
    out('  这次调用没记录门槛：差一点过门槛的列不出来');
  } else if (r.threshold < SEMANTIC_FLOOR) {
    out(`  没过门槛 ${fmt(r.threshold)} 的看不到：语义搜索只返回 ${SEMANTIC_FLOOR} 以上的`);
  }
  if (crowded.length) {
    const shown = crowded.slice(0, 5);
    out(`  ${hasT(r) ? '过了门槛、但' : ''}排在前 ${r.limit} 名之后的（前 ${shown.length} 条）：`);
    for (const f of shown) out(`    #${f.id} ${clip(f.question, 60)} ${fmt(f.similarity)}（第 ${f.rank} 名）`);
  }
  // 只查企业里还在、有 FAQ 的库：被删的库一查就是接口报错（整支审查小问题 7）
  const pending = [];
  for (const kbId of kbIds.filter((id) => hasFaqs(kbs, id))) {
    for (const text of [...new Set([r.query, userText].filter(Boolean))]) {
      for (const f of await checkSimilarity(ctx.identity, ctx.orgId, kbId, text)) {
        if (f.reviewed === false && !pending.some((x) => x.id === f.id)) pending.push(f);
      }
    }
  }
  if (pending.length) {
    out('  问题很像、但没审核的（检索不到）：');
    for (const f of pending.slice(0, 5)) out(`    #${f.id} ${clip(f.question, 60)} ${fmt(f.similarity)}`);
  }
  if (!near.length && !crowded.length && !pending.length) out('  重放和相似度检查都没有别的候选');
  out('  看某一条为什么没召回：加 --expect <FAQ id>');
}

// 报一处检索。给了 --expect 时返回这一次的结果（召回到了没有、结论是什么），给几次调用做总结用
async function reportRetrieval(ctx, r, userText, expect) {
  const kbs = await kbsOf(ctx);
  const kbIds = r.kind === 'call' ? [r.kbId] : r.kbIds;
  out('');
  const query = r.query ? `查询「${clip(r.query, 80)}」${r.queryGuessed ? '（节点的实际查询取不到，按用户原话估计）' : ''}` : '查询取不到';
  const outcome = r.kind !== 'call' ? '' : r.ok ? `召回 ${r.hits.length} 条` : r.failed ? '调用失败' : '返回认不出';
  out(r.kind === 'call'
    ? `检索：#${r.order} ${r.nodeName} 第 ${r.callIndex} 次调用知识库工具 · 库「${kbName(kbs, r.kbId)}」(${shortId(r.kbId)}) · ${query} · ${thresholdText(r)} · ${outcome}`
    : `检索：#${r.order} ${r.nodeName}（知识库查询节点）· 库${kbIds.map((id) => `「${kbName(kbs, id)}」`).join('、')} · ${query} · ${thresholdText(r)} · 召回最多 ${r.limit} 条`);
  // spec §3.5 第 2 步：这类节点运行时的输出结构没核对过，照实说
  if (r.kind === 'node') out('  这类节点的运行记录 md 还不认得：它这次实际召回了什么看不到，下面只按配置和重放估计');
  if (r.kind === 'call' && r.ok === false) {
    const [first] = diagnose({ retrieval: r });
    out(`结论：${first.title} —— ${first.detail}`);
    return expect ? { callIndex: r.callIndex, recalled: false, title: first.title } : null;
  }
  if (r.kind === 'call') {
    out(r.hits.length
      ? `  记录的召回：${r.hits.map(hitLine).join('、')}`
      : `  记录的召回：一条都没有${hasT(r) ? `（没有 FAQ 过门槛 ${fmt(r.threshold)}）` : ''}`);
  }
  const byQuery = r.noReplay ? { rows: [], truncated: false } : await replay(ctx, kbIds, r.query);
  const byUser = !r.noReplay && userText && !sameText(userText, r.query) ? await replay(ctx, kbIds, userText) : byQuery;
  if (r.kind === 'call' && !r.noReplay && drifted(r, byQuery.rows)) {
    out('  ⚠️ 知识库在这次执行之后改过：用同样的查询重放，结果和记录不一样，下面的结论要打折扣');
    const late = firstPerFaq(byQuery.rows).filter((f) => addedAfter(f, ctx.execAt));
    if (late.length) out(`    其中 ${late.slice(0, 5).map((f) => `#${f.id}`).join('、')}${late.length > 5 ? ` 等 ${late.length} 条` : ''} 是执行之后才上传的`);
  }
  if (!expect) {
    await candidates(ctx, r, kbIds, byQuery.rows, userText);
    return null;
  }
  const t = await resolveExpect(ctx, expect, kbIds);
  out(`目标：${targetText(t)}`);
  const hitIndex = r.kind === 'call' && t.kind === 'faq' ? r.hits.findIndex((h) => isFaqHit(h) && h.faqId === t.item.id) : -1;
  if (hitIndex >= 0) {
    out(`结论：这次召回到了这一条（排第 ${hitIndex + 1}，${fmt(r.hits[hitIndex].score)}）`);
    return { callIndex: r.callIndex, recalled: true };
  }
  const reasons = diagnose({
    retrieval: r,
    target: t.kind === 'paragraph'
      ? { inQueriedKb: t.inQueriedKb, status: t.item.status }
      : { inQueriedKb: t.inQueriedKb, otherKbName: t.otherKbName, reviewed: t.item.reviewed },
    replay: t.kind === 'faq' ? { query: place(byQuery, t.item.id, r.threshold), user: place(byUser, t.item.id, r.threshold) } : {},
    userText,
  });
  // 这一条是执行之后才上传的：没召回的原因就是当时库里没有它；按现在的库推出来的原因只能当补充
  if (t.kind === 'faq' && addedAfter(t.item, ctx.execAt)) {
    out(`结论：执行之后才上传的 —— 这一条上传于 ${formatTime(t.item.createdAt)}，执行在 ${formatTime(ctx.execAt)}：执行的时候库里还没有它`);
    for (const x of reasons.filter((y) => y.code !== 'unknown')) out(`补充（按现在的库推的）：${x.title} —— ${x.detail}`);
    return { callIndex: r.callIndex, recalled: false, title: '执行之后才上传的' };
  }
  out(`结论：${reasons[0].title} —— ${reasons[0].detail}`);
  for (const x of reasons.slice(1)) out(`补充：${x.title} —— ${x.detail}`);
  return { callIndex: r.callIndex, recalled: false, title: reasons[0].title };
}

// 一个节点调了好几次、给了 --expect 时，几次放在一起说一句（整支审查小问题 9）
function summarize(outcomes) {
  const hit = outcomes.filter((o) => o.recalled).map((o) => o.callIndex);
  out('');
  if (hit.length) out(`总结：${outcomes.length} 次调用里，第 ${hit.join('、')} 次召回到了这一条`);
  else out(`总结：${outcomes.length} 次调用都没召回这一条（${outcomes.map((o) => `第 ${o.callIndex} 次：${o.title}`).join('；')}）`);
}

async function reportSilent(ctx, s, userText) {
  const kbs = await kbsOf(ctx);
  out('');
  out(`检索：#${s.order} ${s.nodeName} 挂了知识库工具（${s.kbIds.map((id) => `「${kbName(kbs, id)}」`).join('、')}），这次一次都没调`);
  const [first] = diagnose({ retrieval: null, silent: true });
  out(`结论：${first.title} —— ${first.detail}`);
  if (!userText) return;
  const list = firstPerFaq((await replay(ctx, s.kbIds, userText)).rows);
  const top = list.slice(0, 3).map((f) => `#${f.id} ${clip(f.question, 40)} ${fmt(f.similarity)}`).join('；');
  out(`  如果用用户原话去查（语义搜索只返回 ${SEMANTIC_FLOOR} 以上的，前 ${Math.min(3, list.length)} 条）：${top || '一条都没有'}`);
}

export async function why(args) {
  const execId = args._[0];
  if (!execId || !EXEC_ID.test(execId)) throw usage('用法：md kb why <执行id> [--node <节点|#序号>] [--expect <FAQ id|"关键词">]');
  const { target, detail } = await locateExec(args, execId);
  const norm = normalizeDetail(detail);
  const { picked, others } = pick(norm, retrievalsOf(norm), strArg(args, 'node'));
  const expect = strArg(args, 'expect');
  // 取不到文本时，老懂的取法会退化成「[canvas-event-trigger]」这类占位符：当作取不到，不拿它去重放
  const raw = norm.exec.triggerText || '';
  const userText = /^\[[\w-]+\]$/.test(raw) ? '' : raw;
  const ctx = { identity: target.identity, orgId: target.orgId, kbs: null, faqs: new Map(), execAt: Date.parse(norm.exec.createdAt ?? '') || null };
  out(`${targetLine({ ...target, versionLabel: norm.version || undefined })} · 执行 ${shortId(execId)}`);
  out(DATA_NOTE);
  out(`用户原话：${userText ? clip(userText, 200) : '（取不到：这次不是文本消息触发的）'}`);
  if (others.length) out(`另有 ${others.length} 个挂了知识库工具的大模型节点这次没调：${nodeList(others)}（要看${others.length > 1 ? '它们' : '它'}加 --node）`);
  const kbs = await kbsOf(ctx);
  for (const g of picked) {
    if (g.silent) await reportSilent(ctx, g.silent, userText);
    const outcomes = [];
    for (const call of g.calls) {
      outcomes.push(await reportRetrieval(ctx, { ...call, noReplay: noReplayReason(kbs, [call.kbId], call.query, call.tags), estimated: false, recorded: call.hits.length }, userText, expect));
    }
    if (expect && outcomes.length > 1) summarize(outcomes);
    if (g.kbNode) {
      const n = g.kbNode;
      const query = typeof n.inputs?.query === 'string' ? n.inputs.query : userText;
      await reportRetrieval(ctx, {
        kind: 'node', nodeId: n.nodeId, nodeName: n.nodeName, order: n.order, kbIds: n.kbIds,
        query, queryGuessed: typeof n.inputs?.query !== 'string' && Boolean(query),
        threshold: unit(n.threshold), limit: n.limit ?? 5, recorded: null, ok: true, hits: null,
        noReplay: noReplayReason(kbs, n.kbIds, query, []), estimated: true,
      }, userText, expect);
    }
  }
  out('');
  for (const g of picked) out(`下一步：md trial ${g.nodeId} --bot ${target.botId} --from-exec ${execId}（要换问法就加 --input）`);
  return EXIT.OK;
}
