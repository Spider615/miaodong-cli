// 画布比较的公共口径（diff / 合并 / 回读核对都用它，口径不一致就会出现「预演说没改、推上去却变了」）。
// 「内容」= 节点除 position / size / zIndex 以外的全部字段：拖动节点不算改动——
// 秒懂编辑页打开时就可能重排坐标并自动保存，把坐标算进去会让合并天天冲突。
// 连线按「源节点#端口→目标节点#端口」识别，不看 edge.id。

import { createHash } from 'node:crypto';
import { EXIT, MdError } from './errors.mjs';
import { isEdgeCell, isVisualOnlyCell } from '../vendor/laodong/apps/api/lib/miaodong/canvas-derive.ts';
import { stableStringify } from '../vendor/laodong/apps/api/lib/miaodong/canvas-content-patch.ts';

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

// 节点名称最多 20 个 Unicode 字符（中文、英文、数字、符号都计数），不按 UTF-16 码元计数。
// 连线、便签等视觉装饰不属于业务节点；不自动截断名称，以免改成重名。
export function nodeNameProblems(canvas) {
  const problems = [];
  for (const cell of canvas) {
    if (!isElement(cell) || isEdgeCell(cell) || isVisualOnlyCell(cell) || typeof cell.data?.name !== 'string') continue;
    const length = [...cell.data.name].length;
    if (length > 20) problems.push(`节点「${cell.data.name}」[${String(cell.id ?? '?').slice(0, 8)}] 的名称有 ${length} 个字，超过 20 个字上限`);
  }
  return problems;
}

export function assertNodeNames(canvas) {
  const problems = nodeNameProblems(canvas);
  if (problems.length) throw new MdError('node_name_too_long', `节点名称长度检查不通过：\n${problems.map((p) => `  - ${p}`).join('\n')}`, {
    exitCode: EXIT.BLOCKED, hint: '先将节点名称缩短到 20 个字以内，再 md check；--allow-check-errors 和确认码不能跳过名称限制',
  });
}

export function nodeMap(canvas) {
  return new Map(canvas.filter((c) => isElement(c) && !isEdgeCell(c) && typeof c.id === 'string').map((c) => [c.id, c]));
}

// 连线按「源#端口→目标#端口」认（秒懂保存时连线 id 不稳）。两端和端口都一样的重复连线按在画布里的先后编号，
// 第二条起加 @2、@3…：只按两端建表时后一条会盖掉前一条，合并、比较时重复的连线被悄悄并成一条（合并后推送就少了一条）
export function keyedEdges(canvas) {
  const seen = new Map();
  return canvas.filter((c) => isElement(c) && isEdgeCell(c)).map((e) => {
    const key = edgeKey(e);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return [n === 1 ? key : `${key}@${n}`, e];
  });
}

export function edgeMap(canvas) {
  return new Map(keyedEdges(canvas));
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
