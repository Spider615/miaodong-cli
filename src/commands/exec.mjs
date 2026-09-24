// md exec：查执行记录。不给执行 id 是「搜」，给了是「看一条」。
// 看一条时自动串事件链：一条用户消息常被拆成几条执行，回复在后面那条里（会话里两天各重新发现过一次）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { intArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { getCanvas, listVersions } from '../api.mjs';
import { loadIdentities, requireIdentities } from '../identity.mjs';
import { loadBotDirectory, resolveBot, resolveVersion, targetArgs } from '../target.mjs';
import { formatTime, note, out, shortId, targetLine } from '../output.mjs';
import { parseDuration, timeWindow } from '../timewin.mjs';
import { ACTION_ALIASES, TRIGGER_ALIASES, actionTexts, buildSearchBody, clip, formatCost, formatRow, getExecDetail, resolveAlias, searchExecutions, summarizeRow } from '../execs.mjs';
import { execDir, findCachedExec, loadCachedDetail, saveDetail, saveNodes, saveSearch } from '../exec-store.mjs';
import { NODE_LINE_LIMIT, nodeLine, normalizeDetail } from '../exec-detail.mjs';
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
    down: args.down === true,
    up: args.up === true,
    event: strArg(args, 'event'),
    trigger: resolveAlias(TRIGGER_ALIASES, strArg(args, 'trigger'), 'trigger'),
    action: resolveAlias(ACTION_ALIASES, strArg(args, 'action'), 'action'),
    version,
    canary: typeof args.canary === 'boolean' ? args.canary : undefined,
    failed: args.failed === true,
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
  out(`时间 ${window.label}${cond ? ` · 条件：${cond}` : ''}`);
  if (filters.event) {
    const more = res.exhausted ? '（已扫完）' : `（没扫完：加 --scan ${Math.min(scanPages * 2, 50)} 接着扫，或缩小时间窗）`;
    out(`窗口内共 ${res.total ?? '?'} 条事件执行；扫了 ${res.scanned} 条，命中 ${res.matches.length} 条${more}`);
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

const EXEC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 找到这条执行属于哪个区 / 企业 / 智能体。查详情不需要 botId（09-24 核对），所以没给 --bot 时逐个企业试
async function locateExec(args, execId) {
  if (strArg(args, 'bot')) {
    const target = await resolveBot(targetArgs(args));
    const dir = execDir(target, execId);
    const cached = loadCachedDetail(dir);
    if (cached) return { target, dir, detail: cached };
    const detail = await getExecDetail(target.identity, target.orgId, execId, target.botId);
    if (!detail) {
      throw new MdError('exec_not_found', `${target.botName} 下找不到执行 ${execId}`, { exitCode: EXIT.TARGET, hint: '去掉 --bot，md 会在所有已取身份的企业里找' });
    }
    const owner = String(detail.canvasExec.botId ?? '');
    if (owner && owner !== target.botId) {
      throw new MdError('exec_other_bot', `执行 ${execId} 属于另一个智能体（${shortId(owner)}）`, { exitCode: EXIT.TARGET, hint: '去掉 --bot，md 会自己找到它属于哪个智能体' });
    }
    return { target, dir, detail: saveDetail(dir, target, detail), fresh: true };
  }
  const cached = findCachedExec(execId);
  if (cached) {
    const identity = loadIdentities()[cached.target.identityKey];
    if (!identity) {
      throw new MdError('no_identity', `这条执行属于「${cached.target.regionLabel}」，本机没有这个区的身份`, { exitCode: EXIT.AUTH, hint: '先取这个区的身份：md auth snippet <域名>' });
    }
    return { target: { ...cached.target, identity }, dir: cached.dir, detail: cached.detail };
  }
  for (const identity of requireIdentities()) {
    for (const org of identity.orgs) {
      let detail;
      try {
        detail = await getExecDetail(identity, org.id, execId);
      } catch (error) {
        if (error instanceof MdError && error.code === 'auth_expired') throw error;
        note(`（跳过 ${identity.label} / ${org.name}：${error.message}）`);
        continue;
      }
      if (!detail) continue;
      const botId = String(detail.canvasExec.botId ?? '');
      const entry = (await loadBotDirectory()).find((e) => e.botId === botId);
      const target = entry
        ? { ...entry, identity: loadIdentities()[entry.identityKey] ?? identity }
        : { identityKey: identity.key, regionLabel: identity.label, orgId: org.id, orgName: org.name, botId, botName: `智能体 ${shortId(botId)}`, identity };
      const dir = execDir(target, execId);
      return { target, dir, detail: saveDetail(dir, target, detail), fresh: true };
    }
  }
  throw new MdError('exec_not_found', `在已取身份的企业里都找不到执行 ${execId}`, { exitCode: EXIT.TARGET, hint: '执行 id 抄全了吗？如果是别的区的执行，先取那个区的身份' });
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
      ? renderChain(chain, rowsById, { windowLabel: `执行时间前后 ${Math.round(windowMs / 60_000)} 分钟`, truncated: pool.truncated })
      : ['事件链：取不到'];
  }
  const trigger = e.event ? `事件「${eventName || shortId(e.event.eventId)}」` : e.triggerType || '-';
  out(targetLine(target));
  out(`执行 ${e.execId} · ${formatTime(e.createdAt)} · ${trigger} · ${e.status} · 节点 ${norm.nodes.length} 个 · ${(e.ms / 1000).toFixed(1)}s · ${formatCost(e.cost)}${e.testRun ? ' · 测试执行' : ''}`);
  out(`触发：${clip(e.triggerText, 200) || '-'}`);
  out(`本条动作：${clip(actionTexts(e.outputActions).map((a) => a.text).join('；'), 300) || '无'}`);
  for (const line of chainLines) out(line);
  out('节点（按执行顺序）：');
  for (const n of norm.nodes.slice(0, NODE_LINE_LIMIT)) out(nodeLine(n));
  if (norm.nodes.length > NODE_LINE_LIMIT) out(`  …另有 ${norm.nodes.length - NODE_LINE_LIMIT} 个节点，见 ${join(dir, 'nodes.jsonl')}`);
  out(`详情：${join(dir, 'detail.json')} · 节点：${join(dir, 'nodes.jsonl')}`);
  out(`下一步：md exec ${e.execId} --node <节点|#序号>；--find "<文字>"；--vs-draft`);
  return EXIT.OK;
}

// Task 8 替换这三个
async function showNode() {
  throw usage('--node 还没实现');
}
async function showFind() {
  throw usage('--find 还没实现');
}
async function showDrift() {
  throw usage('--vs-draft 还没实现');
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
  if (args['vs-draft']) return showDrift(shown, norm);
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
