// 风险分析上下文：把 workflow JSON 预处理成规则需要的各种索引。
// 所有规则（rules/*.ts）都只读这份 context，不再各自重复遍历 canvas。
//
// 刻意不复用 workflowParser.ParsedNode——它丢掉了 nodePayload.inputs / operations / branches 等
// 规则要用的字段。这里直接持有 raw 节点对象，按需下钻。

import { isCanvasEdge } from '../workflowParser';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 有 outputTypes 的节点类型（能作为数据源被 referenceNodeId 引用）。 */
const PRODUCER_TYPES = new Set([
  'llm-completion',
  'javascript-code',
  'query-knowledge-base',
  'speech-to-text',
  'plugin-calculation',
]);

/** 平台已知 data.type 枚举白名单（F10 用）。触发器 / 事件类另外判定。 */
export const KNOWN_NODE_TYPES = new Set([
  'new-friend',
  'receive-text-message',
  'receive-image-message',
  'receive-audio-message',
  'receive-video-message',
  'receive-file-message',
  'receive-other-message',
  'bot-receive-text-message',
  'tag-event',
  'canvas-event-trigger',
  'send-text-message',
  'send-image-message',
  'send-audio-message',
  'send-combination-message',
  'send-material',
  'tag-user',
  'invite-room',
  'canvas-event-action',
  'update-data',
  'update-custom-attr',
  'handover',
  'plugin-action',
  'llm-completion',
  'rule-center',
  'javascript-code',
  'speech-to-text',
  'query-knowledge-base',
  'plugin-calculation',
  'canvas-tool-comment-node',
]);

// ---------------------------------------------------------------------------
// 节点 / 边 / session 视图
// ---------------------------------------------------------------------------

export interface RiskNode {
  id: string;
  /** canvas item.shape。 */
  shape: string;
  /** data.type || shape。 */
  type: string;
  /** data.category（trigger/action/calculation/comment）。 */
  category: string;
  name: string;
  data: Record<string, unknown>;
  /** data.nodePayload（可能为空对象）。 */
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
  /** 在 canvas 数组里的下标（用于 path）。 */
  index: number;
}

export interface RiskEdge {
  id: string;
  sourceId: string;
  sourcePort: string;
  targetId: string;
  targetPort: string;
  index: number;
  raw: Record<string, unknown>;
}

export interface RiskSession {
  id: string;
  name: string;
  raw: Record<string, unknown>;
}

/** 一个「引用点」：某节点持有的一处对上游/ session 的引用。B/C/E 规则遍历它。 */
export interface RefSite {
  /** 持有引用的消费者节点。 */
  node: RiskNode;
  /** JSON 字段路径，便于定位。 */
  path: string;
  /** 人类可读标签（input name / 'rule.field' / 'query' 等）。 */
  label: string;
  valueType?: string;
  referenceNodeId?: string;
  sessionMemoryItemId?: string;
  dataPath?: string;
  /** 消费点种类。 */
  kind:
    | 'input'
    | 'rule-field'
    | 'rule-value'
    | 'update-value'
    | 'kb-query'
    | 'template'; // {{var}} 模板占位（无 referenceNodeId，仅用于 B4）
}

/** update-data / update-custom-attr 的一次 session 写入。 */
export interface SessionWrite {
  node: RiskNode;
  fieldId: string;
  path: string;
}

export interface AnalysisContext {
  workflow: Record<string, unknown>;
  nodes: RiskNode[];
  edges: RiskEdge[];
  nodeById: Map<string, RiskNode>;
  nodeIds: Set<string>;

  /** sourceId -> 直接下游 targetId 集合。 */
  forward: Map<string, Set<string>>;
  /** targetId -> 直接上游 sourceId 集合。 */
  backward: Map<string, Set<string>>;
  /** nodeId -> 全部上游祖先 id 集合（BFS backward）。 */
  ancestors: Map<string, Set<string>>;
  /** 从任一入口节点顺 edges 前向可达的节点集合。 */
  reachableFromEntry: Set<string>;
  entryNodeIds: Set<string>;

  /** jsonOutput===true 的 llm 节点 id（A/D 组核心）。 */
  jsonLlmIds: Set<string>;
  /** nodeId -> outputTypes[].name 集合（仅 producer 节点有）。 */
  outputNamesById: Map<string, Set<string>>;
  /** nodeId -> 是否能作为数据源被引用（有 outputTypes 概念的类型）。 */
  isProducerById: Map<string, boolean>;

  sessionIds: Set<string>;
  sessionById: Map<string, RiskSession>;
  /** sessionId -> session 变量 name。 */
  sessionNameById: Map<string, string>;

  eventIds: Set<string>;
  events: Record<string, unknown>[];

  /** 所有引用点（B/C/E 遍历）。 */
  refSites: RefSite[];
  /** 所有 session 写入（C2/C3/C4 用）。 */
  sessionWrites: SessionWrite[];
}

// ---------------------------------------------------------------------------
// 入口节点判定（对齐 standard-start/workflow-validator.isLegitimateEntryNode）
// ---------------------------------------------------------------------------

export function isEntryNode(node: RiskNode, eventIds: Set<string>): boolean {
  if (node.category === 'trigger') return true;
  if (node.category === 'comment') return true;
  if (node.shape === 'canvas-tool-comment-node') return true;
  if (/^receive-.+-message$/.test(node.shape)) return true;
  if (node.shape === 'new-friend' || node.shape === 'tag-event') return true;
  if (eventIds.has(node.shape)) return true; // 事件入口节点：shape == eventId
  return false;
}

// ---------------------------------------------------------------------------
// 引用块解析
// ---------------------------------------------------------------------------

/** 判断一个对象是否是「引用块」（含 referenceNodeId / sessionMemoryItemId / valueType:'reference'）。 */
function isRefBlock(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.referenceNodeId === 'string' ||
    typeof obj.sessionMemoryItemId === 'string' ||
    obj.valueType === 'reference'
  );
}

function readRefBlock(
  node: RiskNode,
  obj: Record<string, unknown>,
  path: string,
  label: string,
  kind: RefSite['kind'],
): RefSite {
  return {
    node,
    path,
    label,
    kind,
    valueType: asString(obj.valueType),
    referenceNodeId: asString(obj.referenceNodeId),
    sessionMemoryItemId: asString(obj.sessionMemoryItemId),
    dataPath: asString(obj.dataPath),
  };
}

/** 抽取模板里的 {{var}} 占位符名。 */
export function extractTemplateVars(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// 引用点收集
// ---------------------------------------------------------------------------

function collectRefSites(node: RiskNode): { sites: RefSite[]; writes: SessionWrite[] } {
  const sites: RefSite[] = [];
  const writes: SessionWrite[] = [];
  const payload = node.payload;

  // 1) inputs[]（LLM / JS / send-text / action-event / plugin 通用）
  const inputs = asArray(payload.inputs);
  inputs.forEach((input, i) => {
    const obj = asObject(input);
    if (!obj) return;
    if (!isRefBlock(obj)) return; // value 型输入无需引用检查
    const name = asString(obj.name);
    sites.push(
      readRefBlock(
        node,
        obj,
        `data.nodePayload.inputs[${i}]`,
        name && name.trim() ? name : `输入${i}`,
        'input',
      ),
    );
  });

  // 2) rule-center：branches[].ruleGroup.rules[].field / .value
  if (node.shape === 'rule-center' || node.type === 'rule-center') {
    const branches = asArray(payload.branches);
    branches.forEach((branch, bi) => {
      const b = asObject(branch);
      const rg = asObject(b?.ruleGroup);
      const rules = asArray(rg?.rules);
      rules.forEach((rule, ri) => {
        const r = asObject(rule);
        if (!r) return;
        const field = asObject(r.field);
        if (field && isRefBlock(field)) {
          sites.push(
            readRefBlock(
              node,
              field,
              `data.nodePayload.branches[${bi}].ruleGroup.rules[${ri}].field`,
              '规则字段',
              'rule-field',
            ),
          );
        }
        const value = asObject(r.value);
        if (value && isRefBlock(value)) {
          sites.push(
            readRefBlock(
              node,
              value,
              `data.nodePayload.branches[${bi}].ruleGroup.rules[${ri}].value`,
              '规则比较值',
              'rule-value',
            ),
          );
        }
      });
    });
  }

  // 3) update-data / update-custom-attr：operations[].value（引用）+ .fieldId（session 写）
  if (node.shape === 'update-data' || node.shape === 'update-custom-attr') {
    const ops = asArray(payload.operations);
    ops.forEach((op, oi) => {
      const o = asObject(op);
      if (!o) return;
      const fieldId = asString(o.fieldId);
      if (fieldId) {
        writes.push({ node, fieldId, path: `data.nodePayload.operations[${oi}].fieldId` });
      }
      const value = asObject(o.value);
      if (value && isRefBlock(value)) {
        sites.push(
          readRefBlock(
            node,
            value,
            `data.nodePayload.operations[${oi}].value`,
            '写入值',
            'update-value',
          ),
        );
      }
    });
  }

  // 4) query-knowledge-base：query
  if (node.shape === 'query-knowledge-base') {
    const query = asObject(payload.query);
    if (query && isRefBlock(query)) {
      sites.push(readRefBlock(node, query, 'data.nodePayload.query', 'KB 查询', 'kb-query'));
    }
  }

  return { sites, writes };
}

// ---------------------------------------------------------------------------
// 主构建
// ---------------------------------------------------------------------------

function buildAncestors(
  nodeIds: Set<string>,
  backward: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const ancestors = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    const seen = new Set<string>();
    const queue: string[] = [...(backward.get(id) ?? [])];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const up of backward.get(cur) ?? []) {
        if (!seen.has(up)) queue.push(up);
      }
    }
    ancestors.set(id, seen);
  }
  return ancestors;
}

export function buildContext(workflow: Record<string, unknown>): AnalysisContext {
  const canvas = asArray(workflow.canvas)
    .map(asObject)
    .filter((x): x is Record<string, unknown> => x !== null);

  const nodes: RiskNode[] = [];
  const edges: RiskEdge[] = [];

  canvas.forEach((item, index) => {
    if (isCanvasEdge(item)) {
      const source = asObject(item.source);
      const target = asObject(item.target);
      edges.push({
        id: asString(item.id) ?? `edge-${index}`,
        sourceId: asString(source?.cell) ?? '',
        sourcePort: asString(source?.port) ?? '',
        targetId: asString(target?.cell) ?? '',
        targetPort: asString(target?.port) ?? '',
        index,
        raw: item,
      });
      return;
    }
    const data = asObject(item.data) ?? {};
    const payload = asObject(data.nodePayload) ?? {};
    const shape = asString(item.shape) ?? 'unknown';
    nodes.push({
      id: asString(item.id) ?? `node-${index}`,
      shape,
      type: asString(data.type) ?? shape,
      category:
        asString(data.category) ?? (shape === 'canvas-tool-comment-node' ? 'comment' : 'calculation'),
      name: asString(data.name) ?? shape,
      data,
      payload,
      raw: item,
      index,
    });
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeIds = new Set(nodes.map((n) => n.id));

  // 邻接表
  const forward = new Map<string, Set<string>>();
  const backward = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!e.sourceId || !e.targetId) continue;
    if (!forward.has(e.sourceId)) forward.set(e.sourceId, new Set());
    forward.get(e.sourceId)!.add(e.targetId);
    if (!backward.has(e.targetId)) backward.set(e.targetId, new Set());
    backward.get(e.targetId)!.add(e.sourceId);
  }

  // sessions
  const sessions = asArray(workflow.sessions)
    .map(asObject)
    .filter((x): x is Record<string, unknown> => x !== null);
  const sessionById = new Map<string, RiskSession>();
  const sessionNameById = new Map<string, string>();
  for (const s of sessions) {
    const id = asString(s.id);
    if (!id) continue;
    const name = asString(s.name) ?? '';
    sessionById.set(id, { id, name, raw: s });
    sessionNameById.set(id, name);
  }
  const sessionIds = new Set(sessionById.keys());

  // events
  const events = asArray(workflow.events)
    .map(asObject)
    .filter((x): x is Record<string, unknown> => x !== null);
  const eventIds = new Set(
    events.map((e) => asString(e.eventId)).filter((v): v is string => Boolean(v)),
  );

  // producers / outputs
  const outputNamesById = new Map<string, Set<string>>();
  const isProducerById = new Map<string, boolean>();
  const jsonLlmIds = new Set<string>();
  for (const n of nodes) {
    const isTrigger = n.category === 'trigger';
    const producer = PRODUCER_TYPES.has(n.type) || PRODUCER_TYPES.has(n.shape) || isTrigger;
    isProducerById.set(n.id, producer);
    const outputTypes = asArray(n.data.outputTypes);
    const names = new Set<string>();
    for (const o of outputTypes) {
      const name = asString(asObject(o)?.name);
      if (name) names.add(name);
    }
    outputNamesById.set(n.id, names);
    if ((n.shape === 'llm-completion' || n.type === 'llm-completion') && n.payload.jsonOutput === true) {
      jsonLlmIds.add(n.id);
    }
  }

  // 入口节点 + 可达集
  const entryNodeIds = new Set<string>();
  for (const n of nodes) if (isEntryNode(n, eventIds)) entryNodeIds.add(n.id);
  const reachableFromEntry = new Set<string>();
  {
    const queue = [...entryNodeIds];
    while (queue.length) {
      const cur = queue.shift()!;
      if (reachableFromEntry.has(cur)) continue;
      reachableFromEntry.add(cur);
      for (const down of forward.get(cur) ?? []) {
        if (!reachableFromEntry.has(down)) queue.push(down);
      }
    }
  }

  const ancestors = buildAncestors(nodeIds, backward);

  // 引用点
  const refSites: RefSite[] = [];
  const sessionWrites: SessionWrite[] = [];
  for (const n of nodes) {
    const { sites, writes } = collectRefSites(n);
    refSites.push(...sites);
    sessionWrites.push(...writes);
  }

  return {
    workflow,
    nodes,
    edges,
    nodeById,
    nodeIds,
    forward,
    backward,
    ancestors,
    reachableFromEntry,
    entryNodeIds,
    jsonLlmIds,
    outputNamesById,
    isProducerById,
    sessionIds,
    sessionById,
    sessionNameById,
    eventIds,
    events,
    refSites,
    sessionWrites,
  };
}
