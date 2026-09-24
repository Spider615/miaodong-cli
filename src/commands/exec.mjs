// md exec：查执行记录。不给执行 id 是「搜」，给了是「看一条」。
// 看一条时自动串事件链：一条用户消息常被拆成几条执行，回复在后面那条里（会话里两天各重新发现过一次）。

import { intArg, strArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { getCanvas, listVersions } from '../api.mjs';
import { resolveBot, resolveVersion, targetArgs } from '../target.mjs';
import { note, out, targetLine } from '../output.mjs';
import { timeWindow } from '../timewin.mjs';
import { ACTION_ALIASES, TRIGGER_ALIASES, buildSearchBody, formatRow, resolveAlias, searchExecutions, summarizeRow } from '../execs.mjs';
import { saveSearch } from '../exec-store.mjs';

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

async function viewExec() {
  throw usage('看单条执行还没实现');
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
