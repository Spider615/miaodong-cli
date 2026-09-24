// md spend：看花费（今天、最近几天、每一笔），改门槛。改门槛本身也要用户本人批准——否则 AI 被拦下后可以自己把门槛调高。

import { intArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { formatTime, out } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { loadLimits, readSpends, saveLimits, spentOn } from '../spend.mjs';
import { requestApproval } from '../approve.mjs';

const KIND = { trial: '试跑', test: '测试' };
const APPROVED = { auto: '自动', dialog: '弹窗同意', tty: '终端同意' };

function moneyArg(args, key) {
  const v = strArg(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw usage(`--${key} 要写金额（元），收到「${v}」`);
  return n;
}

export async function changeLimits(args, { approve = requestApproval } = {}) {
  const perCommand = moneyArg(args, 'per-command');
  const perDay = moneyArg(args, 'per-day');
  if (perCommand === undefined && perDay === undefined) throw usage('要给 --per-command 和 / 或 --per-day（单位：元）');
  const before = loadLimits();
  const next = { perCommand: perCommand ?? before.perCommand, perDay: perDay ?? before.perDay };
  const approval = await approve({
    title: 'md：改花费门槛',
    lines: [
      `单次门槛：${formatCost(before.perCommand)} → ${formatCost(next.perCommand)}`,
      `每日上限：${formatCost(before.perDay)} → ${formatCost(next.perDay)}`,
      '',
      '由 AI 发起；只有你本人能点「同意」。',
    ],
  });
  if (!approval.ok) throw new MdError('not_approved', `门槛没改：${approval.reason}`, { exitCode: EXIT.BLOCKED });
  saveLimits(next);
  out(`花费门槛已改：单次 ${formatCost(next.perCommand)}，每日 ${formatCost(next.perDay)}`);
  return EXIT.OK;
}

function showSpend(args) {
  const limits = loadLimits();
  const rows = readSpends().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const days = intArg(args, 'days', 7, 90);
  out(`今天已花 ${formatCost(spentOn(rows))} / 每日上限 ${formatCost(limits.perDay)}（单次门槛 ${formatCost(limits.perCommand)}）`);
  const perDay = [];
  for (let i = 0; i < days; i++) {
    const when = Date.now() - i * 86_400_000;
    const sum = spentOn(rows, when);
    if (sum > 0) perDay.push(`${formatTime(when).slice(5, 10)} ${formatCost(sum)}`);
  }
  out(`最近 ${days} 天：${perDay.length ? perDay.join(' · ') : '没有花费'}`);
  const recent = rows.slice(-intArg(args, 'limit', 10, 200)).reverse();
  if (recent.length) out('最近几笔：');
  for (const r of recent) {
    const estimate = typeof r.estimate === 'number' ? formatCost(r.estimate) : '估不出';
    const actual = typeof r.actual === 'number' ? formatCost(r.actual) : '还没有';
    out(`  ${formatTime(r.at)} ${KIND[r.kind] ?? r.kind} ${r.regionLabel ?? '-'} / ${r.botName ?? '-'}「${r.what ?? '-'}」×${r.count ?? 1} 预估 ${estimate} 实际 ${actual}（${APPROVED[r.approved] ?? r.approved ?? '-'}）`);
  }
  return EXIT.OK;
}

export const spend = {
  summary: '花费：今天花了多少、最近几天、每一笔；spend limit 改门槛（要用户本人在弹窗里同意）',
  usage: [
    'md spend [--days 7] [--limit 10]',
    'md spend limit --per-command <元> --per-day <元>     改门槛：要用户本人在弹窗里点同意',
  ].join('\n'),
  async run(args) {
    if (args._[0] === 'limit') return changeLimits(args);
    if (args._[0]) throw usage(`不认识「${args._[0]}」`, '用 md spend 或 md spend limit');
    return showSpend(args);
  },
};
