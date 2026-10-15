import { boxOf, edgeCurve, occupancy } from './layout-geometry.mjs';

export function eventDistances(canvas, links) {
  const map = new Map(canvas.map((n) => [n.id, n]));
  const ds = links
    .map((l) => {
      const s = map.get(l.from),
        t = map.get(l.to);
      return Math.hypot(
        t.position.x - s.position.x - s.size.width,
        t.position.y + t.size.height / 2 - s.position.y - s.size.height / 2,
      );
    })
    .sort((a, b) => a - b);
  return {
    links: ds.length,
    mean: ds.length ? Math.round(ds.reduce((s, d) => s + d, 0) / ds.length) : 0,
    median: ds.length ? Math.round(ds[Math.floor(ds.length * 0.5)]) : 0,
    p90: ds.length ? Math.round(ds[Math.floor(ds.length * 0.9)]) : 0,
    within1500: ds.filter((d) => d <= 1500).length,
    within3000: ds.filter((d) => d <= 3000).length,
  };
}

export function placeModules(graph) {
  const modules = graph.modules,
    byNode = new Map();
  for (const m of modules) for (const n of m.nodes) byNode.set(n.id, { m, n });
  const links = graph.eventLinks.filter(
    (l) => byNode.get(l.from).m !== byNode.get(l.to).m,
  );
  const ordered = modules
    .slice()
    .sort(
      (a, b) =>
        b.nodes.length - a.nodes.length ||
        a.units[0].id.localeCompare(b.units[0].id),
    );
  const targetWidth = Math.max(
    1,
    ...modules.map((m) => m.width),
    Math.sqrt(
      modules.reduce((s, m) => s + (m.width + 300) * (m.height + 300), 0),
    ) * 1.35,
  );
  let x = 0,
    y = 0,
    rowHeight = 0;
  for (const m of ordered) {
    if (x && x + m.width > targetWidth) {
      x = 0;
      y += rowHeight + 360;
      rowHeight = 0;
    }
    m.x = x;
    m.y = y;
    x += m.width + 360;
    rowHeight = Math.max(rowHeight, m.height);
    m.links = links.filter(
      (l) => byNode.get(l.from).m === m || byNode.get(l.to).m === m,
    );
    m.rects = m.nodes.map((n) => ({ id: n.id, ...n.position, ...n.size }));
    const map = new Map(m.nodes.map((n) => [n.id, n]));
    m.segments = [];
    for (const e of m.edges) {
      const { points } = edgeCurve(map, e, 48);
      for (let i = 1; i < points.length; i++)
        m.segments.push({ id: e.id + ':' + i, a: points[i - 1], b: points[i] });
    }
  }
  const index = occupancy();
  for (const m of modules) index.add(m);
  const endpoint = (id, right, moving = null, px = 0, py = 0) => {
    const { m, n } = byNode.get(id);
    return {
      x: n.position.x + (m === moving ? px : m.x) + (right ? n.size.width : 0),
      y: n.position.y + (m === moving ? py : m.y) + n.size.height / 2,
    };
  };
  const cost = (m, px, py) =>
    m.links.reduce((sum, l) => {
      const a = endpoint(l.from, true, m, px, py),
        b = endpoint(l.to, false, m, px, py),
        dx = b.x - a.x - 220,
        d = Math.hypot(dx, b.y - a.y);
      return (
        sum + 0.35 * d + 1800 * Math.log1p(d / 600) + Math.max(0, -dx) * 0.12
      );
    }, 0);
  const offsets = [[0, 0]];
  for (const r of [
    180, 380, 700, 1100, 1700, 2500, 3600, 5200, 7600, 11000, 16000, 22000,
  ])
    for (let i = 0; i < 12; i++)
      offsets.push([
        Math.round(Math.cos((i * Math.PI) / 6) * r),
        Math.round(Math.sin((i * Math.PI) / 6) * r),
      ]);
  const moving = ordered
    .filter((m) => m !== ordered[0] && m.links.length)
    .sort(
      (a, b) =>
        b.links.length - a.links.length ||
        b.nodes.length - a.nodes.length ||
        a.id - b.id,
    );
  let moves = 0;
  for (let pass = 0; pass < 6; pass++) {
    let changed = 0;
    for (const m of pass % 2 ? moving.slice().reverse() : moving) {
      index.remove(m);
      const current = cost(m, m.x, m.y),
        anchors = m.links.map((l) => {
          const incoming = byNode.get(l.to).m === m,
            own = byNode.get(incoming ? l.to : l.from).n,
            p = endpoint(incoming ? l.from : l.to, incoming);
          return {
            x:
              p.x +
              (incoming ? 220 : -220) -
              own.position.x -
              (incoming ? 0 : own.size.width),
            y: p.y - own.position.y - own.size.height / 2,
          };
        });
      const median = (axis) =>
        anchors.map((p) => p[axis]).sort((a, b) => a - b)[
          Math.floor(anchors.length / 2)
        ];
      anchors.unshift({ x: median('x'), y: median('y') });
      const candidates = new Map();
      for (const a of anchors)
        for (const [dx, dy] of offsets) {
          const px = Math.round(a.x + dx),
            py = Math.round(a.y + dy),
            key = px + ',' + py;
          if (candidates.has(key)) continue;
          const score = cost(m, px, py);
          if (score < current - 0.5)
            candidates.set(key, { x: px, y: py, score });
        }
      for (const p of [...candidates.values()].sort(
        (a, b) => a.score - b.score || a.y - b.y || a.x - b.x,
      ))
        if (index.fits(m, p.x, p.y)) {
          m.x = p.x;
          m.y = p.y;
          changed++;
          moves++;
          break;
        }
      index.add(m);
    }
    if (!changed) break;
  }
  const all = modules.flatMap((m) =>
      m.nodes.map((n) => ({
        ...n,
        position: { x: n.position.x + m.x, y: n.position.y + m.y },
      })),
    ),
    b = boxOf(all);
  for (const n of all)
    n.position = {
      x: n.position.x - b.x,
      y: n.position.y - b.y,
    };
  return {
    positions: new Map(all.map((n) => [n.id, n.position])),
    crossLinks: links,
    moves,
  };
}
