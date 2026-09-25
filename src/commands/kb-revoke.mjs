// md kb revoke <导入id>（spec 3b §5）：撤回一次导入。默认只预演（只读）；用户本人确认计划码后才写。
// 撤回本身也能中断：再运行一次，预演会说明停在哪一步，确认后接着做。
import { confirmCode, givenCode } from '../confirm.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { loadIdentities } from '../identity.mjs';
import { loadRecord } from '../kb-import-store.mjs';
import { STEP_NAMES } from '../kb-import-run.mjs';
import { REVOKE_NAMES, revokePlan, runRevoke } from '../kb-revoke.mjs';
import { out, shortId } from '../output.mjs';

export async function revoke(args) {
  const importId = args._[0];
  if (!importId) throw usage('用法：md kb revoke <导入id> [--confirm <计划码>]', 'md kb imports 看本机有哪些导入记录');
  const rec = loadRecord(importId);
  const { state } = rec;
  out(`${state.region.label} / ${state.org.name} / ${state.kb.name} (${shortId(state.kb.id)}) · 撤回导入 ${importId}`);
  if (state.status === 'revoked') {
    out('这次导入已经撤回了');
    return EXIT.OK;
  }
  const identity = loadIdentities()[state.region.identityKey];
  if (!identity) throw new MdError('no_identity', `本机没有「${state.region.label}」的身份`, { exitCode: EXIT.AUTH, hint: '先问用户秒懂控制台的域名，然后 md auth snippet <域名>' });
  const ctx = { identity, orgId: state.org.id, kbId: state.kb.id, dir: rec.dir, state, pkg: rec.pkg };
  const plan = await revokePlan(ctx, rec);

  const status = state.status === 'done' ? '已完成'
    : state.stopped ? `停在「${STEP_NAMES[state.stopped.step]}」`
      : state.revoke ? '正在撤回' : `没写完（${state.status}）`;
  out(`这次导入：${status}`);
  if (state.revoke?.stopped) out(`撤回停在「${REVOKE_NAMES[state.revoke.stopped.step]}」：${state.revoke.stopped.reason}`);
  out(`要删（这次建的，还在库里的）：FAQ ${plan.deleteFaqIds.length} 条 · 文件 ${plan.deleteDocIds.length} 个`);
  const paragraphs = plan.docItems.reduce((n, d) => n + d.paragraphs.length, 0);
  out(`要重建（这次删的，从备份）：${plan.faqItems.length || plan.docItems.length ? `FAQ ${plan.faqItems.length} 条 · 文件 ${plan.docItems.length} 个（${paragraphs} 段）` : '没有'}`);
  if (plan.skipped.length) out(`不用重建（库里已经有同样的，可能有人手动恢复了）：${plan.skipped.join('、')}`);
  out(plan.changed.length ? `导入后被人改过的（撤回会连改动一起删掉）：${plan.changed.map((c) => c.text).join('、')}` : '导入后被人改过的：没有');
  const cut = plan.docItems.filter((d) => d.name !== d.full);
  if (cut.length) out(`名字超过 30 字，重建时截成：${cut.map((d) => `「${d.name}」`).join('、')}`);
  if (plan.docItems.some((d) => d.originalFile)) out(`原文件传不回秒懂：重建的是同名手工文件（段落一样），原文件在备份里：${rec.dir}/backup/docs`);

  const code = confirmCode({
    kind: 'kb-revoke', importId, steps: Object.keys(state.revoke?.steps ?? {}), scope: plan.scope,
    deleteFaqIds: plan.deleteFaqIds, deleteDocIds: plan.deleteDocIds, changed: plan.changed.map((c) => c.key),
  });
  const given = givenCode(args);
  if (given === null) {
    out(`这是预演，什么都没写。计划码：${code}`);
    out(`用户明确同意后执行：md kb revoke ${importId} --confirm ${code}`);
    return EXIT.OK;
  }
  if (given !== code) throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：库里的情况在预演之后变了，或者计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
  await runRevoke(ctx, plan);
  return EXIT.OK;
}
