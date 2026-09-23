// 输出约定：stdout 只放给 AI / 用户读的结果，stderr 放过程提示与报错。
// 退出前必须等两个流都写完：输出经管道给 AI 读时，裸 process.exit 会在 64KB 处静默截断。
// kit 旧的 flushExit 只看 write('') 的返回值，Node 22 上照样截断（已实测），这里改等回调。

import { shortId } from '../lib/summarize.mjs';

export { shortId };

export function out(text = '') {
  process.stdout.write(`${text}\n`);
}

export function note(text = '') {
  process.stderr.write(`${text}\n`);
}

function drain(stream) {
  return new Promise((resolve) => stream.write('', () => resolve()));
}

export async function finish(code) {
  await drain(process.stdout);
  await drain(process.stderr);
  process.exit(code);
}

export function formatTime(value) {
  if (value === null || value === undefined || value === '') return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 每条命令输出的第一行：区 / 企业 / 智能体 (id8) / 版本。推错智能体的事故都始于看错这一行。 */
export function targetLine(target) {
  const parts = [target.regionLabel, target.orgName, `${target.botName} (${shortId(target.botId)})`];
  if (target.versionLabel) parts.push(target.versionLabel);
  return parts.join(' / ');
}
