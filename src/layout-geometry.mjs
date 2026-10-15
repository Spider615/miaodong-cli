import { isEdgeCell, isVisualOnlyCell } from './canvas.mjs';
import { EXIT, MdError } from './errors.mjs';

export const invalidLayout = (message) =>
  new MdError('layout_invalid', message, { exitCode: EXIT.BLOCKED });
export const boxOf = (nodes) => {
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...nodes.map((n) => n.position.x)),
    y = Math.min(...nodes.map((n) => n.position.y));
  return {
    x,
    y,
    width: Math.max(...nodes.map((n) => n.position.x + n.size.width)) - x,
    height: Math.max(...nodes.map((n) => n.position.y + n.size.height)) - y,
  };
};
export const overlaps = (a, b, pad = 0) =>
  a.x < b.x + b.width + pad - 0.01 &&
  a.x + a.width + pad > b.x + 0.01 &&
  a.y < b.y + b.height + pad - 0.01 &&
  a.y + a.height + pad > b.y + 0.01;
const coordinate = (value, length) =>
  typeof value === 'string' && value.endsWith('%')
    ? (parseFloat(value) * length) / 100
    : value;

export function portPoint(node, id, side) {
  const items = node.ports?.items ?? [];
  const item = id == null ? null : items.find((p) => p.id === id);
  if (id != null && !item)
    throw invalidLayout(`节点 [${node.id}] 的连线端口不存在：${id}`);
  const group = item?.group,
    config = node.ports?.groups?.[group]?.position;
  const name =
    typeof config === 'string' ? config : (config?.name ?? group ?? side);
  const same = items.filter((p) => p.group === group),
    fraction = item ? (same.indexOf(item) + 1) / (same.length + 1) : 0.5;
  let x =
    name === 'left'
      ? 0
      : name === 'right'
        ? node.size.width
        : node.size.width * fraction;
  let y =
    name === 'top'
      ? 0
      : name === 'bottom'
        ? node.size.height
        : node.size.height * fraction;
  const args = {
    ...(typeof config === 'object' ? config.args : {}),
    ...item?.args,
  };
  if (args.x !== undefined) x = coordinate(args.x, node.size.width);
  if (args.y !== undefined) y = coordinate(args.y, node.size.height);
  if (
    !['left', 'right', 'top', 'bottom'].includes(name) &&
    !(args.x !== undefined && args.y !== undefined)
  )
    throw invalidLayout(`节点 [${node.id}] 的端口布局无法识别：${name}`);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > 1_000_000 ||
    Math.abs(y) > 1_000_000
  )
    throw invalidLayout(`节点 [${node.id}] 的端口坐标无效`);
  return {
    x: node.position.x + x,
    y: node.position.y + y,
    localX: x,
    localY: y,
  };
}

export function edgeCurve(map, edge, steps = 32) {
  const a = portPoint(map.get(edge.source.cell), edge.source.port, 'right'),
    b = portPoint(map.get(edge.target.cell), edge.target.port, 'left');
  if (
    !String(edge.shape).includes('custom-curve') &&
    !String(edge.connector?.name ?? '').includes('custom-curve')
  )
    return { points: [a, b], d: `M ${a.x} ${a.y} L ${b.x} ${b.y}` };
  const dx = Math.abs(b.x - a.x),
    s = { x: a.x + 6, y: a.y },
    t = { x: b.x - 6, y: b.y },
    c1 = { x: a.x + (a.x <= b.x ? dx / 2 : dx), y: a.y },
    c2 = { x: b.x - (a.x <= b.x ? dx / 2 : dx), y: b.y };
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps,
      v = 1 - u;
    points.push({
      x:
        v * v * v * s.x +
        3 * v * v * u * c1.x +
        3 * v * u * u * c2.x +
        u * u * u * t.x,
      y:
        v * v * v * s.y +
        3 * v * v * u * c1.y +
        3 * v * u * u * c2.y +
        u * u * u * t.y,
    });
  }
  return {
    points,
    d: `M ${s.x} ${s.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${t.x} ${t.y}`,
  };
}

const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function intersects(a, b, c, d) {
  const epsilon = 1e-8;
  if (
    Math.max(a.x, b.x) < Math.min(c.x, d.x) - epsilon ||
    Math.max(c.x, d.x) < Math.min(a.x, b.x) - epsilon ||
    Math.max(a.y, b.y) < Math.min(c.y, d.y) - epsilon ||
    Math.max(c.y, d.y) < Math.min(a.y, b.y) - epsilon
  )
    return false;
  const sign = (n) => (Math.abs(n) < epsilon ? 0 : Math.sign(n));
  return (
    sign(cross(a, b, c)) * sign(cross(a, b, d)) <= 0 &&
    sign(cross(c, d, a)) * sign(cross(c, d, b)) <= 0
  );
}
export function hitsRect(a, b, r) {
  // Clip against the open interior so a line along the border is not a hit.
  let lo = 0,
    hi = 1;
  const epsilon = 1e-6;
  for (const [origin, delta, min, max] of [
    [a.x, b.x - a.x, r.x + epsilon, r.x + r.width - epsilon],
    [a.y, b.y - a.y, r.y + epsilon, r.y + r.height - epsilon],
  ]) {
    if (Math.abs(delta) < 1e-12) {
      if (origin < min || origin > max) return false;
      continue;
    }
    const p = (min - origin) / delta,
      q = (max - origin) / delta;
    lo = Math.max(lo, Math.min(p, q));
    hi = Math.min(hi, Math.max(p, q));
    if (lo > hi) return false;
  }
  return hi >= lo;
}

class Grid {
  constructor() {
    this.cells = new Map();
    this.items = new Map();
    this.large = new Map();
  }
  keys(r) {
    const nx = Math.floor((r.x + r.width) / 400) - Math.floor(r.x / 400) + 1,
      ny = Math.floor((r.y + r.height) / 400) - Math.floor(r.y / 400) + 1;
    if (nx * ny > 4096) return null;
    const out = [];
    for (
      let x = Math.floor(r.x / 400);
      x <= Math.floor((r.x + r.width) / 400);
      x++
    )
      for (
        let y = Math.floor(r.y / 400);
        y <= Math.floor((r.y + r.height) / 400);
        y++
      )
        out.push(x + ',' + y);
    return out;
  }
  add(item) {
    this.items.set(item.id, item);
    const keys = this.keys(item);
    if (!keys) {
      this.large.set(item.id, item);
      return;
    }
    for (const key of keys) {
      if (!this.cells.has(key)) this.cells.set(key, new Map());
      this.cells.get(key).set(item.id, item);
    }
  }
  remove(item) {
    this.items.delete(item.id);
    this.large.delete(item.id);
    for (const key of this.keys(item) ?? [])
      this.cells.get(key)?.delete(item.id);
  }
  query(rect) {
    const keys = this.keys(rect);
    if (!keys) return this.items.values();
    const found = new Map(this.large);
    for (const key of keys)
      for (const [id, item] of this.cells.get(key) ?? []) found.set(id, item);
    return found.values();
  }
}
const lineBox = (a, b) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

// Moving a whole wire component cannot change its internal intersections. Reject new external ones.
export function occupancy() {
  const ng = new Grid(),
    sg = new Grid();
  function shapes(m, x, y) {
    return {
      rects: m.rects.map((r) => ({ ...r, x: r.x + x, y: r.y + y })),
      lines: m.segments.map((s) => {
        const a = { x: s.a.x + x, y: s.a.y + y },
          b = { x: s.b.x + x, y: s.b.y + y };
        return { ...s, a, b, ...lineBox(a, b) };
      }),
    };
  }
  return {
    add(m) {
      m.occupied = shapes(m, m.x, m.y);
      for (const r of m.occupied.rects) ng.add(r);
      for (const s of m.occupied.lines) sg.add(s);
    },
    remove(m) {
      for (const r of m.occupied.rects) ng.remove(r);
      for (const s of m.occupied.lines) sg.remove(s);
    },
    fits(m, x, y) {
      const { rects, lines } = shapes(m, x, y);
      for (const r of rects) {
        for (const o of ng.query({
          x: r.x - 65,
          y: r.y - 65,
          width: r.width + 130,
          height: r.height + 130,
        }))
          if (overlaps(r, o, 65)) return false;
        for (const s of sg.query(r)) if (hitsRect(s.a, s.b, r)) return false;
      }
      for (const s of lines) {
        for (const r of ng.query(s)) if (hitsRect(s.a, s.b, r)) return false;
        for (const o of sg.query(s))
          if (intersects(s.a, s.b, o.a, o.b)) return false;
      }
      return true;
    },
  };
}

export function geometryReport(canvas, parent = new Map()) {
  const nodes = canvas.filter((c) => !isEdgeCell(c)),
    edges = canvas.filter(isEdgeCell),
    map = new Map(nodes.map((n) => [n.id, n]));
  const related = (a, b) => {
    for (let v = parent.get(a); v; v = parent.get(v)) if (v === b) return true;
    for (let v = parent.get(b); v; v = parent.get(v)) if (v === a) return true;
    return false;
  };
  const rects = nodes.map((n) => ({ id: n.id, ...n.position, ...n.size })),
    ng = new Grid(),
    sg = new Grid();
  let overlapPairs = 0,
    backwardEdges = 0,
    curveLength = 0;
  for (const r of rects) {
    for (const o of ng.query(r))
      if (!related(r.id, o.id) && overlaps(r, o)) overlapPairs++;
    ng.add(r);
  }
  const nodeHits = new Set(),
    edgeHits = new Set();
  for (const e of edges) {
    const { points } = edgeCurve(map, e);
    if (
      map.get(e.source.cell).position.x + map.get(e.source.cell).size.width >
      map.get(e.target.cell).position.x
    )
      backwardEdges++;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        s = { id: e.id + ':' + i, edge: e, a, b, ...lineBox(a, b) };
      curveLength += Math.hypot(b.x - a.x, b.y - a.y);
      for (const r of ng.query(s)) {
        if (
          [e.source.cell, e.target.cell].some(
            (id) => id === r.id || related(id, r.id),
          )
        )
          continue;
        const key = e.id + ':' + r.id;
        if (!nodeHits.has(key) && hitsRect(a, b, r)) nodeHits.add(key);
      }
      for (const o of sg.query(s)) {
        if (
          o.edge.id === e.id ||
          [e.source.cell, e.target.cell].some(
            (id) => id === o.edge.source.cell || id === o.edge.target.cell,
          )
        )
          continue;
        const key = [e.id, o.edge.id].sort().join(':');
        if (!edgeHits.has(key) && intersects(a, b, o.a, o.b)) edgeHits.add(key);
      }
      sg.add(s);
    }
  }
  const bounds = boxOf(nodes);
  return {
    nodes: nodes.filter((n) => !isVisualOnlyCell(n)).length,
    decorations: nodes.filter(isVisualOnlyCell).length,
    edges: edges.length,
    overlapPairs,
    backwardEdges,
    edgeNodeIntersections: nodeHits.size,
    intersectingEdgePairs: edgeHits.size,
    curveLength: Math.round(curveLength),
    bounds,
    area: Math.round(bounds.width * bounds.height),
  };
}
