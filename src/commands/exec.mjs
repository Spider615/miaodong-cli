// md exec：查执行记录。不给执行 id 是「搜」，给了是「看一条」。
// 看一条时自动串事件链：一条用户消息常被拆成几条执行，回复在后面那条里（会话里两天各重新发现过一次）。

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boolArg, intArg, strArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { getCanvas, listVersions } from '../api.mjs';
import { resolveBot, resolveVersion, targetArgs } from '../target.mjs';
import { DATA_NOTE, formatTime, note, out, shortId, targetLine } from '../output.mjs';
import { parseDuration, timeWindow } from '../timewin.mjs';
import { ACTION_ALIASES, TRIGGER_ALIASES, actionSummary, buildSearchBody, clip, formatCost, formatRow, resolveAlias, scanSummary, searchExecutions, summarizeRow } from '../execs.mjs';
import { saveNodes, saveSearch } from '../exec-store.mjs';
import { EXEC_ID, locateExec } from '../exec-locate.mjs';
import { NODE_LINE_LIMIT, driftAgainst, findExecNode, locateText, nodeLine, normalizeDetail, promptText, renderNodeDetail, verdictLine } from '../exec-detail.mjs';
import { DEFAULT_CHAIN_WINDOW_MS, chainExecFromDetail, chainOf, extractEmittedEvents, fetchSessionPool, renderChain } from '../exec-chain.mjs';

const SHOW_LIMIT = 50;

function describeFilters(f) {
  return [
    f.keyword && `关键词「${f.keyword}」`, f.session && `会话 ${f.session}`, f.down && '点踩', f.up && '点赞',
    f.event && `事件「${f.event}」`, f.trigger && `触发 ${f.trigger}`, f.action && `动作 ${f.action}`, f.version && `版本 ${f.version}`,
    f.canary === true && '只看灰度', f.canary === false && '不看灰度', f.failed && '有节点报错',
  ].filter(Boolean).join('、');
}

async function searchExecs(args) {
  const target = await resolveBot(targetArgs(args));
  const { identity, orgId, botId } = target;
  const window = timeWindow(args);
  const limit = intArg(args, 'limit', 20, 1000);
  const scanPages = intArg(args, 'scan', 5, 50);
  const version = strArg(args, 'version');
  let versionCanvasId;
  if (version) {
    const draft = await getCanvas(identity, orgId, botId);
    versionCanvasId = resolveVersion(await listVersions(identity, orgId, draft.canvasId), version).canvasId;
  }
  const filters = {
    keyword: strArg(args, 'keyword'),
    session: strArg(args, 'session'),
    down: boolArg(args, 'down'),
    up: boolArg(args, 'up'),
    event: strArg(args, 'event'),
    trigger: resolveAlias(TRIGGER_ALIASES, strArg(args, 'trigger'), 'trigger'),
    action: resolveAlias(ACTION_ALIASES, strArg(args, 'action'), 'action'),
    version,
    canary: args.canary === undefined ? undefined : boolArg(args, 'canary'),
    failed: boolArg(args, 'failed'),
  };
  const body = buildSearchBody({ botId, start: window.start, end: window.end, versionCanvasId, ...filters });
  const res = await searchExecutions(identity, orgId, body, {
    eventName: filters.event,
    limit,
    scanPages,
    onPage: ({ page, scanned, matched }) => {
      if (filters.event) note(`（第 ${page} 页：已扫 ${scanned} 条，命中 ${matched} 条）`);
    },
  });
  const cond = describeFilters(filters);
  out(targetLine(target));
  out(DATA_NOTE);
  out(`时间 ${window.label}${cond ? ` · 条件：${cond}` : ''}`);
  if (filters.event) {
    out(scanSummary(res, { limit, from: window.start }));
    if (!res.matches.length && res.namesSeen.size) {
      out(`扫到的事件名：${[...res.namesSeen].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => `${name}(${n})`).join('、')}`);
    }
  } else {
    out(`共 ${res.total ?? '?'} 条，显示 ${Math.min(res.matches.length, SHOW_LIMIT)} 条${res.total !== null && res.total > res.matches.length ? '（--limit 调整）' : ''}`);
  }
  if (!res.matches.length && filters.keyword) out('（关键词按词匹配用户消息和回复：换成完整的词或更短的词试试；找事件用 --event）');
  for (const row of res.matches.slice(0, SHOW_LIMIT)) out(formatRow(summarizeRow(row)));
  if (res.matches.length > SHOW_LIMIT) out(`（只显示前 ${SHOW_LIMIT} 条，全部 ${res.matches.length} 条在下面的文件里）`);
  const file = saveSearch(target, {
    regionLabel: target.regionLabel, identityKey: target.identityKey, orgId, orgName: target.orgName, botId, botName: target.botName,
    window: { start: window.start, end: window.end }, filters, total: res.total, scanned: res.scanned,
  }, res.matches, strArg(args, 'save'));
  out(`已存：${file}（JSONL，第一行是查询条件）`);
  if (res.matches.length) out('看一条：md exec <执行id>');
  return EXIT.OK;
}

async function showExec(args, target, norm, dir) {
  const e = norm.exec;
  let chainLines;
  let eventName = '';
  if (e.testRun) {
    chainLines = ['事件链：测试 / 试跑执行不在执行列表里，没有事件链'];
  } else if (!e.event && !extractEmittedEvents(e.outputActions).length) {
    chainLines = ['事件链：无（这条没有收发事件）'];
  } else {
    const windowMs = args['chain-window'] !== undefined ? parseDuration(strArg(args, 'chain-window')) : DEFAULT_CHAIN_WINDOW_MS;
    const center = Date.parse(e.createdAt ?? '') || Date.now();
    const pool = await fetchSessionPool(target.identity, target.orgId, target.botId, e.sessionId, center, windowMs);
    const rowsById = new Map(pool.rows.map((r) => [r.execId, r]));
    if (!rowsById.has(e.execId)) rowsById.set(e.execId, { outputActions: e.outputActions, totalCostInCny: e.cost });
    const chain = chainOf(e.execId, pool.rows, chainExecFromDetail(norm));
    eventName = chain?.target?.triggeredBy?.eventName ?? '';
    chainLines = chain
      ? renderChain(chain, rowsById, { windowLabel: `执行时间前后 ${Math.round(windowMs / 60_000)} 分钟`, truncatedBefore: pool.truncatedBefore, truncatedAfter: pool.truncatedAfter })
      : ['事件链：取不到'];
  }
  const trigger = e.event ? `事件「${eventName || shortId(e.event.eventId)}」` : e.triggerType || '-';
  out(targetLine(target));
  out(DATA_NOTE);
  out(`执行 ${e.execId} · ${formatTime(e.createdAt)} · ${trigger} · ${e.status} · 节点 ${norm.nodes.length} 个 · ${(e.ms / 1000).toFixed(1)}s · ${formatCost(e.cost)}${e.testRun ? ' · 测试执行' : ''}`);
  out(`触发：${clip(e.triggerText, 200) || '-'}`);
  out(`本条动作：${clip(actionSummary(e.outputActions), 300) || '无'}`);
  for (const line of chainLines) out(line);
  out('节点（按执行顺序）：');
  for (const n of norm.nodes.slice(0, NODE_LINE_LIMIT)) out(nodeLine(n));
  if (norm.nodes.length > NODE_LINE_LIMIT) out(`  …另有 ${norm.nodes.length - NODE_LINE_LIMIT} 个节点，见 ${join(dir, 'nodes.jsonl')}`);
  out(`详情：${join(dir, 'detail.json')} · 节点：${join(dir, 'nodes.jsonl')}`);
  out(`下一步：md exec ${e.execId} --node <节点|#序号>；--find "<文字>"；--vs-draft`);
  return EXIT.OK;
}

function showNode(args, target, norm, dir) {
  const n = findExecNode(norm, strArg(args, 'node'));
  const base = join(dir, `node-${String(n.order).padStart(3, '0')}-${shortId(n.id)}`);
  writeFileSync(`${base}.json`, JSON.stringify(n, null, 2));
  const prompt = promptText(n.metadata);
  if (prompt) writeFileSync(`${base}.prompt.txt`, prompt);
  out(targetLine(target));
  out(DATA_NOTE);
  out(`执行 ${norm.exec.execId}`);
  for (const line of renderNodeDetail(n, { nodeFile: `${base}.json`, promptFile: prompt ? `${base}.prompt.txt` : '（无）' })) out(line);
  return EXIT.OK;
}

function showFind(args, target, norm) {
  const needle = strArg(args, 'find');
  const { rows, verdict } = locateText(norm, needle);
  out(targetLine(target));
  out(`执行 ${norm.exec.execId} · 找「${clip(needle, 40)}」：${rows.length} 个节点碰到`);
  const mark = (hit) => (hit ? '✓' : '·');
  for (const r of rows) out(`  #${r.node.order} ${r.node.name} [${shortId(r.node.id)}] 配置${mark(r.inConfig)} 输入${mark(r.inInput)} prompt${mark(r.inPrompt)} 输出${mark(r.inOutput)}`);
  out(verdictLine(verdict));
  return EXIT.OK;
}

async function showDrift(target, norm) {
  const draft = await getCanvas(target.identity, target.orgId, target.botId);
  const { noSnapshot, changed, removed, wires } = driftAgainst(norm, draft.rawCanvas);
  out(targetLine(target));
  out(`执行时 ${norm.version || '版本未知'} → 现在的草稿（最后保存 ${formatTime(draft.updatedAt)}）`);
  if (noSnapshot) {
    out('这条执行的详情里没有画布快照，没法和草稿比。');
    return EXIT.OK;
  }
  const unique = new Set(norm.nodes.map((n) => n.id)).size;
  out(`这次执行跑过的 ${unique} 个节点里：${changed.length} 个改过、${removed.length} 个在草稿里已删除；它们之间的连线新增 ${wires.added.length} 条、删掉 ${wires.removed.length} 条`);
  for (const c of changed.slice(0, 50)) {
    out(`  ~ #${c.node.order} ${c.node.name} [${shortId(c.node.id)}]：${c.paths.slice(0, 5).join('、')}${c.paths.length > 5 ? ` 等 ${c.paths.length} 处` : ''}`);
  }
  if (changed.length > 50) out(`  …另有 ${changed.length - 50} 个改过的节点`);
  for (const n of removed) out(`  - #${n.order} ${n.name} [${shortId(n.id)}]`);
  for (const [from, to] of wires.added.slice(0, 20)) out(`  + 连线 ${from} → ${to}`);
  for (const [from, to] of wires.removed.slice(0, 20)) out(`  - 连线 ${from} → ${to}`);
  if (!changed.length && !removed.length && !wires.added.length && !wires.removed.length) out('  这次跑过的节点和它们之间的连线在草稿里都没改过。');
  return EXIT.OK;
}

async function viewExec(args) {
  const execId = String(args._[0]).trim();
  if (!EXEC_ID.test(execId)) throw usage(`执行 id 要写完整的 36 位，收到「${execId}」`);
  const { target, dir, detail, fresh } = await locateExec(args, execId);
  const norm = normalizeDetail(detail);
  if (fresh || !existsSync(join(dir, 'nodes.jsonl'))) saveNodes(dir, norm.nodes);
  const shown = { ...target, versionLabel: `${norm.version || '版本未知'}${norm.exec.isCanary ? '（灰度）' : ''}` };
  if (args.node !== undefined) return showNode(args, shown, norm, dir);
  if (args.find !== undefined) return showFind(args, shown, norm);
  if (boolArg(args, 'vs-draft')) return showDrift(shown, norm);
  return showExec(args, shown, norm, dir);
}

export const exec = {
  summary: '查执行记录：按条件搜，或看一条的节点轨迹、回复和事件链',
  usage: [
    'md exec --bot <智能体> [--since 24h | --from <时间> --to <时间>] [--keyword 词] [--session <会话id>]',
    '        [--down|--up] [--event <事件名>] [--trigger text|image|audio|event|tag|friend|…]',
    '        [--action send|combo|handover|event|update|tag|…] [--version vX] [--canary|--no-canary] [--failed]',
    '        [--limit 20] [--scan 5] [--save <文件>]                          搜执行记录',
    'md exec <执行id> [--bot <智能体>] [--chain-window 65m]                    看一条：节点顺序、本条动作、事件链',
    'md exec <执行id> --node <节点|#序号>                                      这个节点当时的输入、prompt、推理、输出',
    'md exec <执行id> --find "<文字>"                                          这段文字最早是哪个节点产生的',
    'md exec <执行id> --vs-draft                                               执行时的版本和现在的草稿比，跑过的节点改了哪些',
  ].join('\n'),
  async run(args) {
    return args._[0] ? viewExec(args) : searchExecs(args);
  },
};
