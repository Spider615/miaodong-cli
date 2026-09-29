// 单节点试跑的纯逻辑：哪些节点能跑、输入怎么拼、本地改动推没推。
// 能跑的只有计算类节点，和秒懂页面一致（页面只给计算类节点「测试该节点」按钮）；未知类型一律不跑。
// 插件计算节点、挂了插件工具的大模型会真的调外部系统：要 --allow-plugin，并且要用户确认（确认码）。

import { asArray } from './api.mjs';
import { contentKey, nodeMap } from './canvas.mjs';
import { usage } from './errors.mjs';
import { formatCost } from './execs.mjs';
import { codeFor } from './confirm.mjs';
import { loadLimits, spendDecision, spentOn } from './spend.mjs';

export const TRIAL_ALLOWED = new Set([
  'llm-completion', 'javascript-code', 'rule-center', 'query-knowledge-base', 'query-knowledge-child', 'query-sql-db',
  'calculator', 'quality-check', 'speech-to-text', 'web-search', 'chat-search', 'image-generation',
]);

// 大模型挂的工具只放行已知安全的（知识库查询）；认不出的一律当外部调用（插件、HTTP 之类），宁可多问一次（审查 M6）。
// 工具类型的真实字段是 type：{ type: 'query_kb', configParams: { knowledgeBaseId } }（09-25 核对 147bd600 草稿，110 个工具全是这样）；
// 计划里写的 toolType 在真实画布里不存在——按它找，挂了插件工具的大模型会被当成普通节点、不经确认就跑。toolType 也一起认
const SAFE_TOOL_TYPES = new Set(['query_kb']);
const toolTypeOf = (tool) => String(tool?.type ?? tool?.toolType ?? '');

export function classifyTrialNode(cell) {
  const data = cell?.data ?? {};
  const type = String(data.type ?? cell?.shape ?? '');
  if (type === 'plugin-calculation') return { kind: 'plugin', type, plugins: [String(data.name ?? type)] };
  const external = asArray(data.nodePayload?.tools).filter((t) => !SAFE_TOOL_TYPES.has(toolTypeOf(t)));
  if (type === 'llm-completion' && external.length) {
    return { kind: 'plugin', type, plugins: external.map((t) => String(t?.name ?? t?.toolName ?? t?.pluginName ?? t?.configParams?.name ?? (toolTypeOf(t) || '外部工具'))) };
  }
  if (TRIAL_ALLOWED.has(type)) return { kind: 'allowed', type, plugins: [] };
  return { kind: 'denied', type, plugins: [] };
}

// 节点要哪些输入：nodePayload.inputs[].name。来源是 operationAttrId 的是平台参数（如「质检规则」），不传时秒懂自动填最新值
export function inputDefs(cell) {
  const payload = cell?.data?.nodePayload ?? {};
  const defs = asArray(payload.inputs)
    .filter((i) => i && typeof i.name === 'string' && i.name.trim())
    .map((i) => ({ name: i.name.trim(), platform: Boolean(i.operationAttrId) }));
  if (!defs.length && typeof payload.query?.name === 'string' && payload.query.name.trim()) defs.push({ name: payload.query.name.trim(), platform: false });
  if (cell?.data?.type === 'web-search' && !defs.some((d) => d.name === 'count')) defs.push({ name: 'count', platform: false });
  const media = payload.mediaUrl?.type?.type;
  if (media === 'audio') defs.push({ name: 'audioUrl', platform: false });
  if (media === 'video') defs.push({ name: 'videoUrl', platform: false });
  return defs;
}

export function parseInputPairs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw usage(`--input 要写成 键=值，收到「${pair}」`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

// 执行记录里的输入带着执行当时解析出的平台参数，原样回灌会把它钉成旧值（09-22 会话里因此手工删过「质检规则」）
export function buildTrialInputs(defs, { fromExec = null, fromFile = null, overrides = {}, keepPlatform = false } = {}) {
  const base = { ...(fromExec ?? {}) };
  const dropped = [];
  if (!keepPlatform) {
    for (const d of defs) {
      if (d.platform && Object.prototype.hasOwnProperty.call(base, d.name)) {
        delete base[d.name];
        dropped.push(d.name);
      }
    }
  }
  const inputs = { ...base, ...(fromFile ?? {}), ...overrides };
  const names = new Set(defs.map((d) => d.name));
  const missing = defs.filter((d) => !d.platform && !Object.prototype.hasOwnProperty.call(inputs, d.name)).map((d) => d.name);
  const extra = Object.keys(inputs).filter((k) => !names.has(k));
  return { inputs, dropped, missing, extra };
}

// 试跑跑的是秒懂上的草稿：本地改了还没推，跑出来的就是旧版本。
// 「改了没推」只看这个节点：本地和基线不同（确实动过）且草稿里还不是这个样子。
// 只比本地和草稿会误报：本地改的是别的节点、这个节点在网页上被人改了，那是草稿变了，不是本地没推
export function draftVsLocal(nodeId, draftCanvas, ws) {
  if (!ws) return { status: 'no-workspace' };
  const key = (cell) => (cell ? contentKey(cell) : null);
  const draftNode = key(nodeMap(draftCanvas).get(nodeId));
  const base = key(nodeMap(ws.base.canvas).get(nodeId));
  const local = ws.after ? key(nodeMap(ws.after.canvas).get(nodeId)) : base;
  if (local !== base && local !== draftNode) return { status: 'unpushed', dir: ws.dir };
  if (base && draftNode && base !== draftNode) return { status: 'draft-changed', dir: ws.dir };
  return { status: 'same', dir: ws.dir };
}

// 这些节点本来不花钱：结果里没有花费字段就是 ¥0。别的类型没有花费字段 = 不知道花了多少，不能当 ¥0（审查 I1）
export const FREE_TYPES = new Set(['javascript-code', 'rule-center', 'calculator']);
// 花费不知道的一次按这个价记账、推算（Gemini 一次的上沿），宁可多算
export const UNKNOWN_RUN_COST = 0.7;

// 一次试跑花了多少：null = 不知道（超时没跑完，或者该花钱的节点没回花费字段）
export function costOf(run, type, timedOut) {
  if (timedOut) return null;
  if (typeof run?.cost?.cny === 'number') return run.cost.cny;
  return FREE_TYPES.has(type) ? 0 : null;
}

// 几次试跑的花费。runs[].cost 为 null 的是花费不知道的那几次：不算进实际，也不摊进「每次多少钱」——
// 当成 ¥0 会让推算偏低、以后的预估也跟着偏低（审查 I1 / I2）；账本里另按 assumedPerRun（没有就按实际单价、再没有按保守价）记一笔 assumed
export function costSummary(runs, assumedPerRun = null) {
  const known = runs.filter((r) => typeof r.cost === 'number');
  const actual = known.reduce((sum, r) => sum + r.cost, 0);
  const perRun = known.length ? actual / known.length : null;
  const unknownRuns = runs.length - known.length;
  return { actual, perRun, unknownRuns, assumed: unknownRuns * (assumedPerRun ?? perRun ?? UNKNOWN_RUN_COST) };
}

// 下一次开跑前按实际花费重算整条命令（审查 C1）：开跑前的预估可能偏低（执行记录里是旧价、节点后来改过），
// 只在开头判一次，一条命令就可能不经确认花掉好几倍门槛。这样最多多花一次的钱。
// 每次单价按「预估」和「已跑的实际」取大的；花费不知道的那几次也按这个单价算进已花。
// 返回的 rest 是其余几次的预估，给确认码用：和重跑时的算法一致（重跑时按这次的实际单价估）；
// projected 是按实际推算的整条命令，放行时用它更新账本里这一笔的预留
export function nextRunCheck({ runs, remaining, perRun, confirmed, confirmedEstimate, limits, othersToday, free = false }) {
  // 按类型证明不花钱的：花费恒为 0，不用重算，也不因今天超了上限停下（审查 I1）
  if (free) return { ok: true, projected: 0 };
  const sum = costSummary(runs);
  const unit = sum.perRun ?? perRun;
  const rest = unit === null ? null : unit * remaining;
  const forward = perRun === null && sum.perRun === null ? null : Math.max(perRun ?? 0, sum.perRun ?? 0);
  if (forward === null) {
    // 用户确认过「估不出」就照跑；否则停下来问
    return confirmed && confirmedEstimate === null ? { ok: true } : { ok: false, reasons: ['估不出花费（已跑的还没有实际花费）'], rest };
  }
  const projected = sum.actual + sum.unknownRuns * forward + remaining * forward;
  if (confirmed && confirmedEstimate !== null) {
    if (projected <= confirmedEstimate + limits.perCommand) return { ok: true, projected };
    return { ok: false, reasons: [`按已跑的实际推算整条命令要 ${formatCost(projected)}，比确认时的预估 ${formatCost(confirmedEstimate)} 高出一个单次门槛以上`], rest, projected };
  }
  const reasons = [];
  if (projected > limits.perCommand) reasons.push(`按已跑的实际推算整条命令要 ${formatCost(projected)}，超过单次门槛 ${formatCost(limits.perCommand)}`);
  if (othersToday + projected > limits.perDay) reasons.push(`今天别的花费 ${formatCost(othersToday)}，加上这条命令超过每日上限 ${formatCost(limits.perDay)}`);
  return reasons.length ? { ok: false, reasons, rest, projected } : { ok: true, projected };
}

// 这一笔真跑时会怎样：要不要用户确认、确认码、估不出时是不是先跑 1 次。真跑（在记账锁里）和 --plan 用同一份判断：
// --plan 不记账，账本不变，它给的确认码真跑时就对得上
export function spendPlan({ estimate, external = [], free = false, operation, rows }) {
  const today = spentOn(rows);
  const limits = loadLimits();
  return {
    limits,
    probeFirst: estimate === null && !external.length && today < limits.perDay,
    decision: spendDecision({ estimate, externalCalls: external, free }, { limits, today }),
    confirm: codeFor(operation, rows),
  };
}

// md trial --plan 的结论：前面的预演信息（目标、输入 / 能走到的节点、预估）已经打过了
export function planLines({ probeFirst, decision, confirm }) {
  const lines = ['（--plan：只预演，没发请求，没记账）'];
  if (!decision.needApproval) lines.push('真跑时：不用确认，直接跑（去掉 --plan）。');
  else if (probeFirst) lines.push('真跑时：花费估不出，先跑 1 次看实际；按实际推算其余几次超了门槛才停下要确认。');
  else lines.push(`真跑时：要用户确认（${decision.reasons.join('；')}）。把预估单独告诉用户，同意后同一条命令去掉 --plan、加 --confirm ${confirm.code}`);
  return lines;
}
