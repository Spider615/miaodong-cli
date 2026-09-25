// 「为什么没召回这一条」的判定（spec 3a §3.5 第 6 步）。纯函数：输入检索、目标条目、重放结果，输出按顺序排好的原因；
// 第一条是结论，其余是补充。参数：
//   retrieval：{ kind: 'call' | 'node', query, threshold（0～1）, limit, recorded, ok, failed, error, noReplay, estimated }
//              recorded 是这次记录的召回条数；知识库查询节点没有运行记录，为 null。
//              noReplay：重放不了的原因（查询取不到、带了标签、库已删、只有文件），有它就不拿重放推原因
//   target：{ inQueriedKb, otherKbName, reviewed, status }——期望召回的那一条；没给 --expect 时为 null
//   replay：{ query, user }——这一条在「用记录里的查询重放」「用用户原话重放」里的位置：
//            { score, rank } 找到了；{ floor, count } 没找到（重放结果共 count 行、最低分 floor，没有结果时 floor 为 null）。
//            名次和行数都按行算，和工具一样：同一条 FAQ 在语义索引里可能占好几行，工具取前 limit 行再按 FAQ 去重（09-25 真机验收）
//   silent：节点挂了知识库工具、这次一次都没调
import { SCORE_EPS, SEMANTIC_FLOOR } from './kb.mjs';

export const COMMON_THRESHOLD = 0.6; // 76 次真实调用里最常见的门槛（§2.5），用来回答「换个门槛能不能召回」

const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '?');
export const sameText = (a, b) => String(a ?? '').replace(/\s+/g, '') === String(b ?? '').replace(/\s+/g, '');
const passes = (r, threshold, limit) => Boolean(r && typeof r.score === 'number' && r.score >= threshold && r.rank <= limit);
const RANKS = '（同一条 FAQ 在索引里可能占好几个名次）';

// 重放里没有这一条：语义搜索只返回 0.8 以上的（§2.3），它的分数低于 0.8（结果被截断时不高于最低分），具体多少看不到。按判定表推断：
// - 重放结果的最低分过了门槛：这些行全都过了门槛、分数都比它高，已经占了 limit 个名次就是被挤出，它自己多少分都一样；
// - 门槛不低于 0.8：它的分数低于门槛（结果被截断时最低分又没过门槛，同样低于门槛）；
// - 这次一条都没召回：没有过门槛的，它也没过；
// - 都推不出：分数偏低，交给 md trial。召回了几条但不满 limit 条也推不出：同一条 FAQ 占好几行时，前 limit 行去重后本来就不满
//   （09-25 真机：20 次不满 10 条的调用，前 10 行里全都有重复），不能说明过了门槛的都召回了。
function inferMissing(q, retrieval, note) {
  const { threshold, limit } = retrieval;
  const seen = `重放结果里没有这一条（语义搜索只返回 ${SEMANTIC_FLOOR} 以上的）`;
  if (q.floor !== null && q.floor >= threshold && q.count >= limit) {
    return ['crowded_out', `被挤出前 ${limit} 名`, `${seen}；过了门槛、分数比它高的已经占了 ${q.count} 个名次${RANKS}${note}`];
  }
  if (threshold >= SEMANTIC_FLOOR) return ['below_threshold', '分数不够门槛', `${seen}，它的分数低于门槛 ${fmt(threshold)}${note}`];
  if (retrieval.recorded === 0) {
    return ['below_threshold', '分数不够门槛', `${seen}，它的分数低于 ${SEMANTIC_FLOOR}；这次一条都没召回，说明没有过门槛 ${fmt(threshold)} 的，它也没过${note}`];
  }
  return ['low_score', '分数偏低', `${seen}，它的分数低于 ${SEMANTIC_FLOOR}，更低的分数控制台看不到；推不出是没过门槛 ${fmt(threshold)} 还是被挤出前 ${limit} 名，用 md trial 换问法试${note}`];
}

export function diagnose({ retrieval, target = null, replay = {}, silent = false, userText = '' }) {
  const reasons = [];
  const add = (code, title, detail) => reasons.push({ code, title, detail });
  if (retrieval?.kind === 'call' && retrieval.ok === false) {
    if (retrieval.failed) add('tool_error', '知识库工具调用失败', retrieval.error || '工具返回失败，这不是知识库内容的问题');
    else add('tool_unknown', '工具的返回认不出', retrieval.error || '这次调用的返回认不出');
    return reasons;
  }
  if (silent) add('no_call', '模型没调知识库工具', '这个大模型节点挂了知识库工具，这次运行一次都没调用');
  if (target && target.inQueriedKb === false) {
    add('wrong_kb', '不在查询的库里', target.otherKbName ? `这一条在「${target.otherKbName}」里，这次查的不是这个库` : '这次查的库里没有这一条');
  }
  if (target?.reviewed === false) add('unreviewed', '未审核', '未审核的 FAQ 不进语义索引，检索不到');
  if (target?.status && target.status !== 'ready') add('processing', '还在处理', `状态是 ${target.status}，处理完之前检索不到`);
  const scorable = Boolean(retrieval) && !silent && Boolean(target) && target.inQueriedKb !== false && target.reviewed !== false && (!target.status || target.status === 'ready');
  if (scorable && retrieval.noReplay) {
    add('unknown', '查不出', `${retrieval.noReplay}，只能用 md trial 看`);
    return reasons;
  }
  if (scorable) {
    const { threshold, limit } = retrieval;
    const q = replay.query;
    const u = replay.user;
    const note = retrieval.estimated ? '（知识库查询节点用加权重排，这是按语义分数估计的，用 md trial 确认）' : '';
    if (userText && !sameText(userText, retrieval.query) && passes(u, threshold, limit) && !passes(q, threshold, limit)) {
      add('rewritten', '查询被改写', `拿去查的是「${retrieval.query}」，不是用户原话；用原话查，这一条排第 ${u.rank}（${fmt(u.score)}）`);
    }
    if (q && typeof q.score === 'number') {
      if (q.score < threshold) {
        // 换成常见门槛能不能召回，还要看名次：排在前 limit 名之外的，门槛再低也进不去
        let relax = '';
        if (retrieval.kind === 'call' && threshold > COMMON_THRESHOLD && q.score >= COMMON_THRESHOLD) {
          relax = q.rank <= limit
            ? `；门槛是模型这次自己定的，用 ${COMMON_THRESHOLD} 就能过`
            : `；门槛是模型这次自己定的，用 ${COMMON_THRESHOLD} 也只排第 ${q.rank} 名，照样进不了前 ${limit} 名`;
        }
        add('below_threshold', '分数不够门槛', `分数 ${fmt(q.score)} 低于门槛 ${fmt(threshold)}${relax}${note}`);
      } else if (q.rank > limit) {
        add('crowded_out', `被挤出前 ${limit} 名`, `分数 ${fmt(q.score)} 过了门槛，但排第 ${q.rank} 名${RANKS}${note}`);
      }
    } else if (q) {
      add(...inferMissing(q, retrieval, note));
    }
  }
  if (!reasons.length) add('unknown', '查不出', '以上原因都不成立，用 md trial 复验');
  return reasons;
}

// 用记录里的查询重放，结果和记录对不上，说明知识库在这次执行之后改过（spec §3.5 第 5 步）。rows 是重放的行（按分数从高到低）。
// - 只比分数不低于「门槛和 0.8 里较大的那个」的部分：更低的分数重放看不到；
// - 按工具的做法取前 limit 行再按 FAQ 去重；只比 FAQ（重放只搜得到 FAQ），记录的前 limit 名里混着段落时，段落占掉名额；
// - 边界上（这个分数线、第 limit 行）分数只差一点点的一进一出不算：两边分数本来就差一点（SCORE_EPS）。
export function drifted(retrieval, rows) {
  const line = Math.max(retrieval.threshold ?? 0, SEMANTIC_FLOOR);
  const high = retrieval.hits.filter((h) => typeof h.score === 'number' && h.score >= line);
  const faqHits = high.filter((h) => h.type === 'qa');
  const slots = retrieval.limit - (high.length - faqHits.length);
  const top = rows.filter((f) => typeof f.similarity === 'number' && f.similarity >= line).slice(0, Math.max(slots, 0));
  const cut = top.length === slots ? top.at(-1)?.similarity : null;
  const onEdge = (score) => [line, cut].some((e) => typeof e === 'number' && Math.abs(score - e) <= SCORE_EPS);
  const recorded = new Set(faqHits.map((h) => h.faqId));
  const replayed = new Set(top.map((f) => f.id));
  return faqHits.some((h) => !replayed.has(h.faqId) && !onEdge(h.score)) || top.some((f) => !recorded.has(f.id) && !onEdge(f.similarity));
}
