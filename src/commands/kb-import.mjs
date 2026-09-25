// md kb import（spec 3b §4）：把处理好的客户资料（导入包）写进秒懂知识库。这是 md 写知识库的唯一入口：
// 只在处理客户资料时用；查 case 时绝不写库（用户 09-25 定的规矩）。
// 默认只预演（只读），闸门全过才给计划码；用户本人确认计划码后才写，AI 不能替用户确认。
// 确认之后先给这个库上锁，再重新算一遍计划码：同一时间只有一个 md 在写这个库。
import { basename, resolve } from 'node:path';
import { strArg } from '../args.mjs';
import { confirmCode, givenCode } from '../confirm.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { loadIdentities } from '../identity.mjs';
import { loadPackage } from '../kb-package.mjs';
import { activeImport, createRecord, importCount, listRecords, loadRecord, lockKb } from '../kb-import-store.mjs';
import { IMPORT_STEPS, STEP_NAMES, itemsByType, itemsOf, runImport } from '../kb-import-run.mjs';
import { REVOKE_NAMES, tracking } from '../kb-revoke.mjs';
import { affectedBots, findKbById, importCode, planImport } from '../kb-import-plan.mjs';
import { applySettle, describe, label, orphanRows, rowsOf, save, settleOpen } from '../kb-ops.mjs';
import { textKey } from '../kb-package.mjs';
import { out, shortId } from '../output.mjs';
import { targetArgs } from '../target.mjs';

export const USAGE_IMPORT = 'md kb import <导入包目录> [--confirm <计划码>]；中途停了：md kb import --resume <导入id> [--confirm <计划码>]';
const f3 = (n) => n.toFixed(3);

export function headLine(target, kb, suffix) {
  return `${target.regionLabel} / ${target.orgName} / ${kb.name} (${shortId(kb.id)}) · ${suffix}`;
}

function printPlan(pkg, plan, affected) {
  const { counts: c } = plan;
  const src = pkg.source.files.map((f) => `${f.name}（${f.sha256.slice(0, 8)}）`).join('、');
  out(`来源资料：${src}${pkg.source.note ? `；说明：${pkg.source.note}` : ''}`);
  out(`要加：${c.addFaqs || c.addDocs ? `FAQ ${c.addFaqs} 条 · 文件 ${c.addDocs} 个（${c.addParagraphs} 段）` : '没有'}`);
  out(`要删：${c.deleteFaqs || c.deleteDocs ? `FAQ ${c.deleteFaqs} 条 · 文件 ${c.deleteDocs} 个（${c.deleteParagraphs} 段${c.originals ? `；原文件 ${c.originals} 个，先下载进备份` : ''}）` : '没有'}`);
  if (affected) {
    if (!affected.length) out('引用这个库的智能体：没有（写进去暂时不影响任何智能体）');
    else {
      out('引用这个库的智能体（写进去就对它们生效）：');
      for (const b of affected) {
        if (b.error) { out(`  ${b.botName} (${shortId(b.botId)})：读不到画布（${b.error}）`); continue; }
        const online = b.onlineVersion ? `线上版 ${b.onlineVersion}：${b.onlineNodes.join('、') || '没用这个库'}` : '没有线上版';
        out(`  ${b.botName} (${shortId(b.botId)})：${online}；草稿：${b.draftNodes.join('、') || '没用这个库'}`);
      }
    }
  }
  if (plan.similar.length) {
    out(`很像的 FAQ（≥ 0.9，只提醒，不拦）：`);
    for (const s of plan.similar.slice(0, 20)) out(`  新「${s.question}」≈ 库里 #${s.id}「${s.existing}」${f3(s.similarity)}${s.reviewed === false ? '（未审核）' : ''}`);
    if (plan.similar.length > 20) out(`  ……还有 ${plan.similar.length - 20} 条`);
  }
  if (plan.sameName.length) out(`同名的文件（只提醒）：${plan.sameName.map((s) => `新「${s.name}」和库里 #${s.id}`).join('、')}`);
  if (plan.longNames.length) out(`要删的文件名超过 30 字（撤回时重建成手工文件，名字可能被截断）：${plan.longNames.map((t) => `#${t.id}「${t.name}」`).join('、')}`);
  if (plan.oddParagraphs.length) out(`要删的文件里有超过 1000 字或空的段落（撤回时要原样写回，秒懂接不接受还没实测，可能撤不回去）：${plan.oddParagraphs.map((t) => `#${t.id}「${t.name}」${t.odd} 段`).join('、')}`);
}

// 上次停下时开着的意图，重新认了之后是什么情况（续跑预演给人看，也进计划码）
function printSettle(s, pkg, importId) {
  if (!s) return;
  const { open } = s;
  if (open.op === 'delete') {
    out(`上次停下时正在删：${open.ids.map((id) => `${label(open.type)} #${id}`).join('、')}；现在已经不在的 ${s.gone.length} 个算这次删的，还在的接着删`);
    return;
  }
  const items = itemsOf(pkg);
  const text = (k) => (open.type === 'faq' ? items[k]?.question : items[k]?.name);
  out(`上次停下时发出去、还没对上的：${label(open.type)} ${open.keys.length} 条（${open.keys.slice(0, 5).map((k) => `「${text(k)}」`).join('、')}${open.keys.length > 5 ? '……' : ''}）`);
  const claimed = Object.entries(s.claimed);
  if (claimed.length) out(`  请求刚发完时就在库里、内容一模一样，认下了：${claimed.map(([k, id]) => `#${id}「${text(k)}」`).join('、')}`);
  const late = Object.entries(s.late);
  if (late.length && open.type === 'faq') {
    out(`  库里有和这几条一模一样的，但是这次请求之后才出现的：${late.map(([k, r]) => `#${r.id}「${text(k)}」`).join('、')}——可能是这次的请求晚落库了，也可能是别人按同样的内容建的`);
    out(`  确认续跑就是认定它们是这次建的（md 接着用它们，撤回时会删它们）；不是的话别续跑：先 md kb revoke ${importId}（不会动它们），再弄清楚是谁建的`);
  }
  if (late.length && open.type === 'doc') {
    out(`  库里有同名的文件，是这次请求之后才出现的：${late.map(([, r]) => `#${r.id}「${r.name}」（空的手工文件）`).join('、')}——可能是这次的请求晚落库了，也可能是别人建的；md 不认它、也不往里写，续跑会另建一个`);
    out('  它要是这次晚落库的，请用户之后在秒懂上删掉这个空文件（撤回时也会把它列出来）');
  }
  const resend = s.unresolved.filter((k) => !s.late[k] && !s.ambiguous[k]);
  if (!resend.length) return;
  const doubt = [...s.suspects, ...s.past];
  if (doubt.length) {
    out(`  没对上的 ${resend.length} 条在库里没有一模一样的；写的时候库里多出来、对不上的：${describe(open.type, doubt)}`);
    out(`  确认续跑就是认定它们不是这次建的：md 不会动它们，没对上的 ${resend.length} 条会重新发一次。它们要是这次写进去的（秒懂改写了内容），就别续跑：先 md kb revoke ${importId}，再请用户在秒懂上看一眼、决定怎么处理`);
  } else {
    out(`  没对上的 ${resend.length} 条在库里找不到，写的时候库里也没多出来别的：就是没建成，续跑会重新发一次`);
  }
}

const settleKey = (s) => (s ? {
  op: s.open.op, keys: s.open.keys ?? null, ids: s.open.ids ?? null, claimed: s.claimed ?? null,
  late: s.late ? Object.fromEntries(Object.entries(s.late).map(([k, r]) => [k, r.id])) : null,
  doubt: s.suspects ? [...s.suspects, ...s.past].map((r) => r.id) : null, gone: s.gone ?? null,
} : null);

// 续跑要发的 FAQ（还没认上、也不是等用户确认的）里，库里已经有同一个问题、而且是导入开始之后才出现的、又不是这次建的：
// 和导入时的闸门一样拦下（再建就重复了）。导入开始时就在的（包括包里要删的旧 FAQ）预演时查过，不再查
async function duplicatesNow(ctx, rec, settle) {
  const { pkg, state, snapshot } = rec;
  const waiting = settle?.open.op !== 'delete' ? new Set([...Object.keys(settle?.claimed ?? {}), ...Object.keys(settle?.late ?? {}), ...Object.keys(settle?.ambiguous ?? {})]) : new Set();
  const pending = pkg.faqs.filter((f) => !state.faqIds[f.key] && !waiting.has(f.key));
  if (!pending.length) return [];
  // 一模一样、等用户确认或者分不清的，按它们自己的规矩处理，这里不重复拦；可疑的（问题一样、答案不同）照样拦：再发就有两条同样的问题
  const listed = new Set([...Object.values(settle?.late ?? {}), ...Object.values(settle?.ambiguous ?? {}).flat()].map((r) => r.id));
  const mine = new Set([...Object.values(state.faqIds), ...Object.values(settle?.claimed ?? {})]);
  // 导入开始时就在的，预演时查过：有快照按快照；快照还没拍（停在第一步），至少把包里要删的排除掉（它们还没备份，绝不能让人先删）
  const before = new Set(snapshot?.faqIds ?? pkg.deletes.filter((t) => t.type === 'faq').map((t) => t.id));
  const rows = (await rowsOf(ctx, 'faq')).filter((r) => !before.has(r.id) && !mine.has(r.id) && !listed.has(r.id));
  return pending.flatMap((f) => rows.filter((r) => textKey(r.question) === textKey(f.question)).slice(0, 1)
    .map((r) => `新 FAQ「${f.question}」（${f.key}）和库里 #${r.id} 问题一样（导入开始之后才出现的，不是这次建的）：续跑会让这个问题有两条。请用户在秒懂上看一眼 #${r.id}：要保留它，就撤回这次导入（md kb revoke ${state.importId}）；要换成这次的内容，由用户在秒懂上处理掉它之后再续跑`));
}

// 停下之后接着做（3b §4.3）：说明做完了哪几步、还剩什么（包括还要删的），上次开着的意图重新认一次，给一个新的计划码；
// 确认后（先上锁、再按锁里读到的记录重算）从停下的那一步接着做
async function resumeImport(args, importId) {
  if (args._.length) throw usage(`--resume 不用再给导入包目录（导入记录里有一份）：md kb import --resume ${importId}`);
  const given = givenCode(args);
  let rec = loadRecord(importId);
  const release = given === null ? null : lockKb(rec.state.region.identityKey, rec.state.kb.id, `续跑导入 ${importId}`);
  try {
    if (release) rec = loadRecord(importId);
    const { state } = rec;
    out(`${state.region.label} / ${state.org.name} / ${state.kb.name} (${shortId(state.kb.id)}) · 导入 ${importId}`);
    if (state.status === 'done') {
      out('这次导入已经做完了');
      return EXIT.OK;
    }
    if (state.revoke) throw new MdError('kb_import_revoked', '这次导入已经撤回（或者正在撤回），不能再接着做', { hint: `撤回没做完就再运行 md kb revoke ${importId}` });
    const identity = loadIdentities()[state.region.identityKey];
    if (!identity) throw new MdError('no_identity', `本机没有「${state.region.label}」的身份`, { exitCode: EXIT.AUTH, hint: '先问用户秒懂控制台的域名，然后 md auth snippet <域名>' });
    const ctx = { identity, orgId: state.org.id, kbId: state.kb.id, regionKey: state.region.identityKey, dir: rec.dir, state, pkg: rec.pkg };
    const settle = await settleOpen(ctx, state, itemsByType(rec.pkg));
    const doneSteps = IMPORT_STEPS.filter((s) => state.steps[s]);
    const left = IMPORT_STEPS.filter((s) => !state.steps[s]);
    if (state.stopped) out(`停在「${STEP_NAMES[state.stopped.step]}」：${state.stopped.reason}`);
    printSettle(settle, rec.pkg, importId);
    const same = settle?.open.op !== 'delete' ? Object.values(settle?.ambiguous ?? {}).flat() : [];
    if (same.length) {
      throw new MdError('kb_resume_refused', `库里有不止一条和要建的一模一样的：${describe(settle.open.type, same)}——分不清哪条是这次建的（可能是这次的请求落了两次，也可能是有人同时导了同样的内容），不能续跑`, {
        hint: `先 md kb revoke ${importId}（撤回不会动它们，会列出来），再请用户在秒懂上看一眼、决定留哪条`,
      });
    }
    const stuck = settle?.stuck?.filter((k) => !(settle.late[k] && settle.open.type === 'faq')) ?? [];
    if (stuck.length) {
      const doubt = [...settle.suspects, ...settle.past];
      const late = stuck.map((k) => settle.late[k]).filter(Boolean);
      const orphans = (await orphanRows(ctx, state)).filter((x) => x.type === settle.open.type).map((x) => x.row);
      const same = [...new Map([...late, ...orphans].map((r) => [r.id, r])).values()];
      const why = same.length
        ? `两次写完当时都没在库里找到，之后才出现一模一样的：${describe(settle.open.type, same)}——多半是秒懂的列表延迟很长（它们就是这几次建的），md 不在事后认它们`
        : `两次写完都没在库里找到一模一样的${doubt.length ? `，写的时候库里多出来：${describe(settle.open.type, doubt)}` : ''}——多半是秒懂改写了这几条的内容`;
      throw new MdError('kb_resume_refused', `有 ${stuck.length} 条已经发了两次，${why}，不能再续跑`, {
        hint: `先 md kb revoke ${importId}；再请用户在秒懂上看一眼上面列的：是这次写进去的就手动删掉，不是就别动${same.length ? '' : '；按秒懂改写后的样子改导入包，再重新导入'}`,
      });
    }
    const dups = await duplicatesNow(ctx, rec, settle);
    if (dups.length) throw new MdError('kb_import_blocked', `闸门没过（续跑一条都不会写）：\n${dups.map((b) => `  - ${b}`).join('\n')}`, { hint: '按上面处理之后再预演一次' });
    out(`做完的：${doneSteps.map((s) => STEP_NAMES[s]).join('、') || '没有'}`);
    out(`还要做：${left.map((s) => STEP_NAMES[s]).join('、')}`);
    const goneNow = (t) => settle?.open.op === 'delete' && settle.open.type === t.type && settle.gone.includes(t.id);
    const deletesLeft = state.steps.delete ? [] : rec.pkg.deletes.filter((t) => !state.deleted[t.type].includes(t.id) && !goneNow(t));
    if (deletesLeft.length) out(`还要删：${deletesLeft.map((t) => (t.type === 'faq' ? `FAQ #${t.id}「${t.question}」` : `文件 #${t.id}「${t.name}」`)).join('、')}`);
    const code = confirmCode({
      kind: 'kb-import-resume', importId, done: doneSteps, stopped: state.stopped?.step ?? null, settle: settleKey(settle),
      created: { faq: Object.keys(state.faqIds).length, doc: Object.keys(state.docIds).length }, deletesLeft: deletesLeft.map((t) => `${t.type}#${t.id}`),
    });
    if (given === null) {
      out(`这是预演，什么都没写。计划码：${code}`);
      out(`用户明确同意后执行：md kb import --resume ${importId} --confirm ${code}`);
      return EXIT.OK;
    }
    if (given !== code) throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的情况给用户看' });
    applySettle(ctx, state, settle, { claimLate: true });
    save(ctx);
    await runImport(ctx);
    return EXIT.OK;
  } finally {
    release?.();
  }
}

export async function importCmd(args) {
  const resumeId = strArg(args, 'resume');
  if (resumeId) return resumeImport(args, resumeId);
  const dirArg = args._[0];
  if (!dirArg) throw usage(`用法：${USAGE_IMPORT}`);
  const pkg = loadPackage(resolve(dirArg));
  const { target, kb } = await findKbById(pkg.kb.id, targetArgs(args));
  if (kb.name.trim() !== pkg.kb.name) {
    throw new MdError('kb_name_mismatch', `包里写的库名是「${pkg.kb.name}」，秒懂上 ${shortId(kb.id)} 叫「${kb.name}」`, { exitCode: EXIT.TARGET, hint: '核对 manifest.json：kb.id 和 kb.name 要是同一个库' });
  }
  const given = givenCode(args);
  const release = given === null ? null : lockKb(target.identityKey, kb.id, `导入 ${basename(pkg.dir)}`);
  try {
    out(headLine(target, kb, `导入包 ${basename(pkg.dir)}`));
    const plan = await planImport({ target, kb, pkg });
    // 同一个包在这个库上已经导入过、没撤回：再导一次会重复建（同一个计划码也不能用第二次，审查 I2）
    const same = activeImport(target.identityKey, kb.id, pkg.contentHash);
    if (same) {
      const id = same.state.importId;
      plan.blockers.unshift(`这个导入包在这个库上已经导入过：${id}（${statusText(same.state)}）。${same.state.status === 'done' ? '' : `接着做：md kb import --resume ${id}；`}要重来先撤回：md kb revoke ${id}`);
    }
    if (plan.blockers.length) {
      printPlan(pkg, plan, null);
      throw new MdError('kb_import_blocked', `闸门没过（一条都不会写）：\n${plan.blockers.map((b) => `  - ${b}`).join('\n')}`, { hint: '按上面改导入包（或先在秒懂上处理），再预演一次' });
    }
    printPlan(pkg, plan, await affectedBots(target, kb.id));
    out('闸门：全部通过');
    const code = importCode(kb, pkg, plan, importCount(target.identityKey, kb.id, pkg.contentHash));
    if (given === null) {
      out(`这是预演，什么都没写。计划码：${code}`);
      out(`用户明确同意后执行：md kb import ${dirArg} --confirm ${code}`);
      return EXIT.OK;
    }
    if (given !== code) {
      throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：导入包或要删的内容在预演之后变了，或者计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
    }
    const rec = createRecord({ region: { identityKey: target.identityKey, label: target.regionLabel }, org: { id: target.orgId, name: target.orgName }, kb, pkg });
    out(`导入记录：${rec.importId}（${rec.dir}）`);
    await runImport({ identity: target.identity, orgId: target.orgId, kbId: kb.id, regionKey: target.identityKey, dir: rec.dir, state: rec.state, pkg: rec.pkg });
    return EXIT.OK;
  } finally {
    release?.();
  }
}

// md kb imports：本机的导入记录（新的在前）。撤回、续跑都要用这里的导入 id
export async function importsCmd() {
  const records = listRecords();
  if (!records.length) {
    out('本机还没有导入记录');
    return EXIT.OK;
  }
  out('本机的导入记录（新的在前）：');
  for (const { dir, state } of records) {
    let counts = '';
    try {
      const { pkg } = loadRecord(state.importId);
      const del = (type) => pkg.deletes.filter((t) => t.type === type).length;
      counts = `加 FAQ ${pkg.faqs.length} · 文件 ${pkg.docs.length}；删 FAQ ${del('faq')} · 文件 ${del('doc')}`;
    } catch {
      counts = `导入记录读不出来（${dir}）`;
    }
    out(`  ${state.importId}  ${state.region.label} / ${state.org.name} / ${state.kb.name} (${shortId(state.kb.id)})  ${counts}  ${statusText(state)}`);
  }
  return EXIT.OK;
}

export function statusText(state) {
  if (state.status === 'revoked') return tracking(state) ? `已撤回（有 ${state.revoke?.leftoverIds?.length ?? '几'} 条分不清是不是这次建的，要人看一眼）` : '已撤回';
  if (state.revoke) return state.revoke.stopped ? `撤回停在「${REVOKE_NAMES[state.revoke.stopped.step]}」` : '撤回中';
  if (state.status === 'done') return '已完成';
  if (state.stopped) return `停在「${STEP_NAMES[state.stopped.step]}」`;
  return state.status === 'new' ? '还没开始写' : '进行中';
}
