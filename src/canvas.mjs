// 画布比较的公共口径（diff / 合并 / 回读核对都用它，口径不一致就会出现「预演说没改、推上去却变了」）。
// 「内容」= 节点除 position / size / zIndex 以外的全部字段：拖动节点不算改动——
// 秒懂编辑页打开时就可能重排坐标并自动保存，把坐标算进去会让合并天天冲突。
// 连线按「源节点#端口→目标节点#端口」识别，不看 edge.id。

import { createHash } from 'node:crypto';
import { isEdgeCell, isVisualOnlyCell } from '../../apps/api/lib/miaodong/canvas-derive.ts';
import { stableStringify } from '../../apps/api/lib/miaodong/canvas-content-patch.ts';

export { isEdgeCell, isVisualOnlyCell, stableStringify };

export const LAYOUT_KEYS = ['position', 'size', 'zIndex'];

export function hashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

export function stripLayout(cell) {
  const rest = { ...(cell ?? {}) };
  for (const key of LAYOUT_KEYS) delete rest[key];
  return rest;
}

export function contentKey(cell) {
  return stableStringify(stripLayout(cell));
}

export function edgeKey(edge) {
  return `${edge?.source?.cell ?? ''}#${edge?.source?.port ?? ''}->${edge?.target?.cell ?? ''}#${edge?.target?.port ?? ''}`;
}

const isElement = (cell) => Boolean(cell) && typeof cell === 'object';

export function nodeMap(canvas) {
  return new Map(canvas.filter((c) => isElement(c) && !isEdgeCell(c) && typeof c.id === 'string').map((c) => [c.id, c]));
}

export function edgeMap(canvas) {
  return new Map(canvas.filter((c) => isElement(c) && isEdgeCell(c)).map((e) => [edgeKey(e), e]));
}

export function compareNodes(aCanvas, bCanvas) {
  const a = nodeMap(aCanvas);
  const b = nodeMap(bCanvas);
  let onlyA = 0;
  let onlyB = 0;
  let changed = 0;
  for (const [id, cell] of a) {
    if (!b.has(id)) onlyA++;
    else if (contentKey(cell) !== contentKey(b.get(id))) changed++;
  }
  for (const id of b.keys()) if (!a.has(id)) onlyB++;
  const ea = edgeMap(aCanvas);
  const eb = edgeMap(bCanvas);
  let edgesDiffer = 0;
  for (const key of ea.keys()) if (!eb.has(key)) edgesDiffer++;
  for (const key of eb.keys()) if (!ea.has(key)) edgesDiffer++;
  return { onlyA, onlyB, changed, edgesDiffer, same: onlyA + onlyB + changed + edgesDiffer === 0 };
}
