// 独立的 workflow JSON 结构校验器。
// 从 runtime.ts 提取——原因：runtime.ts 依赖 @/lib 路径别名，脚本/测试从仓库根运行时无法解析。
// 本文件只用相对路径引 shared，可被 engine-tools.ts 和测试脚本直接 import。

import { isCanvasEdge } from '../../../../packages/shared/src/workflowParser';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验 workflow JSON 结构合法性。
 * @param onlyNodeIds 仅校验这些 nodeId 对应的节点（patch 场景：存量残缺节点不拦路）。
 *                    同时只校验涉及这些节点的边。未指定则全量校验。
 */
export function validateWorkflowJsonCandidate(value: unknown, onlyNodeIds?: Set<string>) {
  if (!isRecord(value)) {
    return 'workflow_json 必须是包含 canvas 的 workflow JSON 对象，不能是数组、字符串或空值。';
  }

  if (!Array.isArray(value.canvas)) {
    return 'workflow_json 必须包含 canvas 数组，不能提交空对象或说明文字。';
  }

  const invalidCanvasItemIndex = value.canvas.findIndex((item) => !isRecord(item));
  if (invalidCanvasItemIndex >= 0) {
    return `workflow_json.canvas[${invalidCanvasItemIndex}] 必须是对象。`;
  }

  const canvasItems = value.canvas as Record<string, unknown>[];
  const allNodes = canvasItems.filter((item) => !isCanvasEdge(item));
  const allEdges = canvasItems.filter((item) => isCanvasEdge(item));

  const nodesToValidate = onlyNodeIds
    ? allNodes.filter((node) => typeof node.id === 'string' && onlyNodeIds.has(node.id))
    : allNodes;

  if (!onlyNodeIds && allNodes.length === 0) {
    return allEdges.length > 0
      ? `workflow_json.canvas 只有 ${allEdges.length} 条连线，没有任何节点。连线不能替代节点，请补齐完整节点对象后再保存。`
      : 'workflow_json.canvas 至少需要包含一个节点，不能提交空画布。';
  }

  const invalidNode = nodesToValidate.find(
    (node) => typeof node.id !== 'string' || !node.id.trim() || typeof node.shape !== 'string' || !node.shape.trim(),
  );
  if (invalidNode) {
    const nodeId = typeof invalidNode.id === 'string' && invalidNode.id.trim() ? invalidNode.id : 'unknown';
    return `workflow_json.canvas 中的节点 ${nodeId} 缺少有效的 id 或 shape。`;
  }

  const incompleteNode = nodesToValidate.find((node) => {
    const data = isRecord(node.data) ? node.data : null;
    const isComment = node.shape === 'canvas-tool-comment-node' || data?.category === 'comment';
    const ports = isRecord(node.ports) && Array.isArray(node.ports.items) ? node.ports.items : null;
    const hasRequiredShell =
      typeof node.view === 'string' &&
      node.view.trim().length > 0 &&
      isRecord(node.position) &&
      isRecord(node.size) &&
      Array.isArray(ports) &&
      isRecord(data) &&
      typeof data.type === 'string' &&
      data.type.trim() &&
      typeof data.category === 'string' &&
      data.category.trim() &&
      typeof data.name === 'string' &&
      data.name.trim();
    if (!hasRequiredShell) return true;
    return !isComment && !isRecord(data?.nodePayload);
  });
  if (incompleteNode) {
    const nodeId = typeof incompleteNode.id === 'string' && incompleteNode.id.trim() ? incompleteNode.id : 'unknown';
    return `workflow_json.canvas 中的节点 ${nodeId} 缺少 view、position、size、ports、data.type、data.category、data.name 或 nodePayload 等必要字段。`;
  }

  const allNodeIds = new Set(allNodes.map((node) => String(node.id)));
  const nodeById = new Map(allNodes.map((node) => [String(node.id), node]));

  const edgesToValidate = onlyNodeIds
    ? allEdges.filter((edge) => {
        const source = isRecord(edge.source) ? edge.source : {};
        const target = isRecord(edge.target) ? edge.target : {};
        const sourceId = typeof source.cell === 'string' ? source.cell : '';
        const targetId = typeof target.cell === 'string' ? target.cell : '';
        return onlyNodeIds.has(sourceId) || onlyNodeIds.has(targetId);
      })
    : allEdges;

  const danglingEdges = edgesToValidate
    .map((edge) => {
      const source = isRecord(edge.source) ? edge.source : {};
      const target = isRecord(edge.target) ? edge.target : {};
      const sourceId = typeof source.cell === 'string' ? source.cell : '';
      const targetId = typeof target.cell === 'string' ? target.cell : '';
      return {
        id: typeof edge.id === 'string' ? edge.id : 'unknown',
        sourceId,
        targetId,
      };
    })
    .filter((edge) => !edge.sourceId || !edge.targetId || !allNodeIds.has(edge.sourceId) || !allNodeIds.has(edge.targetId));

  if (danglingEdges.length > 0) {
    const examples = danglingEdges
      .slice(0, 5)
      .map((edge) => `${edge.id}(${edge.sourceId || '?'} -> ${edge.targetId || '?'})`)
      .join('、');
    return `workflow_json.canvas 有 ${danglingEdges.length} 条连线引用了不存在的节点：${examples}。请先创建对应节点，再提交连线。`;
  }

  const invalidPortEdge = edgesToValidate.find((edge) => {
    const source = isRecord(edge.source) ? edge.source : {};
    const target = isRecord(edge.target) ? edge.target : {};
    const sourceId = typeof source.cell === 'string' ? source.cell : '';
    const targetId = typeof target.cell === 'string' ? target.cell : '';
    const sourcePort = typeof source.port === 'string' ? source.port : '';
    const targetPort = typeof target.port === 'string' ? target.port : '';
    const sourceNode = nodeById.get(sourceId);
    const targetNode = nodeById.get(targetId);
    const sourcePorts = isRecord(sourceNode?.ports) && Array.isArray(sourceNode.ports.items) ? sourceNode.ports.items : [];
    const targetPorts = isRecord(targetNode?.ports) && Array.isArray(targetNode.ports.items) ? targetNode.ports.items : [];
    const sourcePortIds = new Set(
      sourcePorts
        .filter(isRecord)
        .map((port) => (typeof port.id === 'string' ? port.id : ''))
        .filter(Boolean),
    );
    const targetPortIds = new Set(
      targetPorts
        .filter(isRecord)
        .map((port) => (typeof port.id === 'string' ? port.id : ''))
        .filter(Boolean),
    );
    return !sourcePort || !targetPort || !sourcePortIds.has(sourcePort) || !targetPortIds.has(targetPort);
  });

  if (invalidPortEdge) {
    const edgeId = typeof invalidPortEdge.id === 'string' ? invalidPortEdge.id : 'unknown';
    return `workflow_json.canvas 中的连线 ${edgeId} 引用了不存在的端口。请确认 source.port 和 target.port 都存在于对应节点 ports.items。`;
  }

  return null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 候选相对源工作流的校验范围，传给 validateWorkflowJsonCandidate 的 onlyNodeIds：
 * 内容变了 / 新增 / 删除的节点，加上被增删改连线的两端节点。
 * 与 runtime.ts apply_workflow_patch「只校验 patch 触及的节点」同一口径。
 *
 * 为什么不能全量校验：真实秒懂画布里有天生过不了节点外壳校验的存量节点——
 * 触发器（接收消息 / 新好友 / 标签事件）没有 nodePayload，便签只有 comment/theme。
 * 任务 3a465cf3 的 1576 个节点里有 8 个，深度执行无论改什么都报「缺少必要字段」。
 *
 * 连线两端必须一起纳入：连线不属于任何节点，只收节点的话，在两个没改动的节点之间
 * 加一条引用不存在端口的连线会漏检。被删节点的 id 也留在范围里，引用它的残留连线才会被判悬空。
 *
 * 候选里出现没有有效 id 的节点时返回 undefined（退回全量校验）：按 id 圈范围圈不住它，
 * 宁可被存量节点误伤，也不能放过一个残缺的新节点。
 */
export function collectChangedScopeNodeIds(source: unknown, proposed: unknown): Set<string> | undefined {
  const index = (workflow: unknown) => {
    const nodes = new Map<string, string>();
    const edges = new Map<string, { json: string; endpoints: string[] }>();
    let hasNodeWithoutId = false;
    const items = isRecord(workflow) && Array.isArray(workflow.canvas) ? workflow.canvas.filter(isRecord) : [];
    for (const item of items) {
      const json = stableJson(item);
      if (isCanvasEdge(item)) {
        const endpoints = [item.source, item.target]
          .map((end) => (isRecord(end) && typeof end.cell === 'string' ? end.cell : ''))
          .filter(Boolean);
        edges.set(typeof item.id === 'string' ? item.id : json, { json, endpoints });
      } else if (typeof item.id === 'string' && item.id.trim()) {
        nodes.set(item.id, json);
      } else {
        hasNodeWithoutId = true;
      }
    }
    return { nodes, edges, hasNodeWithoutId };
  };
  const before = index(source);
  const after = index(proposed);
  if (after.hasNodeWithoutId) return undefined;

  const scope = new Set<string>();
  for (const id of new Set([...before.nodes.keys(), ...after.nodes.keys()])) {
    if (before.nodes.get(id) !== after.nodes.get(id)) scope.add(id);
  }
  for (const id of new Set([...before.edges.keys(), ...after.edges.keys()])) {
    const prev = before.edges.get(id);
    const next = after.edges.get(id);
    if (prev?.json === next?.json) continue;
    for (const endpoint of [...(prev?.endpoints ?? []), ...(next?.endpoints ?? [])]) scope.add(endpoint);
  }
  return scope;
}

export interface WorkflowValidationReport {
  hardError: string | null;
  warnings: string[];
}

export function validateWorkflowJsonCandidateWithWarnings(
  value: unknown,
  onlyNodeIds?: Set<string>,
): WorkflowValidationReport {
  const hardError = validateWorkflowJsonCandidate(value, onlyNodeIds);
  if (hardError) return { hardError, warnings: [] };
  return { hardError: null, warnings: collectBusinessRefWarnings(value, onlyNodeIds) };
}

function collectBusinessRefWarnings(value: unknown, onlyNodeIds?: Set<string>): string[] {
  if (!isRecord(value) || !Array.isArray(value.canvas)) return [];
  const canvasItems = value.canvas.filter(isRecord);
  const allNodes = canvasItems.filter((item) => !isCanvasEdge(item));
  const allNodeIds = new Set(allNodes.map((node) => String(node.id)));
  const nodesToScan = onlyNodeIds
    ? allNodes.filter((node) => typeof node.id === 'string' && onlyNodeIds.has(node.id))
    : allNodes;

  const warnings: string[] = [];
  for (const node of nodesToScan) {
    const data = isRecord(node.data) ? node.data : null;
    const payload = data && isRecord(data.nodePayload) ? data.nodePayload : null;
    if (!payload) continue;
    const nodeName = data && typeof data.name === 'string' && data.name ? data.name : String(node.id);
    const checkEntry = (entry: unknown, fallbackLabel: string) => {
      if (!isRecord(entry)) return;
      const ref = entry.referenceNodeId;
      if (typeof ref !== 'string' || !ref.trim() || allNodeIds.has(ref)) return;
      const label = typeof entry.name === 'string' && entry.name ? entry.name : fallbackLabel;
      warnings.push(
        `节点「${nodeName}」的输入「${label}」引用的上游「${ref}」不在图中（待接：建出该上游，或用 wire_input 改接到正确节点）`,
      );
    };
    if (Array.isArray(payload.inputs)) {
      for (const entry of payload.inputs) checkEntry(entry, '输入');
    }
    checkEntry(payload.query, 'query');
  }
  return warnings;
}
