// md 的错误都带退出码：AI 按退出码决定下一步（3 = 让用户重新取身份，4 = 目标有歧义，5 = 推送被拦）。
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, TARGET: 4, BLOCKED: 5 });

export class MdError extends Error {
  constructor(code, message, { exitCode = EXIT.ERROR, hint = '' } = {}) {
    super(message);
    this.name = 'MdError';
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function usage(message, hint = '') {
  return new MdError('usage', message, { exitCode: EXIT.USAGE, hint });
}
