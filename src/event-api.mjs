// 事件管理接口（控制台 1.19.17）。orgId 在 query；没有删除接口，也不能用删除重建模拟修改。
import { request } from './http.mjs';
import { MdError } from './errors.mjs';
import { object } from './events.mjs';

export async function listEventDefinitions(identity, orgId, botId) {
  const payload = await request(identity, '/api/canvas/event/list', { query: { orgId, botId, eventListFilter: 'all' } });
  const rows = payload?.data;
  // 写前不能把未知响应当空列表，否则会跳过重名和并发检查。
  if (!Array.isArray(rows) || rows.some((e) => !object(e) || typeof e.eventId !== 'string' || !e.eventId || typeof e.name !== 'string' || !Array.isArray(e.variables) || (e.botId !== undefined && e.botId !== botId) || (e.orgId !== undefined && e.orgId !== orgId)) || new Set(rows.map((e) => e.eventId)).size !== rows.length) {
    throw new MdError('events_unavailable', '事件列表响应不完整，已停止操作');
  }
  return rows;
}

export async function eventIsUsed(identity, orgId, botId, eventId) {
  const payload = await request(identity, '/api/canvas/event/event-used', { query: { orgId, botId, eventId } });
  if (typeof payload?.data?.isUsed !== 'boolean') throw new MdError('event_usage_unavailable', '取不到可靠的事件引用信息，已停止操作');
  return payload.data.isUsed;
}

export function createEvent(identity, orgId, botId, config) {
  return request(identity, '/api/canvas/event/create', { method: 'POST', query: { orgId }, body: { ...config, botId } });
}

export function updateEvent(identity, orgId, botId, event) {
  return request(identity, '/api/canvas/event/update', { method: 'POST', query: { orgId }, body: { ...event, botId } });
}

export function setEventVisibility(identity, orgId, eventId, isHidden) {
  // 接口名字叫 toggle，但前端传的是目标状态，不能省略 isHidden。
  return request(identity, '/api/canvas/event/toggle-visibility', { method: 'POST', query: { orgId }, body: { eventId, isHidden } });
}

export function importEvents(identity, orgId, botId, events) {
  return request(identity, '/api/canvas/event/import', { method: 'POST', query: { orgId }, body: { botId, events } });
}
