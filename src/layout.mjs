import { hashOf, isEdgeCell } from './canvas.mjs';
import { layoutChanges } from './layout-only.mjs';
import { layoutGraph } from './layout-graph.mjs';
import { dotModules } from './layout-dot.mjs';
import { eventDistances, placeModules } from './layout-events.mjs';
import { geometryReport, invalidLayout } from './layout-geometry.mjs';

export async function optimizeLayout(input) {
  const graph = layoutGraph(input),
    engine = graph.nodes.length ? await dotModules(graph) : 'Graphviz dot';
  const { positions, crossLinks, moves } = placeModules(graph);
  const canvas = input.canvas.map((c) => {
    if (!isEdgeCell(c))
      return { ...structuredClone(c), position: positions.get(c.id) };
    const edge = structuredClone(c);
    delete edge.vertices;
    return edge;
  });
  const envelope = { ...structuredClone(input), canvas },
    changes = layoutChanges(input.canvas, canvas);
  const before = geometryReport(input.canvas, graph.parent),
    after = geometryReport(canvas, graph.parent);
  // Internal container positions are deliberately retained. All other node overlap must disappear.
  const unitOf = (id) => graph.rootOf.get(id),
    byId = new Map(canvas.filter((c) => !isEdgeCell(c)).map((c) => [c.id, c]));
  if (after.overlapPairs) {
    const nodes = [...byId.values()];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i],
          b = nodes[j];
        if (unitOf(a.id) === unitOf(b.id)) continue;
        if (
          a.position.x < b.position.x + b.size.width &&
          a.position.x + a.size.width > b.position.x &&
          a.position.y < b.position.y + b.size.height &&
          a.position.y + a.size.height > b.position.y
        )
          throw invalidLayout('布局仍存在跨区域节点重叠，未应用');
      }
  }
  return {
    envelope,
    report: {
      engine,
      inputHash: hashOf(input.canvas),
      outputHash: hashOf(canvas),
      changes,
      before,
      after,
      eventLinks: graph.eventLinks,
      unmatchedEventActions: graph.unmatchedEventActions,
      eventDistances: {
        before: eventDistances(input.canvas, crossLinks),
        after: eventDistances(canvas, crossLinks),
      },
      components: graph.modules.length,
      containerUnits: graph.units.filter((u) => u.members.length > 1).length,
      moves,
      geometryApproximation:
        'custom-curve sampled at 32 segments; other connectors approximated by straight lines',
      zones: graph.modules.map((m) => ({
        ids: m.nodes.map((n) => n.id),
        name:
          m.nodes.find((n) => n.data?.category === 'trigger')?.data?.name ??
          m.nodes[0]?.data?.name ??
          '独立区域',
      })),
    },
  };
}
