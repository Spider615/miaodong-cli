// 花钱、调插件、调高门槛之前要用户确认（spec §7）：md 先停下，打出预估、原因和一个确认码（退出码 5）；
// AI 把这些单独告诉用户（不能夹在别的问题里），用户明确同意这一笔后，同一条命令加 --confirm <码> 再跑。
// 码绑定这次操作的全部要素（智能体、节点、次数、输入、预估、插件、日期），任何一样变了就对不上，要重新问。
// 这是约定不是锁：码只有 AI 看得到，能证明 AI 看过金额，证明不了它真的问过用户。2026-09-25 用户决定不用弹窗。

import { createHash } from 'node:crypto';
import { boolWord } from './args.mjs';
import { stableStringify } from './canvas.mjs';
import { EXIT, MdError, usage } from './errors.mjs';
import { out } from './output.mjs';

export function confirmCode(operation) {
  return createHash('sha256').update(stableStringify(operation)).digest('hex').slice(0, 8);
}

// 同一笔操作每确认过一次（账本里记着 opKey），码就换一个：用过的码自然对不上，同样的操作要再跑就得再问一次。
// previous 是上一个已经用掉的码，用来把「用过了」和「抄错了 / 操作变了」分开报
export function codeFor(operation, rows = []) {
  const opKey = confirmCode(operation);
  const uses = rows.filter((r) => r?.opKey === opKey).length;
  return { opKey, code: confirmCode({ opKey, n: uses }), previous: uses ? confirmCode({ opKey, n: uses - 1 }) : null };
}

// 没给 --confirm、或写的是 --confirm false / no / 0 是 null（预演：写 false 的人显然不想确认，码是 8 位十六进制、不会是这几个词）；
// 只写了 --confirm 没给值是 ''（一定对不上）。读 --confirm 的只有这里
export function givenCode(args) {
  const v = args.confirm;
  if (Array.isArray(v)) throw usage('--confirm 只能给一次');
  if (v === undefined || v === false) return null;
  if (v === true) return '';
  const code = String(v).trim();
  return boolWord(code) === false ? null : code;
}

// 估算金额进确认码前取到 0.0001 元：同一笔操作重算出来的浮点数，不会因为最后几位不同而对不上
export const roundCost = (value) => (value === null ? null : Math.round(value * 10000) / 10000);

// 需要用户确认：把原因和确认码打出来，什么都不跑（退出码 5）。remaining 有值时是「跑到一半停下，其余几次要确认」
export function stopForConfirm({ code, previous, given, reasons, remaining = null }) {
  const what = remaining ? `其余 ${remaining} 次` : '';
  out(`⛔ 要用户确认才能跑${what}：${reasons.join('；')}`);
  out(`确认码：${code}（只对这一笔有效：次数、输入、预估任何一样变了就作废，用过一次也作废）`);
  const hint = remaining
    ? `把已跑的实际花费和其余 ${remaining} 次的预估单独告诉用户（不要夹在别的问题里）；用户明确同意后，同一条命令把 --times 改成 ${remaining}，再加 --confirm ${code}`
    : `把上面的预估和原因单独告诉用户（不要夹在别的问题里）；用户明确同意这一笔后，同一条命令加 --confirm ${code}`;
  if (given !== null && given === previous) throw new MdError('confirm_used', `确认码 ${given} 已经用过了：每个码只能用一次`, { exitCode: EXIT.BLOCKED, hint });
  if (given !== null) throw new MdError('confirm_mismatch', `确认码对不上（给的是 ${given || '空'}，当前是 ${code}）：次数、输入或预估和上次不一样了`, { exitCode: EXIT.BLOCKED, hint });
  throw new MdError('confirm_needed', `需要用户确认${what}：${reasons.join('；')}`, { exitCode: EXIT.BLOCKED, hint });
}
