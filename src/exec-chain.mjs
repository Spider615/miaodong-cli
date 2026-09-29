// 事件链：一条用户消息常被拆成几条执行（消息 → 延时回复 → 发送），回复在最后那条里。
// 配对靠「上游发出的事件参数 == 下游收到的事件数据」（复算 189/189）；同会话同事件的候选很常见（32/221），必须比载荷。
// 一次「同会话 ± 时间窗」的列表查询就拿到了整条链要的数据，不用逐条查详情。

import { buildExecutionChain, compareEventPayload, extractEmittedEvents, toChainExec } from '../vendor/laodong/apps/api/lib/miaodong/badcase-normalize.ts';
import { PAGE_SIZE, TRIGGER_LABEL, actionSummary, actionTexts, clip, formatCost, listExecutions } from './execs.mjs';
import { formatTime, shortId } from './output.mjs';

export { extractEmittedEvents };

export const DEFAULT_CHAIN_WINDOW_MS = 65 * 60_000;
export const MAX_POOL_PAGES = 5;

async function fetchRange(identity, orgId, botId, sessionId, start, end) {
  const rows = [];
  let total = null;
  let lastPageFull = false;
  for (let page = 1; page <= MAX_POOL_PAGES; page++) {
    const res = await listExecutions(identity, orgId, { botId, sessionId, startTimestamp: start, endTimestamp: end, current: page, pageSize: PAGE_SIZE });
    if (res.total !== null) total = res.total;
    rows.push(...res.rows);
    lastPageFull = res.rows.length === PAGE_SIZE;
    if (!lastPageFull) break;
  }
  // 接口不给总数时，最后一页还是满页就当作被截断（宁可多提醒）
  return { rows, truncated: total !== null ? rows.length < total : lastPageFull };
}

// 以本条为界分两段查。列表是新到旧：只查一整段时，翻页上限先丢掉的恰好是本条之前的上游（审查 I-3）；
// 分段后，前一段离本条最近的先回来，截断时丢的是离得最远的。
// 回来的每条再按 sessionId 复核：接口万一没认会话条件，别的会话里载荷一样的执行会被当成上下游串进来（foreign 是排除了几条）
export async function fetchSessionPool(identity, orgId, botId, sessionId, centerMs, windowMs) {
  const before = await fetchRange(identity, orgId, botId, sessionId, centerMs - windowMs, centerMs);
  const after = await fetchRange(identity, orgId, botId, sessionId, centerMs, centerMs + windowMs);
  const seen = new Set();
  const rows = [];
  let foreign = 0;
  for (const row of [...before.rows, ...after.rows]) {
    if (seen.has(row?.execId)) continue;
    seen.add(row?.execId);
    if (row?.sessionId !== undefined && row.sessionId !== sessionId) {
      foreign++;
      continue;
    }
    rows.push(row);
  }
  return { rows, foreign, truncated: before.truncated || after.truncated, truncatedBefore: before.truncated, truncatedAfter: after.truncated };
}

export function chainExecFromDetail(norm) {
  const e = norm.exec;
  return {
    execId: e.execId,
    timestamp: Date.parse(e.createdAt ?? '') || 0,
    triggerType: e.triggerType,
    triggerText: e.triggerText,
    triggeredBy: e.event ? { eventId: e.event.eventId, eventName: '', payload: e.event.payload } : null,
    emits: extractEmittedEvents(e.outputActions),
    actionTypes: [...new Set(e.outputActions.map((a) => a?.type).filter((t) => t && t !== 'canvas-event-action'))],
  };
}

// 顺着本条发出的事件往下找：同 eventId、时间不早于本条、载荷对得上的最早一条
export function downstreamOf(start, pool, maxHops = 8) {
  const sorted = [...pool].sort((a, b) => a.timestamp - b.timestamp);
  const hops = [];
  const visited = new Set([start.execId]);
  let frontier = [{ exec: start, depth: 0 }];
  while (frontier.length) {
    const nextFrontier = [];
    for (const { exec, depth } of frontier) {
      if (depth >= maxHops) continue;
      for (const emitted of exec.emits) {
        const candidates = sorted.filter((e) => !visited.has(e.execId) && e.timestamp >= exec.timestamp && e.triggeredBy?.eventId === emitted.eventId);
        const verdicts = candidates.map((e) => ({ e, v: compareEventPayload(emitted.params, e.triggeredBy.payload) }));
        const matched = verdicts.filter((x) => x.v === 'match').map((x) => x.e);
        const undecided = verdicts.filter((x) => x.v === 'unknown').map((x) => x.e);
        const picks = matched.length ? matched : undecided;
        if (!picks.length) {
          hops.push({ missing: true, from: exec.execId, eventId: emitted.eventId, eventName: emitted.eventName, depth: depth + 1 });
          continue;
        }
        const pick = picks[0];
        visited.add(pick.execId);
        // guess = 载荷没有可比的字段，只能按时间猜；ambiguous = 载荷对得上的不止一条
        const link = matched.length === 1 ? 'exact' : matched.length > 1 ? 'ambiguous' : 'guess';
        hops.push({ ...pick, from: exec.execId, via: emitted.eventName, link, otherCandidates: picks.slice(1).map((e) => e.execId), depth: depth + 1 });
        nextFrontier.push({ exec: pick, depth: depth + 1 });
      }
    }
    frontier = nextFrontier;
  }
  return hops;
}

export function chainOf(targetId, rows, fallbackTarget) {
  const pool = rows.map(toChainExec).filter(Boolean);
  if (!pool.some((e) => e.execId === targetId) && fallbackTarget) pool.push(fallbackTarget);
  const target = pool.find((e) => e.execId === targetId);
  if (!target) return null;
  // buildExecutionChain 返回正序（源头在前），最后一跳就是本条；本条上的 link 描述它和上游之间的那条边
  const up = buildExecutionChain(targetId, pool, 8);
  // buildExecutionChain 把「载荷判不了、按时间猜的」也标成 ambiguous；这里分出来，猜的必须看得出是猜的（审查 M-1）
  for (let i = 1; i < up.length; i++) {
    const child = up[i];
    if (child.link !== 'ambiguous' || !child.triggeredBy) continue;
    const verdicts = up[i - 1].emits
      .filter((m) => m.eventId === child.triggeredBy.eventId)
      .map((m) => compareEventPayload(m.params, child.triggeredBy.payload));
    if (!verdicts.includes('match')) child.link = 'guess';
  }
  return { target, upstream: up.slice(0, -1), targetHop: up.at(-1), downstream: downstreamOf(target, pool, 8) };
}

export function renderChain(chain, rowsById, { windowLabel, truncated = false, truncatedBefore = false, truncatedAfter = false }) {
  const lines = [`事件链（同会话，${windowLabel}）：`];
  const actionsOf = (hop) => actionTexts(rowsById.get(hop.execId)?.outputActions);
  const describe = (hop) => {
    const row = rowsById.get(hop.execId);
    const acts = row ? actionSummary(row.outputActions) : hop.actionTypes.join('、');
    const trigger = hop.triggeredBy
      ? `事件「${hop.triggeredBy.eventName || shortId(hop.triggeredBy.eventId)}」`
      : `${TRIGGER_LABEL[hop.triggerType] ?? hop.triggerType}「${clip(hop.triggerText, 30)}」`;
    const raw = row?.totalCostInCny;
    const cost = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    return `${shortId(hop.execId)} ${formatTime(hop.timestamp)} ${trigger} → ${clip(acts, 80) || '无动作'} ${formatCost(Number.isFinite(cost) ? cost : null)}`;
  };
  const note = (hop) => {
    if (hop?.link === 'guess') return '（载荷无法比对，按时间猜的）';
    if (hop?.link === 'ambiguous') return `（同载荷候选还有 ${hop.otherCandidates.length} 个，按时间取了最近的）`;
    return '';
  };
  const source = chain.upstream[0] ?? chain.targetHop;
  if (source?.triggeredBy && source.link === 'root') {
    const event = `事件「${source.triggeredBy.eventName || shortId(source.triggeredBy.eventId)}」`;
    // 截断时放宽时间窗只会让本条之前的执行更多，上游被挤得更远：要缩小
    lines.push(truncatedBefore
      ? `  ? 上游可能被截掉了：本条之前的执行超过 500 条（${event}）；缩小 --chain-window（比如 10m）再看`
      : `  ? 上游不在时间窗内（${event}；可加 --chain-window 3h 再找）`);
  }
  for (const hop of chain.upstream) lines.push(`  ← ${describe(hop)}${note(hop)}`);
  lines.push(`  ● ${describe(chain.targetHop)}${note(chain.targetHop)}  ← 本条`);
  for (const hop of chain.downstream) {
    const pad = '  '.repeat(hop.depth);
    lines.push(hop.missing
      ? `  ${pad}→ 事件「${hop.eventName || shortId(hop.eventId)}」的执行没找到${truncatedAfter ? '（本条之后的执行超过 500 条，可能被截掉了；缩小 --chain-window 再看）' : '（可能还没跑，或超出时间窗；可加 --chain-window 3h 再找）'}`
      : `  ${pad}→ ${describe(hop)}${note(hop)}`);
  }
  // 整条链最终做了什么：只看发文本、组合消息、转人工
  const hops = [...chain.upstream, chain.targetHop, ...chain.downstream.filter((h) => !h.missing)];
  const finals = hops.flatMap((h) => actionsOf(h).filter((a) => a.kind === 'reply' || a.kind === 'handover').map((a) => a.text));
  lines.push(`  整条链最终：${finals.length ? clip(finals.join('；'), 300) : '没有发消息，也没有转人工'}`);
  if (truncated || truncatedBefore || truncatedAfter) lines.push('  （这个会话在时间窗内的执行超过 500 条，链可能不全；缩小 --chain-window 再看）');
  return lines;
}
