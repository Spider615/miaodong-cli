// md test resume <任务>：继续被暂停的任务（止损暂停的、md test stop 暂停的、页面上暂停的）。继续就是多花钱：
// 每次先预演——剩几条、按已跑完的实际单价估其余花费、今天已花——给计划码；用户同意后带 --confirm <码> 才继续。
// 以前只能重新 md test run，已经跑完的条目要再花一次钱。
// 继续后把本机的任务记录改成「用户确认过、额度 = 已花 + 这次确认的 + 一个单次门槛」：md test status --wait 的止损按新额度算，
// 不会一看进度就又被暂停；账本里这个任务那一笔重新挂上预留，跑完照常按秒懂给的总额记实际

import { EXIT, MdError } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { dayKey, loadLimits, readSpends, recordSpend, spentOn, updateSpend, withSpendLock } from '../spend.mjs';
import { codeFor, givenCode, roundCost } from '../confirm.mjs';
import { resumeTask, taskDetail, taskItems } from '../testcenter.mjs';
import { UNKNOWN_CASE_COST } from '../testcases.mjs';
import { readTaskRecord, testTarget, writeTaskRecord } from '../test-common.mjs';
import { judgeFee, progressOf, resolveTask } from './test-run.mjs';

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
  const p = progressOf(detail, await taskItems(t, task.testTaskId), judgeFee(t, detail?.testSetId));
  const remaining = Math.max(0, p.total - p.done);
  const rec = readTaskRecord(t, task.testTaskId);
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

  // 先记账再继续（同 md test run 先记预留再建任务）。这个任务是 md 建的：它那一笔重新挂上预留（已花 + 这次确认的），
  // 另记一笔只存确认信息、实际记 0；不是 md 建的：记一笔带预留的，之后看进度时按它记实际
  const before = rec;
  const plan = await withSpendLock(() => {
    const approval = { approved: 'confirm', opKey, code };
    if (rec?.spendId) {
      updateSpend(rec.spendId, { actual: null, reserve: p.spent + reserve });
      recordSpend({ kind: 'test', regionLabel: t.regionLabel, botId: t.botId, botName: t.botName, what: `继续 ${name}`, testSetId: detail?.testSetId, taskId: task.testTaskId, count: remaining, estimate, reserve: 0, actual: 0, chargedTo: rec.spendId, basis: '花费记在原任务那一笔', ...approval });
      return { spendId: rec.spendId };
    }
    const spendId = recordSpend({ kind: 'test', regionLabel: t.regionLabel, botId: t.botId, botName: t.botName, what: `继续 ${name}`, testSetId: detail?.testSetId, taskId: task.testTaskId, count: remaining, estimate, reserve: p.spent + reserve, basis: estimate === null ? '估不出' : '按已跑完的实际单价', ...approval });
    return { spendId };
  });
  writeTaskRecord(t, {
    ...(rec ?? { testTaskId: task.testTaskId, testSetId: detail?.testSetId, testSetName: '', name, rounds: Number(detail?.repeatTimes) || 1, createdAt: new Date().toISOString() }),
    spendId: plan.spendId, unit, confirmed: true, allowance: p.spent + reserve + limits.perCommand, lastReserve: p.spent + reserve, settled: null,
  });
  try {
    await resumeTask(t, task.testTaskId);
  } catch (error) {
    // 明确被拒（业务错误、4xx）就是没继续：账本和本机记录恢复原样。结果不明（5xx、超时）的保留，让用户先看任务状态
    const refused = error instanceof MdError && (error.code === 'business' || (error.code === 'upstream' && error.status >= 400 && error.status < 500));
    if (refused) {
      if (before?.spendId) updateSpend(before.spendId, { actual: before.settled?.actual ?? p.spent, reserve: before.lastReserve ?? before.reserve ?? p.spent });
      if (before) writeTaskRecord(t, before);
      throw error;
    }
    throw new MdError(error?.code ?? 'upstream', String(error?.message ?? error), { exitCode: error?.exitCode, hint: `任务可能已经继续了：md test status ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} 看一下，不要重复继续` });
  }
  out(`已继续任务 ${name}（${shortId(task.testTaskId)}）：剩下 ${remaining} 条；止损额度调成 ${formatCost(p.spent + reserve + limits.perCommand)}（已花 + 这次确认的 + 一个单次门槛）`);
  out(`下一步：md test status ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} --wait`);
  return EXIT.OK;
}
