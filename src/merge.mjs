// 元素级三方合并：merge(拉取时的基线, 我的改后, 当前草稿)。
// 为什么不用老懂的 planContentPublish：它只处理「纯内容改动」、按整个 node.data 判冲突、不搬结构改动；
// 这里一条路径同时覆盖内容与结构。规则：
//   节点按 id：只有我改 → 用我的内容（位置 / 尺寸沿用草稿）；只有别人改 → 用别人的；
//              双方都改且结果不同 → 冲突；删除与修改撞上 → 冲突。
//   连线按「源#端口→目标#端口」（重复的按先后编号，见 canvas.mjs 的 keyedEdges）：结果 = 草稿的连线 − 我删的 + 我加的。
//   合并后有连线端点不存在 → 冲突（例如我连到的节点被别人删了）。
// 输出顺序以草稿为骨架，我新增的元素追加在后面，尽量不打乱编辑器里的层级。

import { LAYOUT_KEYS, contentKey, edgeKey, edgeMap, isEdgeCell, keyedEdges, nodeMap, stableStringify } from './canvas.mjs';
import { nodeName } from './graph.mjs';

function withLayoutFrom(ours, theirs) {
  if (!theirs) return ours;
  const copy = { ...ours };
  for (const key of LAYOUT_KEYS) {
    if (key in theirs) copy[key] = theirs[key];
    else delete copy[key];
  }
  return copy;
}

export function mergeCanvas(baseCanvas, oursCanvas, theirsCanvas) {
  const B = nodeMap(baseCanvas);
  const O = nodeMap(oursCanvas);
  const T = nodeMap(theirsCanvas);
  const keyOf = (cell) => (cell ? contentKey(cell) : null);
  const conflicts = [];
  const result = new Map();
  const ours = { changed: [], added: [], removed: [] };
  const theirs = { changed: 0, added: 0, removed: 0 };

  for (const id of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(id);
    const o = O.get(id);
    const t = T.get(id);
    const oursChanged = keyOf(o) !== keyOf(b);
    const theirsChanged = keyOf(t) !== keyOf(b);
    if (oursChanged) (b ? (o ? ours.changed : ours.removed) : ours.added).push(id);
    if (theirsChanged) {
      if (!b) theirs.added++;
      else if (!t) theirs.removed++;
      else theirs.changed++;
    }
    if (!oursChanged) {
      result.set(id, t ?? null);
    } else if (!theirsChanged) {
      result.set(id, o ? withLayoutFrom(o, t) : null);
    } else if (keyOf(o) === keyOf(t)) {
      result.set(id, t ?? null);
    } else {
      const reason = !o ? '你删了这个节点，但草稿里它被别人改了'
        : !t ? '你改了这个节点，但草稿里它被别人删了'
          : b ? '你和别人都改了这个节点'
            : '双方新增了同 id 的节点';
      conflicts.push({ id, name: nodeName(o ?? t ?? b), reason });
      result.set(id, t ?? null);
    }
  }

  const EB = edgeMap(baseCanvas);
  const EO = edgeMap(oursCanvas);
  const ET = edgeMap(theirsCanvas);
  const ourRemovedEdges = new Set([...EB.keys()].filter((key) => !EO.has(key)));
  const keptEdges = new Map([...ET].filter(([key]) => !ourRemovedEdges.has(key)));
  for (const [key, edge] of EO) if (!EB.has(key) && !keptEdges.has(key)) keptEdges.set(key, edge);

  const merged = [];
  const emittedNodes = new Set();
  const emittedEdges = new Set();
  // 每张画布按它自己的先后给重复连线编号：同一个连线对象可能同时在两张画布里、编号不同
  const keysIn = (canvas) => new Map(keyedEdges(canvas).map(([key, edge]) => [edge, key]));
  const emit = (keys) => (cell) => {
    if (!cell || typeof cell !== 'object') return;
    if (isEdgeCell(cell)) {
      const key = keys.get(cell);
      if (keptEdges.has(key) && !emittedEdges.has(key)) {
        merged.push(keptEdges.get(key));
        emittedEdges.add(key);
      }
      return;
    }
    if (typeof cell.id !== 'string') return;
    const chosen = result.get(cell.id);
    if (chosen && !emittedNodes.has(cell.id)) {
      merged.push(chosen);
      emittedNodes.add(cell.id);
    }
  };
  theirsCanvas.forEach(emit(keysIn(theirsCanvas)));
  oursCanvas.forEach(emit(keysIn(oursCanvas)));

  const ids = new Set(merged.filter((c) => !isEdgeCell(c)).map((c) => c.id));
  for (const edge of merged.filter((c) => isEdgeCell(c))) {
    if (!ids.has(edge.source?.cell) || !ids.has(edge.target?.cell)) {
      conflicts.push({ id: edgeKey(edge), name: '连线', reason: '合并后这条连线的端点节点不存在（你和别人分别删了节点或连线）' });
    }
  }

  return { canvas: merged, conflicts, ours, theirs, noop: stableStringify(merged) === stableStringify(theirsCanvas) };
}
