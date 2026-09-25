// md kb why（spec 3a §3.5）：这次执行为什么没召回那一条。只读、不花钱、不自动试跑。
// 主路径：大模型的知识库工具调用，用控制台语义搜索按原样重放（分数和当时一致，spec §2.3）；重放和记录对不上时提示「知识库改过」。
// 语义搜索只返回 0.8 以上的：更低的分数重放看不到，这时按门槛和这次召回的条数推断（kb-diagnose）。
// 次要路径：知识库查询节点，只能按配置和重放估计（它用加权重排）。
import { strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { EXEC_ID, locateExec } from '../exec-locate.mjs';
import { findExecNode, normalizeDetail } from '../exec-detail.mjs';
import { clip } from '../execs.mjs';
import { SEARCH_SIZE, SEMANTIC_FLOOR, checkSimilarity, firstPerFaq, listFaqs, listFiles, listKbs, listParagraphs, searchFaqs } from '../kb.mjs';
import { diagnose, drifted, sameText } from '../kb-diagnose.mjs';
import { retrievalsOf } from '../kb-retrieval.mjs';
import { DATA_NOTE, out, shortId, targetLine } from '../output.mjs';

const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '?');
const unit = (t) => (typeof t === 'number' && t > 1 ? t / 100 : t); // 知识库查询节点的门槛写成 80，工具调用写成 0.8
const keyOf = (x) => `${x.nodeId}#${x.order}`;
const isFaqHit = (h) => h.type === 'qa';
const hitLine = (h) => (isFaqHit(h) ? `#${h.faqId} ${fmt(h.score)}` : `#${h.faqId ?? '?'}（${h.type}）${fmt(h.score)}`);

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

function pick(norm, found, nodeQuery) {
  const map = groups(found);
  if (nodeQuery) {
    const n = findExecNode(norm, nodeQuery);
    const g = map.get(`${n.id}#${n.order}`);
    if (!g) throw new MdError('kb_no_retrieval', `「${n.name}」这次没有做知识库检索，也没挂知识库工具`, { exitCode: EXIT.TARGET });
    return g;
  }
  if (map.size === 1) return [...map.values()][0];
  if (!map.size) {
    throw new MdError('kb_no_retrieval', '这次执行没有用到知识库：没有知识库工具调用，也没有跑知识库查询节点', {
      exitCode: EXIT.TARGET,
      hint: '知识库检索可能在同一条事件链的另一条执行里：md exec <执行id> 看事件链',
    });
  }
  const lines = [...map.values()].map((g) => `  - #${g.order} ${g.nodeName}：${describe(g)}`).join('\n');
  throw new MdError('kb_many_retrievals', `这次执行有 ${map.size} 处知识库检索，用 --node 指定：\n${lines}`, { exitCode: EXIT.TARGET });
}

async function kbsOf(ctx) {
  if (!ctx.kbs) ctx.kbs = new Map((await listKbs(ctx.identity, ctx.orgId)).map((k) => [k.id, k]));
  return ctx.kbs;
}
const kbName = (kbs, id) => kbs.get(id)?.name ?? `已不存在的库 ${shortId(id)}`;

// 用一段话在这些库里重做语义搜索，合在一起按分数排（库已经被删时当作没有结果）。
// 保留原样的行：同一条 FAQ 可能占好几行，名次按行算才和工具一致（工具取前 10 行再按 FAQ 去重，09-25 真机验收）
async function replay(ctx, kbIds, text) {
  if (!text) return [];
  const lists = await Promise.all(kbIds.map(async (kbId) => {
    try {
      return (await searchFaqs(ctx.identity, ctx.orgId, kbId, text, { size: SEARCH_SIZE })).map((f) => ({ ...f, kbId }));
    } catch (error) {
      if (error instanceof MdError && error.code === 'auth_expired') throw error;
      return [];
    }
  }));
  return lists.flat().sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
}

// 这一条在重放里的位置：名次按行算（它自己分数最高的那一行）
function place(list, faqId) {
  const i = list.findIndex((f) => f.id === faqId);
  if (i >= 0) return { score: list[i].similarity, rank: i + 1 };
  const scores = list.map((f) => f.similarity).filter((s) => typeof s === 'number');
  return { floor: scores.length ? Math.min(...scores) : null, count: list.length };
}

// --expect：FAQ 的 id，或者一段关键词。关键词先在这次检索的库里找（FAQ 文字搜索、文件段落逐段比对），再到企业的其他库里找 FAQ
async function resolveExpect(ctx, expect, kbIds) {
  const kbs = await kbsOf(ctx);
  const ambiguous = (hits, where) => new MdError('kb_expect_ambiguous', `「${expect}」在${where}里匹配到 ${hits.length} 条：\n${hits.slice(0, 10).map((h) => `  - #${h.id} ${clip(h.question ?? h.content, 40)}`).join('\n')}`, {
    exitCode: EXIT.TARGET,
    hint: '用 --expect <id> 指定',
  });
  if (/^\d+$/.test(expect)) {
    const id = Number(expect);
    for (const kbId of kbIds) {
      const faq = (await listFaqs(ctx.identity, ctx.orgId, kbId)).find((f) => f.id === id);
      if (faq) return { kind: 'faq', item: faq, kbId, inQueriedKb: true };
    }
    return { kind: 'faq', item: { id, question: '' }, kbId: null, inQueriedKb: false, otherKbName: null };
  }
  for (const kbId of kbIds) {
    const k = kbs.get(kbId);
    if (k?.faqCount) {
      const hits = await searchFaqs(ctx.identity, ctx.orgId, kbId, expect, { mode: 'text', size: 20 });
      if (hits.length === 1) return { kind: 'faq', item: hits[0], kbId, inQueriedKb: true };
      if (hits.length > 1) throw ambiguous(hits, `「${kbName(kbs, kbId)}」`);
    }
    if (k?.fileCount) {
      const hits = [];
      for (const f of await listFiles(ctx.identity, ctx.orgId, kbId)) {
        for (const p of await listParagraphs(ctx.identity, ctx.orgId, kbId, f.id)) if (p.content.includes(expect)) hits.push(p);
      }
      if (hits.length === 1) return { kind: 'paragraph', item: hits[0], kbId, inQueriedKb: true };
      if (hits.length > 1) throw ambiguous(hits, `「${kbName(kbs, kbId)}」的段落`);
    }
  }
  for (const k of kbs.values()) {
    if (kbIds.includes(k.id) || !k.faqCount) continue;
    const hits = await searchFaqs(ctx.identity, ctx.orgId, k.id, expect, { mode: 'text', size: 20 });
    if (hits.length === 1) return { kind: 'faq', item: hits[0], kbId: k.id, inQueriedKb: false, otherKbName: k.name };
    if (hits.length > 1) throw ambiguous(hits, `「${k.name}」`);
  }
  throw new MdError('kb_expect_not_found', `企业的知识库里都没找到「${expect}」这段文字`, { exitCode: EXIT.TARGET, hint: '库里可能真的没有这一条；去掉 --expect 看候选' });
}

function targetText(t) {
  if (t.kind === 'paragraph') return `段落 #${t.item.id}「${clip(t.item.content, 60)}」 [${t.item.status}]`;
  const reviewed = t.item.reviewed === false ? ' [未审核]' : t.item.reviewed ? ' [已审核]' : '';
  const where = t.inQueriedKb ? '' : t.otherKbName ? `（在「${t.otherKbName}」里）` : '（不在这次查的库里）';
  return `FAQ #${t.item.id}${t.item.question ? `「${clip(t.item.question, 60)}」` : ''}${reviewed}${where}`;
}

// 没给 --expect：列候选（spec §3.5 第 4 步）——差一点过门槛的、过了门槛但没进前 limit 名的、问题很像但没审核的。
// 都按 FAQ 列（每条取它分数最高的那一行）；名次按行算，已经进了前 limit 名的 FAQ，它排在后面的其他行不算被挤出
async function candidates(ctx, r, kbIds, byQuery, userText) {
  if (!r.replayable) {
    out('  这个库只有文件段落，没有语义搜索接口，候选和分数要用 md trial 看');
    out('  看某一段为什么没召回：加 --expect "<段落里的一段文字>"');
    return;
  }
  const scored = byQuery.filter((f) => typeof f.similarity === 'number');
  const near = firstPerFaq(scored).filter((f) => f.similarity < r.threshold).slice(0, 5);
  const passed = scored.filter((f) => f.similarity >= r.threshold);
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
  } else if (r.threshold < SEMANTIC_FLOOR) {
    out(`  没过门槛 ${fmt(r.threshold)} 的看不到：语义搜索只返回 ${SEMANTIC_FLOOR} 以上的`);
  }
  if (crowded.length) {
    const shown = crowded.slice(0, 5);
    out(`  过了门槛、但排在前 ${r.limit} 名之后的（前 ${shown.length} 条）：`);
    for (const f of shown) out(`    #${f.id} ${clip(f.question, 60)} ${fmt(f.similarity)}（第 ${f.rank} 名）`);
  }
  const pending = [];
  for (const kbId of kbIds) {
    for (const text of [...new Set([r.query, userText].filter(Boolean))]) {
      for (const f of await checkSimilarity(ctx.identity, ctx.orgId, kbId, text)) {
        if (!f.reviewed && !pending.some((x) => x.id === f.id)) pending.push(f);
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

async function reportRetrieval(ctx, r, userText, expect) {
  const kbs = await kbsOf(ctx);
  const kbIds = r.kind === 'call' ? [r.kbId] : r.kbIds;
  out('');
  out(r.kind === 'call'
    ? `检索：#${r.order} ${r.nodeName} 第 ${r.callIndex} 次调用知识库工具 · 库「${kbName(kbs, r.kbId)}」(${shortId(r.kbId)}) · 查询「${clip(r.query, 80)}」 · 门槛 ${fmt(r.threshold)} · 召回 ${r.hits.length} 条`
    : `检索：#${r.order} ${r.nodeName}（知识库查询节点）· 库${kbIds.map((id) => `「${kbName(kbs, id)}」`).join('、')} · 查询「${clip(r.query, 80)}」${r.queryGuessed ? '（节点的实际查询取不到，按用户原话估计）' : ''} · 门槛 ${fmt(r.threshold)} · 召回最多 ${r.limit} 条`);
  if (r.kind === 'call' && r.ok === false) {
    const [first] = diagnose({ retrieval: r });
    out(`结论：${first.title} —— ${first.detail}`);
    return;
  }
  if (r.kind === 'call') {
    out(r.hits.length
      ? `  记录的召回：${r.hits.map(hitLine).join('、')}`
      : `  记录的召回：一条都没有（没有 FAQ 过门槛 ${fmt(r.threshold)}）`);
  }
  const byQuery = r.replayable ? await replay(ctx, kbIds, r.query) : [];
  const byUser = r.replayable && userText && !sameText(userText, r.query) ? await replay(ctx, kbIds, userText) : byQuery;
  if (r.kind === 'call' && r.replayable && drifted(r, byQuery)) {
    out('  ⚠️ 知识库在这次执行之后改过：用同样的查询重放，结果和记录不一样，下面的结论要打折扣');
  }
  if (!expect) {
    await candidates(ctx, r, kbIds, byQuery, userText);
    return;
  }
  const t = await resolveExpect(ctx, expect, kbIds);
  out(`目标：${targetText(t)}`);
  const hitIndex = r.kind === 'call' && t.kind === 'faq' ? r.hits.findIndex((h) => isFaqHit(h) && h.faqId === t.item.id) : -1;
  if (hitIndex >= 0) {
    out(`结论：这次召回到了这一条（排第 ${hitIndex + 1}，${fmt(r.hits[hitIndex].score)}）`);
    return;
  }
  const reasons = diagnose({
    retrieval: r,
    target: t.kind === 'paragraph'
      ? { inQueriedKb: t.inQueriedKb, status: t.item.status }
      : { inQueriedKb: t.inQueriedKb, otherKbName: t.otherKbName, reviewed: t.item.reviewed },
    replay: t.kind === 'faq' ? { query: place(byQuery, t.item.id), user: place(byUser, t.item.id) } : {},
    userText,
  });
  out(`结论：${reasons[0].title} —— ${reasons[0].detail}`);
  for (const x of reasons.slice(1)) out(`补充：${x.title} —— ${x.detail}`);
}

async function reportSilent(ctx, s, userText) {
  const kbs = await kbsOf(ctx);
  out('');
  out(`检索：#${s.order} ${s.nodeName} 挂了知识库工具（${s.kbIds.map((id) => `「${kbName(kbs, id)}」`).join('、')}），这次一次都没调`);
  const [first] = diagnose({ retrieval: null, silent: true });
  out(`结论：${first.title} —— ${first.detail}`);
  if (!userText) return;
  const list = firstPerFaq(await replay(ctx, s.kbIds, userText));
  const top = list.slice(0, 3).map((f) => `#${f.id} ${clip(f.question, 40)} ${fmt(f.similarity)}`).join('；');
  out(`  如果用用户原话去查（语义搜索只返回 ${SEMANTIC_FLOOR} 以上的，前 ${Math.min(3, list.length)} 条）：${top || '一条都没有'}`);
}

export async function why(args) {
  const execId = args._[0];
  if (!execId || !EXEC_ID.test(execId)) throw usage('用法：md kb why <执行id> [--node <节点|#序号>] [--expect <FAQ id|"关键词">]');
  const { target, detail } = await locateExec(args, execId);
  const norm = normalizeDetail(detail);
  const picked = pick(norm, retrievalsOf(norm), strArg(args, 'node'));
  const expect = strArg(args, 'expect');
  // 取不到文本时，老懂的取法会退化成「[canvas-event-trigger]」这类占位符：当作取不到，不拿它去重放
  const raw = norm.exec.triggerText || '';
  const userText = /^\[[\w-]+\]$/.test(raw) ? '' : raw;
  const ctx = { identity: target.identity, orgId: target.orgId, kbs: null };
  out(`${targetLine({ ...target, versionLabel: norm.version || undefined })} · 执行 ${shortId(execId)}`);
  out(DATA_NOTE);
  out(`用户原话：${userText ? clip(userText, 200) : '（取不到：这次不是文本消息触发的）'}`);
  if (picked.silent) await reportSilent(ctx, picked.silent, userText);
  const kbs = await kbsOf(ctx);
  // 库里一条 FAQ 都没有（只有文件）时重放不了；库已经被删时照样重放，结果是空的
  for (const call of picked.calls) {
    await reportRetrieval(ctx, { ...call, replayable: kbs.get(call.kbId)?.faqCount !== 0, estimated: false, recorded: call.hits.length }, userText, expect);
  }
  if (picked.kbNode) {
    const n = picked.kbNode;
    const query = typeof n.inputs?.query === 'string' ? n.inputs.query : userText;
    await reportRetrieval(ctx, {
      kind: 'node', nodeId: n.nodeId, nodeName: n.nodeName, order: n.order, kbIds: n.kbIds,
      query, queryGuessed: typeof n.inputs?.query !== 'string',
      threshold: unit(n.threshold), limit: n.limit ?? 5, recorded: null, ok: true, hits: null,
      replayable: n.kbIds.some((id) => kbs.get(id)?.faqCount > 0), estimated: true,
    }, userText, expect);
  }
  out('');
  out(`下一步：md trial ${picked.nodeId} --bot ${target.botId} --from-exec ${execId}（要换问法就加 --input）`);
  return EXIT.OK;
}
