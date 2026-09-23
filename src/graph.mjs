// 画布的图结构：节点、连线、事件跳转、节点间引用。
// 事件跳转没有真实连线：事件动作节点（canvas-event-action）与同 eventId 的事件触发节点
// （canvas-event-trigger）之间靠 eventId 关联。老懂的 trace 不走这层，会话里 AI 手补过 210 条。
// 引用 = 任意层级里带 referenceNodeId 的对象（inputs、规则条件、写回操作……），
// 只扫顶层 inputs 会漏掉约 28%（实测）。

import { EXIT, MdError, usage } from './errors.mjs';
import { isEdgeCell, isVisualOnlyCell } from './canvas.mjs';
import { shortId } from './output.mjs';

const isElement = (cell) => Boolean(cell) && typeof cell === 'object';

export function businessNodes(canvas) {
  return canvas.filter((c) => isElement(c) && !isEdgeCell(c) && !isVisualOnlyCell(c));
}

export function edgesOf(canvas) {
  return canvas.filter((c) => isElement(c) && isEdgeCell(c));
}

export function nodeName(cell) {
  const name = cell?.data?.name;
  return typeof name === 'string' && name ? name : '(无名)';
}

export function nodeType(cell) {
  return String(cell?.data?.type ?? cell?.shape ?? '?');
}

export function collectRefs(node) {
  const refs = [];
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.referenceNodeId === 'string' && value.referenceNodeId) {
      refs.push({ from: node.id, to: value.referenceNodeId, path, dataPath: typeof value.dataPath === 'string' ? value.dataPath : null });
    }
    for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') walk(child, `${path}.${key}`);
  };
  walk(node.data, 'data');
  return refs;
}

export function buildIndex(canvas, events = []) {
  const nodes = businessNodes(canvas);
  const eventName = new Map((events ?? []).map((e) => [e?.eventId, e?.name]));
  const edges = edgesOf(canvas).map((e) => ({
    kind: 'wire', from: e.source?.cell ?? null, fromPort: e.source?.port ?? null, to: e.target?.cell ?? null, toPort: e.target?.port ?? null,
  }));
  const triggersByEvent = new Map();
  for (const n of nodes) {
    const eventId = n.data?.nodePayload?.eventId;
    if (n.data?.type === 'canvas-event-trigger' && eventId) {
      if (!triggersByEvent.has(eventId)) triggersByEvent.set(eventId, []);
      triggersByEvent.get(eventId).push(n.id);
    }
  }
  for (const n of nodes) {
    const eventId = n.data?.nodePayload?.eventId;
    if (n.data?.type !== 'canvas-event-action' || !eventId) continue;
    for (const trigger of triggersByEvent.get(eventId) ?? []) {
      edges.push({ kind: 'event', from: n.id, fromPort: null, to: trigger, toPort: null, eventId, eventName: eventName.get(eventId) ?? null });
    }
  }
  const inDeg = new Map();
  const outDeg = new Map();
  for (const e of edges) {
    if (e.from) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    if (e.to) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  return {
    nodes: nodes.map((n) => ({
      id: n.id, name: nodeName(n), type: nodeType(n), category: n.data?.category ?? null,
      model: n.data?.nodePayload?.modelType ?? null, in: inDeg.get(n.id) ?? 0, out: outDeg.get(n.id) ?? 0,
    })),
    edges,
    refs: nodes.flatMap(collectRefs),
  };
}

export function resolveNode(canvas, query) {
  const q = String(query ?? '').trim();
  if (!q) throw usage('缺节点（id、id 前缀或唯一的节点名）');
  const nodes = businessNodes(canvas);
  const exact = nodes.filter((n) => n.id === q);
  const byPrefix = exact.length ? exact : nodes.filter((n) => typeof n.id === 'string' && n.id.startsWith(q));
  const hits = byPrefix.length ? byPrefix : nodes.filter((n) => nodeName(n) === q);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new MdError('node_not_found', `没有节点「${q}」`, { exitCode: EXIT.TARGET });
  const lines = hits.slice(0, 20).map((n) => `  - ${shortId(n.id)} ${nodeName(n)} (${nodeType(n)})`).join('\n');
  throw new MdError('node_ambiguous', `「${q}」匹配到 ${hits.length} 个节点：\n${lines}`, { exitCode: EXIT.TARGET, hint: '用 id 前缀指定' });
}

export function traceLines(index, startId, { direction = 'down', depth = 6, maxLines = 200 } = {}) {
  const byId = new Map(index.nodes.map((n) => [n.id, n]));
  const adjacency = new Map();
  for (const e of index.edges) {
    const [from, to] = direction === 'down' ? [e.from, e.to] : [e.to, e.from];
    if (!from || !to) continue;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ next: to, edge: e });
  }
  const lines = [];
  const seen = new Set();
  const label = (id) => {
    const n = byId.get(id);
    return n ? `${n.name} (${n.type}) [${shortId(id)}]` : `(不存在的节点) [${shortId(id)}]`;
  };
  const walk = (id, level, via) => {
    if (lines.length >= maxLines) return;
    const lead = level === 0 ? '▶ ' : via?.kind === 'event' ? `⇢ 事件「${via.eventName ?? shortId(via.eventId)}」→ ` : '↳ ';
    const prefix = `${'  '.repeat(level)}${lead}`;
    if (seen.has(id)) {
      lines.push(`${prefix}${label(id)} …见上`);
      return;
    }
    seen.add(id);
    lines.push(`${prefix}${label(id)}`);
    const next = adjacency.get(id) ?? [];
    if (level >= depth) {
      if (next.length) lines.push(`${'  '.repeat(level + 1)}…（超过 --depth ${depth}）`);
      return;
    }
    for (const { next: child, edge } of next) walk(child, level + 1, edge);
  };
  walk(startId, 0, null);
  if (lines.length >= maxLines) lines.push(`…（超过 ${maxLines} 行，已截断）`);
  return lines;
}

export function refsTo(index, nodeId) {
  return index.refs.filter((r) => r.to === nodeId);
}
