import { instance } from '@viz-js/viz';
import { orderBranchRoots } from './layout-branches.mjs';
import { boxOf, invalidLayout, portPoint } from './layout-geometry.mjs';

let engine;
const viz = () => (engine ??= instance());

// Partition by reachability from the first substantial decision, never by business names or IDs.
function structuralGroups(units, edges) {
  if (units.length < 40) return new Map(units.map((u) => [u.id, 'all']));
  const adj = new Map(units.map((u) => [u.id, []])),
    indegree = new Map(units.map((u) => [u.id, 0]));
  for (const e of edges) {
    adj.get(e.from).push(e);
    indegree.set(e.to, indegree.get(e.to) + 1);
  }
  const roots = units
    .filter(
      (u) =>
        !indegree.get(u.id) ||
        u.members.some((n) => n.data?.category === 'trigger'),
    )
    .map((u) => u.id);
  const q = roots.length ? roots : [units[0].id],
    visited = new Set();
  for (let i = 0; i < q.length; i++) {
    const id = q[i];
    if (visited.has(id)) continue;
    visited.add(id);
    const out = adj.get(id),
      branches = [...new Set(out.map((e) => e.sourceKey))];
    if (branches.length >= 3 && branches.length <= 8) {
      const masks = new Map();
      for (const [j, key] of branches.entries()) {
        const todo = out.filter((e) => e.sourceKey === key).map((e) => e.to),
          seen = new Set();
        while (todo.length) {
          const t = todo.pop();
          if (t === id || seen.has(t)) continue;
          seen.add(t);
          if (!masks.has(t)) masks.set(t, new Set());
          masks.get(t).add(j);
          for (const e of adj.get(t)) todo.push(e.to);
        }
      }
      const counts = branches.map(
        (_, j) =>
          [...masks.values()].filter((set) => set.size === 1 && set.has(j))
            .length,
      );
      const groups = new Map(
        units.map((u) => [
          u.id,
          [...(masks.get(u.id) ?? [])].sort().join('-') || 'entry',
        ]),
      );
      if (
        counts.filter((n) => n >= 4).length >= 3 &&
        new Set(groups.values()).size <= 20
      )
        return groups;
    }
    q.push(...out.map((e) => e.to));
  }
  return new Map(units.map((u) => [u.id, 'all']));
}

export async function dotModules(graph) {
  const runtime = await viz();
  for (const m of graph.modules) {
    const units = m.units.slice().sort((a, b) => a.id.localeCompare(b.id)),
      names = new Map(units.map((u, i) => [u.id, 'n' + i])),
      slots = new Map(units.map((u) => [u.id, new Map()])),
      endpoint = new Map();
    for (const e of m.edges)
      for (const side of ['source', 'target']) {
        const n = graph.map.get(e[side].cell),
          uid = graph.rootOf.get(n.id),
          u = graph.unitMap.get(uid),
          p = portPoint(n, e[side].port, side === 'source' ? 'right' : 'left');
        const y = Math.max(
            1,
            Math.min(Math.ceil(u.height) - 1, Math.round(p.y - u.box.y)),
          ),
          direction = side === 'source' ? 'right' : 'left',
          key = direction + ':' + y;
        if (!slots.get(uid).has(key))
          slots
            .get(uid)
            .set(key, { name: 'p' + slots.get(uid).size, y, direction });
        endpoint.set(e.id + ':' + side, slots.get(uid).get(key));
      }
    function label(u) {
      const ps = [...slots.get(u.id).values()],
        ys = [...new Set(ps.map((p) => p.y))].sort((a, b) => a - b);
      let rows = '',
        y = 0;
      for (const py of ys) {
        const gap = py - 1 - y;
        if (gap > 0) rows += `<TR><TD HEIGHT="${gap}"></TD><TD></TD></TR>`;
        const l = ps.find((p) => p.direction === 'left' && p.y === py),
          r = ps.find((p) => p.direction === 'right' && p.y === py);
        rows += `<TR><TD ${l ? `PORT="${l.name}"` : ''} HEIGHT="2"></TD><TD ${r ? `PORT="${r.name}"` : ''}></TD></TR>`;
        y = py + 1;
      }
      if (y < u.height)
        rows += `<TR><TD HEIGHT="${Math.ceil(u.height - y)}"></TD><TD></TD></TR>`;
      return `<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0" FIXEDSIZE="TRUE" WIDTH="${Math.ceil(u.width)}" HEIGHT="${Math.ceil(u.height)}">${rows}</TABLE>>`;
    }
    const es = m.edges
      .map((e) => ({
        ...e,
        from: graph.rootOf.get(e.source.cell),
        to: graph.rootOf.get(e.target.cell),
        sourceKey: e.source.cell + ':' + e.source.port,
      }))
      .filter((e) => e.from !== e.to)
      .sort(
        (a, b) =>
          a.from.localeCompare(b.from) ||
          endpoint.get(a.id + ':source').y - endpoint.get(b.id + ':source').y ||
          a.id.localeCompare(b.id),
      );
    const groups = structuralGroups(units, es),
      grouped = new Map();
    for (const u of units) {
      const key = groups.get(u.id);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(u);
    }
    const lines = [
      'digraph G {',
      'graph [rankdir=LR,nodesep=.45,ranksep=1.15,pad=0,margin=0,newrank=true,compound=true,splines=false];',
      'node [shape=plain,margin=0,fontsize=1,ordering=out];',
    ];
    for (const [i, list] of [...grouped.values()].entries()) {
      if (grouped.size > 1)
        lines.push(`subgraph cluster_${i} { label=""; margin=70;`);
      for (const u of list)
        lines.push(`${names.get(u.id)} [label=${label(u)}];`);
      if (grouped.size > 1) lines.push('}');
    }
    const outgoing = new Map(units.map((u) => [u.id, []])),
      incoming = new Map(units.map((u) => [u.id, 0]));
    for (const e of es) {
      outgoing.get(e.from).push(e);
      incoming.set(e.to, incoming.get(e.to) + 1);
    }
    for (const e of es)
      lines.push(
        `${names.get(e.from)}:${endpoint.get(e.id + ':source').name}:e -> ${names.get(e.to)}:${endpoint.get(e.id + ':target').name}:w [minlen=${outgoing.get(e.from).length > 3 ? 3 : 1}];`,
      );
    for (const list of outgoing.values()) {
      const targets = [...new Set(list.map((e) => e.to))].filter(
        (id) => incoming.get(id) === 1,
      );
      if (targets.length < 2 || new Set(list.map((e) => e.sourceKey)).size < 2)
        continue;
      lines.push(
        `{ rank=same; ${targets.map((id) => names.get(id)).join('; ')}; }`,
      );
      for (let i = 1; i < targets.length; i++)
        lines.push(
          `${names.get(targets[i - 1])} -> ${names.get(targets[i])} [style=invis,weight=1000];`,
        );
    }
    lines.push('}');
    let out;
    try {
      out = runtime.renderJSON(lines.join('\n'), { engine: 'dot' });
    } catch (error) {
      throw invalidLayout(`布局引擎无法处理当前图：${error.message}`);
    }
    const objects = new Map(
        (out.objects ?? []).filter((o) => o.pos).map((o) => [o.name, o]),
      ),
      bb = (out.bb ?? '0,0,0,0').split(',').map(Number);
    m.nodes = [];
    for (const u of units) {
      const o = objects.get(names.get(u.id));
      if (!o) throw invalidLayout(`布局引擎未返回节点 [${u.id}]`);
      const [x, y] = o.pos.split(',').map(Number),
        ox = Math.round(x - u.width / 2),
        oy = Math.round(bb[3] - y - u.height / 2);
      for (const n of u.members) {
        const offset = u.offsets.get(n.id);
        m.nodes.push({
          ...n,
          position: { x: ox + offset.x, y: oy + offset.y },
        });
      }
    }
    m.branchAdjustments = orderBranchRoots(graph, m);
    const b = boxOf(m.nodes);
    for (const n of m.nodes)
      n.position = { x: n.position.x - b.x, y: n.position.y - b.y };
    m.width = b.width;
    m.height = b.height;
    m.x = 0;
    m.y = 0;
    m.groups = [...grouped.values()].map((list) =>
      list.flatMap((u) => u.members.map((n) => n.id)),
    );
  }
  return `Graphviz dot ${runtime.graphvizVersion}`;
}
