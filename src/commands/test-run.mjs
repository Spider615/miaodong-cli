// md test run <集>（spec §6.5）：跑前检查 → 预估 → 用户确认（§7）→ 建任务。建完不等：用 md test status --wait 盯着跑。

import { boolArg, intArg, strArg } from '../args.mjs';
import { EXIT, MdError } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { getCanvas, listEvents, listSessions, listVersions } from '../api.mjs';
import { resolveVersion } from '../target.mjs';
import { hashOf } from '../canvas.mjs';
import { dayKey, loadLimits, readSpends, recordSpend, spendDecision, spentOn, updateSpend, withSpendLock } from '../spend.mjs';
import { codeFor, givenCode, roundCost, stopForConfirm } from '../confirm.mjs';
import { createTask, listCases, recentTasks } from '../testcenter.mjs';
import { UNKNOWN_CASE_COST, preflight } from '../testcases.mjs';
import { readSources, resolveTestSet, testTarget, writeTaskRecord } from '../test-common.mjs';

const QUEUED = new Set(['pending', 'processing', 'running']);
const pad2 = (n) => String(n).padStart(2, '0');
const nowLabel = () => {
  const d = new Date();
  return `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
};

// 每条每轮的单价（spec §6.5）：这个测试集上次跑完的任务的平均花费 → 导入来源里源执行的平均花费 → 估不出
async function unitCost(t, set) {
  const last = (await recentTasks(t, { testSetId: set.testSetId, limit: 20 })).find((x) => x.status === 'finished' && typeof x.averageCostInCny === 'number');
  if (last) return { unit: last.averageCostInCny, basis: `上次跑完的任务「${last.name}」平均每条 ${formatCost(last.averageCostInCny)}` };
  const costs = Object.values(readSources(t, set.testSetId)).map((s) => s?.cost).filter((c) => typeof c === 'number');
  if (costs.length) {
    const unit = costs.reduce((a, b) => a + b, 0) / costs.length;
    return { unit, basis: `导入来源的 ${costs.length} 条执行平均 ${formatCost(unit)}` };
  }
  return { unit: null, basis: '' };
}

export async function run(args) {
  const t = await testTarget(args);
  const rounds = intArg(args, 'rounds', 1, 20);
  const concurrency = intArg(args, 'concurrency', 5, 20);
  const allowErrors = boolArg(args, 'allow-preflight-errors');
  const given = givenCode(args);
  const set = await resolveTestSet(t, args._[0]);
  const cases = await listCases(t, set.testSetId);
  if (!cases.length) throw new MdError('empty_set', `测试集「${set.name}」里没有用例`, { exitCode: EXIT.BLOCKED });

  // 跑哪张画布：默认草稿；--version 用那个版本的 canvasId（spec §6.5）。跑前检查也对着这张画布做
  const draft = await getCanvas(t.identity, t.orgId, t.botId);
  let canvasId = draft.canvasId;
  let label = '草稿';
  let canvas = draft.rawCanvas;
  const versionQuery = strArg(args, 'version');
  if (versionQuery) {
    const v = resolveVersion(await listVersions(t.identity, t.orgId, draft.canvasId), versionQuery);
    canvasId = v.canvasId;
    label = v.version;
    canvas = (await getCanvas(t.identity, t.orgId, t.botId, v.canvasId)).rawCanvas;
  }
  const [events, vars, recent] = await Promise.all([listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId), recentTasks(t, { limit: 20 })]);
  const pre = preflight(cases, { canvas, events, vars });
  const busy = recent.filter((x) => QUEUED.has(String(x.status)));
  const { unit, basis } = await unitCost(t, set);
  const runsCount = cases.length * rounds;
  const estimate = unit === null ? null : unit * runsCount;

  out(targetLine({ ...t, versionLabel: label }));
  out(`测试集「${set.name}」(${shortId(set.testSetId)})：${cases.length} 条 × ${rounds} 轮 = ${runsCount} 次 · 并发 ${concurrency}${pre.unreviewed ? ` · 未审核 ${pre.unreviewed} 条（照样会跑）` : ''}`);
  if (!events || !vars) out('⚠️ 取不到事件或会话变量列表：没法核对用例会不会空跑');
  if (pre.errors.length) {
    out(`❌ 跑前检查：${pre.errors.length} 处对不上（这些用例会「成功」但什么都没执行）：`);
    for (const e of pre.errors.slice(0, 20)) out(`  - ${e.name}：${e.reason}`);
    if (pre.errors.length > 20) out(`  …另有 ${pre.errors.length - 20} 处`);
  }
  if (pre.plugins.length) out(`⚠️ 画布上会真实调用的外部系统：${pre.plugins.join('、')}（测试中心里也会真的调）`);
  if (busy.length) out(`排队：这个智能体上还有 ${busy.length} 个任务没跑完（${busy.slice(0, 3).map((x) => `${x.name} ${x.status}`).join('、')}），新任务排在后面`);
  out(`花费：预计 ${estimate === null ? '估不出（参考：单条 ¥0–0.3）' : `${formatCost(estimate)}（${basis}）`} · 今天已花 ${formatCost(spentOn(readSpends()))} / 上限 ${formatCost(loadLimits().perDay)}`);
  if (pre.errors.length && !allowErrors) {
    throw new MdError('preflight_failed', `跑前检查有 ${pre.errors.length} 处对不上，没有建任务`, {
      exitCode: EXIT.BLOCKED,
      hint: '跨智能体的用例用 md test import … --from-bot <源智能体> 重新导（会按名字换 id）；确认要照跑加 --allow-preflight-errors',
    });
  }

  // 确认 + 记一笔（同 md trial：锁里做，先记预留）。测试估不出花费时一律要确认（spec §7）
  const name = strArg(args, 'name') ?? `${set.name}-${label}-${nowLabel()}`;
  const operation = { kind: 'test-run', botId: t.botId, testSetId: set.testSetId, canvasId, cases: hashOf(cases.map((c) => c.testCaseId).sort()), rounds, estimate: roundCost(estimate), external: pre.plugins, day: dayKey() };
  const plan = await withSpendLock(() => {
    const rows = readSpends();
    const limits = loadLimits();
    const decision = spendDecision({ estimate, externalCalls: pre.plugins }, { limits, today: spentOn(rows) });
    const confirm = codeFor(operation, rows);
    const confirmed = decision.needApproval && given === confirm.code;
    if (decision.needApproval && !confirmed) stopForConfirm({ ...confirm, given, reasons: decision.reasons });
    const id = recordSpend({
      kind: 'test', regionLabel: t.regionLabel, botId: t.botId, botName: t.botName, what: set.name, testSetId: set.testSetId,
      count: runsCount, estimate, reserve: estimate ?? UNKNOWN_CASE_COST * runsCount, basis: basis || '估不出', approved: confirmed ? 'confirm' : 'auto',
      ...(confirmed ? { opKey: confirm.opKey, code: confirm.code } : {}),
    });
    return { id, confirmed, limits };
  });
  if (plan.confirmed) out('（用户已确认这一笔）');

  let testTaskId;
  try {
    testTaskId = await createTask(t, { testSetId: set.testSetId, canvasId, name, rounds, concurrency });
  } catch (error) {
    // 明确被拒（业务错误、4xx）就是没建成，这一笔记 0；结果不明（5xx、超时）的保留预留，让用户先看任务列表
    const refused = error instanceof MdError && (error.code === 'business' || (error.code === 'upstream' && error.status >= 400 && error.status < 500));
    if (refused) {
      updateSpend(plan.id, { actual: 0, runs: 0 });
      throw error;
    }
    throw new MdError(error?.code ?? 'upstream', String(error?.message ?? error), { hint: `任务可能已经建了：md test status --bot ${shortId(t.botId)} 看最近的任务，不要重跑` });
  }
  // 止损额度（md test status --wait 用）：自动放行的按单次门槛；用户确认过的按「确认的金额 + 一个单次门槛」；
  // 确认的是「估不出」的，按参考单价 × 次数 + 一个单次门槛
  const allowance = !plan.confirmed ? plan.limits.perCommand : (estimate ?? UNKNOWN_CASE_COST * runsCount) + plan.limits.perCommand;
  writeTaskRecord(t, { testTaskId, testSetId: set.testSetId, testSetName: set.name, name, canvasId, label, rounds, cases: cases.length, estimate, spendId: plan.id, allowance, createdAt: new Date().toISOString() });
  updateSpend(plan.id, { taskId: testTaskId });
  out(`已建任务 ${name}（${testTaskId}）：跑的是${label}，${cases.length} 条 × ${rounds} 轮`);
  out(`下一步：md test status ${shortId(testTaskId)} --bot ${shortId(t.botId)} --wait（每 15 秒看一次；按实际花费推算超出额度会自动暂停）`);
  return EXIT.OK;
}
