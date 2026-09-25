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
import { isNoop } from '../testresults.mjs';
import { readSources, readTaskRecord, resolveTestSet, testTarget, writeTaskRecord } from '../test-common.mjs';

const QUEUED = new Set(['pending', 'processing', 'running']);
const pad2 = (n) => String(n).padStart(2, '0');
const nowLabel = () => {
  const d = new Date();
  return `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
};

// 每条每轮的单价（spec §6.5，审查 C1）。取下面两项里大的：
// - 账本里这个集最近观察到的单价：md 看进度时记下的（包括被止损暂停的任务），之后换了模型也会被它纠正；
// - 这个集上次跑完的任务：总花费 ÷ 真正执行了的条数（averageCostInCny 把空跑也算进分母，空跑多就被稀释，spec §2.3）。
// 两项都没有才看导入来源里源执行的平均花费；都没有就估不出。单价是 0 也当估不出：多半是那次全空跑
// （spec §1 那次「100 条 8.9 秒跑完、花费 ¥0」），拿它估价会让下一批不经确认就跑；真正免费的集每次多问一句
async function unitCost(t, set) {
  const candidates = [];
  const seen = readSpends().filter((r) => r.kind === 'test' && r.botId === t.botId && r.testSetId === set.testSetId && typeof r.actualPerRun === 'number' && r.actualPerRun > 0).at(-1);
  if (seen) candidates.push({ unit: seen.actualPerRun, basis: `上次盯着跑时观察到每条 ${formatCost(seen.actualPerRun)}` });
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

// 进度：跑完的条目数、通过、空跑（spec §2.3：没有执行、花费为空）、正在跑的、已完成条目的花费和平均（空跑不进平均）
function progressOf(detail, items) {
  const done = items.filter((i) => i?.status && !['pending', 'processing'].includes(i.status));
  const costs = done.map((i) => i.costInCny).filter((c) => typeof c === 'number');
  const spent = costs.reduce((a, b) => a + b, 0);
  return {
    total: Math.max(items.length, (Number(detail?.totalTestCaseCount) || 0) * (Number(detail?.repeatTimes) || 1)),
    done: done.length,
    inflight: items.filter((i) => i?.status === 'processing').length,
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

// 止损（同 md trial 的逐次止损，审查 C1 / I2）：md 建的任务，按已完成条目的实际单价推算整个任务，
// 超过额度（自动放行的是单次门槛；用户确认过的是确认的金额 + 一个单次门槛）就暂停；自动放行的还看每日上限。
// 每次看进度都判断，不带 --wait 也判断
function stopLoss(t, rec, detail, p) {
  if (!rec || TERMINAL.has(String(detail?.status)) || p.unit === null) return null;
  const projected = p.spent + (p.total - p.done) * p.unit;
  const head = `按已跑完的 ${p.done} 条平均 ${formatCost(p.unit)} 推算，整个任务要 ${formatCost(projected)}`;
  if (projected > rec.allowance) return `${head}，超过额度 ${formatCost(rec.allowance)}`;
  if (!rec.confirmed) {
    const limits = loadLimits();
    const others = spentOn(readSpends().filter((r) => r.id !== rec.spendId));
    if (others + projected > limits.perDay) return `${head}，加上今天别的花费 ${formatCost(others)} 超过每日上限 ${formatCost(limits.perDay)}`;
  }
  return null;
}

// 账本跟着实际走（审查 C1）：每次看进度都把观察到的写回 md 建的那一笔——
// 跑的过程中，预留 = max(原预留, 已花 + 没跑的 × 单价)，并记下观察到的单价（下次 md test run 按它估价）；
// 任务停下来（跑完、暂停、失败）就记实际：跑完用秒懂给的总花费，别的按已完成条目的花费 + 正在跑的按单价。
// 同样的结果只写一次；暂停后在页面上接着跑完，会再按新结果记
function observe(t, detail, p) {
  const rec = readTaskRecord(t, detail?.testTaskId);
  if (!rec?.spendId) return;
  const unit = p.unit ?? rec.unit ?? UNKNOWN_CASE_COST;
  const status = String(detail?.status);
  if (TERMINAL.has(status)) {
    const actual = status === 'finished' && typeof detail.totalCostInCny === 'number' ? detail.totalCostInCny : p.spent + p.inflight * unit;
    if (rec.settled?.status === status && rec.settled?.actual === actual) return;
    updateSpend(rec.spendId, { actual, runs: p.done, ...(p.unit !== null ? { actualPerRun: p.unit } : {}) });
    writeTaskRecord(t, { ...rec, settled: { status, actual } });
    return;
  }
  const projected = p.spent + (p.total - p.done) * unit;
  const reserve = Math.max(rec.lastReserve ?? rec.reserve ?? 0, projected);
  if (reserve === rec.lastReserve && p.unit === rec.lastUnit) return;
  updateSpend(rec.spendId, { reserve, ...(p.unit !== null ? { actualPerRun: p.unit } : {}) });
  writeTaskRecord(t, { ...rec, lastReserve: reserve, lastUnit: p.unit });
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
  let detail;
  let p;
  const refresh = async () => {
    detail = await taskDetail(t, task.testTaskId);
    p = progressOf(detail, await taskItems(t, task.testTaskId));
    observe(t, detail, p);
  };
  await refresh();
  let last = '';
  let failures = 0;
  for (;;) {
    const guard = stopLoss(t, readTaskRecord(t, task.testTaskId), detail, p);
    if (guard) {
      await pauseTask(t, task.testTaskId);
      out(`⛔ ${guard}，已暂停任务。账本已按实际花费记；秒懂没有取消，重新 md test run 会把已经跑完的条目再花一次钱，新的预估按这次观察到的单价算`);
      await refresh();
      break;
    }
    if (!wait || TERMINAL.has(String(detail?.status)) || Date.now() - started >= timeoutMs) break;
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
  // 暂停了也是停下来：账本按已跑完的条目记实际（同 status 的 observe，审查 C1）
  const detail = await taskDetail(t, task.testTaskId);
  const p = progressOf(detail, await taskItems(t, task.testTaskId));
  observe(t, detail, p);
  out(`已暂停任务 ${detail?.name ?? task.name}（${shortId(task.testTaskId)}）：${detail?.status}。秒懂没有取消，只能暂停；账本按已跑完的条目记实际花费（正在跑的按单价算进去）`);
  out(statusLine(detail, p));
  return EXIT.OK;
}
