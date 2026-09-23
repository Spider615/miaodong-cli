// 给人看的改动清单：用户问「你改了啥」时直接贴这个（会话里这类追问每会话约 3.5 次）。
// 口径与合并一致：节点按 id，连线按端点；坐标 / 尺寸变化不算改动，只计数。
// 长文本（prompt）按行比，只显示改动行和前后各 1 行；类型突变（数组 → 对象）单独标出来。

import { contentKey, edgeMap, isVisualOnlyCell, nodeMap, stableStringify, stripLayout } from './canvas.mjs';
import { nodeName, nodeType } from './graph.mjs';
import { shortId } from './output.mjs';

export const kindOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

export function fieldChanges(a, b, path = '', list = []) {
  if (a === undefined || b === undefined) {
    if (a !== b) list.push({ path, kind: a === undefined ? 'added' : 'removed', before: a, after: b });
    return list;
  }
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) {
    // 只有数组 ↔ 对象才是「改坏了」的信号（老懂 setByPath 的 bug 就是这样）；
    // null / 标量与结构互换可能是有意的（给空字段填配置），只标出来提醒
    const container = (k) => k === 'array' || k === 'object';
    const flipped = (ka === 'array' && kb === 'object') || (ka === 'object' && kb === 'array');
    list.push({ path, kind: flipped ? 'typechange' : container(ka) || container(kb) ? 'reshape' : 'value', before: a, after: b });
    return list;
  }
  if (ka === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) fieldChanges(a[key], b[key], path ? `${path}.${key}` : key, list);
    return list;
  }
  if (ka === 'array') {
    if (stableStringify(a) === stableStringify(b)) return list;
    for (let i = 0; i < Math.max(a.length, b.length); i++) fieldChanges(a[i], b[i], `${path}[${i}]`, list);
    return list;
  }
  if (a !== b) {
    const long = typeof a === 'string' && typeof b === 'string' && (a.includes('\n') || b.includes('\n') || a.length > 80 || b.length > 80);
    list.push({ path, kind: long ? 'text' : 'value', before: a, after: b });
  }
  return list;
}

export function diffEnvelopes(base, after) {
  const a = nodeMap(base.canvas);
  const b = nodeMap(after.canvas);
  const added = [];
  const removed = [];
  const changed = [];
  let layoutOnly = 0;
  for (const [id, cell] of b) if (!a.has(id)) added.push(cell);
  for (const [id, cell] of a) {
    const next = b.get(id);
    if (!next) {
      removed.push(cell);
      continue;
    }
    if (contentKey(cell) === contentKey(next)) {
      if (stableStringify(cell) !== stableStringify(next)) layoutOnly++;
      continue;
    }
    changed.push({ id, name: nodeName(next), type: nodeType(next), decoration: isVisualOnlyCell(next), fields: fieldChanges(stripLayout(cell), stripLayout(next)) });
  }
  const ea = edgeMap(base.canvas);
  const eb = edgeMap(after.canvas);
  const edgesAdded = [...eb.keys()].filter((key) => !ea.has(key));
  const edgesRemoved = [...ea.keys()].filter((key) => !eb.has(key));
  const empty = !added.length && !removed.length && !changed.length && !edgesAdded.length && !edgesRemoved.length;
  return { added, removed, changed, edgesAdded, edgesRemoved, layoutOnly, empty };
}

export function lineDiff(before, after, context = 1) {
  const x = before.split('\n');
  const y = after.split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000) return [`- （原文 ${n} 行）`, `+ （新文 ${m} 行，太长不逐行比）`];
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { ops.push([' ', x[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push(['-', x[i]]); i++; }
    else { ops.push(['+', y[j]]); j++; }
  }
  while (i < n) ops.push(['-', x[i++]]);
  while (j < m) ops.push(['+', y[j++]]);
  const keep = ops.map((op, k) => op[0] !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o[0] !== ' '));
  const lines = [];
  let skipped = false;
  ops.forEach((op, k) => {
    if (keep[k]) {
      lines.push(`${op[0]} ${op[1]}`);
      skipped = false;
    } else if (!skipped) {
      lines.push('  …');
      skipped = true;
    }
  });
  return lines;
}

export function nameMapOf(...canvases) {
  const names = new Map();
  for (const canvas of canvases) for (const [id, cell] of nodeMap(canvas)) names.set(id, nodeName(cell));
  return names;
}

function brief(value) {
  if (value === undefined) return '（无）';
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function edgeLabel(key, names) {
  const [from, to] = key.split('->');
  const nodeLabel = (part) => {
    const id = part.split('#')[0];
    return `${names.get(id) ?? '?'} [${shortId(id)}]`;
  };
  return `${nodeLabel(from)} → ${nodeLabel(to)}`;
}

export function renderDiff(d, { names = new Map(), limit = 400 } = {}) {
  if (d.empty) return [`没有内容改动${d.layoutOnly ? `（只有 ${d.layoutOnly} 个节点挪了位置）` : ''}`];
  const lines = [
    `新增节点 ${d.added.length} · 删除节点 ${d.removed.length} · 改动节点 ${d.changed.length} · 新增连线 ${d.edgesAdded.length} · 删除连线 ${d.edgesRemoved.length}${d.layoutOnly ? ` · 仅挪位置 ${d.layoutOnly}` : ''}`,
  ];
  for (const cell of d.added) lines.push(`+ 新增 ${nodeName(cell)} (${nodeType(cell)}) [${shortId(cell.id)}]`);
  for (const cell of d.removed) lines.push(`- 删除 ${nodeName(cell)} (${nodeType(cell)}) [${shortId(cell.id)}]`);
  for (const nodeChange of d.changed) {
    lines.push(`~ ${nodeChange.name} (${nodeChange.type}) [${shortId(nodeChange.id)}]`);
    for (const field of nodeChange.fields) {
      if (field.kind === 'text') {
        lines.push(`    ${field.path}（文本 ${field.before.length} → ${field.after.length} 字）：`);
        for (const line of lineDiff(field.before, field.after)) lines.push(`      ${line}`);
      } else if (field.kind === 'typechange' || field.kind === 'reshape') {
        lines.push(`    ⚠️ ${field.path}：类型从 ${kindOf(field.before)} 变成 ${kindOf(field.after)}`);
      } else {
        lines.push(`    ${field.path}：${brief(field.before)} → ${brief(field.after)}`);
      }
    }
  }
  for (const key of d.edgesAdded) lines.push(`+ 连线 ${edgeLabel(key, names)}`);
  for (const key of d.edgesRemoved) lines.push(`- 连线 ${edgeLabel(key, names)}`);
  if (lines.length > limit) return [...lines.slice(0, limit), `…（共 ${lines.length} 行，已截断；--limit 调大，或 --json 看全部）`];
  return lines;
}

export function diffToJson(d) {
  const brief2 = (cell) => ({ id: cell.id, name: nodeName(cell), type: nodeType(cell) });
  return { added: d.added.map(brief2), removed: d.removed.map(brief2), changed: d.changed, edgesAdded: d.edgesAdded, edgesRemoved: d.edgesRemoved, layoutOnly: d.layoutOnly };
}
