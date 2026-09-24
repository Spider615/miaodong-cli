// 花钱、调插件、调高门槛之前要用户确认（spec §7）：md 先停下，打出预估、原因和一个确认码（退出码 5）；
// AI 把这些单独告诉用户（不能夹在别的问题里），用户明确同意这一笔后，同一条命令加 --confirm <码> 再跑。
// 码绑定这次操作的全部要素（智能体、节点、次数、输入、预估、插件、日期），任何一样变了就对不上，要重新问。
// 这是约定不是锁：码只有 AI 看得到，能证明 AI 看过金额，证明不了它真的问过用户。2026-09-25 用户决定不用弹窗。

import { createHash } from 'node:crypto';
import { stableStringify } from './canvas.mjs';
import { usage } from './errors.mjs';

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

// 没给 --confirm 是 null；只写了 --confirm 没给值是 ''（一定对不上）
export function givenCode(args) {
  const v = args.confirm;
  if (Array.isArray(v)) throw usage('--confirm 只能给一次');
  if (v === undefined || v === false) return null;
  return v === true ? '' : String(v).trim();
}
