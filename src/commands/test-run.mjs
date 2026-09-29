// md test run <集>（spec §6.5）：跑前检查 → 预估 → 用户确认（§7）→ 建任务。建完不等：用 md test status --wait 盯着跑。

import { boolArg, intArg, listArg, strArg } from '../args.mjs';
import { EXIT, MdError } from '../errors.mjs';
import { formatTime, note, out, shortId, targetLine } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { asArray, getCanvas, listEvents, listSessions, listVersions } from '../api.mjs';
import { resolveVersion } from '../target.mjs';
import { hashOf } from '../canvas.mjs';
import { dayKey, loadLimits, readSpends, recordSpend, spendDecision, spentOn, updateSpend, withSpendLock } from '../spend.mjs';
import { codeFor, givenCode, roundCost, stopForConfirm } from '../confirm.mjs';
import { createTask, listCases, pauseTask, recentTasks, taskDetail, taskItems } from '../testcenter.mjs';
import { UNKNOWN_CASE_COST, preflight } from '../testcases.mjs';
import { isNoop } from '../testresults.mjs';
import { pickCases, readSources, readTaskRecord, resolveTestSet, taskCaseCount, testTarget, writeTaskRecord } from '../test-common.mjs';
import { envPollMs } from '../poll.mjs';

const QUEUED = new Set(['pending', 'processing', 'running']);
const pad2 = (n) => String(n).padStart(2, '0');
const nowLabel = () => {
  const d = new Date();
  return `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
};

// 断言判定费（09-29 实测）：秒懂任务总额比逐条花费（test-task-item.costInCny）多出断言判定的钱——177 条、1052 条动作断言，
// 总额 ¥68.96、逐条合计 ¥56.92，多 ¥12.04，约每条断言 ¥0.0114。逐条花费里没有这笔：只按逐条算，止损推算、「已完成的」
// 和下次的估价都偏低约两成。跑的过程中按「已判的断言数 × 每条断言的判定费」补上；任务跑完用总额反推出实际的判定费记进账本
export const JUDGE_FEE_PER_ASSERTION = 0.012;
const assertionResults = (item) => asArray(item?.canvasActionOutputAssertionResult).length + asArray(item?.testNodeOutputAssertionResult).length;
const caseAssertions = (c) => asArray(c?.canvasActionOutputAssertions).length + asArray(c?.testNodeOutputAssertions).length;

// 每条断言的判定费：先用这个集上次跑完反推出来的，再用这个智能体的，都没有就按 09-29 的实测值
export function judgeFee(t, testSetId) {
  const rows = readSpends().filter((r) => r.kind === 'test' && r.botId === t.botId && typeof r.judgePerAssertion === 'number' && r.judgePerAssertion >= 0);
  const hit = rows.filter((r) => r.testSetId === testSetId).at(-1) ?? rows.at(-1);
  return hit ? hit.judgePerAssertion : JUDGE_FEE_PER_ASSERTION;
}

// 每条每轮的单价（spec §6.5，审查 C1）。取下面两项里大的：
// - 账本里这个集最近观察到的单价：md 看进度时记下的（包括被止损暂停的任务），之后换了模型也会被它纠正；
// - 这个集上次跑完的任务：总花费 ÷ 真正执行了的条数（averageCostInCny 把空跑也算进分母，空跑多就被稀释，spec §2.3）。
// 两项都没有才看导入来源里源执行的平均花费；都没有就估不出。单价是 0 也当估不出：多半是那次全空跑
// （spec §1 那次「100 条 8.9 秒跑完、花费 ¥0」），拿它估价会让下一批不经确认就跑；真正免费的集每次多问一句
// 只含执行花费的来源（旧账本里的单价、导入来源的执行花费）要补上断言判定费：按这个集每条用例的断言数算
async function unitCost(t, set, cases) {
  const candidates = [];
  const judging = cases.length ? (cases.reduce((n, c) => n + caseAssertions(c), 0) / cases.length) * judgeFee(t, set.testSetId) : 0;
  const seen = readSpends().filter((r) => r.kind === 'test' && r.botId === t.botId && r.testSetId === set.testSetId && typeof r.actualPerRun === 'number' && r.actualPerRun > 0).at(-1);
  if (seen) {
    // allIn：09-29 起记下的单价已经含判定费；之前的只有逐条花费
    const unit = seen.allIn ? seen.actualPerRun : seen.actualPerRun + judging;
    candidates.push({ unit, basis: `上次盯着跑时观察到每条 ${formatCost(unit)}${seen.allIn ? '' : '（加上断言判定）'}` });
  }
  const last = (await recentTasks(t, { testSetId: set.testSetId, limit: 20 })).find((x) => x.status === 'finished');
  if (last && typeof last.totalCostInCny === 'number' && last.totalCostInCny > 0) {
    const executed = (await taskItems(t, last.testTaskId)).filter((i) => typeof i.costInCny === 'number' && !isNoop(i)).length;
    if (executed) {
      const unit = last.totalCostInCny / executed;
      candidates.push({ unit, basis: `上次跑完的任务「${last.name}」真正执行的 ${executed} 条平均 ${formatCost(unit)}` });
    }
  }
  if (candidates.length) return candidates.reduce((a, b) => (b.unit > a.unit ? b : a));
  const costs = Object.values(readSources(t, set.testSetId).execs).map((x) => x?.cost).filter((c) => typeof c === 'number' && c > 0);
  if (costs.length) {
    const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
    return { unit: avg + judging, basis: `导入来源的 ${costs.length} 条执行平均 ${formatCost(avg)}，加上断言判定约 ${formatCost(judging)}/条` };
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
  const all = await listCases(t, set.testSetId);
  if (!all.length) throw new MdError('empty_set', `测试集「${set.name}」里没有用例`, { exitCode: EXIT.BLOCKED });
  // --case：只跑挑出来的几条（先跑 1 条看看对不对）；跑前检查、预估、确认码都只算这几条
  const picks = listArg(args, 'case');
  const cases = picks.length ? pickCases(all, picks, { set, botId: t.botId }) : all;

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
  const { unit, basis } = await unitCost(t, set, cases);
  const runsCount = cases.length * rounds;
  const estimate = unit === null ? null : unit * runsCount;

  out(targetLine({ ...t, versionLabel: label }));
  const size = picks.length ? `挑出来的 ${cases.length} 条（集里共 ${all.length} 条）` : `${cases.length} 条`;
  out(`测试集「${set.name}」(${shortId(set.testSetId)})：${size} × ${rounds} 轮 = ${runsCount} 次 · 并发 ${concurrency}${pre.unreviewed ? ` · 未审核 ${pre.unreviewed} 条（照样会跑）` : ''}`);
  if (pre.errors.length) {
    const why = [
      pre.errors.some((e) => e.kind !== 'assertion') ? '触发、会话变量对不上的用例会「成功」但什么都没执行' : '',
      pre.errors.some((e) => e.kind === 'assertion') ? '断言里引用的对不上，那条断言永远不过' : '',
    ].filter(Boolean).join('；');
    out(`❌ 跑前检查：${pre.errors.length} 处对不上（${why}）：`);
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
    testTaskId = await createTask(t, { testSetId: set.testSetId, canvasId, name, rounds, concurrency, ...(picks.length ? { selectedTestCaseIds: cases.map((c) => c.testCaseId) } : {}) });
  } catch (error) {
    // 身份失效、企业到期、积分不足、明确被拒（业务错误、4xx）都是没建成：这一笔记 0，身份类原样报（退出码 3 让用户重新取身份，审查 M3）。
    // 结果不明（5xx、超时）的保留预留，让用户先看任务列表
    if (error instanceof MdError && ['auth_expired', 'org_expired', 'points_exhausted'].includes(error.code)) {
      updateSpend(plan.id, { actual: 0, runs: 0 });
      throw error;
    }
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
  writeTaskRecord(t, {
    testTaskId, testSetId: set.testSetId, testSetName: set.name, name, canvasId, label, rounds, cases: cases.length,
    estimate, unit, reserve: estimate ?? UNKNOWN_CASE_COST * runsCount, confirmed: plan.confirmed, spendId: plan.id, allowance, createdAt: new Date().toISOString(),
  });
  updateSpend(plan.id, { taskId: testTaskId });
  out(`已建任务 ${name}（${testTaskId}）：跑的是${label}，${cases.length} 条 × ${rounds} 轮`);
  out(`下一步：md test status ${shortId(testTaskId)} --bot ${shortId(t.botId)} --wait（每 15 秒看一次；按实际花费推算超出额度会自动暂停）`);
  return EXIT.OK;
}

const TERMINAL = new Set(['finished', 'paused', 'failed', 'error', 'cancelled', 'canceled']);
const pollMs = () => envPollMs('MD_TEST_POLL_MS', 15_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 找任务：完整 id、id 前缀（至少 4 位）、任务名，在最近 50 个里找；给了完整 id 却不在里面，就直接查 detail
export async function resolveTask(t, query) {
  const q = String(query ?? '').trim();
  if (!q) throw new MdError('usage', '缺任务：给任务 id、id 前缀或任务名', { exitCode: EXIT.USAGE });
  const rows = await recentTasks(t, { limit: 50 });
  const hits = rows.filter((x) => x.testTaskId === q || (q.length >= 4 && String(x.testTaskId).startsWith(q)) || x.name === q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new MdError('task_ambiguous', `「${q}」匹配到 ${hits.length} 个任务：${hits.slice(0, 5).map((x) => `${x.name}(${shortId(x.testTaskId)})`).join('、')}`, { exitCode: EXIT.TARGET, hint: '用更长的 id 前缀' });
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
    const detail = await taskDetail(t, q);
    if (detail) return detail;
  }
  throw new MdError('task_not_found', `${t.botName} 最近的任务里没有「${q}」`, { exitCode: EXIT.TARGET, hint: `md test status --bot ${shortId(t.botId)} 看最近的任务` });
}

// 进度：跑完的条目数、通过、空跑（spec §2.3：没有执行、花费为空）、正在跑的、已完成条目的花费和平均（空跑不进平均）。
// 花费含断言判定费：逐条花费里没有这笔，按已判的断言数 × 每条断言的判定费补上（09-29 实测）。
// cases：md 建任务时记下的条数（--case 只跑几条时，任务详情带不带 selectedTestCaseIds 没实测，不能靠它）
export function progressOf(detail, items, fee = JUDGE_FEE_PER_ASSERTION, cases = null) {
  const done = items.filter((i) => i?.status && !['pending', 'processing'].includes(i.status));
  const costs = done.map((i) => i.costInCny).filter((c) => typeof c === 'number');
  const execSpent = costs.reduce((a, b) => a + b, 0);
  const judged = done.reduce((n, i) => n + assertionResults(i), 0);
  const judging = judged * fee;
  return {
    total: Math.max(items.length, (cases ?? taskCaseCount(detail)) * (Number(detail?.repeatTimes) || 1)),
    done: done.length,
    inflight: items.filter((i) => i?.status === 'processing').length,
    passed: done.filter((i) => i.passed === true).length,
    noop: done.filter((i) => i.canvasExecAvailable === false && (i.costInCny === null || i.costInCny === undefined)).length,
    costed: costs.length,
    execSpent,
    judged,
    judging,
    spent: execSpent + judging,
    unit: costs.length ? execSpent / costs.length + (done.length ? judging / done.length : 0) : null,
  };
}

function statusLine(detail, p) {
  const cost = typeof detail?.totalCostInCny === 'number' ? formatCost(detail.totalCostInCny) : `已完成的 ${formatCost(p.spent)}${p.judging ? `（含断言判定约 ${formatCost(p.judging)}）` : ''}`;
  return `${detail?.name ?? ''} ${detail?.status} · ${p.done}/${p.total} · 通过 ${p.passed}${p.noop ? ` · 空跑 ${p.noop}` : ''} · ${cost}`;
}

// 任务停下来了没有。刚用 md test resume 继续的任务，秒懂的状态可能还没从 paused 变过来：这一阵的 paused 不算停下，
// 不然 --wait 一看就结束、账本把继续那一笔结算成 0（整支审查 3）
const RESUME_GRACE_MS = 60_000;
export function stopped(detail, rec) {
  const status = String(detail?.status);
  if (!TERMINAL.has(status)) return false;
  return !(status === 'paused' && rec?.resumedAt && Date.now() - Date.parse(rec.resumedAt) < RESUME_GRACE_MS);
}

// 止损（同 md trial 的逐次止损，审查 C1 / I2）：md 建的任务，按已完成条目的实际单价推算整个任务，
// 超过额度（自动放行的是单次门槛；用户确认过的是确认的金额 + 一个单次门槛）就暂停；自动放行的还看每日上限。
// 每次看进度都判断，不带 --wait 也判断
function stopLoss(t, rec, detail, p) {
  if (!rec || stopped(detail, rec) || String(detail?.status) === 'paused' || p.unit === null) return null;
  const projected = p.spent + (p.total - p.done) * p.unit;
  const head = `按已跑完的 ${p.done} 条平均 ${formatCost(p.unit)} 推算${p.judging ? '（含断言判定）' : ''}，整个任务要 ${formatCost(projected)}`;
  if (projected > rec.allowance) return `${head}，超过额度 ${formatCost(rec.allowance)}`;
  if (!rec.confirmed) {
    const limits = loadLimits();
    const others = spentOn(readSpends().filter((r) => r.id !== rec.spendId));
    if (others + projected > limits.perDay) return `${head}，加上今天别的花费 ${formatCost(others)} 超过每日上限 ${formatCost(limits.perDay)}`;
  }
  return null;
}

// 账本跟着实际走（审查 C1）：每次看进度都把观察到的写回 md 记着的那一笔——
// 跑的过程中，预留 = max(原预留, 已花 + 没跑的 × 单价)，并记下观察到的单价（下次 md test run 按它估价）；
// 任务停下来（跑完、暂停、失败）就记实际：跑完用秒懂给的总花费，别的按已完成条目的花费 + 正在跑的按单价。
// 同样的结果只写一次；之后状态或花费变了（比如暂停的任务后来又跑完了），再按新结果记。
// offset：继续过的任务，继续之前的花费记在别的笔里（原任务那一笔，或者不是 md 的账），这一笔只记继续之后的（md test resume）。
// 结算过又跑起来了（页面上点了继续）：实际清掉、重新挂预留，不然账本看到有实际就不看预留，今天已花少算（整支审查 3）
function observe(t, detail, p) {
  const rec = readTaskRecord(t, detail?.testTaskId);
  if (!rec?.spendId) return;
  const offset = rec.offset ?? 0;
  const unit = p.unit ?? rec.unit ?? UNKNOWN_CASE_COST;
  const status = String(detail?.status);
  if (stopped(detail, rec)) {
    const total = status === 'finished' && typeof detail.totalCostInCny === 'number' ? detail.totalCostInCny : null;
    const actual = total ?? p.spent + p.inflight * unit;
    if (rec.settled?.status === status && rec.settled?.actual === actual) return;
    // 跑完了：总额里含断言判定费，用它反推每条断言的判定费（下次看进度按它补），单价也按总额 ÷ 真正执行的条数记（和估价的算法一样）
    const learned = total !== null && p.judged > 0 ? { judgePerAssertion: Math.max(0, total - p.execSpent) / p.judged } : {};
    const perRun = total !== null && p.costed ? total / p.costed : p.unit;
    updateSpend(rec.spendId, { actual: Math.max(0, actual - offset), runs: p.done, allIn: true, ...(perRun !== null ? { actualPerRun: perRun } : {}), ...learned });
    writeTaskRecord(t, { ...rec, settled: { status, actual } });
    return;
  }
  const projected = p.spent + (p.total - p.done) * unit;
  const reserve = Math.max(rec.lastReserve ?? rec.reserve ?? 0, projected - offset);
  if (!rec.settled && reserve === rec.lastReserve && p.unit === rec.lastUnit) return;
  updateSpend(rec.spendId, { ...(rec.settled ? { actual: null } : {}), reserve, allIn: true, ...(p.unit !== null ? { actualPerRun: p.unit } : {}) });
  writeTaskRecord(t, { ...rec, settled: null, lastReserve: reserve, lastUnit: p.unit });
}

// 网络抖动、秒懂偶尔 5xx：看进度时连续 3 次才放弃（09-25 真机上一次 DNS 解析失败就把 --wait 整个断掉了）
const transient = (error) => error instanceof MdError && (error.code === 'network' || (error.code === 'upstream' && error.status >= 500));

export async function status(args) {
  const t = await testTarget(args);
  if (!args._[0]) {
    const setQuery = strArg(args, 'set');
    const set = setQuery ? await resolveTestSet(t, setQuery) : null;
    const rows = await recentTasks(t, { testSetId: set?.testSetId, limit: 10 });
    out(targetLine(t));
    if (!rows.length) out('没有任务');
    for (const x of rows) {
      const total = taskCaseCount(x) * (Number(x.repeatTimes) || 1);
      out(`  ${formatTime(x.createdAt)} ${shortId(x.testTaskId)} ${x.name} · ${x.status} · ${x.processedTestCaseCount ?? 0}/${total} · 通过 ${x.passedTestCaseCount ?? 0} · ${typeof x.totalCostInCny === 'number' ? formatCost(x.totalCostInCny) : '花费跑完才有'}`);
    }
    return EXIT.OK;
  }
  const task = await resolveTask(t, args._[0]);
  const wait = boolArg(args, 'wait');
  const timeoutMs = intArg(args, 'timeout', 540, 3600) * 1000;
  const started = Date.now();
  out(targetLine(t));
  let detail;
  let p;
  const record = () => readTaskRecord(t, task.testTaskId);
  const refresh = async () => {
    detail = await taskDetail(t, task.testTaskId);
    p = progressOf(detail, await taskItems(t, task.testTaskId), judgeFee(t, detail?.testSetId), record()?.cases ?? null);
    observe(t, detail, p);
  };
  await refresh();
  let last = '';
  let failures = 0;
  for (;;) {
    const guard = stopLoss(t, record(), detail, p);
    if (guard) {
      await pauseTask(t, task.testTaskId);
      out(`⛔ ${guard}，已暂停任务。账本已按实际花费记。要接着跑剩下的 ${p.total - p.done} 条：md test resume ${shortId(task.testTaskId)} --bot ${shortId(t.botId)}（先预演其余花费，用户同意后带计划码继续）；重新 md test run 会把已经跑完的条目再花一次钱`);
      await refresh();
      break;
    }
    if (!wait || stopped(detail, record()) || Date.now() - started >= timeoutMs) break;
    const line = statusLine(detail, p);
    if (line !== last) note(`${Math.round((Date.now() - started) / 1000)}s ${line}`);
    last = line;
    await sleep(pollMs());
    try {
      await refresh();
      failures = 0;
    } catch (error) {
      if (!transient(error) || ++failures >= 3) {
        throw new MdError(error?.code ?? 'upstream', String(error?.message ?? error), { exitCode: error?.exitCode, hint: `任务还在秒懂那边跑，这里只是看不到进度：过一会儿再 md test status ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} --wait` });
      }
      note(`（查进度出错，${Math.round(pollMs() / 1000)} 秒后再试：${error.message}）`);
    }
  }
  out(statusLine(detail, p));
  if (!stopped(detail, record())) {
    out(wait ? `还没跑完（等了 ${Math.round(timeoutMs / 1000)} 秒）；接着等：md test status ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} --wait` : '还没跑完；盯着跑加 --wait');
  } else {
    out(`看结果：md test results ${shortId(task.testTaskId)} --bot ${shortId(t.botId)} --out <文件.xlsx>`);
  }
  return EXIT.OK;
}

export async function stop(args) {
  const t = await testTarget(args);
  const task = await resolveTask(t, args._[0]);
  out(targetLine(t));
  if (TERMINAL.has(String(task.status))) {
    out(`任务 ${task.name}（${shortId(task.testTaskId)}）已经是 ${task.status}，不用暂停`);
    return EXIT.OK;
  }
  await pauseTask(t, task.testTaskId);
  // 暂停了也是停下来：账本按已跑完的条目记实际（同 status 的 observe，审查 C1）
  const detail = await taskDetail(t, task.testTaskId);
  const p = progressOf(detail, await taskItems(t, task.testTaskId), judgeFee(t, detail?.testSetId), readTaskRecord(t, task.testTaskId)?.cases ?? null);
  observe(t, detail, p);
  out(`已暂停任务 ${detail?.name ?? task.name}（${shortId(task.testTaskId)}）：${detail?.status}。秒懂没有取消，只能暂停；账本按已跑完的条目记实际花费（正在跑的按单价算进去）`);
  out(`要接着跑：md test resume ${shortId(task.testTaskId)} --bot ${shortId(t.botId)}（先预演其余花费）`);
  out(statusLine(detail, p));
  return EXIT.OK;
}
