// md 的错误都带退出码：AI 按退出码决定下一步（3 = 让用户重新取身份，4 = 目标有歧义，5 = 推送被拦）。
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, TARGET: 4, BLOCKED: 5 });

export class MdError extends Error {
  constructor(code, message, { exitCode = EXIT.ERROR, hint = '', status = null } = {}) {
    super(message);
    this.name = 'MdError';
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
    // 秒懂返回的 HTTP 状态码（上游报错时才有）：按它判断，不要在报错全文里找字符串——正文里可能恰好也写着「HTTP 404」
    this.status = status;
  }
}

export function usage(message, hint = '') {
  return new MdError('usage', message, { exitCode: EXIT.USAGE, hint });
}
