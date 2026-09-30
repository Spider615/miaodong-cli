// 秒懂接口封装：只做「请求 + 把外壳拆成 md 用的形状」，不含业务判断。
// 路径与参数位置都来自仓库已接入的代码或会话实测（见 spec §11），orgId 一律放 query。

import { request } from './http.mjs';
import { MdError } from './errors.mjs';
import { deriveDomainEdges, deriveDomainNodes } from '../vendor/laodong/apps/api/lib/miaodong/canvas-derive.ts';

const str = (value) => (typeof value === 'string' ? value : '');

export function asArray(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.list) ? value.list : [];
}

export async function listBots(identity, orgId) {
  const payload = await request(identity, '/api/bot/list', { query: { orgId } });
  return asArray(payload?.data)
    .map((bot) => ({ id: str(bot.id), name: str(bot.name), enabled: bot.enabled !== false }))
    .filter((bot) => bot.id);
}

export async function getCanvas(identity, orgId, botId, canvasId) {
  const payload = await request(identity, '/api/canvas/get', { query: { botId, orgId, canvasId } });
  const data = payload?.data ?? {};
  const canvas = {
    canvasId: str(data.canvasId),
    rawCanvas: Array.isArray(data.rawCanvas) ? data.rawCanvas : [],
    version: str(data.version),
    updatedAt: str(data.updatedAt),
    name: str(data.name),
    isRoot: data.isRoot === true,
    rootCanvasId: str(data.rootCanvasId),
    versionType: str(data.versionType),
  };
  // 上游异常时这里和「真的是空画布」长得一样；两样都空就当异常，免得拿空画布去比、去推
  if (!canvas.canvasId && canvas.rawCanvas.length === 0) {
    throw new MdError('canvas_missing', `秒懂没有返回画布内容（智能体 ${botId}${canvasId ? `，版本 ${canvasId}` : ''}）`, {
      hint: '确认智能体选对了、画布已经初始化',
    });
  }
  return canvas;
}

export async function listVersions(identity, orgId, mainCanvasId) {
  // list-version 要的是主画布（草稿）的 canvasId，不是 botId
  const payload = await request(identity, '/api/canvas/list-version', {
    query: { canvasId: mainCanvasId, orgId, current: 1, pageSize: 1000 },
  });
  return asArray(payload?.data)
    .map((v) => ({
      canvasId: str(v.canvasId),
      version: str(v.version),
      name: str(v.name),
      versionType: str(v.versionType),
      isCanary: v.isCanary === true,
      testStatus: str(v.testStatus),
      passedRate: typeof v.passedRate === 'number' ? v.passedRate : null,
      createdAt: str(v.createdAt),
      createdBy: str(v.createdBy),
      isLocked: v.isLocked === true,
    }))
    .filter((v) => v.canvasId);
}

export async function basicInfo(identity, orgId, botId) {
  // 只有前端代码证据；取不到就返回 null，由调用方说明「取不到」
  try {
    const payload = await request(identity, '/api/bot/basic-info', { query: { botId, orgId } });
    const data = payload?.data ?? {};
    return { name: str(data.name), canvasVersion: str(data.canvasVersion), enabledCanvasId: str(data.enabledCanvasId), mainCanvasId: str(data.mainCanvasId) };
  } catch (error) {
    if (error instanceof MdError && error.code === 'auth_expired') throw error;
    return null;
  }
}

// 会话变量 / 事件列表在个别区版本不齐；取不到返回 null，由调用方说明，不中断拉取。
// 网络出错、超时、5xx 是偶发的，先重试两次再算取不到：md test run 的跑前检查偶发「取不到列表」就是一次超时，重试即过
const RETRY_DELAYS_MS = [300, 1000];
const transient = (error) => error instanceof MdError && (error.code === 'network' || (error.code === 'upstream' && error.status >= 500));

async function optionalArray(fetchOnce) {
  for (let attempt = 0; ; attempt++) {
    try {
      return asArray((await fetchOnce())?.data);
    } catch (error) {
      if (error instanceof MdError && error.code === 'auth_expired') throw error;
      if (!transient(error) || attempt >= RETRY_DELAYS_MS.length) return null;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

export function listSessions(identity, orgId, botId) {
  return optionalArray(() => request(identity, '/api/session-memory/list', { query: { botId, orgId } }));
}

export function listEvents(identity, orgId, botId) {
  // 固定带 eventListFilter=all：不带时是否包含隐藏事件没有确认
  return optionalArray(() => request(identity, '/api/canvas/event/list', { query: { botId, orgId, eventListFilter: 'all' } }));
}

// canvas/save 是全量覆盖、写编辑器草稿；nodes / edges 由 rawCanvas 推出（与老懂、kit 同一套契约）
export function saveCanvas(identity, orgId, canvasId, rawCanvas) {
  return request(identity, '/api/canvas/save', {
    method: 'POST',
    query: { orgId },
    body: { canvasId, rawCanvas, nodes: deriveDomainNodes(rawCanvas), edges: deriveDomainEdges(rawCanvas) },
    timeoutMs: 120_000,
  });
}

// 会话属性（智能体的 session memory 定义）的增、改、删。接口文档 13.9.2 只列了路径，请求体照控制台 1.19.11 的写法：
// 新增 {botId, name, type: {type}, description}；修改多一个 itemId、三样都要带（控制台编辑也是整条提交）；删除 {botId, itemId}。
// 会话属性没有草稿这一层，写进去立刻对整个智能体生效。当前版本引用着的，秒懂拒绝删除和改类型（业务错误）
export function createSessionVar(identity, orgId, botId, { name, type, description }) {
  return request(identity, '/api/session-memory/create', { method: 'POST', query: { orgId }, body: { botId, name, type: { type }, description } });
}

export function updateSessionVar(identity, orgId, botId, { id, name, type, description }) {
  return request(identity, '/api/session-memory/update', { method: 'POST', query: { orgId }, body: { botId, itemId: id, name, type: { type }, description } });
}

export function deleteSessionVar(identity, orgId, botId, id) {
  return request(identity, '/api/session-memory/delete', { method: 'POST', query: { orgId }, body: { botId, itemId: id } });
}
