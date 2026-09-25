// apps/api/lib/miaodong/canvas-derive.ts

/**
 * 画布 push 的纯派生逻辑（无 IO / 无 db 依赖，可脱网单测、可被 miaodong-kit 直接 import）。
 *
 * 从 canvas-sync.ts 抽出，行为逐字保持一致。抽出的原因：
 *   canvas-sync.ts 顶部 import 了 @juzi/db（binding 查询），任何想复用这些纯转换的地方
 *   （如 miaodong-kit 的独立 CLI）一 import 就会连带初始化 SQLite。
 *   这些函数本身与 db 无关，单独成模块后 canvas-sync.ts 与 kit 共享同一份，避免两处实现漂移。
 *
 * 契约来源：2026-06-06 抓包验证 POST /api/canvas/save body = { canvasId, rawCanvas, nodes, edges }。
 * rawCanvas 是渲染层（AntV X6 扁平数组），nodes/edges 是秒懂领域层，后者从前者现推
 * （秒懂自己的编辑器也是 load rawCanvas 后客户端现推）。
 */

/**
 * 全量字符串替换画布 JSON 中的旧 ID → 新 ID。
 * 简单粗暴但有效：遍历所有映射对，对序列化后的 JSON 字符串做全局替换。
 * 适用于 eventId / sessionMemoryItemId 等散落在多种节点多种字段的场景。
 */
export function replaceIdsInCanvas(
  canvasJsonStr: string,
  eventIdMap: Record<string, string>,
  itemsIdMap: Record<string, string>,
): string {
  let result = canvasJsonStr;
  for (const [oldId, newId] of Object.entries(eventIdMap)) {
    if (oldId && newId && oldId !== newId) {
      result = result.replaceAll(oldId, newId);
    }
  }
  for (const [oldId, newId] of Object.entries(itemsIdMap)) {
    if (oldId && newId && oldId !== newId) {
      result = result.replaceAll(oldId, newId);
    }
  }
  return result;
}

/**
 * rawCanvas 元素是否是连线。
 *
 * 秒懂画布里连线有两种 shape 并存：绝大多数是 'custom-curve-edge'，但历史数据里还有一批
 * 裸 'edge'（实测 2026-07-28 赛博销售-美护 bot 有 2 条）。只认前者会把后者派生成 node，
 * 秒懂 /api/canvas/save 校验 node.type 枚举时报 400。
 * 因此再兜一层：带 source.cell + target.cell 的元素一律按连线处理——业务节点不会有这两个字段。
 */
export function isEdgeCell(cell: Record<string, unknown>): boolean {
  if (cell?.shape === 'custom-curve-edge' || cell?.shape === 'edge') return true;
  const source = cell?.source as { cell?: unknown } | undefined;
  const target = cell?.target as { cell?: unknown } | undefined;
  return Boolean(source?.cell && target?.cell);
}

/** rawCanvas 元素是否是纯视觉装饰（注释等 canvas-tool-* 节点，不进领域模型）。 */
export function isVisualOnlyCell(cell: Record<string, unknown>): boolean {
  return typeof cell?.shape === 'string' && (cell.shape as string).startsWith('canvas-tool-');
}

/**
 * 从 rawCanvas 派生秒懂领域层 nodes（2026-06-06 抓包验证的字段映射）。
 * 过滤：排除连线 + canvas-tool-* 视觉装饰，其余都算业务节点（含没有 nodePayload 的触发器）。
 * 字段：nodeId←cell.id；name/description/type/category/nodePayload/outputTypes←cell.data 同名字段；
 *       outputBranches←cell.ports 里 group==='right' 的输出端口（branchName 实测恒为 'default'）。
 */
export function deriveDomainNodes(rawCanvas: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rawCanvas
    .filter((cell) => !isEdgeCell(cell) && !isVisualOnlyCell(cell))
    .map((cell) => {
      const data = (cell.data ?? {}) as Record<string, unknown>;
      const ports = (cell.ports as { items?: Array<{ id?: string; group?: string }> } | undefined)?.items ?? [];
      const outputBranches = ports
        .filter((p) => p?.group === 'right' && typeof p.id === 'string')
        .map((p) => ({ branchId: p.id, branchName: 'default' }));
      return {
        nodeId: cell.id,
        name: typeof data.name === 'string' ? data.name : '',
        description: typeof data.description === 'string' ? data.description : '',
        type: typeof data.type === 'string' ? data.type : cell.shape,
        category: data.category,
        nodePayload: data.nodePayload,
        outputTypes: sanitizeOutputTypes(data.outputTypes),
        outputBranches,
      };
    });
}

/**
 * 秒懂 /api/canvas/save 校验：object 类型必须有 properties，array 类型必须有 items。
 * LLM / generator 产出的 outputTypes 经常只有顶层 type 没有嵌套 schema，这里递归补齐。
 */
export function sanitizeOutputTypes(outputTypes: unknown): unknown {
  if (!Array.isArray(outputTypes)) return outputTypes;
  return outputTypes.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const e = entry as Record<string, unknown>;
    if (!e.type || typeof e.type !== 'object') return entry;
    return { ...e, type: sanitizeTypeSchema(e.type as Record<string, unknown>) };
  });
}

export function sanitizeTypeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const s = { ...schema };
  if (s.type === 'object' && (!s.properties || typeof s.properties !== 'object')) {
    s.properties = {};
  }
  if (s.type === 'array' && (s.items === null || s.items === undefined)) {
    s.items = { type: 'string' };
  }
  // 递归：properties 内的值、items 自身可能也是 object/array
  if (s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, unknown>;
    const fixed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      fixed[k] = v && typeof v === 'object' ? sanitizeTypeSchema(v as Record<string, unknown>) : v;
    }
    s.properties = fixed;
  }
  if (s.items && typeof s.items === 'object') {
    s.items = sanitizeTypeSchema(s.items as Record<string, unknown>);
  }
  return s;
}

/**
 * 从 rawCanvas 派生秒懂领域层 edges（2026-06-06 抓包验证的字段映射）。
 * 字段：edgeId←cell.id；sourceNodeId←source.cell；targetNodeId←target.cell；
 *       sourceBranchId←source.port（源节点出口端口=分支 id）；scope 固定 'main'；edgeRole 固定 'normal'。
 */
export function deriveDomainEdges(rawCanvas: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rawCanvas
    .filter((cell) => isEdgeCell(cell))
    .map((cell) => {
      const source = (cell.source ?? {}) as Record<string, unknown>;
      const target = (cell.target ?? {}) as Record<string, unknown>;
      return {
        edgeId: cell.id,
        sourceNodeId: source.cell,
        targetNodeId: target.cell,
        sourceBranchId: source.port,
        scope: 'main',
        edgeRole: 'normal',
      };
    });
}
