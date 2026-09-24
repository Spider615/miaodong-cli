// 单节点试跑的纯逻辑：哪些节点能跑、输入怎么拼、本地改动推没推。
// 能跑的只有计算类节点，和秒懂页面一致（页面只给计算类节点「测试该节点」按钮）；未知类型一律不跑。
// 插件计算节点、挂了插件工具的大模型会真的调外部系统：要 --allow-plugin，并且要用户本人批准。

import { asArray } from './api.mjs';
import { contentKey, nodeMap } from './canvas.mjs';
import { usage } from './errors.mjs';

export const TRIAL_ALLOWED = new Set([
  'llm-completion', 'javascript-code', 'rule-center', 'query-knowledge-base', 'query-knowledge-child', 'query-sql-db',
  'calculator', 'quality-check', 'speech-to-text', 'web-search', 'chat-search', 'image-generation',
]);

export function classifyTrialNode(cell) {
  const data = cell?.data ?? {};
  const type = String(data.type ?? cell?.shape ?? '');
  if (type === 'plugin-calculation') return { kind: 'plugin', type, plugins: [String(data.name ?? type)] };
  const pluginTools = asArray(data.nodePayload?.tools).filter((t) => t?.toolType === 'plugin');
  if (type === 'llm-completion' && pluginTools.length) {
    return { kind: 'plugin', type, plugins: pluginTools.map((t) => String(t?.name ?? t?.toolName ?? t?.pluginName ?? '插件工具')) };
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

// 几次试跑的花费。跑完了没有花费字段的算 ¥0（代码、规则这类节点本来不花钱）；
// 超时没跑完的那次花了多少不知道：不算进实际，也不摊进「每次多少钱」——当成 ¥0 会让推算偏低，该要批准的直接放行
export function costSummary(runs) {
  const settled = runs.filter((r) => !r.timedOut);
  const actual = settled.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  return { actual, perRun: settled.length ? actual / settled.length : null, unknownRuns: runs.length - settled.length };
}
