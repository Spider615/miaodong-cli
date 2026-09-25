// 从整理好的执行详情（normalizeDetail 的结果）里取出这次执行的知识库检索（spec 3a §2.5、§3.5 第 2 步）。纯函数。
// - calls：大模型每调一次知识库工具算一次检索：查询、门槛（模型自己定的）、标签、召回的条目（类型、分数）；
//   ok 只在返回是 success=true 加召回列表时为真；failed 是明说失败（success=false），两样都不是就是认不出；
// - kbNodes：知识库查询节点的运行。它运行时的输出结构还没核对过（spec §7），原样带着输入输出，只用配置判断；
// - silent：挂了知识库工具、这次却一次都没调的大模型节点。
import { asArray } from './api.mjs';
import { kbRefs, toolKbId } from './kb-refs.mjs';

// 工具取过了门槛、分数最高的 10 行，再按 FAQ 去重（同一条 FAQ 可能占好几行，所以常常不满 10 条）；topK 基本不起作用（§2.5，09-25 真机验收）
export const TOOL_LIMIT = 10;
// 返回里没有 success=true 和召回列表：真机 76 次调用都是这个结构，别的样子没见过，照实说认不出，不当成「召回 0 条」
export const UNKNOWN_RETURN = '这次调用的返回认不出（没有 success=true 和召回列表）';

export function retrievalsOf(norm) {
  const refs = new Map(kbRefs(norm.snapshot).map((r) => [r.nodeId, r]));
  const calls = [];
  const kbNodes = [];
  const silent = [];
  for (const n of norm.nodes) {
    const ref = refs.get(n.id);
    // toolType 或工具名 q_kb_<库 id> 任一对得上就算：只认一个的话，它改名时会把检索误判成「模型没调」（整支审查小问题 4）
    const toolCalls = asArray(n.metadata?.toolCallResults).filter((t) => t?.toolType === 'query_kb' || toolKbId(t?.name) !== null);
    toolCalls.forEach((t, k) => {
      const args = t.toolCallArguments ?? {};
      const res = t.toolResult;
      const failed = res?.success === false;
      const ok = res?.success === true && Array.isArray(res?.result);
      const hits = (ok ? res.result : []).map((h) => ({
        faqId: Number(h?.reference?.source?.id) || null,
        question: String(h?.reference?.source?.question ?? ''),
        score: typeof h?.score === 'number' ? h.score : null,
        kbId: String(h?.knowledgeBaseId ?? ''),
        // 实测的调用全是 FAQ（qa）；库里有文件时会混着段落，比对「知识库改过」时只能拿 FAQ 比（重放只搜得到 FAQ）
        type: String(h?.reference?.type || h?.sourceType || 'qa'),
      }));
      calls.push({
        kind: 'call', nodeId: n.id, nodeName: n.name, order: n.order, callIndex: k + 1,
        kbId: toolKbId(t.name) ?? hits[0]?.kbId ?? '',
        query: String(args.query ?? ''),
        threshold: typeof args.threshold === 'number' ? args.threshold : null,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        limit: TOOL_LIMIT,
        ok,
        failed,
        error: failed ? String(res?.error ?? res?.message ?? '') : ok ? '' : UNKNOWN_RETURN,
        hits,
      });
    });
    if (ref?.kind === 'tool' && toolCalls.length === 0) silent.push({ nodeId: n.id, nodeName: n.name, order: n.order, kbIds: ref.kbIds });
    if (ref?.kind === 'node') {
      kbNodes.push({
        kind: 'node', nodeId: n.id, nodeName: n.name, order: n.order,
        kbIds: ref.kbIds, threshold: ref.threshold, limit: ref.resultCount, rerank: ref.rerank,
        inputs: n.inputs, output: n.output,
      });
    }
  }
  return { calls, kbNodes, silent };
}
