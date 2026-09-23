// 改动脚本：AI 写一个 .mjs，默认导出 (ctx) => void，在 ctx.canvas 上改；md 负责守卫和记录。
// 为什么用脚本而不是直接改 JSON 或写 ops 清单：同一套修改要在 v400 / v401 / 另一个智能体上各做一遍
// （会话里真实发生过），脚本表达的是「规则」，能在新基线上重跑；按节点 id 记的 ops 换个版本就会漏掉新冒出来的同类节点。
// 所有 helper 都「宁可报错也不猜」：锚点命中次数不对、路径不存在、数量不符都直接失败。
// 路径支持 a[0].b 与 a.0.b；绝不把数组改成对象（老懂 workflow-patch 的 setByPath 有这个 bug）。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, MdError, usage } from './errors.mjs';
import { isEdgeCell, stableStringify } from './canvas.mjs';
import { businessNodes, edgesOf, nodeName, resolveNode } from './graph.mjs';

export class TransformError extends MdError {
  constructor(message) {
    super('transform_failed', message, { exitCode: EXIT.ERROR });
  }
}

export function parsePath(path) {
  const tokens = [];
  for (const part of String(path).split('.')) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let match;
    while ((match = re.exec(part))) tokens.push(match[2] !== undefined ? Number(match[2]) : match[1]);
  }
  if (tokens.length === 0) throw new TransformError(`路径为空：${path}`);
  return tokens;
}

function stepInto(container, token, path) {
  if (Array.isArray(container)) {
    const index = typeof token === 'number' ? token : /^\d+$/.test(token) ? Number(token) : Number.NaN;
    if (!Number.isInteger(index)) throw new TransformError(`路径 ${path}：这一层是数组，要用下标`);
    return { key: index, exists: index < container.length };
  }
  if (container && typeof container === 'object') {
    const key = String(token);
    return { key, exists: Object.prototype.hasOwnProperty.call(container, key) };
  }
  throw new TransformError(`路径 ${path}：中途遇到的不是对象或数组`);
}

export function getPath(obj, path) {
  let current = obj;
  for (const token of parsePath(path)) {
    const { key, exists } = stepInto(current, token, path);
    if (!exists) throw new TransformError(`路径不存在：${path}`);
    current = current[key];
  }
  return current;
}

export function setPath(obj, path, value) {
  const tokens = parsePath(path);
  let current = obj;
  for (const token of tokens.slice(0, -1)) {
    const { key, exists } = stepInto(current, token, path);
    if (!exists) throw new TransformError(`路径不存在：${path}`);
    current = current[key];
  }
  const { key } = stepInto(current, tokens[tokens.length - 1], path);
  if (Array.isArray(current) && key > current.length) throw new TransformError(`路径 ${path}：数组下标越界`);
  current[key] = value;
}

function countOccurrences(text, find) {
  if (!find) throw new TransformError('查找内容不能为空');
  let count = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) count++;
  return count;
}

function preview(text) {
  const flat = String(text).replace(/\s+/g, ' ');
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat;
}

export function createHelpers(ctx, log) {
  const label = (node) => `${nodeName(node)} [${String(node.id).slice(0, 8)}]`;
  const textAt = (node, path) => {
    const value = getPath(node, path);
    if (typeof value !== 'string') throw new TransformError(`${label(node)} 的 ${path} 不是文本`);
    return value;
  };
  const removeWhere = (pred) => {
    let removed = 0;
    for (let i = ctx.canvas.length - 1; i >= 0; i--) {
      if (pred(ctx.canvas[i])) {
        ctx.canvas.splice(i, 1);
        removed++;
      }
    }
    return removed;
  };
  const isEdge = (cell) => Boolean(cell) && typeof cell === 'object' && isEdgeCell(cell);

  const h = {
    nodes: () => businessNodes(ctx.canvas),
    edges: () => edgesOf(ctx.canvas),
    select: (pred) => businessNodes(ctx.canvas).filter(pred),
    node: (query) => resolveNode(ctx.canvas, query),
    name: (node) => nodeName(node),
    get: (node, path) => getPath(node, path),
    has(node, path) {
      try {
        getPath(node, path);
        return true;
      } catch {
        return false;
      }
    },
    set(node, path, value) {
      setPath(node, path, value);
      log.push(`改 ${label(node)} 的 ${path}`);
    },
    replaceOnce(node, path, find, replacement) {
      const text = textAt(node, path);
      const count = countOccurrences(text, find);
      if (count !== 1) throw new TransformError(`${label(node)} 的 ${path} 里「${preview(find)}」出现 ${count} 次，replaceOnce 要求恰好 1 次`);
      setPath(node, path, text.replace(find, () => replacement));
      log.push(`替换 ${label(node)} 的 ${path}`);
    },
    replaceAll(node, path, find, replacement, { expect } = {}) {
      const text = textAt(node, path);
      const count = countOccurrences(text, find);
      if (expect !== undefined && count !== expect) throw new TransformError(`${label(node)} 的 ${path} 里「${preview(find)}」出现 ${count} 次，预期 ${expect} 次`);
      if (count > 0) setPath(node, path, text.split(find).join(replacement));
      log.push(`替换 ${label(node)} 的 ${path} ×${count}`);
      return count;
    },
    insertAfter(node, path, anchor, insertion) {
      h.replaceOnce(node, path, anchor, anchor + insertion);
    },
    insertBefore(node, path, anchor, insertion) {
      h.replaceOnce(node, path, anchor, insertion + anchor);
    },
    expectCount(list, count, what = '选中的节点') {
      if (list.length !== count) throw new TransformError(`${what}有 ${list.length} 个，预期 ${count} 个`);
      return list;
    },
    retargetRefs({ from, to, fromDataPath, toDataPath, expect }) {
      // from 缺省时 `referenceNodeId === undefined` 会命中所有对象，把全图写坏；必须显式给两个不同的 id
      if (typeof from !== 'string' || !from) throw new TransformError('retargetRefs 需要 from（原来被引用的节点 id）');
      if (typeof to !== 'string' || !to) throw new TransformError('retargetRefs 需要 to（改为引用的节点 id）');
      if (from === to) throw new TransformError('retargetRefs 的 from 和 to 不能相同');
      let count = 0;
      let skipped = 0;
      const walk = (value, apply) => {
        if (Array.isArray(value)) {
          value.forEach((item) => walk(item, apply));
          return;
        }
        if (!value || typeof value !== 'object') return;
        if (value.referenceNodeId === from && (fromDataPath === undefined || value.dataPath === fromDataPath)) {
          if (apply) {
            value.referenceNodeId = to;
            if (toDataPath !== undefined) value.dataPath = toDataPath;
            count++;
          } else {
            skipped++;
          }
        }
        for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, apply);
      };
      // 目标节点自己对 from 的引用不改：否则它会引用自己（典型场景：把节点挪到 from 后面，它本来就该继续读 from）
      for (const node of businessNodes(ctx.canvas)) walk(node.data, node.id !== to);
      if (expect !== undefined && count !== expect) {
        throw new TransformError(`把引用从 ${from.slice(0, 8)} 改到 ${to.slice(0, 8)}：命中 ${count} 处，预期 ${expect} 处`);
      }
      log.push(`改引用 ${from.slice(0, 8)} → ${to.slice(0, 8)} ×${count}${skipped ? `（跳过目标节点自身 ${skipped} 处）` : ''}`);
      return count;
    },
    cloneNode(query, { name, offset = { x: 40, y: 40 } } = {}) {
      const source = resolveNode(ctx.canvas, query);
      const copy = JSON.parse(JSON.stringify(source));
      copy.id = randomUUID();
      for (const port of copy.ports?.items ?? []) port.id = randomUUID();
      if (copy.position) copy.position = { x: (copy.position.x ?? 0) + offset.x, y: (copy.position.y ?? 0) + offset.y };
      if (name && copy.data) copy.data.name = name;
      ctx.canvas.push(copy);
      log.push(`复制 ${label(source)} → ${label(copy)}`);
      return copy;
    },
    portOf(node, group, index = 0) {
      const ports = (node.ports?.items ?? []).filter((port) => port.group === group);
      if (!ports[index]) throw new TransformError(`${label(node)} 没有第 ${index + 1} 个 ${group} 端口`);
      return ports[index].id;
    },
    addEdge(fromNode, fromPort, toNode, toPort) {
      const hasPort = (node, id) => (node.ports?.items ?? []).some((port) => port.id === id);
      if (!hasPort(fromNode, fromPort)) throw new TransformError(`${label(fromNode)} 没有端口 ${fromPort}`);
      if (!hasPort(toNode, toPort)) throw new TransformError(`${label(toNode)} 没有端口 ${toPort}`);
      // 连线样式照抄画布里已有的一条，避免编辑器渲染出无样式的线
      const template = edgesOf(ctx.canvas)[0];
      const edge = {
        ...(template?.attrs ? { attrs: JSON.parse(JSON.stringify(template.attrs)) } : {}),
        ...(template?.connector ? { connector: JSON.parse(JSON.stringify(template.connector)) } : {}),
        shape: template?.shape ?? 'custom-curve-edge',
        id: randomUUID(),
        zIndex: template?.zIndex ?? 0,
        source: { cell: fromNode.id, port: fromPort },
        target: { cell: toNode.id, port: toPort },
      };
      ctx.canvas.push(edge);
      log.push(`连线 ${label(fromNode)} → ${label(toNode)}`);
      return edge;
    },
    removeEdges(pred, { expect } = {}) {
      const count = removeWhere((cell) => isEdge(cell) && pred(cell));
      if (expect !== undefined && count !== expect) throw new TransformError(`删连线命中 ${count} 条，预期 ${expect} 条`);
      log.push(`删连线 ×${count}`);
      return count;
    },
    removeNode(query) {
      const node = resolveNode(ctx.canvas, query);
      const edges = removeWhere((cell) => isEdge(cell) && (cell.source?.cell === node.id || cell.target?.cell === node.id));
      removeWhere((cell) => cell === node);
      log.push(`删节点 ${label(node)}（连带 ${edges} 条连线）`);
    },
    log(message) {
      log.push(String(message));
    },
  };
  return h;
}

export async function runTransform(file, envelope) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw usage(`找不到改动脚本：${abs}`);
  const ctx = JSON.parse(JSON.stringify(envelope));
  const log = [];
  // 带时间戳参数绕开 ESM 模块缓存：同一进程里重跑（rebase）必须读到最新文件
  const mod = await import(`${pathToFileURL(abs).href}?t=${Date.now()}`);
  if (typeof mod.default !== 'function') throw usage(`${abs} 需要 export default (ctx) => { ... }`);
  let result;
  try {
    result = await mod.default({ canvas: ctx.canvas, sessions: ctx.sessions, events: ctx.events, h: createHelpers(ctx, log) });
  } catch (error) {
    if (error instanceof MdError) throw error;
    throw new TransformError(`改动脚本出错：${error?.message ?? String(error)}`);
  }
  if (Array.isArray(result)) ctx.canvas = result;
  const unchanged = (key) => stableStringify(ctx[key] ?? []) === stableStringify(envelope[key] ?? []);
  if (!unchanged('sessions') || !unchanged('events')) {
    throw new MdError('unsupported', '第 1 步只能改画布，不能改会话变量或事件', { exitCode: EXIT.USAGE });
  }
  return { envelope: ctx, log };
}
