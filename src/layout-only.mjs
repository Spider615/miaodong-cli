// 布局推送独立于内容合并：本地只许修改 position / vertices，写入以最新草稿为底。
// 布局依赖节点尺寸、端口和拓扑；这些输入或坐标发生并发变化时必须重新计算。
import { EXIT, MdError } from './errors.mjs';
import { isEdgeCell, stableStringify } from './canvas.mjs';

const same = (a, b) => stableStringify(a) === stableStringify(b);
const blocked = (message) =>
  new MdError('layout_blocked', message, {
    exitCode: EXIT.BLOCKED,
    hint: '重新 md pull，基于最新草稿计算布局后再预演',
  });
const field = (cell) => (isEdgeCell(cell) ? 'vertices' : 'position');
const withoutGeometry = (cell) => {
  const copy = { ...cell };
  delete copy[field(cell)];
  return copy;
};
const nodeDependencies = (cell) => ({
  shape: cell.shape,
  size: cell.size,
  ports: cell.ports,
  parent: cell.parent,
  children: cell.children,
  loop: cell.data?.parentLoopBodyNodeId,
  type: cell.data?.type,
  eventId: cell.data?.nodePayload?.eventId ?? cell.data?.eventItem?.eventId,
});
const edgeDependencies = (cell) => ({
  shape: cell.shape,
  source: cell.source,
  target: cell.target,
  connector: cell.connector,
  router: cell.router,
});
const point = (p) =>
  p &&
  typeof p === 'object' &&
  !Array.isArray(p) &&
  Object.keys(p).every((k) => k === 'x' || k === 'y') &&
  Number.isFinite(p.x) &&
  Number.isFinite(p.y);

export function layoutChanges(base, after) {
  if (base.length !== after.length) throw blocked('仅布局模式不能增删画布元素');
  const changes = { nodes: [], edges: [] };
  for (let i = 0; i < base.length; i++) {
    const b = base[i],
      a = after[i];
    if (
      !b?.id ||
      b.id !== a?.id ||
      !same(withoutGeometry(b), withoutGeometry(a))
    )
      throw blocked(
        `仅布局模式不能修改业务配置、尺寸、端口或结构 [${b?.id ?? '?'}]`,
      );
    const key = field(a);
    if (same(b[key], a[key])) continue;
    if (
      key === 'position'
        ? !point(a[key])
        : a[key] !== undefined &&
          (!Array.isArray(a[key]) || !a[key].every(point))
    )
      throw blocked(`布局坐标无效 [${a.id}]`);
    changes[key === 'position' ? 'nodes' : 'edges'].push(a.id);
  }
  return changes;
}

export function mergeLayoutOnly(base, after, live) {
  const changes = layoutChanges(base, after);
  const current = new Map(live.map((c) => [c.id, c]));
  if (current.size !== live.length || current.size !== base.length)
    throw blocked('草稿的节点或连线数量发生变化，旧布局需要重新计算');
  const desired = new Map(after.map((c) => [c.id, c]));
  for (const b of base) {
    const t = current.get(b.id),
      a = desired.get(b.id);
    const dependency = isEdgeCell(b) ? edgeDependencies : nodeDependencies;
    if (!t || !same(dependency(b), dependency(t)))
      throw blocked(`草稿的布局依赖发生变化 [${b.id}]：尺寸、端口或连接已改变`);
    const key = field(b);
    if (!same(t[key], b[key]) && !same(t[key], a[key]))
      throw blocked(`草稿的布局坐标发生变化 [${b.id}]，不能覆盖他人的排版`);
  }
  const touched = new Set([...changes.nodes, ...changes.edges]);
  const canvas = live.map((t) => {
    if (!touched.has(t.id)) return t;
    const a = desired.get(t.id),
      key = field(t),
      copy = { ...t };
    if (Object.hasOwn(a, key)) copy[key] = structuredClone(a[key]);
    else delete copy[key];
    return copy;
  });
  return { canvas, changes, noop: same(canvas, live) };
}

export function verifyLayoutReadback(expected, actual) {
  const a = new Map(actual.map((c) => [c.id, c])),
    e = new Map(expected.map((c) => [c.id, c]));
  const problems = [];
  if (
    a.size !== actual.length ||
    a.size !== e.size ||
    [...a.keys()].some((id) => !e.has(id))
  )
    problems.push('布局回读的元素 ID 或数量不一致');
  for (const id of e.keys()) {
    const want = e.get(id),
      got = a.get(id);
    const dependencies = isEdgeCell(want) ? edgeDependencies : nodeDependencies;
    if (
      !got ||
      !same(want[field(want)], got[field(want)]) ||
      !same(dependencies(want), dependencies(got))
    )
      problems.push(`布局回读不一致 [${id}]`);
  }
  return problems;
}
