// 会话属性定义的纯逻辑：认会话属性（id、id 前缀、名字）、画布里哪些节点在用、规范化列表（算计划码用）。
// 画布按 id 引用会话属性：输入的 sessionMemoryItemId、规则中心条件的 field / value、写字段节点的 fieldId……（09-30 在
// 181fc177 的真实画布上数过，527 个节点、11 种字段路径）。字段路径会变，这里不挑字段：节点里任何一个等于会话属性 id 的字符串都算在用

import { EXIT, MdError } from './errors.mjs';
import { isEdgeCell } from './canvas.mjs';
import { shortId } from './output.mjs';

// 控制台新建、修改只给这三种；真实智能体上自定义的也只见过这三种（系统默认的还有 array、tag、datetime）
export const VAR_TYPES = ['string', 'number', 'boolean'];

export const normalizeVar = (v) => ({ id: String(v?.id ?? ''), name: String(v?.name ?? ''), type: String(v?.type?.type ?? v?.type ?? ''), description: String(v?.description ?? ''), isDefault: v?.isDefault === true });

// 名字、完整 id、id 前缀（至少 4 位）都认；必须正好一个
export function resolveVar(list, query) {
  const q = String(query ?? '').trim();
  const exact = list.filter((v) => v.id === q);
  const byPrefix = exact.length ? exact : /^[0-9a-f-]{4,}$/i.test(q) ? list.filter((v) => v.id.startsWith(q)) : [];
  const hits = byPrefix.length ? byPrefix : list.filter((v) => v.name === q);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new MdError('var_not_found', `没有会话属性「${q}」`, { exitCode: EXIT.TARGET, hint: 'md vars --bot <智能体> 看有哪些' });
  throw new MdError('var_ambiguous', `「${q}」有 ${hits.length} 个同名：${hits.map((v) => shortId(v.id)).join('、')}`, { exitCode: EXIT.TARGET, hint: '用 id（或 id 前缀）指定' });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// 会话属性 id → 在用它的节点 [{id, name}]
export function varUsage(canvas) {
  const usage = new Map();
  for (const cell of Array.isArray(canvas) ? canvas : []) {
    if (!cell || typeof cell !== 'object' || isEdgeCell(cell)) continue;
    const ids = new Set(JSON.stringify(cell).match(UUID) ?? []);
    for (const id of ids) {
      if (id === cell.id) continue;
      usage.set(id, [...(usage.get(id) ?? []), { id: String(cell.id), name: String(cell.data?.name ?? cell.id) }]);
    }
  }
  return usage;
}
