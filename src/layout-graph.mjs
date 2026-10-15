import { isEdgeCell } from './canvas.mjs';
import { boxOf, invalidLayout, portPoint } from './layout-geometry.mjs';

export function layoutGraph(envelope) {
  const canvas = envelope.canvas;
  if (!Array.isArray(canvas)) throw invalidLayout('画布必须是数组');
  const cells = new Map();
  for (const c of canvas) {
    if (typeof c?.id !== 'string' || !c.id || cells.has(c.id))
      throw invalidLayout('画布元素 ID 缺失或重复');
    cells.set(c.id, c);
  }
  const nodes = canvas.filter((c) => !isEdgeCell(c)),
    edges = canvas.filter(isEdgeCell),
    map = new Map(nodes.map((n) => [n.id, n])),
    parent = new Map();
  for (const n of nodes) {
    if (
      !Number.isFinite(n.position?.x) ||
      !Number.isFinite(n.position?.y) ||
      !Number.isFinite(n.size?.width) ||
      !Number.isFinite(n.size?.height) ||
      Math.abs(n.position.x) > 10_000_000 ||
      Math.abs(n.position.y) > 10_000_000 ||
      n.size.width > 100_000 ||
      n.size.height > 100_000 ||
      n.size.width <= 0 ||
      n.size.height <= 0
    )
      throw invalidLayout(`节点 [${n.id}] 的坐标或尺寸无效或超出安全范围`);
    const portIds = (n.ports?.items ?? []).map((p) => p.id);
    if (
      portIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(portIds).size !== portIds.length
    )
      throw invalidLayout(`节点 [${n.id}] 的端口 ID 缺失或重复`);
  }
  function setParent(child, p) {
    if (
      !map.has(child) ||
      !map.has(p) ||
      (parent.has(child) && parent.get(child) !== p)
    )
      throw invalidLayout(`容器父子关系悬空或不一致 [${child}]`);
    parent.set(child, p);
  }
  for (const n of nodes) {
    if (n.parent) setParent(n.id, n.parent);
    if (n.data?.parentLoopBodyNodeId)
      setParent(n.id, n.data.parentLoopBodyNodeId);
    for (const child of n.children ?? [])
      setParent(typeof child === 'string' ? child : child?.id, n.id);
  }
  const rootOf = new Map();
  for (const n of nodes) {
    let v = n.id;
    const seen = new Set([v]);
    while (parent.has(v)) {
      v = parent.get(v);
      if (seen.has(v)) throw invalidLayout(`容器父子关系成环 [${v}]`);
      seen.add(v);
    }
    rootOf.set(n.id, v);
  }
  const unitMap = new Map();
  for (const n of nodes) {
    const root = rootOf.get(n.id);
    if (!unitMap.has(root)) unitMap.set(root, { id: root, members: [] });
    unitMap.get(root).members.push(n);
  }
  const units = [...unitMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const u of units) {
    u.box = boxOf(u.members);
    u.offsets = new Map(
      u.members.map((n) => [
        n.id,
        { x: n.position.x - u.box.x, y: n.position.y - u.box.y },
      ]),
    );
    u.width = u.box.width;
    u.height = u.box.height;
  }
  const adj = new Map(units.map((u) => [u.id, new Set()]));
  for (const e of edges) {
    if (!map.has(e.source?.cell) || !map.has(e.target?.cell))
      throw invalidLayout(`连线 [${e.id}] 的端点悬空`);
    portPoint(map.get(e.source.cell), e.source.port, 'right');
    portPoint(map.get(e.target.cell), e.target.port, 'left');
    const a = rootOf.get(e.source.cell),
      b = rootOf.get(e.target.cell);
    adj.get(a).add(b);
    adj.get(b).add(a);
  }
  const modules = [],
    moduleOf = new Map();
  for (const u of units) {
    if (moduleOf.has(u.id)) continue;
    const ids = [],
      q = [u.id],
      id = modules.length;
    moduleOf.set(u.id, id);
    while (q.length) {
      const v = q.pop();
      ids.push(v);
      for (const t of adj.get(v))
        if (!moduleOf.has(t)) {
          moduleOf.set(t, id);
          q.push(t);
        }
    }
    const set = new Set(ids);
    modules.push({
      id,
      units: ids.map((id) => unitMap.get(id)),
      edges: edges.filter((e) => set.has(rootOf.get(e.source.cell))),
    });
  }
  const triggers = new Map(),
    eventNames = new Map(
      (envelope.events ?? []).map((e) => [e.eventId, e.name]),
    );
  for (const n of nodes)
    if (n.data?.type === 'canvas-event-trigger') {
      const eid = n.data.nodePayload?.eventId ?? n.data.eventItem?.eventId;
      if (eid) {
        if (!triggers.has(eid)) triggers.set(eid, []);
        triggers.get(eid).push(n.id);
      }
    }
  const eventLinks = [],
    unmatchedEventActions = [];
  for (const n of nodes
    .filter((n) => n.data?.type === 'canvas-event-action')
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const eventId = n.data.nodePayload?.eventId,
      targets = triggers.get(eventId) ?? [];
    const link = {
      from: n.id,
      eventId,
      eventName: eventNames.get(eventId) ?? null,
    };
    if (!targets.length) unmatchedEventActions.push(link);
    for (const to of targets.slice().sort()) eventLinks.push({ ...link, to });
  }
  return {
    nodes,
    edges,
    map,
    parent,
    rootOf,
    unitMap,
    units,
    modules,
    moduleOf,
    eventLinks,
    unmatchedEventActions,
  };
}
