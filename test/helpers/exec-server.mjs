// 带执行记录的假秒懂：列表按请求体筛选、分页、新到旧排；详情按 execId 取，没有就回 CANVAS_EXEC_NOT_FOUND。
// ignoreSession：列表不按会话筛（模拟接口没认 sessionId）；listFails：列表接口报 500
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { EXEC_BOT, X, chainRows, delayDetail, draftCanvas } from './exec-fixtures.mjs';

export const EXEC_EVENTS = [{ eventId: 'ev-delay', name: '延时回复' }, { eventId: 'ev-send', name: '发送' }];

export async function startExecServer({ rows = chainRows(), details = { [X(2)]: delayDetail() }, extraDetails = {}, ignoreSession = false, listFails = false } = {}) {
  const all = { ...details, ...extraDetails };
  return startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: EXEC_BOT, name: '太极2.0 质检革新版' }] : []),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: draftCanvas(), version: 'v1.0.403', updatedAt: '2026-09-24T01:00:00.000Z' }),
    'GET /api/canvas/list-version': () => ok([{ canvasId: 'ver-402', version: 'v1.0.402', name: '402', versionType: 'online' }]),
    'GET /api/canvas/event/list': () => ok(EXEC_EVENTS),
    'POST /api/canvas/history/list': ({ body }) => {
      if (listFails) return { status: 500, body: { code: -1, message: 'INTERNAL_ERROR' } };
      let list = rows.filter((r) => {
        const t = Date.parse(r.createdAt);
        return t >= body.startTimestamp && t <= body.endTimestamp;
      });
      if (body.sessionId && !ignoreSession) list = list.filter((r) => r.sessionId === body.sessionId);
      if (body.triggerType) list = list.filter((r) => r.triggerContent?.triggerType === body.triggerType);
      if (body.actionType) list = list.filter((r) => (r.outputActions ?? []).some((a) => a.type === body.actionType));
      if (body.keyword) list = list.filter((r) => JSON.stringify([r.triggerContent?.content?.text, r.outputActions]).includes(body.keyword));
      if (body.canvasId) list = list.filter((r) => body.canvasId === 'ver-402' && r.canvasVersion === 'v1.0.402');
      if (typeof body.isCanary === 'boolean') list = list.filter((r) => r.isCanary === body.isCanary);
      if (body.feedbackStatus) list = list.filter((r) => r.feedbackStatus === body.feedbackStatus);
      list = [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const from = (body.current - 1) * body.pageSize;
      return ok(list.slice(from, from + body.pageSize), { page: { current: body.current, pageSize: body.pageSize, total: list.length } });
    },
    'GET /api/canvas/history/details': ({ query }) => (all[query.execId]
      ? ok(all[query.execId])
      : { status: 201, body: { code: -1, message: 'CANVAS_EXEC_NOT_FOUND' } }),
  });
}
