// md kb import（spec 3b §4）：把处理好的客户资料（导入包）写进秒懂知识库。这是 md 写知识库的唯一入口：
// 只在处理客户资料时用；查 case 时绝不写库（用户 09-25 定的规矩）。
// 默认只预演（只读），闸门全过才给计划码；用户本人确认计划码后才写，AI 不能替用户确认。
import { basename, resolve } from 'node:path';
import { strArg } from '../args.mjs';
import { givenCode } from '../confirm.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { loadPackage } from '../kb-package.mjs';
import { affectedBots, findKbById, importCode, planImport } from '../kb-import-plan.mjs';
import { out, shortId } from '../output.mjs';
import { targetArgs } from '../target.mjs';

export const USAGE_IMPORT = 'md kb import <导入包目录> [--confirm <计划码>]';
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
}

export async function importCmd(args) {
  const dirArg = args._[0];
  if (!dirArg) throw usage(`用法：${USAGE_IMPORT}`);
  const pkg = loadPackage(resolve(dirArg));
  const { target, kb } = await findKbById(pkg.kb.id, targetArgs(args));
  if (kb.name.trim() !== pkg.kb.name) {
    throw new MdError('kb_name_mismatch', `包里写的库名是「${pkg.kb.name}」，秒懂上 ${shortId(kb.id)} 叫「${kb.name}」`, { exitCode: EXIT.TARGET, hint: '核对 manifest.json：kb.id 和 kb.name 要是同一个库' });
  }
  out(headLine(target, kb, `导入包 ${basename(pkg.dir)}`));
  const plan = await planImport({ target, kb, pkg });
  if (plan.blockers.length) {
    printPlan(pkg, plan, null);
    throw new MdError('kb_import_blocked', `闸门没过（一条都不会写）：\n${plan.blockers.map((b) => `  - ${b}`).join('\n')}`, { hint: '按上面改导入包（或先在秒懂上处理），再预演一次' });
  }
  printPlan(pkg, plan, await affectedBots(target, kb.id));
  out('闸门：全部通过');
  const code = importCode(kb, pkg, plan);
  const given = givenCode(args);
  if (given === null) {
    out(`这是预演，什么都没写。计划码：${code}`);
    out(`用户明确同意后执行：md kb import ${dirArg} --confirm ${code}`);
    return EXIT.OK;
  }
  if (given !== code) {
    throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：导入包或要删的内容在预演之后变了，或者计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
  }
  throw new MdError('kb_import_unfinished', '执行还没做完');
}
