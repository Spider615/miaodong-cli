// md test run <集>（spec §6.5）：跑前检查 → 预估 → 用户确认（§7）→ 建任务。建完不等：用 md test status --wait 盯着跑。

import { boolArg, intArg, strArg } from '../args.mjs';
import { EXIT, MdError } from '../errors.mjs';
import { formatTime, note, out, shortId, targetLine } from '../output.mjs';
import { formatCost } from '../execs.mjs';
import { getCanvas, listEvents, listSessions, listVersions } from '../api.mjs';
import { resolveVersion } from '../target.mjs';
import { hashOf } from '../canvas.mjs';
import { dayKey, loadLimits, readSpends, recordSpend, spendDecision, spentOn, updateSpend, withSpendLock } from '../spend.mjs';
import { codeFor, givenCode, roundCost, stopForConfirm } from '../confirm.mjs';
import { createTask, listCases, pauseTask, recentTasks, taskDetail, taskItems } from '../testcenter.mjs';
import { UNKNOWN_CASE_COST, preflight } from '../testcases.mjs';
import { readSources, readTaskRecord, resolveTestSet, testTarget, writeTaskRecord } from '../test-common.mjs';

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
  const costs = Object.values(readSources(t, set.testSetId).execs).map((s) => s?.cost).filter((c) => typeof c === 'number');
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

const TERMINAL = new Set(['finished', 'paused', 'failed', 'error', 'cancelled', 'canceled']);
const pollMs = () => (Number(process.env.MD_TEST_POLL_MS) > 0 ? Number(process.env.MD_TEST_POLL_MS) : 15_000);
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

// 进度：跑完的条目数、通过、空跑（spec §2.3：没有执行、花费为空）、已完成条目的花费和平均
function progressOf(detail, items) {
  const done = items.filter((i) => i?.status && !['pending', 'processing'].includes(i.status));
  const costs = done.map((i) => i.costInCny).filter((c) => typeof c === 'number');
  const spent = costs.reduce((a, b) => a + b, 0);
  return {
    total: Math.max(items.length, (Number(detail?.totalTestCaseCount) || 0) * (Number(detail?.repeatTimes) || 1)),
    done: done.length,
    passed: done.filter((i) => i.passed === true).length,
    noop: done.filter((i) => i.canvasExecAvailable === false && (i.costInCny === null || i.costInCny === undefined)).length,
    spent,
    unit: costs.length ? spent / costs.length : null,
  };
}

function statusLine(detail, p) {
  const cost = typeof detail?.totalCostInCny === 'number' ? formatCost(detail.totalCostInCny) : `已完成的 ${formatCost(p.spent)}`;
  return `${detail?.name ?? ''} ${detail?.status} · ${p.done}/${p.total} · 通过 ${p.passed}${p.noop ? ` · 空跑 ${p.noop}` : ''} · ${cost}`;
}

// 止损（同 md trial 的逐次止损，审查 C1）：md 建的任务，按已完成条目的平均花费推算整个任务，超过额度就暂停
function stopLoss(t, detail, p) {
  const rec = readTaskRecord(t, detail?.testTaskId);
  if (!rec || p.unit === null) return null;
  const projected = p.unit * p.total;
  if (projected <= rec.allowance) return null;
  return `按已跑完的 ${p.done} 条平均 ${formatCost(p.unit)} 推算，整个任务要 ${formatCost(projected)}，超过额度 ${formatCost(rec.allowance)}`;
}

// 跑完记账：用秒懂给的总花费（没有就用逐条加起来的），只记一次（spec §6.6）。暂停的不记，账本保留预估
function settle(t, detail, p) {
  const rec = readTaskRecord(t, detail?.testTaskId);
  if (!rec?.spendId || rec.settled || detail?.status !== 'finished') return;
  updateSpend(rec.spendId, { actual: typeof detail.totalCostInCny === 'number' ? detail.totalCostInCny : p.spent, runs: p.total });
  writeTaskRecord(t, { ...rec, settled: true });
}

export async function status(args) {
  const t = await testTarget(args);
  if (!args._[0]) {
    const setQuery = strArg(args, 'set');
    const set = setQuery ? await resolveTestSet(t, setQuery) : null;
    const rows = await recentTasks(t, { testSetId: set?.testSetId, limit: 10 });
    out(targetLine(t));
    if (!rows.length) out('没有任务');
    for (const x of rows) {
      const total = (Number(x.totalTestCaseCount) || 0) * (Number(x.repeatTimes) || 1);
      out(`  ${formatTime(x.createdAt)} ${shortId(x.testTaskId)} ${x.name} · ${x.status} · ${x.processedTestCaseCount ?? 0}/${total} · 通过 ${x.passedTestCaseCount ?? 0} · ${typeof x.totalCostInCny === 'number' ? formatCost(x.totalCostInCny) : '花费跑完才有'}`);
    }
    return EXIT.OK;
  }
  const task = await resolveTask(t, args._[0]);
  const wait = boolArg(args, 'wait');
  const timeoutMs = intArg(args, 'timeout', 540, 3600) * 1000;
  const started = Date.now();
  out(targetLine(t));
  let detail = await taskDetail(t, task.testTaskId);
  let p = progressOf(detail, await taskItems(t, task.testTaskId));
  let last = '';
  while (wait && !TERMINAL.has(String(detail?.status)) && Date.now() - started < timeoutMs) {
    const line = statusLine(detail, p);
    if (line !== last) note(`${Math.round((Date.now() - started) / 1000)}s ${line}`);
    last = line;
    const guard = stopLoss(t, detail, p);
    if (guard) {
      await pauseTask(t, task.testTaskId);
      out(`⛔ ${guard}，已暂停任务（秒懂没有取消；要接着跑，把新的预估告诉用户，再重新 md test run）`);
      detail = await taskDetail(t, task.testTaskId);
      break;
    }
    await sleep(pollMs());
    detail = await taskDetail(t, task.testTaskId);
    p = progressOf(detail, await taskItems(t, task.testTaskId));
  }
  settle(t, detail, p);
  out(statusLine(detail, p));
  if (!TERMINAL.has(String(detail?.status))) {
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
  const detail = await taskDetail(t, task.testTaskId);
  out(`已暂停任务 ${detail?.name ?? task.name}（${shortId(task.testTaskId)}）：${detail?.status}。秒懂没有取消，只能暂停；暂停后秒懂不给任务花费，账本保留预估`);
  return EXIT.OK;
}
