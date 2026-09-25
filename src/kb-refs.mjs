// 画布里的知识库引用（spec 3a §2.4）。纯函数。
// - 大模型节点挂的知识库工具（主路径）：data.nodePayload.tools[] 里的 { type: 'query_kb', configParams: { knowledgeBaseId } }；
// - 知识库查询节点（次要路径）：data.type 是 query-knowledge-base，配置在 data.nodePayload。
import { asArray } from './api.mjs';
import { isEdgeCell } from './canvas.mjs';

// 执行记录里，工具调用的名字是 q_kb_<知识库 id>（spec §2.5）。id 的写法不限：别的区可能带横杠
const TOOL_NAME = /^q_kb_(.+)$/i;
export function toolKbId(name) {
  const m = TOOL_NAME.exec(String(name ?? ''));
  return m ? m[1] : null;
}

function rerankOf(p) {
  if (p.rerankType === 'weighted') return `加权（向量 ${p.weightedRerankConfig?.vectorWeight ?? '?'}）`;
  if (p.rerankType) return `${p.rerankType}${p.modelRerankConfig?.modelType ? `（${p.modelRerankConfig.modelType}）` : ''}`;
  return '无';
}

export function kbRefs(canvas) {
  const refs = [];
  for (const c of asArray(canvas)) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || isEdgeCell(c)) continue;
    const payload = c.data?.nodePayload ?? {};
    const nodeName = String(c.data?.name ?? '');
    if ((c.data?.type ?? c.shape) === 'query-knowledge-base') {
      refs.push({
        kind: 'node', nodeId: c.id, nodeName,
        kbIds: asArray(payload.knowledgeBaseIds).map(String),
        resultCount: Number(payload.resultCount) || null,
        threshold: typeof payload.threshold === 'number' ? payload.threshold : null,
        rerank: rerankOf(payload),
      });
      continue;
    }
    const kbIds = asArray(payload.tools)
      .filter((t) => t?.type === 'query_kb')
      .map((t) => String(t.configParams?.knowledgeBaseId ?? ''))
      .filter(Boolean);
    if (kbIds.length) refs.push({ kind: 'tool', nodeId: c.id, nodeName, kbIds });
  }
  return refs;
}
