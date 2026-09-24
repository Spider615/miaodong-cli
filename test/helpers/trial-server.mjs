// 带单节点试跑接口的假秒懂。state 在测试里可改：startStatus（POST 返回的 HTTP 状态）、runningPolls（先回几次 running）、
// pollStatus（GET 返回的 HTTP 状态）、cost（每次试跑的花费）。POST 请求体都记在 state.posts 里。
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { U, node } from './fixtures.mjs';
import { EXEC_BOT, X, delayDetail, execSnapshot } from './exec-fixtures.mjs';

// 在 2a 的快照上：回答生成多一个平台参数输入；再加一个插件计算节点和一个挂了插件工具的大模型
export function trialDraft() {
  return [
    ...execSnapshot().map((c) => (c.id === U(2)
      ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, inputs: [...c.data.nodePayload.inputs, { name: '质检规则', operationAttrId: 'op-1', valueType: 'reference', type: { type: 'string' } }] } } }
      : c)),
    node(7, { name: '兴趣岛用户详情', type: 'plugin-calculation' }),
    node(8, { name: '带插件的大模型', payload: { modelType: 'gemini-3.5-flash', inputs: [{ name: 'text' }], tools: [{ toolType: 'plugin', name: '写多维表' }] } }),
  ];
}

export async function startTrialServer({ cost = 0.0123, startStatus = 201, runningPolls = 1, pollStatus = 200 } = {}) {
  const state = { posts: [], polls: new Map(), cost, startStatus, runningPolls, pollStatus };
  const server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: EXEC_BOT, name: '太极2.0 质检革新版' }] : []),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: trialDraft(), version: 'v1.0.403', updatedAt: '2026-09-24T01:00:00.000Z' }),
    'GET /api/canvas/history/details': ({ query }) => (query.execId === X(2) ? ok(delayDetail()) : { status: 201, body: { code: -1, message: 'CANVAS_EXEC_NOT_FOUND' } }),
    'POST /api/canvas/node/exec': ({ body }) => {
      state.posts.push(body);
      if (state.startStatus >= 400) return { status: state.startStatus, body: { statusCode: state.startStatus, message: state.startStatus >= 500 ? 'Bad Gateway' : 'Bad Request' } };
      return { status: 201, body: { code: 0, data: { execId: `ne-${state.posts.length}` } } };
    },
    'GET /api/canvas/node/exec': ({ query }) => {
      if (state.pollStatus >= 400) return { status: state.pollStatus, body: { message: 'Internal Server Error' } };
      const n = (state.polls.get(query.nodeExecId) ?? 0) + 1;
      state.polls.set(query.nodeExecId, n);
      const body = state.posts[Number(query.nodeExecId.slice(3)) - 1];
      if (n <= state.runningPolls) return ok({ execId: query.nodeExecId, nodeId: body.nodeId, status: 'running' });
      const text = String(body.inputs.inputData.text ?? '');
      return ok({
        execId: query.nodeExecId, nodeId: body.nodeId, status: 'success', processDuration: 1200,
        output: { message: `回复：${text}` },
        metadata: {
          prompt: [{ role: 'system', content: '你是客服。' }, { role: 'user', content: text }],
          reasoningMessage: '想了想',
          tokenUsage: { prompt: 100, completion: 10, costInCny: state.cost },
        },
      });
    },
  });
  return { server, state };
}
