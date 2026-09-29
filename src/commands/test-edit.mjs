// md test edit <集> <脚本.mjs> [--confirm <计划码>]（spec §6.4）：按脚本批量改用例。
// 默认预演：跑脚本，比较改前改后，列出改了哪些，给计划码。带 --confirm 才写：先备份，再逐条 update（全量覆盖），最后回读核对。
// 计划码绑定每条改前和改后的内容：预演之后集里的用例、或者脚本变了，确认就对不上。

import { join } from 'node:path';
import { EXIT, MdError, usage } from '../errors.mjs';
import { note, out, shortId, targetLine } from '../output.mjs';
import { writeJson } from '../home.mjs';
import { stamp } from '../workspace.mjs';
import { hashOf } from '../canvas.mjs';
import { confirmCode, givenCode } from '../confirm.mjs';
import { listEvents, listSessions } from '../api.mjs';
import { WRITABLE_FIELDS, listCases, updateCase } from '../testcenter.mjs';
import { caseDiffs, fieldLabel, idProblems } from '../testcases.mjs';
import { editChanges, runEditScript } from '../caseedit.mjs';
import { HISTORY_VAR, byName } from '../casefile.mjs';
import { resolveTestSet, testTarget, testsDir } from '../test-common.mjs';

export async function edit(args) {
  const t = await testTarget(args);
  const set = await resolveTestSet(t, args._[0]);
  const file = args._[1];
  if (!file) throw usage('缺脚本：md test edit <集> <脚本.mjs> --bot <智能体>', '脚本写法见 skill 的 references/test-cases.md');
  const given = givenCode(args);
  const [before, events, vars] = await Promise.all([listCases(t, set.testSetId), listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId)]);
  const { cases: after, log } = await runEditScript(file, before, { events, vars });
  const history = vars ? byName(vars, HISTORY_VAR, '会话变量').hit : null;
  const { changed, errors } = editChanges(before, after, { historyVarId: history?.id ?? null });
  // 改出来的事件、会话变量要在这个智能体里有：脚本改出新的对不上就拦；改之前就对不上的（比如事件后来删了）只提醒，
  // 不因为它拦下只改别的字段的脚本。列表取不到时这里不查，md test run 的跑前检查会拦
  const stale = [];
  if (events && vars) {
    for (const c of changed) {
      const was = new Set(idProblems([c.before], { events, vars }).map((p) => p.reason));
      for (const p of idProblems([c.after], { events, vars })) (was.has(p.reason) ? stale : errors).push(`用例「${p.name}」：${p.reason}`);
    }
  }
  out(targetLine(t));
  for (const line of log) out(`  · ${line}`);
  for (const line of stale.slice(0, 10)) out(`⚠️ 改之前就对不上：${line}`);
  if (stale.length > 10) out(`⚠️ 改之前就对不上的另有 ${stale.length - 10} 处`);
  if (errors.length) {
    out(`❌ ${errors.length} 处问题，什么都没改：`);
    for (const e of errors.slice(0, 30)) out(`  - ${e}`);
    if (errors.length > 30) out(`  …另有 ${errors.length - 30} 处`);
    throw new MdError('edit_invalid', `脚本改出来的用例有 ${errors.length} 处问题，什么都没改`, { hint: '改脚本再预演' });
  }
  if (!changed.length) {
    out(`脚本没改测试集「${set.name}」里的任何用例`);
    return EXIT.OK;
  }
  // 按用例 id 排好再算：秒懂列用例的顺序不固定，内容没变、顺序变了，计划码不该变
  const byId = [...changed].sort((a, b) => String(a.before.testCaseId).localeCompare(String(b.before.testCaseId)));
  const code = confirmCode({ kind: 'test-edit', botId: t.botId, testSetId: set.testSetId, changes: hashOf(byId.map((c) => [c.before, c.after])) });
  out(`测试集「${set.name}」(${shortId(set.testSetId)})：要改 ${changed.length} 条（共 ${before.length} 条）`);
  for (const c of changed.slice(0, 30)) out(`  ${c.before.name}${c.fields.includes('name') ? ` → ${c.after.name}` : ''}：${c.fields.map(fieldLabel).join('、')}`);
  if (changed.length > 30) out(`  …另有 ${changed.length - 30} 条`);
  if (given === null) {
    out(`这是预演，什么都没改。计划码：${code}`);
    out(`用户明确同意后执行：md test edit ${set.testSetId} ${file} --bot ${shortId(t.botId)} --confirm ${code}`);
    return EXIT.OK;
  }
  if (given !== code) {
    throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：预演之后集里的用例或脚本变了，或者计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
  }
  const backup = join(testsDir(t, 'backups'), `${shortId(set.testSetId)}-edit-${stamp()}.json`);
  writeJson(backup, { testSet: set, cases: before });
  // 先打出备份在哪：改得多时命令可能被 AI 的超时打断，打断后也要知道去哪找（审查 M8）
  out(`已备份全部 ${before.length} 条用例：${backup}`);
  let done = 0;
  try {
    for (const c of changed) {
      await updateCase(t, c.after);
      done++;
      if (done % 20 === 0 && done < changed.length) note(`（已改 ${done}/${changed.length}）`);
    }
  } catch (error) {
    throw new MdError(error?.code ?? 'upstream', `${error?.message ?? error}（已改 ${done}/${changed.length} 条）`, {
      exitCode: error?.exitCode,
      hint: `改之前的全部用例备份在 ${backup}；md test cases ${set.testSetId} --bot ${shortId(t.botId)} 看现在的样子`,
    });
  }
  // 回读：update 会写的字段全部比。没改的字段也要比：update 是全量覆盖，这个区不保存的字段（dimension）会被冲掉（审查 I1）；
  // 关键字段不一致算错，非关键字段只提醒
  const back = new Map((await listCases(t, set.testSetId)).map((c) => [c.testCaseId, c]));
  const soft = new Map();
  const hard = [];
  for (const c of changed) {
    for (const d of caseDiffs(c.after, back.get(c.after.testCaseId), WRITABLE_FIELDS)) {
      if (d.critical) hard.push(`${c.after.name}：${fieldLabel(d.field)}`);
      else soft.set(d.field, (soft.get(d.field) ?? 0) + 1);
    }
  }
  out(`已改 ${changed.length} 条；备份：${backup}`);
  for (const [field, n] of soft) out(`⚠️ ${fieldLabel(field)}：${n} 条读回来和改的不一样（这个区可能不保存这个字段）`);
  if (hard.length) {
    for (const line of hard.slice(0, 20)) out(`  ❌ ${line} 读回来和改的不一样`);
    throw new MdError('edit_readback', `${hard.length} 处回读和改的不一样`, { hint: `改之前的全部用例备份在 ${backup}` });
  }
  return EXIT.OK;
}
