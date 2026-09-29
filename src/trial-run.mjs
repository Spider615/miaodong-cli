// 试跑的一次：POST 一次，每 2 秒查一次，最长 5 分钟。单节点（/canvas/node/exec）和整条（/canvas/exec）共用轮询和启动失败的判定。
// POST 结果不明时绝不重发：秒懂没有取消接口，重发可能跑两遍（多花钱；插件节点还会多调一次外部系统）。

import { getNodeTrialRun, startNodeTrialRun } from '../vendor/laodong/apps/api/lib/miaodong/trial-core.ts';
import { asArray } from './api.mjs';
import { request } from './http.mjs';
import { MdError } from './errors.mjs';
import { envPollMs } from './poll.mjs';

export const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_POLL_ERRORS = 3;
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultPollMs = () => envPollMs('MD_POLL_MS', 2000);
// 只能调短（测试用）：调短只会更早带着 timedOut 返回，不会多跑、多花钱
const defaultTimeoutMs = () => (Number(process.env.MD_TRIAL_TIMEOUT_MS) > 0 ? Math.min(Number(process.env.MD_TRIAL_TIMEOUT_MS), RUN_TIMEOUT_MS) : RUN_TIMEOUT_MS);

// sent 记下请求有没有真的发出去：没发出去就失败（参数校验）= 明确没启动
function requesterFor(identity, sent = { value: false }) {
  return (path, { method = 'GET', body, query } = {}) => {
    sent.value = true;
    return request(identity, path, { method, body, query, timeoutMs: 60_000 });
  };
}

function startFailure(error, sent, where) {
  // 身份失效、企业到期、积分不足都是秒懂明确拒绝，原样报出去，方便用户对症处理
  if (error instanceof MdError && ['auth_expired', 'org_expired', 'points_exhausted'].includes(error.code)) return error;
  // 明确被拒（业务错误、HTTP 4xx、请求还没发出去就失败）= 没启动；网络错误、超时、5xx、缺 execId = 不知道启动没有。
  // 按状态码判断，不在报错全文里找「HTTP 4xx」：5xx 的正文里可能恰好带着（审查 I5）
  const refused = !sent || (error instanceof MdError && (error.code === 'business' || (error.code === 'upstream' && error.status >= 400 && error.status < 500)));
  if (refused) return new MdError('trial_not_started', `试跑没有启动：${error?.message ?? error}`);
  return new MdError('trial_start_unknown', `试跑有没有启动不确定：${error?.message ?? error}`, {
    hint: `不要重试（可能已经在跑）：去秒懂画布页看${where}`,
  });
}

async function pollUntil(fetchOnce, done, { execId, where, sleep, now, pollMs, timeoutMs }) {
  const started = now();
  let errors = 0;
  for (;;) {
    let run;
    try {
      run = await fetchOnce();
      errors = 0;
    } catch (error) {
      if (error instanceof MdError && error.code === 'auth_expired') throw error;
      errors++;
      if (errors >= MAX_POLL_ERRORS) {
        throw new MdError('trial_poll_failed', `试跑已启动（${execId}），但连续 ${errors} 次查不到结果：${error?.message ?? error}`, {
          hint: `去秒懂画布页看${where}；不要重跑`,
        });
      }
      await sleep(pollMs);
      continue;
    }
    if (done(run)) return { run, timedOut: false };
    if (now() - started >= timeoutMs) return { run, timedOut: true };
    await sleep(pollMs);
  }
}

export async function runNodeOnce({ identity, orgId, canvasId, node, inputs }, { sleep = sleepMs, now = Date.now, pollMs = defaultPollMs(), timeoutMs = defaultTimeoutMs() } = {}) {
  const sent = { value: false };
  const requester = requesterFor(identity, sent);
  const where = '这个节点的运行结果';
  let execId;
  try {
    ({ execId } = await startNodeTrialRun(requester, { orgId, canvasId, nodeId: node.id, nodeInputs: inputs }));
  } catch (error) {
    throw startFailure(error, sent.value, where);
  }
  const { run, timedOut } = await pollUntil(
    () => getNodeTrialRun(requester, {
      orgId, nodeExecId: execId, canvasId, nodeId: node.id,
      nodeName: node.name, nodeType: node.type, nodeCategory: node.category, nodeInputs: inputs,
    }),
    (r) => r.isTerminal,
    { execId, where, sleep, now, pollMs, timeoutMs },
  );
  return { execId, run, timedOut };
}

// 整条试跑的终态和秒懂页面一样（spec §2.1）：状态是这几个之一，而且没有节点还在「有序发送」（queued / sending）
export const FLOW_TERMINAL = new Set(['success', 'cancelled', 'canceled', 'error', 'failed', 'merged_skipped', 'interrupted']);

export function flowDone(result) {
  const delivering = asArray(result?.nodeResults).some((r) => ['queued', 'sending'].includes(r?.metadata?.orderedDelivery?.state));
  return FLOW_TERMINAL.has(String(result?.canvasExec?.status ?? '')) && !delivering;
}

// 整条试跑一次（spec §5.1）：body 由调用方拼好（canvasId、sessionId、触发、可选 sessionMemoryData）
export async function runFlowOnce({ identity, orgId, body }, { sleep = sleepMs, now = Date.now, pollMs = defaultPollMs(), timeoutMs = defaultTimeoutMs() } = {}) {
  const sent = { value: false };
  const requester = requesterFor(identity, sent);
  const where = '这次试跑的结果';
  let execId;
  try {
    if (!body?.canvasId) throw new Error('草稿没有 canvasId');
    const res = await requester('/api/canvas/exec', { method: 'POST', query: { orgId }, body });
    execId = String(res?.data?.execId ?? res?.data?.canvasExecId ?? '');
    if (!execId) throw new Error('秒懂没有返回 execId');
  } catch (error) {
    throw startFailure(error, sent.value, where);
  }
  try {
    const { run, timedOut } = await pollUntil(
      async () => (await requester('/api/canvas/exec', { query: { canvasExecId: execId, orgId } }))?.data ?? {},
      flowDone,
      { execId, where, sleep, now, pollMs, timeoutMs },
    );
    return { execId, result: run, timedOut };
  } catch (error) {
    // 已经启动了：后面不管怎么失败（查不到结果、身份失效……），调用方都要把这一次记进账本、告诉用户执行 id（审查 M1）
    if (error && typeof error === 'object') error.started = { execId };
    throw error;
  }
}

// 同一个试跑会话里、这次之后的执行（spec §5.3）。history/list 查不到试跑执行，list-by-session 能（09-29 实测：
// timestamp、pageSize 要字符串，direction 是 before / middle / after；用 middle 拿两边，再按时间筛）
export async function sessionExecsAfter(identity, orgId, { botId, sessionId, execId, sinceMs }) {
  const res = await request(identity, '/api/canvas/history/list-by-session', {
    query: { botId, sessionId, timestamp: String(sinceMs), direction: 'middle', pageSize: '20', orgId },
  });
  const at = (row) => Date.parse(row?.createdAt ?? '') || 0;
  return asArray(res?.data)
    .filter((row) => row?.execId && row.execId !== execId && at(row) >= sinceMs)
    .sort((a, b) => at(a) - at(b));
}
