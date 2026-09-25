// 跑一次单节点试跑：POST 一次，每 2 秒查一次，最长 5 分钟。
// POST 结果不明时绝不重发：秒懂没有取消接口，也没有能列出节点执行的接口，重发可能跑两遍（多花钱，插件节点还会多调一次外部系统）。

import { getNodeTrialRun, startNodeTrialRun } from '../vendor/laodong/apps/api/lib/miaodong/trial-core.ts';
import { request } from './http.mjs';
import { MdError } from './errors.mjs';

export const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_POLL_ERRORS = 3;
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultPollMs = () => (Number(process.env.MD_POLL_MS) > 0 ? Number(process.env.MD_POLL_MS) : 2000);
// 只能调短（测试用）：调短只会更早带着 timedOut 返回，不会多跑、多花钱
const defaultTimeoutMs = () => (Number(process.env.MD_TRIAL_TIMEOUT_MS) > 0 ? Math.min(Number(process.env.MD_TRIAL_TIMEOUT_MS), RUN_TIMEOUT_MS) : RUN_TIMEOUT_MS);

// sent 记下请求有没有真的发出去：没发出去就失败（参数校验）= 明确没启动
function requesterFor(identity, sent = { value: false }) {
  return (path, { method = 'GET', body, query } = {}) => {
    sent.value = true;
    return request(identity, path, { method, body, query, timeoutMs: 60_000 });
  };
}

function startFailure(error, sent) {
  // 身份失效、企业到期、积分不足都是秒懂明确拒绝，原样报出去，方便用户对症处理
  if (error instanceof MdError && ['auth_expired', 'org_expired', 'points_exhausted'].includes(error.code)) return error;
  // 明确被拒（业务错误、HTTP 4xx、请求还没发出去就失败）= 没启动；网络错误、超时、5xx、缺 execId = 不知道启动没有。
  // 按状态码判断，不在报错全文里找「HTTP 4xx」：5xx 的正文里可能恰好带着（审查 I5）
  const refused = !sent || (error instanceof MdError && (error.code === 'business' || (error.code === 'upstream' && error.status >= 400 && error.status < 500)));
  if (refused) return new MdError('trial_not_started', `试跑没有启动：${error?.message ?? error}`);
  return new MdError('trial_start_unknown', `试跑有没有启动不确定：${error?.message ?? error}`, {
    hint: '不要重试（可能已经在跑）：去秒懂画布页看这个节点的运行结果',
  });
}

export async function runNodeOnce({ identity, orgId, canvasId, node, inputs }, { sleep = sleepMs, now = Date.now, pollMs = defaultPollMs(), timeoutMs = defaultTimeoutMs() } = {}) {
  const sent = { value: false };
  const requester = requesterFor(identity, sent);
  let execId;
  try {
    ({ execId } = await startNodeTrialRun(requester, { orgId, canvasId, nodeId: node.id, nodeInputs: inputs }));
  } catch (error) {
    throw startFailure(error, sent.value);
  }
  const started = now();
  let errors = 0;
  for (;;) {
    let run;
    try {
      run = await getNodeTrialRun(requester, {
        orgId, nodeExecId: execId, canvasId, nodeId: node.id,
        nodeName: node.name, nodeType: node.type, nodeCategory: node.category, nodeInputs: inputs,
      });
      errors = 0;
    } catch (error) {
      if (error instanceof MdError && error.code === 'auth_expired') throw error;
      errors++;
      if (errors >= MAX_POLL_ERRORS) {
        throw new MdError('trial_poll_failed', `试跑已启动（${execId}），但连续 ${errors} 次查不到结果：${error?.message ?? error}`, {
          hint: '去秒懂画布页看这个节点的运行结果；不要重跑',
        });
      }
      await sleep(pollMs);
      continue;
    }
    if (run.isTerminal) return { execId, run, timedOut: false };
    if (now() - started >= timeoutMs) return { execId, run, timedOut: true };
    await sleep(pollMs);
  }
}
