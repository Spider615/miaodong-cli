// 事件契约来自控制台 1.19.17；所有请求只落到本机假秒懂。
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { node } from './fixtures.mjs';

export const EVENTS_BOT = '181fc177-0000-4000-8000-000000000000';
export const eid = (n) => `e7e7${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;
export const event = (n, name, patch = {}) => ({
  eventId: eid(n), botId: EVENTS_BOT, orgId: 'org-1', name,
  variables: [{ name: 'text', type: { type: 'string' } }],
  triggerTimesType: 'unlimited', maxTriggerTimes: 0,
  effectiveDateType: 'always', effectiveDateConfig: [],
  effectiveTimeType: 'always', effectiveTimeConfig: [],
  triggerIntervalType: 'no_interval', triggerIntervalSeconds: 0,
  isHidden: false, createdAt: '2026-10-01T00:00:00.000Z', ...patch,
});

export async function startEventsServer() {
  const state = {};
  let seq = 100;
  const reset = (patch = {}) => {
    Object.assign(state, { events: [event(1, '跟进'), event(2, '隐藏的事件', { isHidden: true })], used: false, draft: [], posts: [], ...patch });
  };
  reset();
  const server = await startFakeMiaodong({
    'GET /api/bot/list': () => ok([{ id: EVENTS_BOT, name: '测试智能体' }]),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: state.draft }),
    'GET /api/canvas/event/list': () => ok(state.events),
    'GET /api/canvas/event/event-used': () => ok({ isUsed: state.used }),
    'POST /api/canvas/event/create': (q) => {
      state.posts.push(q);
      state.events.push(event(++seq, q.body.name, q.body));
      return ok(null);
    },
    'POST /api/canvas/event/update': (q) => {
      state.posts.push(q);
      Object.assign(state.events.find((x) => x.eventId === q.body.eventId), q.body);
      return ok(null);
    },
    'POST /api/canvas/event/toggle-visibility': (q) => {
      state.posts.push(q);
      state.events.find((x) => x.eventId === q.body.eventId).isHidden = q.body.isHidden;
      return ok(null);
    },
    'POST /api/canvas/event/import': (q) => {
      state.posts.push(q);
      const eventIdMap = {};
      for (const item of q.body.events) {
        const id = eid(++seq);
        eventIdMap[item.eventId] = id;
        state.events.push({ ...item, eventId: id });
      }
      return ok({ eventIdMap });
    },
  });
  return { server, state, reset, draftUse: () => [node(1, { name: '事件入口', shape: eid(1), type: 'canvas-event-trigger', payload: { eventId: eid(1) } })] };
}
