// 从整理好的执行详情（normalizeDetail 的结果）里取出这次执行的知识库检索（spec 3a §2.5、§3.5 第 2 步）。纯函数。
// - calls：大模型每调一次知识库工具算一次检索：查询、门槛（模型自己定的）、召回的条目（类型、分数）；
// - kbNodes：知识库查询节点的运行。它运行时的输出结构还没核对过（spec §7），原样带着输入输出，只用配置判断；
// - silent：挂了知识库工具、这次却一次都没调的大模型节点。
import { asArray } from './api.mjs';
import { kbRefs, toolKbId } from './kb-refs.mjs';

export const TOOL_LIMIT = 10; // 工具调用最多返回 10 条，topK 基本不起作用（§2.5）

export function retrievalsOf(norm) {
  const refs = new Map(kbRefs(norm.snapshot).map((r) => [r.nodeId, r]));
  const calls = [];
  const kbNodes = [];
  const silent = [];
  for (const n of norm.nodes) {
    const ref = refs.get(n.id);
    const toolCalls = asArray(n.metadata?.toolCallResults).filter((t) => t?.toolType === 'query_kb');
    toolCalls.forEach((t, k) => {
      const args = t.toolCallArguments ?? {};
      const hits = asArray(t.toolResult?.result).map((h) => ({
        faqId: Number(h?.reference?.source?.id) || null,
        question: String(h?.reference?.source?.question ?? ''),
        score: typeof h?.score === 'number' ? h.score : null,
        kbId: String(h?.knowledgeBaseId ?? ''),
        // 实测的调用全是 FAQ（qa）；库里有文件时会混着段落，比对「知识库改过」时只能拿 FAQ 比（重放只搜得到 FAQ）
        type: String(h?.reference?.type || h?.sourceType || 'qa'),
      }));
      const failed = t.toolResult?.success === false;
      calls.push({
        kind: 'call', nodeId: n.id, nodeName: n.name, order: n.order, callIndex: k + 1,
        kbId: toolKbId(t.name) ?? hits[0]?.kbId ?? '',
        query: String(args.query ?? ''),
        threshold: typeof args.threshold === 'number' ? args.threshold : null,
        limit: TOOL_LIMIT,
        ok: !failed,
        error: failed ? String(t.toolResult?.error ?? t.toolResult?.message ?? '') : '',
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
