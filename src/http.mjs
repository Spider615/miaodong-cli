// 秒懂内部 API 的唯一出口。与 kit / 老懂两份旧客户端的差别，每条都有来由：
// - 检查业务 code：登录失败是 HTTP 201 + code:-1，只看状态码会把失败当成功；
// - redirect: 'error'：F 区旧域名 301 会把 POST 降成 GET，而且跟随重定向会把 token 带去别处；
// - 401 / 403 不自动重登：md 没有密码，身份失效只能让用户在浏览器里重新取；
// - 报错里绝不带 token。

import { EXIT, MdError } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;

function buildUrl(origin, path, query) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

// 秒懂的报错字段不统一：页面优先展示 userMessage，exec 类接口只给 errorMessage + errorCode，校验失败时 message 是数组
function messageOf(payload) {
  const parts = [];
  for (const key of ['userMessage', 'message', 'errorMessage']) {
    const m = payload?.[key];
    const text = Array.isArray(m) ? m.join('；') : typeof m === 'string' ? m : '';
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (typeof payload?.errorCode === 'string' && payload.errorCode) parts.push(`[${payload.errorCode}]`);
  return parts.join(' ');
}

const POINTS_EXHAUSTED = 'AI_INTEGRAL_POINTS_EXHAUSTED';

function isOrgExpired(payload) {
  return payload?.code === -7 || payload?.reason === 'EXPIRED' || payload?.errorCode === 'ORG_EXPIRED';
}

export async function request(identity, path, { method = 'GET', query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = buildUrl(identity.origin, path, query);
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError'
      ? `超时（${Math.round(timeoutMs / 1000)} 秒）`
      : error?.cause?.message ?? error?.message ?? String(error);
    throw new MdError('network', `连不上 ${identity.label}（${url.host}）：${method} ${path} ${reason}`);
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  const businessFailed = payload && typeof payload === 'object' && !Array.isArray(payload) && 'code' in payload && Number(payload.code) !== 0;
  if ((!res.ok || businessFailed) && payload?.errorCode === POINTS_EXHAUSTED) {
    throw new MdError('points_exhausted', `${identity.label} 的秒懂积分不足：${payload.userMessage || '请充值后重试'}`, {
      hint: '让用户去秒懂充值；md 不会自动重试',
    });
  }
  if (res.status === 401 || (res.status === 403 && !isOrgExpired(payload))) {
    throw new MdError('auth_expired', `${identity.label} 的身份已失效（HTTP ${res.status}）`, {
      exitCode: EXIT.AUTH,
      hint: `请用户在浏览器里重新取身份：md auth snippet ${identity.origin}`,
    });
  }
  if (res.status === 403) throw new MdError('org_expired', `${identity.label} 的企业已到期（HTTP 403）`);
  if (!res.ok) {
    throw new MdError('upstream', `秒懂接口报错 ${method} ${path} → HTTP ${res.status}：${messageOf(payload) || text.slice(0, 200)}`, { status: res.status });
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'code' in payload && Number(payload.code) !== 0) {
    throw new MdError('business', `秒懂业务错误 ${method} ${path}：code=${payload.code} ${messageOf(payload)}`.trim());
  }
  return payload;
}
