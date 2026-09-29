// 整条试跑的纯逻辑（spec 2026-09-29-miaodong-cli-flow-trial-design）：从入口能走到哪些节点、能不能跑、
// --var / --data 的值怎么转、一次花了多少、--session 认不认、事件那头怎么接着跑。

import { asArray } from './api.mjs';
import { EXIT, MdError, usage } from './errors.mjs';
import { buildIndex, businessNodes, nodeName, nodeType } from './graph.mjs';
import { shortId } from './output.mjs';
import { FREE_TYPES, TRIAL_ALLOWED, classifyTrialNode } from './trial.mjs';

// 照跑、开跑前列出来的动作。它们作用在当前会话 / 联系人上：试跑会话没有联系人和接收人（09-29 实测），
// 发文本只留下一条动作记录、不进投递
export const FLOW_ACTIONS = new Map([
  ['send-text-message', '发文本'], ['send-image-message', '发图片'], ['send-audio-message', '发语音'],
  ['send-combination-message', '发组合消息'], ['send-material', '发素材'],
  ['tag-user', '打标签'], ['smart-tag', '智能标签'], ['update-data', '写会话变量'], ['update-custom-attr', '改自定义属性'],
  ['invite-room', '邀请入群'], ['canvas-event-action', '发事件'], ['handover', '转人工'],
]);

// 入口：--text 是草稿里所有「收到文本」触发器，--event 是这个事件的所有事件入口
export function entryNodes(canvas, entry) {
  const nodes = businessNodes(asArray(canvas));
  if (entry.kind === 'text') return nodes.filter((n) => nodeType(n) === 'receive-text-message');
  return nodes.filter((n) => nodeType(n) === 'canvas-event-trigger' && n.data?.nodePayload?.eventId === entry.eventId);
}

// 从入口出发能走到的节点（含入口）：沿连线和事件跳转（buildIndex 的 event 边）；
// 可达节点的子节点（x6 的 parent / children、循环体的 parentLoopBodyNodeId）也算，循环体里的节点不能漏
export function reachableNodes(canvas, startIds, events = []) {
  const cells = asArray(canvas);
  const nodes = new Map(businessNodes(cells).map((c) => [c.id, c]));
  const next = new Map();
  const link = (from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) return;
    if (!next.has(from)) next.set(from, []);
    next.get(from).push(to);
  };
  for (const e of buildIndex(cells, events ?? []).edges) link(e.from, e.to);
  for (const c of nodes.values()) {
    link(c.parent, c.id);
    link(c.data?.parentLoopBodyNodeId, c.id);
    for (const child of asArray(c.children)) link(c.id, typeof child === 'string' ? child : child?.id);
  }
  const seen = new Set(startIds);
  const queue = [...startIds];
  while (queue.length) {
    const id = queue.shift();
    for (const to of next.get(id) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return [...seen].map((id) => nodes.get(id)).filter(Boolean);
}

// 判定（spec §4.2）：插件、md 不认识的类型、会执行的动作（按类型计数）。触发器只是入口，不判
export function flowPreflight(cells) {
  const plugins = [];
  const unknown = [];
  const actions = new Map();
  for (const cell of cells) {
    if (cell.data?.category === 'trigger') continue;
    const type = nodeType(cell);
    const cls = classifyTrialNode(cell);
    if (cls.kind === 'plugin' || type === 'plugin-action') {
      plugins.push({ id: cell.id, name: nodeName(cell), type, calls: cls.kind === 'plugin' ? cls.plugins : [nodeName(cell)] });
      continue;
    }
    if (TRIAL_ALLOWED.has(type)) continue;
    if (FLOW_ACTIONS.has(type)) {
      actions.set(type, (actions.get(type) ?? 0) + 1);
      continue;
    }
    unknown.push({ id: cell.id, name: nodeName(cell), type });
  }
  return { plugins, unknown, actions };
}

const listNodes = (items) => [
  ...items.slice(0, 10).map((n) => `  - ${n.name} [${shortId(n.id)}] ${n.type}`),
  ...(items.length > 10 ? [`  …另有 ${items.length - 10} 个`] : []),
].join('\n');

// 两道闸门，都在任何 POST 之前：能走到插件、能走到 md 不认识的类型，都不跑
export function assertRunnable(pre) {
  if (pre.plugins.length) {
    throw new MdError('trial_flow_plugin', `从入口（含事件那头）能走到 ${pre.plugins.length} 个会调外部系统的节点；整条试跑没法 mock 插件，不跑：\n${listNodes(pre.plugins)}`, {
      exitCode: EXIT.BLOCKED,
      hint: '要 mock 插件就走测试中心：md test import → md test edit 补插件 mock → md test run；只想看某一段，用 --event 从走不到插件的事件入口跑',
    });
  }
  if (pre.unknown.length) {
    const types = [...new Set(pre.unknown.map((n) => n.type))].join('、');
    throw new MdError('trial_flow_unknown', `从入口能走到 md 不认识的节点类型（${types}），判断不了会不会调外部系统，不跑：\n${listNodes(pre.unknown)}`, {
      exitCode: EXIT.BLOCKED,
      hint: '把节点类型告诉维护 md 的人，核对过再加进白名单；或者走测试中心',
    });
  }
}

export function describeActions(actions) {
  return [...actions].map(([type, n]) => `${FLOW_ACTIONS.get(type)} ${n}`).join('、');
}

// 名=值 拆开；值里可以再有等号
export function splitPairs(pairs, flag) {
  return pairs.map((pair) => {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw usage(`--${flag} 要写成 名=值，收到「${pair}」`);
    return { key: pair.slice(0, eq).trim(), raw: pair.slice(eq + 1) };
  });
}

// 会话变量的类型是 {type:'string'}，事件变量的类型可能直接是 'string'
const typeName = (v) => String(v?.type?.type ?? v?.type ?? 'string');
const TEXT_TYPES = new Set(['string', 'datetime', 'date', 'time']);

// 按变量类型转值：文字类原样；数字、布尔按字面；其它（数组、标签……）按 JSON
export function typedValue(raw, type, label) {
  if (TEXT_TYPES.has(type)) return raw;
  if (type === 'number') {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n)) throw usage(`${label}是数字，收到「${raw}」`);
    return n;
  }
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw usage(`${label}是 true / false，收到「${raw}」`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw usage(`${label}是 ${type} 类型，值要写成 JSON，收到「${raw}」`);
  }
}

// --var：自定义会话变量，按名字找；内置变量平台会静默忽略（09-29 实测「最后一条消息来源」），拦下
export function buildSessionData(pairs, sessions) {
  const data = {};
  for (const { key, raw } of splitPairs(pairs, 'var')) {
    const hits = asArray(sessions).filter((s) => s?.name === key);
    if (!hits.length) throw usage(`没有叫「${key}」的会话变量`, '名字要和秒懂「会话属性」里的完全一致');
    if (hits.length > 1) throw usage(`叫「${key}」的会话变量有 ${hits.length} 个，分不清是哪个`);
    const [s] = hits;
    if (s.isDefault) throw usage(`「${key}」是平台内置的会话变量：试跑里预置了也不生效（平台会忽略）`, '要带聊天历史，用 --session 接着同一个会话聊');
    if (Object.prototype.hasOwnProperty.call(data, s.id)) throw usage(`--var ${key} 给了两次`);
    data[s.id] = typedValue(raw, typeName(s), `会话变量「${key}」`);
  }
  return data;
}

// --data：事件声明的变量，按名字；缺一个都不跑（和秒懂页面一样，空字符串也算缺）
export function buildEventData(pairs, event) {
  const vars = asArray(event?.variables).filter((v) => typeof v?.name === 'string' && v.name);
  const byName = new Map(vars.map((v) => [v.name, v]));
  const data = {};
  for (const { key, raw } of splitPairs(pairs, 'data')) {
    const v = byName.get(key);
    if (!v) throw usage(`事件「${event.name}」没有变量「${key}」`, `它的变量：${vars.map((x) => x.name).join('、') || '（没有）'}`);
    if (Object.prototype.hasOwnProperty.call(data, key)) throw usage(`--data ${key} 给了两次`);
    data[key] = typedValue(raw, typeName(v), `事件变量「${key}」`);
  }
  const missing = vars.map((v) => v.name).filter((name) => data[name] === undefined || data[name] === '');
  if (missing.length) throw usage(`事件「${event.name}」的变量没给全：缺 ${missing.join('、')}`, `和秒懂页面一样，每个变量都要有值，比如 --data ${missing[0]}=…`);
  return data;
}

// --event：事件 id 完全一致 > id 前缀（至少 8 位）> 名字完全一致；同一档命中多个就报出来，绝不自己挑
export function resolveEvent(events, query) {
  const q = String(query ?? '').trim();
  const list = asArray(events).filter((e) => e?.eventId);
  const tiers = [
    (e) => e.eventId === q,
    (e) => q.length >= 8 && String(e.eventId).startsWith(q),
    (e) => e.name === q,
  ];
  for (const match of tiers) {
    const hits = list.filter(match);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new MdError('event_ambiguous', `「${q}」匹配到 ${hits.length} 个事件：${hits.map((e) => `${e.name}(${shortId(e.eventId)})`).join('、')}`, { exitCode: EXIT.TARGET, hint: '用事件 id 的前 8 位' });
    }
  }
  throw new MdError('event_not_found', `这个智能体没有事件「${q}」`, { exitCode: EXIT.TARGET, hint: `有这些事件：${list.map((e) => e.name).slice(0, 30).join('、') || '（没有）'}` });
}

// 不花钱的节点：触发器、代码 / 规则 / 计算器，以及除智能标签以外的动作（智能标签可能要调模型）
export function isFreeNode(n) {
  if (n?.category === 'trigger') return true;
  if (FREE_TYPES.has(n?.type)) return true;
  return FLOW_ACTIONS.has(n?.type) && n.type !== 'smart-tag';
}

// 一次花了多少（spec §4.3）：null = 不知道。用了 token 却报 ¥0 的不信（大模型花费字段在试跑里还没实测过）
export function flowCostOf(canvasExec, executed, timedOut) {
  if (timedOut) return null;
  const value = canvasExec?.totalCostInCny;
  const reported = typeof value === 'number' ? value : Number.parseFloat(value);
  const tokens = canvasExec?.tokenCount;
  const usedTokens = Boolean(tokens) && typeof tokens === 'object' && Object.keys(tokens).length > 0;
  if (Number.isFinite(reported)) return reported === 0 && usedTokens ? null : reported;
  return asArray(executed).every(isFreeNode) ? 0 : null;
}

// --session 只认 md 在这个智能体上开过的试跑会话（本机记录）：免得把试跑写进真实客户的会话
export function matchSession(records, query, botId) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 8) throw usage('--session 至少写 8 位', '开头打印过「会话 xxxxxxxx」，照抄即可');
  const ids = [...new Set(asArray(records).filter((r) => r?.botId === botId).map((r) => String(r.sessionId)))];
  const hits = ids.filter((id) => id.toLowerCase().startsWith(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw usage(`「${query}」匹配到 ${hits.length} 个试跑会话，多写几位`);
  throw new MdError('trial_session_unknown', `「${query}」不是 md 在这个智能体上开过的试跑会话`, {
    exitCode: EXIT.USAGE,
    hint: '只能接着 md 自己开的试跑会话聊（免得把试跑写进真实客户的会话）；不给 --session 就新开一个',
  });
}

// 草稿里发这个事件的节点怎么调度：SCHEDULE 带延时秒数，TIMER 是定时
export function eventSchedules(canvas) {
  const out = new Map();
  for (const n of businessNodes(asArray(canvas))) {
    const p = n.data?.nodePayload ?? {};
    if (nodeType(n) !== 'canvas-event-action' || !p.eventId || out.has(p.eventId)) continue;
    out.set(p.eventId, { mode: String(p.triggerType ?? ''), delaySeconds: Number(p.delaySeconds) || 0 });
  }
  return out;
}

export function scheduleLabel(schedule) {
  if (schedule?.mode === 'SCHEDULE' && schedule.delaySeconds > 0) return `（延时 ${schedule.delaySeconds} 秒）`;
  if (schedule?.mode === 'TIMER') return '（定时）';
  return '';
}

const quote = (s) => (/^[\w.@%+=:,/-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
export const DATA_VALUE_LIMIT = 200;

// 从事件入口接着跑的命令（spec §5.3）：--data 取自事件参数，太长的截断并说明
export function followCommand(emitted, { bot, session }) {
  const parts = ['md trial --event', quote(emitted.eventName || String(emitted.eventId)), '--bot', quote(bot), '--session', quote(session)];
  let clipped = false;
  const params = emitted.params && typeof emitted.params === 'object' && !Array.isArray(emitted.params) ? emitted.params : {};
  for (const [key, value] of Object.entries(params)) {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.length > DATA_VALUE_LIMIT) {
      text = text.slice(0, DATA_VALUE_LIMIT);
      clipped = true;
    }
    parts.push('--data', quote(`${key}=${text}`));
  }
  return { command: parts.join(' '), clipped };
}
