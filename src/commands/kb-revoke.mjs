// md kb revoke <导入id>（spec 3b §5）：撤回一次导入。默认只预演（只读）；用户本人确认计划码后才写（先给这个库上锁）。
// 撤回本身也能中断：再运行一次，预演会说明停在哪一步，确认后接着做。
// 导入时认不清的（可能是秒懂改写了内容的这次写的，也可能是别人加的），撤回不删、列出来，退出码 1；
// 人在秒懂上处理完，再运行一次 md kb revoke <导入id> 复查。
import { confirmCode, givenCode } from '../confirm.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { loadIdentities } from '../identity.mjs';
import { loadRecord, lockKb } from '../kb-import-store.mjs';
import { STEP_NAMES } from '../kb-import-run.mjs';
import { REVOKE_NAMES, dismissLeftovers, leftovers, revokePlan, runRevoke } from '../kb-revoke.mjs';
import { describe } from '../kb-ops.mjs';
import { out, shortId } from '../output.mjs';

const SHOW = 20;
const listOf = (type, rows) => (rows.length ? `\n  ${describe(type, rows.slice(0, SHOW))}${rows.length > SHOW ? `……还有 ${rows.length - SHOW} 条` : ''}` : '');

function reportLeft(left, importId) {
  out(`撤回做完了，但还有 ${left.rows.length} 条分不清是不是这次建的，没删：${describe(left.type, left.rows)}`);
  out(`在秒懂上看一眼：是这次导入写进去的（秒懂改写了内容），就手动删掉；处理完再运行一次 md kb revoke ${importId} 复查`);
  return EXIT.ERROR;
}

export async function revoke(args) {
  const importId = args._[0];
  if (!importId) throw usage('用法：md kb revoke <导入id> [--confirm <计划码>]', 'md kb imports 看本机有哪些导入记录');
  const given = givenCode(args);
  let rec = loadRecord(importId);
  const release = given === null ? null : lockKb(rec.state.region.identityKey, rec.state.kb.id, `撤回导入 ${importId}`);
  try {
    if (release) rec = loadRecord(importId);
    const { state } = rec;
    out(`${state.region.label} / ${state.org.name} / ${state.kb.name} (${shortId(state.kb.id)}) · 撤回导入 ${importId}`);
    if (state.status === 'revoked' && !state.open) {
      out('这次导入已经撤回了');
      return EXIT.OK;
    }
    const identity = loadIdentities()[state.region.identityKey];
    if (!identity) throw new MdError('no_identity', `本机没有「${state.region.label}」的身份`, { exitCode: EXIT.AUTH, hint: '先问用户秒懂控制台的域名，然后 md auth snippet <域名>' });
    const ctx = { identity, orgId: state.org.id, kbId: state.kb.id, regionKey: state.region.identityKey, dir: rec.dir, state, pkg: rec.pkg };
    if (state.status === 'revoked') {
      // 撤回做完了，还有认不清的：复查它们还在不在（只读库）。都是别人的（不是这次导入建的），用户确认后不再追踪（只改本机记录）
      out('这次导入已经撤回了');
      const left = await leftovers(ctx);
      if (!left?.rows.length) {
        out(`分不清是不是这次建的那 ${left?.was ?? 0} 条已经不在了`);
        return EXIT.OK;
      }
      const code = confirmCode({ kind: 'kb-revoke-dismiss', importId, rows: left.rows.map((r) => r.id) });
      if (given === code) {
        dismissLeftovers(ctx, left);
        out(`不再追踪：${describe(left.type, left.rows)}（用户确认它们不是这次导入建的；秒懂上什么都没动）`);
        return EXIT.OK;
      }
      if (given !== null) throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的情况给用户看' });
      reportLeft(left, importId);
      out(`它们要是都不是这次导入建的（比如同事同一时间加的），用户确认后运行 md kb revoke ${importId} --confirm ${code}：md 不再追踪它们，秒懂上什么都不动。计划码：${code}`);
      return EXIT.ERROR;
    }
    const plan = await revokePlan(ctx, rec);

    const status = state.status === 'done' ? '已完成'
      : state.stopped ? `停在「${STEP_NAMES[state.stopped.step]}」`
        : state.revoke ? '正在撤回' : `没写完（${state.status}）`;
    out(`这次导入：${status}`);
    if (state.revoke?.stopped) out(`撤回停在「${REVOKE_NAMES[state.revoke.stopped.step]}」：${state.revoke.stopped.reason}`);
    const rs = plan.revokeSettle;
    if (rs?.repeat?.length) {
      throw new MdError('kb_revoke_refused', `重建时有 ${rs.repeat.length} 条已经确认过「多出来的不是撤回建的」、重发了一次，写的时候库里又多出来对不上的：${describe(rs.open.type, rs.others)}。两次都对不上，多半是秒懂改写了内容，md 没法照备份原样重建它们`, {
        hint: `在秒懂上手动处理：删掉上面列的，按备份（${rec.dir}/backup）手工恢复这几条`,
      });
    }
    if (rs?.open.op === 'create' && rs.unresolved.length) {
      out(`撤回上次停下时发出去、还没对上的：${rs.open.type === 'faq' ? 'FAQ' : '文件'} ${rs.unresolved.length} 条`);
      out(rs.others.length
        ? `  写的时候库里多出来、对不上的：${describe(rs.open.type, rs.others)}。确认就是认定它们不是撤回建的：md 不会动它们，没对上的会重新发一次`
        : '  在库里找不到，写的时候库里也没多出来别的：就是没建成，接着做会重新发一次');
    }
    const del = plan.deleteFaqs.length || plan.deleteDocs.length;
    out(`要删（这次建的，还在库里的）：${del ? `FAQ ${plan.deleteFaqs.length} 条 · 文件 ${plan.deleteDocs.length} 个${listOf('faq', plan.deleteFaqs)}${listOf('doc', plan.deleteDocs)}` : '没有'}`);
    const paragraphs = plan.docItems.reduce((n, d) => n + d.paragraphs.length, 0);
    out(`要重建（这次删的，从备份）：${plan.faqItems.length || plan.docItems.length ? `FAQ ${plan.faqItems.length} 条 · 文件 ${plan.docItems.length} 个（${paragraphs} 段）` : '没有'}`);
    if (plan.dupes.length) out(`库里已经有一样的（不是这次导入建的，可能有人手动恢复了；照样重建，会重复，确认前先在秒懂上看一眼）：${plan.dupes.join('、')}`);
    out(plan.changed.length ? `导入后被人改过的（撤回会连改动一起删掉）：${plan.changed.map((c) => c.text).join('、')}` : '导入后被人改过的：没有');
    if (plan.doubt) out(`分不清是不是这次建的（导入写的时候库里多出来、对不上的；撤回不会删它们）：${describe(plan.doubt.type, plan.doubt.rows)}`);
    const cut = plan.docItems.filter((d) => d.name !== d.full);
    if (cut.length) out(`名字超过 30 字，重建时截成：${cut.map((d) => `「${d.name}」`).join('、')}`);
    if (plan.docItems.some((d) => d.originalFile)) out(`原文件传不回秒懂：重建的是同名手工文件（段落一样），原文件在备份里：${rec.dir}/backup/docs`);

    const code = confirmCode({
      kind: 'kb-revoke', importId, steps: Object.keys(state.revoke?.steps ?? {}), scope: plan.scope,
      deleteFaqIds: plan.deleteFaqs.map((r) => r.id), deleteDocIds: plan.deleteDocs.map((r) => r.id), changed: plan.changed.map((c) => c.key),
      doubt: plan.doubt?.rows.map((r) => r.id) ?? [], dupes: plan.dupes,
      revokeOpen: plan.revokeSettle ? { claimed: plan.revokeSettle.claimed ?? null, others: plan.revokeSettle.others?.map((r) => r.id) ?? null, gone: plan.revokeSettle.gone ?? null } : null,
    });
    if (given === null) {
      out(`这是预演，什么都没写。计划码：${code}`);
      out(`用户明确同意后执行：md kb revoke ${importId} --confirm ${code}`);
      return EXIT.OK;
    }
    if (given !== code) throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：库里的情况在预演之后变了，或者计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
    const left = await runRevoke(ctx, plan);
    if (left) return reportLeft(left, importId);
    out('撤回完成：这次导入建的都删了，删掉的都按备份重建了。');
    return EXIT.OK;
  } finally {
    release?.();
  }
}
