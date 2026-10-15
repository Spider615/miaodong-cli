import { boxOf, overlaps, portPoint } from './layout-geometry.mjs';

// Dot's crossing minimizer can reverse siblings despite ordering=out. Correct private roots
// inside their existing column slots; ports, downstream nodes and horizontal ranks stay fixed.
export function orderBranchRoots(graph, module) {
  const nodes = new Map(module.nodes.map((n) => [n.id, n])),
    byUnit = new Map(
      module.units.map((u) => [u.id, u.members.map((n) => nodes.get(n.id))]),
    );
  const incoming = new Map(),
    outgoing = new Map();
  for (const e of module.edges) {
    const from = graph.rootOf.get(e.source.cell),
      to = graph.rootOf.get(e.target.cell);
    if (from === to) continue;
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(e);
  }
  let adjusted = 0;
  for (const edges of outgoing.values()) {
    const ordered = edges
      .slice()
      .sort(
        (a, b) =>
          portPoint(nodes.get(a.source.cell), a.source.port, 'right').y -
            portPoint(nodes.get(b.source.cell), b.source.port, 'right').y ||
          nodes.get(a.target.cell).position.y -
            nodes.get(b.target.cell).position.y,
      );
    if (
      new Set(ordered.map((e) => e.source.cell + ':' + e.source.port)).size < 2
    )
      continue;
    const ids = [
      ...new Set(ordered.map((e) => graph.rootOf.get(e.target.cell))),
    ].filter((id) => incoming.get(id) === 1);
    if (ids.length < 2) continue;
    const boxes = new Map(ids.map((id) => [id, boxOf(byUnit.get(id))]));
    const first = boxes.get(ids[0]),
      center = first.x + first.width / 2;
    if (
      [...boxes.values()].some(
        (b) => Math.abs(b.x + b.width / 2 - center) > 1,
      ) ||
      ids.every((id, i) => !i || boxes.get(id).y >= boxes.get(ids[i - 1]).y)
    )
      continue;
    const slots = [...boxes.values()].sort((a, b) => a.y - b.y),
      gaps = slots.slice(1).map((s, i) => s.y - slots[i].y - slots[i].height);
    let y = slots[0].y;
    const planned = new Map();
    for (const [i, id] of ids.entries()) {
      const delta = y - boxes.get(id).y;
      for (const n of byUnit.get(id))
        planned.set(n.id, { ...n.position, y: n.position.y + delta });
      y += boxes.get(id).height + (gaps[i] ?? 0);
    }
    let hit = false;
    for (const [id, p] of planned) {
      const n = nodes.get(id),
        r = { ...p, ...n.size };
      for (const other of module.nodes) {
        if (planned.has(other.id)) continue;
        if (overlaps(r, { ...other.position, ...other.size })) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) continue;
    for (const [id, p] of planned) nodes.get(id).position = p;
    adjusted++;
  }
  return adjusted;
}
