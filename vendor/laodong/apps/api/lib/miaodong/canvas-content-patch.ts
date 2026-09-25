// apps/api/lib/miaodong/canvas-content-patch.ts

/**
 * content-only 快速上线的纯派生逻辑（无 IO / 无 db，可脱网单测、可被 miaodong-kit 直接 import）。
 *
 * ── 动机 ────────────────────────────────────────────────────────────────
 * 老懂现在推送到秒懂是「全量覆盖 + 无条件重导事件」：只要 workflow 里有 events，每次 push 都会
 * 调 POST /api/canvas/event/import 一遍，而秒懂这个端点是 **create 语义**（每次新建、返回新
 * eventId），于是重复 push 会在 bot 上堆叠出重复事件（这就是当前最疼的 bug）。
 *
 * 本模块支撑「content-only 快速上线」这条止血路径：当一次改动 **只改了节点内容**（提示词 /
 * 节点 data 里的字段），没有动到图的结构（增删节点、改连线、改分支端口），也没动 events /
 * sessions 时，就走一条 **完全不碰任何 import 端点** 的路径——把改动的节点内容打补丁到秒懂
 * **当前线上** 画布上再 save。这样：
 *   1. 不调 event/import → 不产生重复事件（这正是止血能覆盖的场景）；
 *   2. 覆盖的是秒懂自己的画布 + 最小 diff → 不需要 UUID 适配、不会因缺字段 400；
 *   3. 打补丁是 3-way（baseline / edited / live），只改用户真正动过的那几个节点、其余保留线上
 *      现状 → 不会冲掉别人在别的节点上的并发改动。
 *
 * ── 术语（三份画布） ─────────────────────────────────────────────────────
 *   baseline —— 用户开始改之前的画布（= 上次 pull 下来的快照）。用来算「用户到底改了啥」。
 *   edited   —— 用户改完之后的画布（老懂侧）。
 *   live     —— 发布这一刻秒懂线上的画布（发布前重新 pull 拿到，可能含别人的并发改动）。
 * 三者的节点 id 都应是同一批真实 UUID —— 前提是这个 bot 的画布是从秒懂 pull 来的（从零 generate
 * 的画布 id 是 ss-xxx，跟线上没有对应关系，不能走这条路，只能走全量 push）。
 *
 * ── 结构 vs 内容的界线 ───────────────────────────────────────────────────
 *   结构 = 图的形状：有哪些节点(id)、节点类型(shape)、每个节点的端口拓扑(ports)、连线(edges)，
 *          以及 workflow 顶层的 events / sessions。**任何结构改动都不能走快速上线**，退回全量 push。
 *   内容 = 节点 data 里的东西：name / description / nodePayload（提示词、文案）/ outputTypes 等。
 *
 * 契约来源：rawCanvas 是 AntV X6 扁平数组（节点+边混在一起靠 shape 区分）。边 / 视觉装饰的判定
 * 复用 canvas-derive.ts 的 isEdgeCell / isVisualOnlyCell，避免两处漂移。
 */
import { isEdgeCell, isVisualOnlyCell } from './canvas-derive';

type Cell = Record<string, unknown>;
type Canvas = Array<Cell>;

/** 老懂 workflow 信封：canvas 是 rawCanvas 扁平数组，events/sessions 是顶层资源定义。 */
export type WorkflowEnvelope = {
  canvas: Canvas;
  events?: unknown[];
  sessions?: unknown[];
};

export type ChangeClass = {
  /** 是否「只改了内容、没动任何结构」。false 时必须退回全量 push。 */
  contentOnly: boolean;
  /** 用户改了 data（内容）的节点 id 列表。 */
  changedNodeIds: string[];
  /** 非 content-only 时的具体原因（给用户看的中文，可能多条）。 */
  reasons: string[];
};

export type PublishPlan = ChangeClass & {
  /** 能否真的走 content-only 快速上线（content-only 且无冲突 / 无缺失 且确有改动）。 */
  eligible: boolean;
  /** 用户改的节点，在 live 上也相对 baseline 变了 → 并发冲突，需人工确认。 */
  conflictNodeIds: string[];
  /** 用户改的节点，在 live 上已不存在（可能被别人删了）→ 无法定点打补丁。 */
  missingOnLive: string[];
  /** live + 用户内容补丁后的画布；不可发布时为 null。深拷贝，不改任何入参。 */
  patchedCanvas: Canvas | null;
};

/**
 * 稳定序列化：对象按 key 排序后再 JSON，让「值是否相等」的比较不受属性顺序影响
 * （baseline / edited / live 可能来自不同序列化路径，key 顺序未必一致）。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 把 rawCanvas 里的业务节点（排除边、排除 canvas-tool-* 视觉装饰）按 id 索引。 */
export function indexNodes(canvas: Canvas): Map<string, Cell> {
  const map = new Map<string, Cell>();
  for (const cell of canvas) {
    if (isEdgeCell(cell) || isVisualOnlyCell(cell)) continue;
    if (typeof cell.id === 'string') map.set(cell.id, cell);
  }
  return map;
}

/** 单节点的结构签名：shape + 端口拓扑（排序后的 id:group 列表）。不含 data（那是内容）。 */
function nodeStructSig(cell: Cell): string {
  const items = ((cell.ports as { items?: Array<{ id?: string; group?: string }> } | undefined)?.items) ?? [];
  const portSig = items.map((p) => `${p?.id ?? ''}:${p?.group ?? ''}`).sort().join('|');
  return stableStringify({ shape: cell.shape ?? null, ports: portSig });
}

/** 连线拓扑签名集合：每条边 = 源节点#源端口 -> 目标节点#目标端口，排序后可整体比较。 */
function edgeTopoSet(canvas: Canvas): string[] {
  return canvas
    .filter((c) => isEdgeCell(c))
    .map((e) => {
      const s = (e.source ?? {}) as Record<string, unknown>;
      const t = (e.target ?? {}) as Record<string, unknown>;
      return `${s.cell ?? ''}#${s.port ?? ''}->${t.cell ?? ''}#${t.port ?? ''}`;
    })
    .sort();
}

/**
 * 判定 baseline → edited 是不是「只改内容、没动结构」。
 * 任一结构差异（events/sessions 变、增删节点、改连线、改节点类型/端口）→ contentOnly=false。
 * 结构完全一致时，返回 data 发生变化的节点 id（= 用户改了内容的节点）。
 */
export function classifyChange(base: WorkflowEnvelope, edited: WorkflowEnvelope): ChangeClass {
  const reasons: string[] = [];

  // 1. events / sessions 必须完全不变——变了就必须重新导入（这正是重复事件的来源），不能走快速上线
  if (stableStringify(base.events ?? []) !== stableStringify(edited.events ?? [])) {
    reasons.push('events（主动触达事件）有改动——新增/修改事件必须重新导入，走全量 push');
  }
  if (stableStringify(base.sessions ?? []) !== stableStringify(edited.sessions ?? [])) {
    reasons.push('sessions（会话变量）有改动——需重新导入，走全量 push');
  }

  const baseNodes = indexNodes(base.canvas);
  const editNodes = indexNodes(edited.canvas);
  const baseIds = new Set(baseNodes.keys());
  const editIds = new Set(editNodes.keys());

  // 2. 节点 id 集合一致（增 / 删节点 = 结构）
  const added = [...editIds].filter((id) => !baseIds.has(id));
  const removed = [...baseIds].filter((id) => !editIds.has(id));
  if (added.length) reasons.push(`新增了 ${added.length} 个节点（结构改动）`);
  if (removed.length) reasons.push(`删除了 ${removed.length} 个节点（结构改动）`);

  // 3. 边拓扑一致（改 / 增 / 删连线 = 结构）
  if (stableStringify(edgeTopoSet(base.canvas)) !== stableStringify(edgeTopoSet(edited.canvas))) {
    reasons.push('连线（edges）有改动（结构改动）');
  }

  // 4. 每个共有节点：结构签名一致才比内容；结构变了（换类型 / 增删端口分支）= 结构改动
  const changedNodeIds: string[] = [];
  for (const id of editIds) {
    if (!baseIds.has(id)) continue;
    const b = baseNodes.get(id) as Cell;
    const e = editNodes.get(id) as Cell;
    if (nodeStructSig(b) !== nodeStructSig(e)) {
      reasons.push(`节点 ${id} 的结构（类型 / 端口分支）有改动`);
      continue;
    }
    if (stableStringify(b.data ?? null) !== stableStringify(e.data ?? null)) {
      changedNodeIds.push(id);
    }
  }

  return { contentOnly: reasons.length === 0, changedNodeIds, reasons };
}

/**
 * 老懂节点 id → 秒懂线上节点 id 的映射。
 *
 * 为什么需要它：老懂 generator 产出的 id 是 ss-NNNNNN，push 时 adaptWorkflowForMiaodong 会换成
 * UUID 才能过秒懂校验。所以「用户在老懂里改了哪个节点」算出来是老懂 id，要打到线上必须先翻译。
 * 从秒懂 pull 来的画布 id 本就是 UUID，此时映射为空（恒等）即可。
 */
export type NodeIdMap = Record<string, string>;

const mapId = (id: string, idMap?: NodeIdMap): string => idMap?.[id] ?? id;

/**
 * 把 edited 里改过的节点 data 打到 live 画布对应节点上。
 * - 深拷贝 live，绝不改入参；
 * - 只覆盖 changedNodeIds 命中的节点的 data，其余元素（含别人并发改过的其它节点）原样保留；
 * - changedNodeIds 是【老懂 id】，靠 idMap 翻译成线上 id 后再定位；
 * - live 上找不到的 id 直接跳过（由 planContentPublish 提前拦成 missingOnLive，这里只兜底）。
 */
export function applyContentPatch(
  liveCanvas: Canvas,
  editedCanvas: Canvas,
  changedNodeIds: string[],
  idMap?: NodeIdMap,
): Canvas {
  const editNodes = indexNodes(editedCanvas);
  // 线上 id → 老懂侧改后的节点，便于按 live 顺序遍历时 O(1) 命中
  const patchByLiveId = new Map<string, Cell>();
  for (const localId of changedNodeIds) {
    const src = editNodes.get(localId);
    if (src) patchByLiveId.set(mapId(localId, idMap), src);
  }
  return liveCanvas.map((cell) => {
    if (typeof cell.id === 'string') {
      const src = patchByLiveId.get(cell.id);
      if (src) return { ...clone(cell), data: clone(src.data ?? {}) };
    }
    return clone(cell);
  });
}

export type PlanOptions = {
  /** 老懂节点 id → 秒懂线上节点 id。从秒懂 pull 来的画布可省略（id 本就一致）。 */
  idMap?: NodeIdMap;
  /**
   * 上一次【实际推上秒懂】的那份画布（秒懂 id 空间）。用来做并发冲突检测：
   * 线上现在的节点内容 ≠ 我们上次推上去的内容 ⇒ 期间有人在秒懂上动过这个节点。
   * 省略时退化为用 base.canvas 比 —— 仅当老懂侧画布本身就是从秒懂 pull 来的（id 已是 UUID）才成立。
   */
  pushedCanvas?: Canvas;
};

/**
 * 生成一次 content-only 快速上线的执行计划（3-way：baseline / edited / live）。
 *
 * 决策：
 *   - 非 content-only（结构 / events / sessions 有动）→ eligible=false，退回全量 push；
 *   - 用户改的节点在 live 上被并发改过（conflict）或已不存在（missing）→ eligible=false，
 *     patchedCanvas=null，交人工处理（不擅自覆盖别人的改动）；
 *   - 否则 → eligible=true，patchedCanvas = live + 用户内容补丁，可直接 save（跳过所有 import）。
 *
 * 注意：changedNodeIds / conflictNodeIds / missingOnLive 里的 id 都是【老懂侧 id】，
 * 方便上层拿去在老懂画布里反查节点名展示给用户；打补丁时内部才翻译成线上 id。
 */
export function planContentPublish(
  base: WorkflowEnvelope,
  edited: WorkflowEnvelope,
  liveCanvas: Canvas,
  options: PlanOptions = {},
): PublishPlan {
  const cls = classifyChange(base, edited);
  if (!cls.contentOnly) {
    return { ...cls, eligible: false, conflictNodeIds: [], missingOnLive: [], patchedCanvas: null };
  }

  const { idMap, pushedCanvas } = options;
  // 冲突检测的比较基准必须与 live 处于同一 id 空间：优先用「上次实际推上去的那份」，
  // 没有时退回 base.canvas（只有老懂画布本就来自秒懂 pull 时才等价）。
  const pushedNodes = indexNodes(pushedCanvas ?? base.canvas);
  const liveNodes = indexNodes(liveCanvas);
  const conflictNodeIds: string[] = [];
  const missingOnLive: string[] = [];

  for (const localId of cls.changedNodeIds) {
    const liveId = mapId(localId, idMap);
    const liveCell = liveNodes.get(liveId);
    if (!liveCell) {
      missingOnLive.push(localId);
      continue;
    }
    const pushedCell = pushedNodes.get(liveId);
    if (!pushedCell) {
      // 基线里没有这个节点却在线上有：基线与线上已经对不上，不冒险定点改
      missingOnLive.push(localId);
      continue;
    }
    // 并发冲突：这个节点用户改了，同时线上内容相对「我们上次推上去的」也变了
    if (stableStringify(liveCell.data ?? null) !== stableStringify(pushedCell.data ?? null)) {
      conflictNodeIds.push(localId);
    }
  }

  const reasons = [...cls.reasons];
  if (conflictNodeIds.length) reasons.push(`${conflictNodeIds.length} 个节点在秒懂上被并发改动，需人工确认后再发布`);
  if (missingOnLive.length) reasons.push(`${missingOnLive.length} 个节点在秒懂上已不存在或与基线对不上，无法定点更新`);

  const blocked = conflictNodeIds.length > 0 || missingOnLive.length > 0;
  const eligible = !blocked && cls.changedNodeIds.length > 0;
  const patchedCanvas = eligible ? applyContentPatch(liveCanvas, edited.canvas, cls.changedNodeIds, idMap) : null;

  return { ...cls, reasons, eligible, conflictNodeIds, missingOnLive, patchedCanvas };
}
