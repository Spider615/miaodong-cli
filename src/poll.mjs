// 轮询间隔。环境变量只给测试调快用（假秒懂上几毫秒就有结果）：只能比默认快，不能更慢；
// 认不出的值、0、负数用默认。以前任意正数都收：设得很大时第一次查结果就晚于超时；超过 2^31 毫秒的 setTimeout 会立刻触发，反而变成不停地发请求
export function envPollMs(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(value, fallback));
}
