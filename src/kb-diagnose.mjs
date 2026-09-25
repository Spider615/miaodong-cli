// 「为什么没召回这一条」的判定（spec 3a §3.5 第 6 步）。纯函数：输入检索、目标条目、重放结果，输出按顺序排好的原因；
// 第一条是结论，其余是补充。参数：
//   retrieval：{ kind: 'call' | 'node', query, threshold（0～1）, limit, recorded, ok, error, replayable, estimated }
//              recorded 是这次记录的召回条数；知识库查询节点没有运行记录，为 null
//   target：{ inQueriedKb, otherKbName, reviewed, status }——期望召回的那一条；没给 --expect 时为 null
//   replay：{ query, user }——这一条在「用记录里的查询重放」「用用户原话重放」里的位置：
//            { score, rank } 找到了；{ floor, count } 没找到（重放结果共 count 条、最低分 floor，没有结果时 floor 为 null）
//   silent：节点挂了知识库工具、这次一次都没调
import { SEMANTIC_FLOOR } from './kb.mjs';

export const COMMON_THRESHOLD = 0.6; // 76 次真实调用里最常见的门槛（§2.5），用来回答「换个门槛能不能召回」

const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '?');
export const sameText = (a, b) => String(a ?? '').replace(/\s+/g, '') === String(b ?? '').replace(/\s+/g, '');
const passes = (r, threshold, limit) => Boolean(r && typeof r.score === 'number' && r.score >= threshold && r.rank <= limit);

// 重放里没有这一条：语义搜索只返回 0.8 以上的（§2.3），它的分数低于 0.8（结果被截断时不高于最低分），具体多少看不到。按判定表推断：
// - 重放结果的最低分过了门槛：这些结果全都过了门槛、分数都比它高，已经有 limit 条就是被挤出，它自己多少分都一样；
// - 门槛不低于 0.8：它的分数低于门槛（结果被截断时最低分又没过门槛，同样低于门槛）；
// - 这次记录的召回不满 limit 条：过了门槛的都召回了，它没过门槛；
// - 都推不出：分数偏低，交给 md trial。
function inferMissing(q, retrieval, note) {
  const { threshold, limit } = retrieval;
  const recorded = typeof retrieval.recorded === 'number' ? retrieval.recorded : null;
  const seen = `重放结果里没有这一条（语义搜索只返回 ${SEMANTIC_FLOOR} 以上的）`;
  if (q.floor !== null && q.floor >= threshold && q.count >= limit) {
    return ['crowded_out', `被挤出前 ${limit} 条`, `${seen}；过了门槛、分数比它高的已经有 ${q.count} 条${note}`];
  }
  if (threshold >= SEMANTIC_FLOOR) return ['below_threshold', '分数不够门槛', `${seen}，它的分数低于门槛 ${fmt(threshold)}${note}`];
  if (recorded !== null && recorded < limit) {
    return ['below_threshold', '分数不够门槛', `${seen}，它的分数低于 ${SEMANTIC_FLOOR}；这次只召回了 ${recorded} 条（不满 ${limit} 条），过了门槛的都召回了，所以它没过门槛 ${fmt(threshold)}${note}`];
  }
  const full = recorded !== null ? `这次召回满了 ${limit} 条，` : '';
  return ['low_score', '分数偏低', `${seen}，它的分数低于 ${SEMANTIC_FLOOR}，更低的分数控制台看不到；${full}推不出是没过门槛 ${fmt(threshold)} 还是被挤出前 ${limit} 条，用 md trial 换问法试${note}`];
}

export function diagnose({ retrieval, target = null, replay = {}, silent = false, userText = '' }) {
  const reasons = [];
  const add = (code, title, detail) => reasons.push({ code, title, detail });
  if (retrieval?.kind === 'call' && retrieval.ok === false) {
    add('tool_error', '知识库工具调用失败', retrieval.error || '工具返回失败，这不是知识库内容的问题');
    return reasons;
  }
  if (silent) add('no_call', '模型没调知识库工具', '这个大模型节点挂了知识库工具，这次运行一次都没调用');
  if (target && target.inQueriedKb === false) {
    add('wrong_kb', '不在查询的库里', target.otherKbName ? `这一条在「${target.otherKbName}」里，这次查的不是这个库` : '这次查的库里没有这一条');
  }
  if (target?.reviewed === false) add('unreviewed', '未审核', '未审核的 FAQ 不进语义索引，检索不到');
  if (target?.status && target.status !== 'ready') add('processing', '还在处理', `状态是 ${target.status}，处理完之前检索不到`);
  const scorable = Boolean(retrieval) && !silent && Boolean(target) && target.inQueriedKb !== false && target.reviewed !== false && (!target.status || target.status === 'ready');
  if (scorable && retrieval.replayable === false) {
    add('unknown', '查不出', '这个库只有文件段落，没有语义搜索接口，只能用 md trial 看');
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
        const relax = retrieval.kind === 'call' && threshold > COMMON_THRESHOLD && q.score >= COMMON_THRESHOLD
          ? `；门槛是模型这次自己定的，用 ${COMMON_THRESHOLD} 就能过`
          : '';
        add('below_threshold', '分数不够门槛', `分数 ${fmt(q.score)} 低于门槛 ${fmt(threshold)}${relax}${note}`);
      } else if (q.rank > limit) {
        add('crowded_out', `被挤出前 ${limit} 条`, `分数 ${fmt(q.score)} 过了门槛，但排第 ${q.rank}${note}`);
      }
    } else if (q) {
      add(...inferMissing(q, retrieval, note));
    }
  }
  if (!reasons.length) add('unknown', '查不出', '以上原因都不成立，用 md trial 复验');
  return reasons;
}
