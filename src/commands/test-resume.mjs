// md test resume <任务>：继续被暂停的任务（止损暂停的、md test stop 暂停的、页面上暂停的）。继续就是多花钱：
// 每次先预演——剩几条、按已跑完的实际单价估其余花费、今天已花——给计划码；用户同意后带 --confirm <码> 才继续。
// 以前只能重新 md test run，已经跑完的条目要再花一次钱。
//
// 账本：继续那天另记一笔「继续」，预留 = 剩下的估价；跑完这一笔的实际 = 任务总额 − 继续前已经记在账上的（offset）。
// md 建的任务，原来那一笔停在继续前的实际。以前把预留挂回原来那一笔：隔天继续时钱记到了建任务那天，今天的每日上限看不到（整支审查 1）。
// 不是 md 建的任务，继续之前花的不是 md 的账，不算进今天。
// 本机任务记录改成「用户确认过、额度 = 已花 + 这次确认的 + 一个单次门槛」：md test status --wait 的止损按新额度算，不会一看进度就又暂停。

import { EXIT, MdError } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { dayKey, loadLimits, readSpends, recordSpend, spentOn, updateSpend, withSpendLock } from '../spend.mjs';
import { codeFor, givenCode, roundCost } from '../confirm.mjs';
import { resumeTask, taskDetail, taskItems } from '../testcenter.mjs';
import { UNKNOWN_CASE_COST } from '../testcases.mjs';
import { readTaskRecord, taskCaseCount, testTarget, writeTaskRecord } from '../test-common.mjs';
import { judgeFee, progressOf, resolveTask } from './test-run.mjs';

// 这些错误是明确没继续（被拒、身份失效、企业到期、积分不足）：继续那一笔记 0，原样报错（身份类的提示要留着）
const refused = (error) => error instanceof MdError
  && (['auth_expired', 'org_expired', 'points_exhausted', 'business'].includes(error.code) || (error.code === 'upstream' && error.status >= 400 && error.status < 500));

export async function resume(args) {
  const t = await testTarget(args);
  const given = givenCode(args);
  const task = await resolveTask(t, args._[0]);
  out(targetLine(t));
  const detail = await taskDetail(t, task.testTaskId);
  const name = detail?.name ?? task.name;
  const status = String(detail?.status ?? task.status);
  if (status !== 'paused') {
    out(`任务 ${name}（${shortId(task.testTaskId)}）已经是 ${status}，只有暂停的任务能继续`);
    return EXIT.OK;
  }
  const rec = readTaskRecord(t, task.testTaskId);
  const p = progressOf(detail, await taskItems(t, task.testTaskId), judgeFee(t, detail?.testSetId), rec?.cases ?? null);
  const remaining = Math.max(0, p.total - p.done);
  const unit = p.unit ?? rec?.unit ?? null;
  const estimate = unit === null ? null : unit * remaining;
  const reserve = estimate ?? UNKNOWN_CASE_COST * remaining;
  const limits = loadLimits();
  out(`任务 ${name}（${shortId(task.testTaskId)}）暂停中：已跑完 ${p.done}/${p.total} 条，花了 ${formatCost(p.spent)}；剩下 ${remaining} 条${estimate === null ? `估不出花费（参考：单条 ¥0–0.3，按 ${formatCost(reserve)} 预留）` : `按每条 ${formatCost(unit)} 估要 ${formatCost(estimate)}`}`);
  out(`今天已花 ${formatCost(spentOn(readSpends()))} / 上限 ${formatCost(limits.perDay)}`);

  // 计划码绑定任务、进度和预估：预演之后任务又跑了几条、单价变了，码就对不上；用过一次也作废（记在账本里）
  const operation = { kind: 'test-resume', botId: t.botId, testTaskId: task.testTaskId, done: p.done, total: p.total, estimate: roundCost(estimate), day: dayKey() };
  const { opKey, code } = codeFor(operation, readSpends());
  if (given === null) {
    out(`这是预演，什么都没写。计划码：${code}`);
    out(`把其余 ${remaining} 条的花费单独告诉用户，用户明确同意后执行：md test resume ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} --confirm ${code}`);
    return EXIT.OK;
  }
  if (given !== code) {
    throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：预演之后任务的进度或花费变了、这个码已经用过，或者计划码抄错了`, {
      exitCode: EXIT.BLOCKED,
      hint: '重新预演一次，把新的预估单独给用户看',
    });
  }

  // 继续前已经记在账上的（按任务总额算）：md 建的是原来那一笔结算的实际（没结算过的现在按已跑完的结算）；不是 md 建的是全部已花
  const accounted = rec?.spendId ? rec.settled?.actual ?? p.spent : p.spent;
  // 先记账再继续（同 md test run 先记预留再建任务）
  const row = await withSpendLock(() => {
    if (rec?.spendId && !rec.settled) updateSpend(rec.spendId, { actual: Math.max(0, accounted - (rec.offset ?? 0)), runs: p.done, allIn: true });
    return recordSpend({
      kind: 'test', regionLabel: t.regionLabel, botId: t.botId, botName: t.botName, what: `继续 ${name}`, testSetId: detail?.testSetId, taskId: task.testTaskId,
      count: remaining, estimate, reserve, basis: estimate === null ? '估不出' : '按已跑完的实际单价', approved: 'confirm', opKey, code,
    });
  });
  const settledBefore = rec?.spendId && !rec.settled ? { ...rec, settled: { status: 'paused', actual: accounted } } : rec;
  const next = {
    ...(rec ?? { testTaskId: task.testTaskId, testSetId: detail?.testSetId, testSetName: '', name, rounds: Number(detail?.repeatTimes) || 1, cases: taskCaseCount(detail), createdAt: new Date().toISOString() }),
    spendId: row, offset: accounted, unit, confirmed: true, allowance: p.spent + reserve + limits.perCommand,
    lastReserve: reserve, lastUnit: p.unit, settled: null, resumedAt: new Date().toISOString(),
  };
  try {
    await resumeTask(t, task.testTaskId);
  } catch (error) {
    if (refused(error)) {
      updateSpend(row, { actual: 0, runs: 0 });
      if (settledBefore) writeTaskRecord(t, settledBefore);
      throw error;
    }
    // 结果不明（5xx、超时）：可能已经继续了，按继续了记，让用户先看任务状态
    writeTaskRecord(t, next);
    throw new MdError(error?.code ?? 'upstream', String(error?.message ?? error), { exitCode: error?.exitCode, hint: `任务可能已经继续了：md test status ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} 看一下，不要重复继续` });
  }
  writeTaskRecord(t, next);
  out(`已继续任务 ${name}（${shortId(task.testTaskId)}）：剩下 ${remaining} 条；止损额度调成 ${formatCost(next.allowance)}（已花 + 这次确认的 + 一个单次门槛）`);
  out(`下一步：md test status ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} --wait`);
  return EXIT.OK;
}
