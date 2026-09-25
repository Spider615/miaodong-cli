// md kb revoke <导入id>（spec 3b §5）：撤回一次导入。默认只预演（只读）；用户本人确认计划码后才写（先给这个库上锁）。
// 撤回本身也能中断：再运行一次，预演会说明停在哪一步，确认后接着做。
// 导入时认不清的（可能是秒懂改写了内容的这次写的，也可能是别人加的），撤回不删、列出来，退出码 1；
// 人在秒懂上处理完，再运行一次 md kb revoke <导入id> 复查。重建一直过不去的，预演给出跳过它的重建（要用户确认）。
import { confirmCode, givenCode } from '../confirm.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { loadIdentities } from '../identity.mjs';
import { loadRecord, lockKb } from '../kb-import-store.mjs';
import { STEP_NAMES } from '../kb-import-run.mjs';
import { REVOKE_NAMES, closeLeftovers, leftovers, revokePlan, runRevoke, tracking } from '../kb-revoke.mjs';
import { describe, label } from '../kb-ops.mjs';
import { out, shortId } from '../output.mjs';

const SHOW = 20;
const listOf = (type, rows) => (rows.length ? `\n  ${describe(type, rows.slice(0, SHOW))}${rows.length > SHOW ? `……还有 ${rows.length - SHOW} 条` : ''}` : '');
// 认不清的可能 FAQ、文件都有：按类型分开列
const mixed = (rows) => {
  const faqs = rows.filter((x) => x.type === 'faq').map((x) => x.row);
  const docs = rows.filter((x) => x.type === 'doc').map((x) => x.row);
  return [faqs.length ? describe('faq', faqs) : '', docs.length ? `${faqs.length ? '文件 ' : ''}${describe('doc', docs)}` : ''].filter(Boolean).join('、');
};

function reportLeft(left, importId) {
  out(`撤回做完了，但还有 ${left.length} 条分不清是不是这次建的，没删：${mixed(left)}`);
  out(`在秒懂上看一眼：是这次导入写进去的（秒懂改写了内容），就手动删掉；处理完再运行一次 md kb revoke ${importId} 复查`);
}

// 不带 --confirm 时也要改本机记录（复查发现都不在了）：短暂上个锁，锁着就不改、只报告
function withBriefLock(state, importId, fn) {
  let release;
  try {
    release = lockKb(state.region.identityKey, state.kb.id, `复查撤回 ${importId}`);
  } catch (error) {
    if (error.code === 'kb_locked') return;
    throw error;
  }
  try {
    fn();
  } finally {
    release();
  }
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
    if (state.status === 'revoked' && !tracking(state)) {
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
      if (!left.length) {
        const was = state.revoke.leftoverIds?.length ?? 0;
        if (release) closeLeftovers(ctx, 'gone');
        else withBriefLock(state, importId, () => closeLeftovers(ctx, 'gone'));
        out(`分不清是不是这次建的那 ${was} 条已经不在了`);
        return EXIT.OK;
      }
      const code = confirmCode({ kind: 'kb-revoke-dismiss', importId, rows: left.map(({ type, row }) => `${type}#${row.id}`) });
      if (given === code) {
        closeLeftovers(ctx, 'dismissed', left);
        out(`不再追踪：${mixed(left)}（用户确认它们不是这次导入建的；秒懂上什么都没动）`);
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
    if (rs?.open.op === 'create' && rs.unresolved.length) {
      const doubt = [...rs.suspects, ...rs.past];
      const resend = rs.unresolved.filter((k) => !rs.stuck.includes(k));
      if (resend.length) {
        out(`撤回上次停下时发出去、还没对上的：${label(rs.open.type)} ${resend.length} 条`);
        out(doubt.length
          ? `  写的时候库里多出来、对不上的：${describe(rs.open.type, doubt)}。确认就是认定它们不是撤回建的：md 不会动它们，没对上的会重新发一次`
          : '  在库里找不到，写的时候库里也没多出来别的：就是没建成，接着做会重新发一次');
      }
    }
    const skipped = ['faq', 'doc'].flatMap((t) => plan.skip[t].map((k) => (t === 'faq' ? plan.faqItems : plan.docItems).find((it) => it.key === k)).filter(Boolean)
      .map((it) => (t === 'faq' ? `FAQ #${it.key}「${it.question}」` : `文件 #${it.key}「${it.full}」`)));
    if (skipped.length) {
      const doubt = rs?.stuck?.length ? [...rs.suspects, ...rs.past] : [];
      out(`重建不了（发了两次，两次都对不上，多半是秒懂改写了内容）：${skipped.join('、')}${doubt.length ? `；改写出来的：${describe(rs.open.type, doubt)}（不删，列出来）` : ''}`);
      out(`  确认撤回就跳过它们的重建，先把这次导入建的删掉；它们的原样在备份里：${rec.dir}/backup，需要时在秒懂上手工恢复`);
    }
    const del = plan.deleteFaqs.length || plan.deleteDocs.length;
    out(`要删（这次建的，还在库里的）：${del ? `FAQ ${plan.deleteFaqs.length} 条 · 文件 ${plan.deleteDocs.length} 个${listOf('faq', plan.deleteFaqs)}${listOf('doc', plan.deleteDocs)}` : '没有'}`);
    if (del) out(`  删之前先把它们当时的内容备份到本机：${rec.dir}/revoke-backup`);
    const paragraphs = plan.docItems.reduce((n, d) => n + d.paragraphs.length, 0);
    out(`要重建（这次删的，从备份）：${plan.faqItems.length || plan.docItems.length ? `FAQ ${plan.faqItems.length} 条 · 文件 ${plan.docItems.length} 个（${paragraphs} 段）` : '没有'}`);
    if (plan.dupes.length) out(`库里已经有一样的（不是这次导入建的，可能有人手动恢复了；照样重建，会重复，确认前先在秒懂上看一眼）：${plan.dupes.join('、')}`);
    out(plan.changed.length ? `导入后被人改过的（撤回会连改动一起删掉）：${plan.changed.map((c) => c.text).join('、')}` : '导入后被人改过的：没有');
    if (plan.doubt) out(`分不清是不是这次建的（导入写的时候库里多出来、对不上的；撤回不会删它们）：${describe(plan.doubt.type, plan.doubt.rows)}`);
    const cut = plan.docItems.filter((d) => d.name !== d.full);
    if (cut.length) out(`名字超过 30 字，重建时截成：${cut.map((d) => `「${d.name}」`).join('、')}`);
    if (plan.docItems.some((d) => d.originalFile)) out(`原文件传不回秒懂：重建的是同名手工文件（段落一样），原文件在备份里：${rec.dir}/backup/docs`);

    const code = confirmCode({
      kind: 'kb-revoke', importId, steps: Object.keys(state.revoke?.steps ?? {}), scope: plan.scope, skip: plan.skip,
      deleteFaqIds: plan.deleteFaqs.map((r) => r.id), deleteDocIds: plan.deleteDocs.map((r) => r.id), changed: plan.changed.map((c) => c.key),
      doubt: plan.doubt?.rows.map((r) => r.id) ?? [], dupes: plan.dupes,
      revokeOpen: rs ? { claimed: rs.claimed ?? null, extras: rs.extras ?? null, doubt: rs.suspects ? [...rs.suspects, ...rs.past].map((r) => r.id) : null, gone: rs.gone ?? null } : null,
    });
    if (given === null) {
      out(`这是预演，什么都没写。计划码：${code}`);
      out(`用户明确同意后执行：md kb revoke ${importId} --confirm ${code}`);
      return EXIT.OK;
    }
    if (given !== code) throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：库里的情况在预演之后变了，或者计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
    const left = await runRevoke(ctx, plan);
    if (skipped.length) out(`没有重建（跳过了）：${skipped.join('、')}；原样在备份里：${rec.dir}/backup`);
    if (left.length) {
      reportLeft(left, importId);
      return EXIT.ERROR;
    }
    if (skipped.length) {
      out('撤回做完了：这次导入建的都删了；上面跳过的几条没有重建，要在秒懂上手工恢复。');
      return EXIT.ERROR;
    }
    out('撤回完成：这次导入建的都删了，删掉的都按备份重建了。');
    return EXIT.OK;
  } finally {
    release?.();
  }
}
