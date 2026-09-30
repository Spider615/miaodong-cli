// 带会话属性的假秒懂：会话属性存在内存里，create / update / delete 会改它（请求体照控制台 1.19.11 的写法核对）。
// 草稿（main-1）、线上版本（ver-400）、灰度版本（ver-401）各一张画布，节点按 id 引用会话属性（inputs[].sessionMemoryItemId 等）。
// 秒懂自己的规矩照控制台的提示做：线上版本引用着的，删除、改类型回业务错误（「当前版本正在引用此会话属性」）
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { U, node, sampleCanvas } from './fixtures.mjs';

export const VARS_BOT = '181fc177-0000-4000-8000-000000000000';
export const SOURCE_BOT = '147bd600-0000-4000-8000-000000000000';
export const vid = (n) => `5e55${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

const item = (n, name, type, description = '', isDefault = false) => ({ id: vid(n), name, type: { type }, description, isDefault });

export function targetVars() {
  return [
    item(1, '消息历史', 'array', '', true),
    item(2, '意向', 'string', '客户意向'),
    item(3, '已报名', 'boolean', '是否报过名'),
    item(4, '分数', 'number', ''),
  ];
}

export function sourceVars() {
  return [
    item(51, '消息历史', 'array', '', true),
    item(52, '客户阶段', 'string', '售前 / 售后'),
    item(53, '预算', 'number', '单位：元'),
    item(54, '意向', 'string', '源里的意向'),
  ];
}

// 草稿：「回答生成」读「意向」，「规则中心」按「分数」分支；线上版本只读「意向」；灰度版本什么都不引用
const readVar = (canvas, nodeId, varId) => canvas.map((c) => (c.id === nodeId ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, inputs: [...(c.data.nodePayload.inputs ?? []), { name: 'v', type: 'reference', valueType: 'string', sessionMemoryItemId: varId }] } } } : c));
export function draftCanvas() {
  const rule = node(7, { name: '按分数分流', type: 'rule-center', payload: { branches: [{ branchId: 'b1', name: '高分', ruleGroup: { rules: [{ field: { sessionMemoryItemId: vid(4) }, operator: 'gt', value: { value: 80 } }] } }] } });
  return [...readVar(sampleCanvas(), U(2), vid(2)), rule];
}
export const onlineCanvas = () => readVar(sampleCanvas(), U(2), vid(2));

export async function startVarsServer() {
  const state = {};
  let n = 100;
  const reset = (patch = {}) => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, { vars: { [VARS_BOT]: targetVars(), [SOURCE_BOT]: sourceVars() }, draft: draftCanvas(), online: onlineCanvas(), canary: sampleCanvas(), posts: [], ...patch });
  };
  reset();
  const bad = (message) => ({ status: 400, body: { statusCode: 400, message, error: 'Bad Request' } });
  const refused = (message) => ({ status: 200, body: { code: -1, message } });
  const usedOnline = (id) => JSON.stringify(state.online).includes(id);
  const server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: VARS_BOT, name: '太极2.0重构' }, { id: SOURCE_BOT, name: '源智能体' }] : []),
    'GET /api/canvas/get': ({ query }) => {
      if (query.canvasId === 'ver-400') return ok({ canvasId: 'ver-400', rawCanvas: state.online, version: 'v1.0.400', updatedAt: '2026-09-20T00:00:00.000Z' });
      if (query.canvasId === 'ver-401') return ok({ canvasId: 'ver-401', rawCanvas: state.canary, version: 'v1.0.401', updatedAt: '2026-09-21T00:00:00.000Z' });
      return ok({ canvasId: query.botId === SOURCE_BOT ? 'main-src' : 'main-1', rawCanvas: query.botId === SOURCE_BOT ? sampleCanvas() : state.draft, version: 'v1.0.402', updatedAt: '2026-09-23T00:00:00.000Z' });
    },
    'GET /api/canvas/list-version': () => ok([
      { canvasId: 'ver-400', version: 'v1.0.400', name: '400', versionType: 'online', isCanary: false },
      { canvasId: 'ver-401', version: 'v1.0.401', name: '401', versionType: 'online', isCanary: true },
    ]),
    'GET /api/bot/basic-info': ({ query }) => ok({ name: '太极2.0重构', canvasVersion: 'v1.0.400', enabledCanvasId: query.botId === VARS_BOT ? 'ver-400' : '', mainCanvasId: 'main-1' }),
    'GET /api/session-memory/list': ({ query }) => ok(state.vars[query.botId] ?? []),
    'POST /api/session-memory/create': ({ body }) => {
      state.posts.push({ path: 'create', body });
      if (typeof body?.botId !== 'string' || typeof body?.name !== 'string' || typeof body?.type?.type !== 'string') return bad('botId、name、type.type 都要给');
      state.vars[body.botId].push({ id: `5e55${String(++n).padStart(4, '0')}-0000-4000-8000-000000000000`, name: body.name, type: { type: body.type.type }, description: body.description ?? '', isDefault: false });
      return ok(null);
    },
    'POST /api/session-memory/update': ({ body }) => {
      state.posts.push({ path: 'update', body });
      const list = state.vars[body?.botId] ?? [];
      const hit = list.find((v) => v.id === body?.itemId);
      if (!hit) return bad('itemId 不存在');
      if (hit.type.type !== body.type?.type && usedOnline(hit.id)) return refused('当前版本正在引用此会话属性，无法编辑数据类型');
      Object.assign(hit, { name: body.name, type: { type: body.type.type }, description: body.description ?? '' });
      return ok(null);
    },
    'POST /api/session-memory/delete': ({ body }) => {
      state.posts.push({ path: 'delete', body });
      if (usedOnline(body?.itemId)) return refused('当前版本正在引用此会话属性，无法删除');
      state.vars[body.botId] = (state.vars[body.botId] ?? []).filter((v) => v.id !== body.itemId);
      return ok(null);
    },
  });
  return { server, state, reset };
}
