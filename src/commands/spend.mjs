// md spend：看花费（今天、最近几天、每一笔），改门槛。调高门槛也要用户确认——否则 AI 被拦下后可以自己把门槛调高；调低只会更严，直接生效。

import { intArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { formatTime, out } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { dayKey, loadLimits, readSpends, saveLimits, spentOn } from '../spend.mjs';
import { confirmCode, givenCode } from '../confirm.mjs';

const KIND = { trial: '试跑', flow: '整条试跑', test: '测试' };
const APPROVED = { auto: '自动', confirm: '用户确认' };

function moneyArg(args, key) {
  const v = strArg(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw usage(`--${key} 要写金额（元），收到「${v}」`);
  return n;
}

function changeLimits(args) {
  const perCommand = moneyArg(args, 'per-command');
  const perDay = moneyArg(args, 'per-day');
  if (perCommand === undefined && perDay === undefined) throw usage('要给 --per-command 和 / 或 --per-day（单位：元）');
  const given = givenCode(args);
  const before = loadLimits();
  const next = { perCommand: perCommand ?? before.perCommand, perDay: perDay ?? before.perDay };
  out(`单次门槛：${formatCost(before.perCommand)} → ${formatCost(next.perCommand)}`);
  out(`每日上限：${formatCost(before.perDay)} → ${formatCost(next.perDay)}`);
  if (next.perCommand === before.perCommand && next.perDay === before.perDay) {
    out('门槛没变');
    return EXIT.OK;
  }
  if (next.perCommand > before.perCommand || next.perDay > before.perDay) {
    const code = confirmCode({ kind: 'limit', before, next, day: dayKey() });
    if (given !== code) {
      out(`确认码：${code}`);
      throw new MdError(given === null ? 'confirm_needed' : 'confirm_mismatch', given === null ? '调高门槛要用户确认，门槛没改' : `确认码对不上（给的是 ${given || '空'}，当前是 ${code}），门槛没改`, {
        exitCode: EXIT.BLOCKED,
        hint: `把新旧门槛单独告诉用户（不要夹在别的问题里）；用户明确同意后，同一条命令加 --confirm ${code}`,
      });
    }
  }
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
    const unknown = r.unknownRuns ? `（另有 ${r.unknownRuns} 次花费不知道，按 ${formatCost(r.assumed)} 记）` : '';
    // 继续暂停的任务那一笔只记确认信息，钱记在原任务那一笔（md test resume）
    const actual = r.chargedTo ? '记在原任务那一笔' : typeof r.actual === 'number' ? `${formatCost(r.actual)}${unknown}` : '还没有';
    out(`  ${formatTime(r.at)} ${KIND[r.kind] ?? r.kind} ${r.regionLabel ?? '-'} / ${r.botName ?? '-'}「${r.what ?? '-'}」×${r.count ?? 1} 预估 ${estimate} 实际 ${actual}（${APPROVED[r.approved] ?? r.approved ?? '-'}）`);
  }
  return EXIT.OK;
}

export const spend = {
  summary: '花费：今天花了多少、最近几天、每一笔；spend limit 改门槛（调高要用户确认）',
  usage: [
    'md spend [--days 7] [--limit 10]',
    'md spend limit --per-command <元> --per-day <元> [--confirm <码>]   改门槛：调高要用户确认（先给确认码），调低直接生效',
  ].join('\n'),
  async run(args) {
    if (args._[0] === 'limit') return changeLimits(args);
    if (args._[0]) throw usage(`不认识「${args._[0]}」`, '用 md spend 或 md spend limit');
    return showSpend(args);
  },
};
