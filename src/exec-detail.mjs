// 执行详情的加工。nodeResults 没有节点名、没有时间戳，数组顺序也不是执行顺序（实测），
// 所以名字从执行当时的画布快照反查，顺序按快照连线对执行过的节点做拓扑排序（cdf0baa1 会话里 59/59 还原）。

import { contentKey, isEdgeCell, nodeMap, stripLayout } from './canvas.mjs';
import { fieldChanges } from './diff.mjs';
import { asArray } from './api.mjs';
import { EXIT, MdError, usage } from './errors.mjs';
import { shortId } from './output.mjs';
import { actionTexts, clip, formatCost } from './execs.mjs';
import { buildBranchNameIndex, buildNodeMetaIndex, extractEventTrigger, extractTriggerTextFromSnapshot } from '../vendor/laodong/apps/api/lib/miaodong/badcase-normalize.ts';

export const NODE_LINE_LIMIT = 150;
const INPUT_KEY_LIMIT = 20;

export function orderExecuted(nodeIds, snapshot) {
  const unique = [...new Set(nodeIds)];
  // 快照里没有的节点（循环子节点、已删的节点）不知道位置，放到最后，不假装知道它什么时候跑的
  const known = new Set(asArray(snapshot).filter((c) => c && typeof c.id === 'string' && !isEdgeCell(c)).map((c) => c.id));
  const ids = unique.filter((id) => known.has(id));
  const unknown = unique.filter((id) => !known.has(id));
  const set = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, []]));
  for (const cell of asArray(snapshot)) {
    if (!cell || typeof cell !== 'object' || !isEdgeCell(cell)) continue;
    const from = cell.source?.cell;
    const to = cell.target?.cell;
    if (!set.has(from) || !set.has(to) || from === to) continue;
    next.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order = [];
  const done = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (done.has(id)) continue;
    done.add(id);
    order.push(id);
    for (const to of next.get(id)) {
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  // 环（循环节点）里剩下的，按秒懂返回的原顺序补在后面
  for (const id of ids) if (!done.has(id)) order.push(id);
  return [...order, ...unknown];
}

// 分支名按节点分开查：复制出来的规则中心共用 branchId、名字各不相同（09-29：兴趣岛画布 65–83 个共用、22–27 个名字冲突），
// 全局一张 branchId → 名字的表会把别的节点的分支名显示出来（约 6% 的分支显示错）。每个节点只查它自己的分支
export function nodeBranchNames(snapshot) {
  const out = new Map();
  for (const cell of asArray(snapshot)) {
    if (!cell || typeof cell !== 'object' || typeof cell.id !== 'string') continue;
    const names = buildBranchNameIndex([cell]);
    if (names.size) out.set(cell.id, names);
  }
  return out;
}

export function normalizeDetail(detail) {
  const ce = detail?.canvasExec ?? {};
  const snapshot = asArray(detail?.canvas?.rawCanvas).length ? detail.canvas.rawCanvas : asArray(ce.rawCanvas);
  const meta = buildNodeMetaIndex(snapshot);
  const branches = nodeBranchNames(snapshot);
  const cells = new Map(snapshot.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
  // 同一个节点可能跑多次（循环）：按 id 分组、组内保持秒懂返回的顺序，每一次都列出来（审查 I-5：以前后一次会盖掉前一次，出错的那次被显示成 ✅）
  const groups = new Map();
  for (const r of asArray(detail?.nodeResults)) {
    if (!r?.nodeId) continue;
    if (!groups.has(r.nodeId)) groups.set(r.nodeId, []);
    groups.get(r.nodeId).push(r);
  }
  const nodes = [];
  for (const id of orderExecuted([...groups.keys()], snapshot)) {
    const runs = groups.get(id);
    const m = meta.get(id);
    runs.forEach((r, k) => {
      const usageInfo = r.metadata?.tokenUsage;
      nodes.push({
        order: nodes.length + 1,
        id,
        iteration: runs.length > 1 ? `${k + 1}/${runs.length}` : null,
        name: m?.name || '(快照里没有这个节点)',
        type: m?.type || '?',
        category: m?.category || '',
        status: String(r.status ?? ''),
        ms: Number(r.processDuration) || 0,
        branch: r.outputBranchId ? branches.get(id)?.get(r.outputBranchId) ?? shortId(r.outputBranchId) : null,
        model: cells.get(id)?.data?.nodePayload?.modelType ?? null,
        cost: typeof usageInfo?.costInCny === 'number' ? usageInfo.costInCny : null,
        error: r.errorMessage ? String(r.errorMessage) : null,
        inputs: r.inputs?.inputData ?? r.inputs ?? null,
        output: r.output ?? null,
        actions: asArray(r.actions),
        metadata: r.metadata ?? null,
      });
    });
  }
  const cost = typeof ce.totalCostInCny === 'number' ? ce.totalCostInCny : Number.parseFloat(ce.totalCostInCny);
  return {
    exec: {
      execId: String(ce.execId ?? ''),
      botId: String(ce.botId ?? ''),
      sessionId: String(ce.sessionId ?? ''),
      status: String(ce.status ?? ''),
      triggerType: String(ce.triggerType ?? ''),
      createdAt: ce.createdAt ?? null,
      ms: Number(ce.processDuration) || 0,
      cost: Number.isFinite(cost) ? cost : null,
      testRun: ce.testRun === true,
      isCanary: ce.isCanary === true,
      outputActions: asArray(ce.outputActions),
      triggerText: extractTriggerTextFromSnapshot(ce),
      event: extractEventTrigger(ce),
    },
    version: String(detail?.canvas?.version ?? ''),
    snapshot,
    nodes,
  };
}

const ICON = { success: '✅', error: '❌', running: '⏳', pending: '⏳' };

export function nodeLine(n) {
  const parts = [`${String(n.order).padStart(3)} ${ICON[n.status] ?? `⚪${n.status}`} ${n.name}${n.iteration ? `（第 ${n.iteration} 次）` : ''} [${[n.type, n.model].filter(Boolean).join(' · ')}]`];
  if (n.branch) parts.push(`→ 分支「${n.branch}」`);
  if (n.cost !== null) parts.push(formatCost(n.cost));
  if (n.ms) parts.push(`${(n.ms / 1000).toFixed(1)}s`);
  if (n.error) parts.push(`：${clip(n.error, 120)}`);
  return parts.join(' ');
}

export function findExecNode(norm, query) {
  const q = String(query ?? '').trim();
  const byOrder = /^#(\d+)$/.exec(q);
  let hits = byOrder ? norm.nodes.filter((n) => n.order === Number(byOrder[1])) : norm.nodes.filter((n) => n.id === q);
  if (!hits.length && !byOrder) hits = norm.nodes.filter((n) => n.id.startsWith(q));
  if (!hits.length && !byOrder) hits = norm.nodes.filter((n) => n.name === q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const lines = hits.slice(0, 20).map((n) => `  - #${n.order} ${shortId(n.id)} ${n.name}`).join('\n');
    throw new MdError('node_ambiguous', `「${q}」在这次执行里匹配到 ${hits.length} 个节点：\n${lines}`, { exitCode: EXIT.TARGET, hint: '用 #序号 或 id 前缀指定' });
  }
  const inSnapshot = norm.snapshot.some((c) => typeof c?.id === 'string' && (c.id === q || c.id.startsWith(q) || c?.data?.name === q));
  throw new MdError('node_not_found', inSnapshot ? `这次执行没有跑到「${q}」` : `这次执行的画布里没有节点「${q}」`, { exitCode: EXIT.TARGET });
}

const contentText = (content) => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

export function promptText(metadata) {
  return asArray(metadata?.prompt).map((m) => `## ${m?.role ?? '?'}\n${contentText(m?.content)}`).join('\n\n');
}

export function renderNodeDetail(n, { nodeFile, promptFile }) {
  const lines = [];
  const head = [`节点 #${n.order} ${n.name}${n.iteration ? `（第 ${n.iteration} 次）` : ''} [${[n.type, n.model].filter(Boolean).join(' · ')}] ${n.status}`];
  if (n.ms) head.push(`${(n.ms / 1000).toFixed(1)}s`);
  if (n.cost !== null) head.push(formatCost(n.cost));
  if (n.branch) head.push(`→ 分支「${n.branch}」`);
  lines.push(head.join(' '));
  if (n.error) lines.push(`报错：${clip(n.error, 500)}`);
  lines.push('输入：');
  const inputs = n.inputs && typeof n.inputs === 'object' ? Object.entries(n.inputs) : [];
  if (!inputs.length) lines.push('  （无）');
  // 每个键截到 300 字，键的个数也要设上限：60 个键时整段能到近 2 万字（审查 M-2）
  for (const [key, value] of inputs.slice(0, INPUT_KEY_LIMIT)) lines.push(`  ${key}: ${clip(typeof value === 'string' ? value : JSON.stringify(value), 300)}`);
  if (inputs.length > INPUT_KEY_LIMIT) lines.push(`  …另有 ${inputs.length - INPUT_KEY_LIMIT} 个键，完整内容见 ${nodeFile}`);
  const msgs = asArray(n.metadata?.prompt);
  if (msgs.length) {
    lines.push(`Prompt：${msgs.map((m) => `${m?.role ?? '?'} ${contentText(m?.content).length} 字`).join(' · ')} → ${promptFile}`);
    const sys = msgs.find((m) => m?.role === 'system');
    if (sys) lines.push(`  system 开头：${clip(contentText(sys.content), 200)}`);
  }
  const reasoning = n.metadata?.reasoningMessage;
  if (typeof reasoning === 'string' && reasoning.trim()) lines.push(`推理：${clip(reasoning, 500)}`);
  lines.push(`输出：${clip(typeof n.output === 'string' ? n.output : JSON.stringify(n.output), 3000) || '（空）'}`);
  for (const t of asArray(n.metadata?.toolCallResults)) {
    const query = t?.toolCallArguments?.query;
    const result = t?.toolResult ? ` → ${t.toolResult.success === false ? '失败' : `返回 ${asArray(t.toolResult.result).length} 条`}` : '';
    lines.push(`工具：${t?.toolType ?? t?.name ?? '?'}${query ? `「${clip(query, 60)}」` : ''}${result}`);
  }
  const acts = actionTexts(n.actions);
  if (acts.length) lines.push(`动作：${clip(acts.map((a) => a.text).join('；'), 500)}`);
  const u = n.metadata?.tokenUsage;
  if (u && typeof u === 'object') {
    lines.push(`token：prompt ${u.prompt ?? '-'} · completion ${u.completion ?? '-'} · reasoning ${u.reasoning ?? '-'} · ${formatCost(typeof u.costInCny === 'number' ? u.costInCny : null)}`);
  }
  lines.push(`完整内容：${nodeFile}`);
  return lines;
}

// 一段文字是谁产生的。优先级：写死在配置里 > 某节点生成（输入里没有、输出里有）> 从执行外面传进来。
// 配置排第一：写死的话术最容易被误判成「模型想出来的」，然后去调温度、加约束，完全白费
export function locateText(norm, needle) {
  const target = String(needle ?? '').trim();
  if (!target) throw usage('--find 需要一段文字');
  const text = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const cells = new Map(norm.snapshot.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
  const rows = norm.nodes.map((node) => ({
    node,
    inConfig: text(cells.get(node.id)?.data).includes(target),
    inInput: text(node.inputs).includes(target),
    inPrompt: text(node.metadata?.prompt).includes(target),
    inOutput: text(node.output).includes(target) || text(node.actions).includes(target),
  }));
  // 先找起点：第一个「输入里没有、输出里有」的节点。只在配置里出现不算——意图识别的 few-shot 示例、话术库里
  // 常写着同一句话，以前按「配置优先」会把结论指到这些根本没输出它的节点上（审查 I-1）
  const origin = rows.find((r) => r.inOutput && !r.inInput);
  let verdict;
  if (origin) {
    const kind = origin.inConfig ? 'hardcoded' : origin.node.category === 'trigger' ? 'trigger' : 'generated';
    verdict = { kind, node: origin.node };
  } else {
    const external = rows.find((r) => r.inInput);
    const configOnly = rows.find((r) => r.inConfig);
    if (external) verdict = { kind: 'external', node: external.node };
    else if (configOnly) verdict = { kind: 'config-only', node: configOnly.node };
    else verdict = { kind: 'none', node: null };
  }
  return { rows: rows.filter((r) => r.inConfig || r.inInput || r.inPrompt || r.inOutput), verdict };
}

export function verdictLine(v) {
  if (v.kind === 'none') return '结论：这次执行的节点里都没有这段文字（可能在事件链上别的执行里：先 md exec <执行id> 看事件链）';
  const who = `#${v.node.order}「${v.node.name}」[${shortId(v.node.id)}]`;
  const texts = {
    hardcoded: `结论：写死在 ${who} 的配置里（该改的是这段配置，而不是调模型）`,
    trigger: `结论：来自触发内容 ${who}（用户消息或事件载荷）`,
    generated: `结论：最早由 ${who} 生成（它的输入里没有、输出里有）`,
    external: `结论：从这条执行外面传进来，最早出现在 ${who} 的输入里（上游执行、会话变量或用户消息）`,
    'config-only': `结论：这段文字写在 ${who} 的配置里，但这次执行没有输出它（可能在事件链上别的执行里：先 md exec <执行id> 看事件链）`,
  };
  return texts[v.kind];
}

// 执行时的快照 vs 现在的草稿：只看这次跑过的节点；坐标、尺寸这类纯渲染字段不算改动
export function driftAgainst(norm, draftCanvas) {
  if (!norm.snapshot.length) return { noSnapshot: true, changed: [], removed: [], wires: { added: [], removed: [] } };
  const draft = nodeMap(draftCanvas);
  const snap = nodeMap(norm.snapshot);
  const changed = [];
  const removed = [];
  const seen = new Set();
  for (const node of norm.nodes) {
    // 同一个节点跑了多次（循环）只比一次
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const before = snap.get(node.id);
    if (!before) continue;
    const now = draft.get(node.id);
    if (!now) {
      removed.push(node);
      continue;
    }
    if (contentKey(before) === contentKey(now)) continue;
    changed.push({ node, paths: fieldChanges(stripLayout(before), stripLayout(now)).map((c) => c.path) });
  }
  // 只改连线的修复（挪节点、插节点）很常见：跑过的节点之间的连线也要比，按「源→目标」对齐，不看端口 id（审查 M-3）
  const nameOf = new Map(norm.nodes.map((n) => [n.id, n.name]));
  const pairs = (canvas) => new Set(asArray(canvas)
    .filter((c) => c && typeof c === 'object' && isEdgeCell(c) && seen.has(c.source?.cell) && seen.has(c.target?.cell))
    .map((c) => `${c.source.cell}>${c.target.cell}`));
  const before = pairs(norm.snapshot);
  const now = pairs(draftCanvas);
  const names = (key) => key.split('>').map((id) => nameOf.get(id) ?? shortId(id));
  const wires = {
    added: [...now].filter((k) => !before.has(k)).map(names),
    removed: [...before].filter((k) => !now.has(k)).map(names),
  };
  return { changed, removed, wires };
}
