// src/summarize.mjs：画布摘要（从旧 kit 带过来，md 只用 shortId、describeNode）
//
// 画布摘要 —— 这个模块存在的唯一理由是保护 AI 的上下文窗口。
//
// 背景：秒懂真实画布实测 611 个 rawCanvas 元素，执行详情里的画布快照 900+。
// 整坨 JSON 灌进模型上下文，一次调用就能吃掉半个窗口，而且 90% 是坐标、样式、端口
// 这类对理解业务毫无用处的字段。所以约定：
//   pull 把完整 JSON 落盘，stdout 只出摘要；要看细节用 --node 定向查。
//
// 摘要分三档（--format）：
//   brief   仅统计 + 类型分布，约 20 行
//   outline 默认，一节点一行（id 短码 + 名称 + 类型 + 出入度）
//   chain   按边推导执行链路，看流程走向

import { isEdgeCell, isVisualOnlyCell } from '../vendor/laodong/apps/api/lib/miaodong/canvas-derive.ts';

/** UUID 太长，摘要里统一用前 8 位短码；--node 查询时支持用短码前缀匹配。 */
export function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '';
}

/** 把 rawCanvas 拆成 nodes / edges / decorations 三类。 */
export function splitCanvas(rawCanvas) {
  const nodes = [];
  const edges = [];
  const decorations = [];
  for (const cell of rawCanvas) {
    if (!cell || typeof cell !== 'object') continue;
    if (isEdgeCell(cell)) edges.push(cell);
    else if (isVisualOnlyCell(cell)) decorations.push(cell);
    else nodes.push(cell);
  }
  return { nodes, edges, decorations };
}

function nodeLabel(cell) {
  const data = cell.data ?? {};
  const name = typeof data.name === 'string' && data.name ? data.name : '(无名)';
  const type = typeof data.type === 'string' ? data.type : cell.shape ?? '?';
  return { name, type, category: data.category ?? '' };
}

/**
 * 生成画布摘要文本。
 * @param rawCanvas X6 扁平数组
 * @param opts { format: 'brief'|'outline'|'chain', botName, canvasId, events, sessions }
 */
export function summarizeCanvas(rawCanvas, opts = {}) {
  const { format = 'outline', botName = '', canvasId = '', events = [], sessions = [] } = opts;
  const { nodes, edges, decorations } = splitCanvas(rawCanvas);

  // 类型分布
  const typeCount = new Map();
  for (const n of nodes) {
    const { type } = nodeLabel(n);
    typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
  }
  const typeRows = [...typeCount.entries()].sort((a, b) => b[1] - a[1]);

  const lines = [];
  lines.push(`# 画布摘要${botName ? ` — ${botName}` : ''}`);
  if (canvasId) lines.push(`canvasId: ${canvasId}`);
  lines.push(
    `元素总数 ${rawCanvas.length}（业务节点 ${nodes.length} / 连线 ${edges.length} / 视觉装饰 ${decorations.length}）`,
  );
  if (events.length) lines.push(`事件（主动触达）${events.length} 个`);
  if (sessions.length) lines.push(`会话变量 ${sessions.length} 个`);
  lines.push('');

  lines.push('## 节点类型分布');
  for (const [type, count] of typeRows) lines.push(`- ${type}: ${count}`);
  lines.push('');

  if (format === 'brief') {
    return lines.join('\n');
  }

  // 出入度统计
  const inDeg = new Map();
  const outDeg = new Map();
  for (const e of edges) {
    const s = e.source?.cell;
    const t = e.target?.cell;
    if (s) outDeg.set(s, (outDeg.get(s) ?? 0) + 1);
    if (t) inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
  }

  if (format === 'chain') {
    lines.push('## 执行链路');
    lines.push(...renderChains(nodes, edges, inDeg));
    return lines.join('\n');
  }

  // outline（默认）
  lines.push('## 节点清单');
  lines.push('格式：短码 | 名称 | 类型 | 入度→出度');
  for (const n of nodes) {
    const { name, type } = nodeLabel(n);
    const i = inDeg.get(n.id) ?? 0;
    const o = outDeg.get(n.id) ?? 0;
    const orphan = i === 0 && o === 0 ? '  ⚠️孤立' : '';
    lines.push(`${shortId(n.id)} | ${name} | ${type} | ${i}→${o}${orphan}`);
  }
  lines.push('');
  lines.push(`> 看单个节点完整配置（含 prompt 全文）：--node <短码>`);
  lines.push(`> 看流程走向：--format chain`);

  return lines.join('\n');
}

/** 从入口节点（入度 0）出发做深度遍历，渲染成缩进链路。 */
function renderChains(nodes, edges, inDeg) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map();
  for (const e of edges) {
    const s = e.source?.cell;
    const t = e.target?.cell;
    if (!s || !t) continue;
    if (!adj.has(s)) adj.set(s, []);
    adj.get(s).push(t);
  }

  const roots = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0);
  const out = [];
  const globalSeen = new Set();

  const walk = (id, depth, pathSeen) => {
    const n = byId.get(id);
    if (!n) return;
    const { name, type } = nodeLabel(n);
    const indent = '  '.repeat(depth);
    // 已在别的链路展开过的节点只标一次，避免菱形结构指数级刷屏
    if (globalSeen.has(id) && (adj.get(id)?.length ?? 0) > 0) {
      out.push(`${indent}↳ ${name} (${type}) [${shortId(id)}] …见上`);
      return;
    }
    globalSeen.add(id);
    out.push(`${indent}${depth === 0 ? '▶' : '↳'} ${name} (${type}) [${shortId(id)}]`);
    const next = adj.get(id) ?? [];
    for (const t of next) {
      if (pathSeen.has(t)) {
        // 环：标出来就停，别无限递归
        out.push(`${'  '.repeat(depth + 1)}↺ 回到 [${shortId(t)}]（成环）`);
        continue;
      }
      walk(t, depth + 1, new Set([...pathSeen, t]));
    }
  };

  for (const r of roots) walk(r.id, 0, new Set([r.id]));

  // 不可达节点（既不是入口、也没被任何入口走到）
  const unreached = nodes.filter((n) => !globalSeen.has(n.id));
  if (unreached.length) {
    out.push('');
    out.push(`## 未被任何入口连到的节点（${unreached.length} 个）`);
    for (const n of unreached) {
      const { name, type } = nodeLabel(n);
      out.push(`- ${name} (${type}) [${shortId(n.id)}]`);
    }
  }
  return out;
}

/** 查单个节点的完整配置（含 prompt 全文）。idPrefix 支持短码前缀。 */
export function describeNode(rawCanvas, idPrefix) {
  const { nodes } = splitCanvas(rawCanvas);
  const matches = nodes.filter((n) => typeof n.id === 'string' && n.id.startsWith(idPrefix));
  if (matches.length === 0) return `没有 id 以 "${idPrefix}" 开头的节点`;
  if (matches.length > 1) {
    return `短码 "${idPrefix}" 匹配到 ${matches.length} 个节点，请给更长的前缀：\n` +
      matches.map((n) => `- ${shortId(n.id)} ${nodeLabel(n).name}`).join('\n');
  }
  const n = matches[0];
  const { name, type, category } = nodeLabel(n);
  const lines = [
    `# 节点 ${name}`,
    `id: ${n.id}`,
    `type: ${type}   category: ${category}`,
    '',
    '## nodePayload',
    JSON.stringify(n.data?.nodePayload ?? null, null, 2),
  ];
  if (n.data?.outputTypes) {
    lines.push('', '## outputTypes', JSON.stringify(n.data.outputTypes, null, 2));
  }
  return lines.join('\n');
}

/**
 * 对比两份画布，输出结构差异摘要。
 * push 前用它告诉用户「这次要改什么」，避免全量覆盖变成盲推。
 */
export function diffCanvas(oldRaw, newRaw) {
  const a = splitCanvas(oldRaw);
  const b = splitCanvas(newRaw);
  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));

  const added = [...bNodes.keys()].filter((id) => !aNodes.has(id));
  const removed = [...aNodes.keys()].filter((id) => !bNodes.has(id));
  const common = [...bNodes.keys()].filter((id) => aNodes.has(id));
  const changed = common.filter(
    (id) => JSON.stringify(aNodes.get(id).data) !== JSON.stringify(bNodes.get(id).data),
  );

  const lines = [];
  lines.push('## 变更摘要');
  lines.push(
    `线上 ${a.nodes.length} 节点 / ${a.edges.length} 边  →  待推送 ${b.nodes.length} 节点 / ${b.edges.length} 边`,
  );
  lines.push('');

  // id 全变（例如经过 adapt 重新 UUID 化）时，逐 id 对比没有意义，明确提示
  if (common.length === 0 && a.nodes.length > 0 && b.nodes.length > 0) {
    lines.push('⚠️ 两份画布的节点 id 完全不重叠 —— 这是整图替换，不是增量修改。');
    lines.push('   线上这份的所有节点都会被覆盖掉。确认这是你要的再推。');
    return lines.join('\n');
  }

  if (added.length) {
    lines.push(`### 新增 ${added.length} 个节点`);
    for (const id of added) lines.push(`+ ${nodeLabel(bNodes.get(id)).name} (${nodeLabel(bNodes.get(id)).type})`);
    lines.push('');
  }
  if (removed.length) {
    lines.push(`### 删除 ${removed.length} 个节点`);
    for (const id of removed) lines.push(`- ${nodeLabel(aNodes.get(id)).name} (${nodeLabel(aNodes.get(id)).type})`);
    lines.push('');
  }
  if (changed.length) {
    lines.push(`### 配置变更 ${changed.length} 个节点`);
    for (const id of changed) lines.push(`~ ${nodeLabel(bNodes.get(id)).name} (${nodeLabel(bNodes.get(id)).type}) [${shortId(id)}]`);
    lines.push('');
  }
  if (!added.length && !removed.length && !changed.length) {
    lines.push('（节点层面无变化，可能只有连线或坐标变动）');
  }
  return lines.join('\n');
}
