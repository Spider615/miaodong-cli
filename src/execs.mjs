// 执行记录（调优中心）的接口与纯函数。
// 列表每条约 25KB（八成是会话变量快照），高流量 bot 一天九十万条执行：能让秒懂筛的条件全部放进请求
// （09-24 核对：triggerType / actionType / canvasId / isCanary / allNodesSuccess / execId 都生效），
// 只有「事件名」服务端筛不了，要拉回来本地比，而且有页数上限，扫了多少如实说。

import { request } from './http.mjs';
import { asArray } from './api.mjs';
import { MdError, usage } from './errors.mjs';
import { formatTime } from './output.mjs';
import { extractTriggerTextFromSnapshot } from '../../apps/api/lib/miaodong/badcase-normalize.ts';

export const PAGE_SIZE = 100;

export const TRIGGER_ALIASES = {
  text: 'receive-text-message', image: 'receive-image-message', audio: 'receive-audio-message', video: 'receive-video-message',
  file: 'receive-file-message', other: 'receive-other-message', event: 'canvas-event-trigger', tag: 'tag-event', friend: 'new-friend',
};
export const ACTION_ALIASES = {
  send: 'send-text-message', combo: 'send-combination-message', handover: 'handover', event: 'canvas-event-action',
  update: 'update-data', tag: 'tag-user', material: 'send-material', plugin: 'plugin-action',
};
export const TRIGGER_LABEL = {
  'receive-text-message': '文本', 'receive-image-message': '图片', 'receive-audio-message': '语音', 'receive-video-message': '视频',
  'receive-file-message': '文件', 'receive-other-message': '其他消息', 'tag-event': '标签', 'new-friend': '新好友', 'canvas-event-trigger': '事件',
};

const str = (v) => (typeof v === 'string' ? v : '');

export async function listExecutions(identity, orgId, body) {
  const payload = await request(identity, '/api/canvas/history/list', { method: 'POST', query: { orgId }, body, timeoutMs: 90_000 });
  const total = Number(payload?.page?.total);
  return { rows: asArray(payload?.data), total: Number.isFinite(total) ? total : null };
}

// 找不到时秒懂回业务错误 CANVAS_EXEC_NOT_FOUND；这里统一成 null，由调用方决定报什么
export async function getExecDetail(identity, orgId, execId, botId) {
  let payload;
  try {
    payload = await request(identity, '/api/canvas/history/details', { query: { execId, botId, orgId }, timeoutMs: 120_000 });
  } catch (error) {
    if (error instanceof MdError && error.code !== 'auth_expired' && /NOT_FOUND|不存在/i.test(error.message)) return null;
    throw error;
  }
  const data = payload?.data;
  return data?.canvasExec ? data : null;
}

export function resolveAlias(aliases, value, flag) {
  if (value === undefined) return undefined;
  if (value.includes('-')) return value;
  const full = aliases[value];
  if (!full) throw usage(`--${flag} 不认识「${value}」`, `写完整类型名，或用简写：${Object.keys(aliases).join('、')}`);
  return full;
}

export function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatCost(cost) {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return '¥-';
  if (cost === 0) return '¥0';
  return `¥${cost >= 1 ? cost.toFixed(2) : cost >= 0.01 ? cost.toFixed(3) : cost.toFixed(4)}`;
}

// 回复不止 send-text：组合消息的内容在 payload.messages[].content，转人工话术在 handoverMessage（老懂的 extractBotReply 只认 text/content）
export function actionTexts(outputActions) {
  return asArray(outputActions).map((action) => {
    const p = action?.payload ?? {};
    switch (action?.type) {
      case 'send-text-message':
        return { kind: 'reply', text: `发文本「${str(p.text)}」` };
      case 'send-combination-message':
        return { kind: 'reply', text: `发组合消息「${asArray(p.messages).map((m) => str(m?.content)).filter(Boolean).join(' / ')}」` };
      case 'handover':
        return { kind: 'handover', text: `转人工${str(p.handoverMessage) ? `「${p.handoverMessage}」` : ''}` };
      case 'canvas-event-action': {
        const text = str(p.params?.text);
        return { kind: 'event', text: `发出事件「${str(p.eventName) || String(p.eventId ?? '').slice(0, 8)}」${text ? `：${text}` : ''}` };
      }
      case 'update-data':
        return { kind: 'other', text: `写 ${asArray(p.operations).length} 个字段`, fields: asArray(p.operations).length };
      case 'tag-user':
      case 'smart-tag': {
        const names = asArray(p.tags).map((t) => str(t?.tagName)).filter(Boolean);
        return { kind: 'other', text: `${p.operation === 'REMOVE' ? '去标签' : '打标签'}${names.length ? ` ${names.join('、')}` : ''}` };
      }
      default:
        return { kind: 'other', text: String(action?.type ?? '未知动作') };
    }
  });
}

const KIND_ORDER = { reply: 0, handover: 1, event: 2, other: 3 };

// 只有几十个字的摘要里，回复和转人工排最前：它们最常被找，平台原顺序里却常排在一串写字段、打标签后面（真机上因此被截掉）。
// 多次写字段合成一条，其余保持平台原顺序
export function actionSummary(outputActions) {
  const items = actionTexts(outputActions);
  const fields = items.filter((a) => a.fields !== undefined).reduce((sum, a) => sum + a.fields, 0);
  const merged = [];
  for (const item of items) {
    if (item.fields === undefined) merged.push(item);
    else if (!merged.some((a) => a.fields !== undefined)) merged.push({ ...item, text: `写 ${fields} 个字段` });
  }
  return merged
    .map((a, i) => ({ ...a, i }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.i - b.i)
    .map((a) => a.text)
    .join('；');
}

export function summarizeRow(row) {
  const tc = row?.triggerContent ?? {};
  const triggerType = str(tc.triggerType) || str(row?.rawTrigger?.triggerType);
  const eventName = str(tc.content?.eventName);
  const cost = typeof row?.totalCostInCny === 'number' ? row.totalCostInCny : Number.parseFloat(row?.totalCostInCny);
  return {
    execId: String(row?.execId ?? ''),
    at: row?.createdAt ?? null,
    status: str(row?.status),
    triggerType,
    trigger: eventName ? `事件「${eventName}」` : TRIGGER_LABEL[triggerType] ?? (triggerType || '-'),
    eventName,
    triggerText: extractTriggerTextFromSnapshot({ triggerContent: row?.triggerContent, eventSnapshot: row?.rawTrigger }),
    actions: actionSummary(row?.outputActions),
    version: str(row?.canvasVersion),
    canary: row?.isCanary === true,
    cost: Number.isFinite(cost) ? cost : null,
    feedback: str(row?.feedbackStatus),
  };
}

export function formatRow(s) {
  const feedback = s.feedback === 'thumb-down' ? ' 👎' : s.feedback === 'thumb-up' ? ' 👍' : '';
  const status = s.status && s.status !== 'success' ? `（${s.status}）` : '';
  return `${formatTime(s.at)} ${s.execId} ${s.trigger}${status} ｜ ${clip(s.triggerText, 40) || '-'} ｜ ${clip(s.actions, 60) || '无动作'} ｜ ${s.version || '-'}${s.canary ? '（灰度）' : ''} ${formatCost(s.cost)}${feedback}`;
}

export function buildSearchBody(f) {
  if (f.event && f.trigger && f.trigger !== 'canvas-event-trigger') throw usage('--event 只能配事件触发，不能和别的 --trigger 一起用');
  if (f.down && f.up) throw usage('--down 和 --up 只能选一个');
  const body = { botId: f.botId, startTimestamp: f.start, endTimestamp: f.end };
  if (f.keyword) body.keyword = f.keyword;
  if (f.session) body.sessionId = f.session;
  if (f.down) body.feedbackStatus = 'thumb-down';
  if (f.up) body.feedbackStatus = 'thumb-up';
  const trigger = f.event ? 'canvas-event-trigger' : f.trigger;
  if (trigger) body.triggerType = trigger;
  if (f.action) body.actionType = f.action;
  if (f.versionCanvasId) body.canvasId = f.versionCanvasId;
  if (typeof f.canary === 'boolean') body.isCanary = f.canary;
  if (f.failed) body.allNodesSuccess = false;
  return body;
}

export async function searchExecutions(identity, orgId, body, { eventName = '', limit = 20, scanPages = 5, onPage = () => {} } = {}) {
  const local = Boolean(eventName);
  const pageSize = local ? PAGE_SIZE : Math.min(PAGE_SIZE, limit);
  const maxPages = local ? scanPages : Math.ceil(limit / pageSize);
  const matches = [];
  const namesSeen = new Map();
  let total = null;
  let scanned = 0;
  let pages = 0;
  let oldestAt = null;
  // stop：limit = 取满了 --limit；scan = 扫到 --scan 上限还没扫完；end = 窗口里的都看过了。
  // scanned 只算真正看过的行：在某页中间取满时不能按整页算，否则「接着扫」的提示会让人原地打转（审查 I-2）
  let stop = null;
  for (let page = 1; page <= maxPages; page++) {
    const res = await listExecutions(identity, orgId, { ...body, current: page, pageSize });
    if (res.total !== null) total = res.total;
    pages = page;
    for (const row of res.rows) {
      scanned++;
      if (row?.createdAt) oldestAt = row.createdAt;
      if (local) {
        const name = str(row?.triggerContent?.content?.eventName);
        if (name) namesSeen.set(name, (namesSeen.get(name) ?? 0) + 1);
        if (name !== eventName) continue;
      }
      matches.push(row);
      if (matches.length >= limit) {
        stop = 'limit';
        break;
      }
    }
    onPage({ page, scanned, matched: matches.length, total });
    if (stop) break;
    if (res.rows.length < pageSize) {
      stop = 'end';
      break;
    }
  }
  if (total !== null && scanned >= total) stop = 'end';
  if (!stop) stop = local ? 'scan' : 'end';
  return { matches, total, scanned, pages, stop, oldestAt, namesSeen };
}

// 按事件名本地扫时的一句总结。列表是新到旧，所以「接着扫」= 保持起点、把终点挪到已扫到的最旧那条之前，不重扫
export function scanSummary(res, { limit, from }) {
  const head = `窗口内共 ${res.total ?? '?'} 条事件执行；`;
  if (res.stop === 'limit') return `${head}看了 ${res.scanned} 条，已取满 --limit ${limit}（要更多就加大 --limit）`;
  if (res.stop === 'scan') {
    const next = res.oldestAt
      ? `；接着往前扫：把 --since 换成 --from "${new Date(from).toISOString()}" --to "${new Date(Date.parse(res.oldestAt) - 1).toISOString()}"（从停下的地方继续，不重扫）`
      : '；要接着扫就缩小时间窗';
    return `${head}扫了 ${res.scanned} 条（到 --scan 上限），命中 ${res.matches.length} 条${next}`;
  }
  return `${head}扫了 ${res.scanned} 条，命中 ${res.matches.length} 条（已扫完）`;
}
