// md test import <集> --from-execs <文件 | 执行id…> [--from-bot <源智能体>] [--into]（spec §6.2）
// 秒懂的 test-case/import 把执行记录转成用例，断言按当时的动作自动生成。md 在前后补三件事：
// - 跨智能体时按名字换 id（事件 id、会话变量 id），全量回写，再回读核对；
// - 只给了执行 id、没说来源，结果事件或会话变量对不上：多半是别的智能体的执行。把这次导进来的撤回
//   （只删这次新增的），要求补 --from-bot——不留一堆会静默空跑的用例（spec §2.3 核对 6）；
// - 从 md exec 保存的文件导入时，记下每条执行的时间、用户消息、线上回复，结果报告里对照用。

import { existsSync, readFileSync } from 'node:fs';
import { boolArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { listEvents, listSessions } from '../api.mjs';
import { EXEC_ID } from '../exec-locate.mjs';
import { actionTexts } from '../execs.mjs';
import { resolveBot } from '../target.mjs';
import { createTestSet, deleteCases, deleteTestSet, importExecs, listCases, listTestSets, updateCase } from '../testcenter.mjs';
import { buildIdMap, execIdOfCase, idProblems, leftoverIds, remapCase } from '../testcases.mjs';
import { mergeSources, resolveTestSet, testTarget } from '../test-common.mjs';
import { extractTriggerTextFromSnapshot } from '../../../apps/api/lib/miaodong/badcase-normalize.ts';

// --from-execs：md exec 保存的 JSONL（第一行是查询条件，带着源智能体），或者逗号 / 空格隔开的执行 id
export function readExecSource(value) {
  if (existsSync(value)) {
    const lines = readFileSync(value, 'utf-8').split('\n').filter((line) => line.trim());
    let header = null;
    const rows = [];
    lines.forEach((line, i) => {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw usage(`--from-execs 的第 ${i + 1} 行不是 JSON：${value}`);
      }
      if (i === 0 && row?.kind === 'md-exec-search') header = row;
      else if (typeof row?.execId === 'string' && EXEC_ID.test(row.execId)) rows.push(row);
    });
    if (!rows.length) throw usage(`${value} 里没有执行记录`, '给 md exec --bot <智能体> … 搜出来的文件，或者执行 id');
    return { header, ids: [...new Set(rows.map((r) => r.execId))], rows };
  }
  const ids = [...new Set(String(value).split(/[\s,]+/).filter(Boolean))];
  const bad = ids.filter((id) => !EXEC_ID.test(id));
  if (!ids.length || bad.length) {
    throw usage(bad.length ? `不是完整的执行 id：${bad.slice(0, 5).join('、')}` : '--from-execs 要给文件或执行 id', '执行 id 要写完整的 36 位；或者给 md exec 保存的 .jsonl 文件');
  }
  return { header: null, ids, rows: [] };
}

// 源智能体：--from-bot > 文件里记的 > 只给了 id 时先当作目标自己的。stated 表示来源是明说的
async function sourceOf(t, header, fromBot) {
  let bot = null;
  if (fromBot) {
    bot = await resolveBot({ bot: fromBot });
    if (header && header.botId !== bot.botId) throw usage(`--from-bot 是「${bot.botName}」，但文件里的执行来自「${header.botName}」`);
  } else if (header) {
    bot = header.botId === t.botId ? t : await resolveBot({ bot: header.botId });
  }
  if (!bot) return { bot: t, stated: false };
  if (bot.identityKey !== t.identityKey) {
    throw new MdError('cross_region', `执行来自「${bot.regionLabel}」，目标智能体在「${t.regionLabel}」：不能跨区导入`, { exitCode: EXIT.BLOCKED });
  }
  return { bot, stated: true };
}

// 一条执行的来源：时间、用户消息、线上回复（回复 / 转人工优先，没有就取发出的事件里的文本）、花费
function sourceEntry(row) {
  const texts = actionTexts(row.outputActions);
  const pick = (kinds) => texts.filter((a) => kinds.includes(a.kind)).map((a) => a.text).join('；');
  const cost = typeof row.totalCostInCny === 'number' ? row.totalCostInCny : Number.parseFloat(row.totalCostInCny);
  return {
    at: row.createdAt ?? null,
    text: extractTriggerTextFromSnapshot({ triggerContent: row.triggerContent, eventSnapshot: row.rawTrigger }) || String(row.triggerContent?.content?.data?.text ?? ''),
    reply: pick(['reply', 'handover']) || pick(['event']),
    cost: Number.isFinite(cost) ? cost : null,
  };
}

// 跨智能体：按名字把事件 id、会话变量 id 从源换成目标的，全量回写，再回读核对不剩源 bot 的 id（spec §6.2）
async function remapInto(t, testSetId, cases, { sourceEvents, sourceVars, targetEvents, targetVars }) {
  const maps = buildIdMap({ sourceEvents, targetEvents, sourceVars, targetVars });
  let changed = 0;
  const problems = [];
  for (const c of cases) {
    const { testCase, problems: found } = remapCase(c, maps);
    if (found.length) problems.push({ name: c.name, reason: found.join('；') });
    if (JSON.stringify(testCase) !== JSON.stringify(c)) {
      await updateCase(t, testCase);
      changed++;
    }
  }
  const mappedEvents = sourceEvents.filter((e) => maps.map.has(e.eventId)).length;
  const mappedVars = sourceVars.filter((v) => maps.map.has(v.id)).length;
  out(`换 id：更新了 ${changed} 条（按名字对上：事件 ${mappedEvents} 个、会话变量 ${mappedVars} 个）`);
  for (const p of problems.slice(0, 20)) out(`  ⚠️ ${p.name}：${p.reason}`);
  // 回读：换得了的源 id 不该还在（换不了的已经在上面列了）
  const ids = new Set(cases.map((c) => c.testCaseId));
  const readback = (await listCases(t, testSetId)).filter((c) => ids.has(c.testCaseId));
  const shouldBeGone = new Set([...maps.map.entries()].filter(([from, to]) => from !== to).map(([from]) => from));
  const left = readback.filter((c) => leftoverIds(c, shouldBeGone).length);
  if (left.length) out(`⚠️ 回读发现 ${left.length} 条还带着源智能体的 id（更新没生效？）：${left.slice(0, 5).map((c) => c.name).join('、')}`);
  return readback;
}

export async function importCmd(args) {
  const t = await testTarget(args);
  const name = String(args._[0] ?? '').trim();
  if (!name) throw usage('缺测试集：md test import <集> --bot <智能体> --from-execs <文件或执行 id>');
  const from = strArg(args, 'from-execs');
  if (!from) throw usage('缺 --from-execs：给 md exec 保存的 .jsonl，或者执行 id（逗号隔开）');
  const into = boolArg(args, 'into');
  const src = readExecSource(from);
  const source = await sourceOf(t, src.header, strArg(args, 'from-bot'));
  const cross = source.bot.botId !== t.botId;

  // 先取两边的事件和会话变量：取不到就没法核对导进来的用例会不会空跑、跨智能体也没法换 id。
  // 在写秒懂之前停下（审查 I4：以前是先建集、先导入，出错时把没换 id 的用例留在集里）
  const allowUnverified = boolArg(args, 'allow-preflight-errors');
  const [targetEvents, targetVars] = await Promise.all([listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId)]);
  const [sourceEvents, sourceVars] = cross
    ? await Promise.all([listEvents(source.bot.identity, source.bot.orgId, source.bot.botId), listSessions(source.bot.identity, source.bot.orgId, source.bot.botId)])
    : [targetEvents, targetVars];
  const listsOk = Boolean(targetEvents && targetVars && sourceEvents && sourceVars);
  if (!listsOk && !allowUnverified) {
    throw new MdError('lists_unavailable', `取不到${cross ? '源或目标' : '这个'}智能体的事件 / 会话变量列表：没法核对导进来的用例会不会空跑${cross ? '，也没法跨智能体换 id' : ''}；什么都没写`, {
      exitCode: EXIT.BLOCKED,
      hint: '这个区的版本可能不支持这两个接口；确认要照导（不核对、不换 id）加 --allow-preflight-errors',
    });
  }

  const existing = await listTestSets(t);
  let set;
  let created = false;
  if (into) {
    set = await resolveTestSet(t, name, existing);
  } else {
    if (existing.some((s) => s.name === name)) {
      throw new MdError('testset_exists', `${t.botName} 下已经有测试集「${name}」`, { exitCode: EXIT.BLOCKED, hint: '导进这个已有的集加 --into；否则换个名字' });
    }
    set = { testSetId: await createTestSet(t, name), name };
    created = true;
  }
  out(targetLine(t));
  out(`${created ? '新建' : '导进已有的'}测试集「${set.name}」(${shortId(set.testSetId)})；${src.ids.length} 条执行${cross ? `，来自「${source.bot.botName}」（跨智能体，导完按名字换 id）` : ''}`);
  if (!listsOk) out('⚠️ 取不到事件 / 会话变量列表：这次不核对、不换 id（--allow-preflight-errors）');

  let fresh;
  try {
    // 按导入前后的差集认「这次导进来的」：--into 时集里可能已经有同名用例（重复导了同一条执行），不能碰
    const before = new Set((await listCases(t, set.testSetId)).map((c) => c.testCaseId));
    const sum = await importExecs(t, set.testSetId, src.ids);
    fresh = (await listCases(t, set.testSetId)).filter((c) => !before.has(c.testCaseId));
    out(`导入：成功 ${sum.imported} · 失败 ${sum.failed}${sum.skippedNodeTypes.length ? ` · 跳过的节点类型 ${sum.skippedNodeTypes.join('、')}` : ''}`);
    const missing = src.ids.filter((id) => !fresh.some((c) => execIdOfCase(c.name) === id));
    if (missing.length) out(`⚠️ 没导进来的执行 ${missing.length} 条：${missing.slice(0, 10).map(shortId).join('、')}${missing.length > 10 ? '…' : ''}`);
    if (cross && listsOk && fresh.length) fresh = await remapInto(t, set.testSetId, fresh, { sourceEvents, sourceVars, targetEvents, targetVars });
  } catch (error) {
    // 写到一半出错：说清留下了什么、怎么清理（审查 I4）
    throw new MdError(error?.code ?? 'upstream', `${error?.message ?? error}（测试集「${set.name}」(${shortId(set.testSetId)}) ${created ? '已经建了' : '是已有的'}，可能已经导进去了一部分）`, {
      exitCode: error?.exitCode,
      hint: `md test cases ${set.testSetId} --bot ${shortId(t.botId)} 看留下了什么；要清理用 md test drop ${set.testSetId} --bot ${shortId(t.botId)}`,
    });
  }
  const bad = idProblems(fresh, { events: targetEvents, vars: targetVars });
  const badNames = [...new Set(bad.map((b) => b.name))];
  if (badNames.length && !source.stated) {
    // 撤回后回读：没删干净就不删集，并说清还剩几条（审查 M6）
    const freshIds = new Set(fresh.map((c) => c.testCaseId));
    await deleteCases(t, [...freshIds]);
    const left = (await listCases(t, set.testSetId)).filter((c) => freshIds.has(c.testCaseId)).length;
    if (created && !left) await deleteTestSet(t, set.testSetId);
    const tail = left ? `；但还剩 ${left} 条没删掉，用 md test drop ${set.testSetId} --bot ${shortId(t.botId)} 清理` : created ? '，也删了新建的测试集' : '';
    throw new MdError('source_mismatch', `${badNames.length} 条用例的事件或会话变量在「${t.botName}」里对不上，多半是别的智能体的执行；已撤回这次导进来的 ${fresh.length - left} 条${tail}`, {
      exitCode: EXIT.BLOCKED,
      hint: '补 --from-bot <源智能体> 再导：md 会按名字把 id 换成这个智能体的',
    });
  }
  if (badNames.length) {
    out(`⚠️ ${badNames.length} 条用例对不上这个智能体，md test run 的跑前检查会拦下它们：`);
    for (const b of bad.slice(0, 20)) out(`  - ${b.name}：${b.reason}`);
  }
  // 记下每条新用例对应哪条执行（用例 id 不随改名变，跨智能体换 id 也不变）；从文件导入的再记下时间、用户消息、线上回复
  const byCase = Object.fromEntries(fresh.map((c) => [c.testCaseId, execIdOfCase(c.name)]).filter(([, execId]) => execId));
  const file = mergeSources(t, set.testSetId, { execs: Object.fromEntries(src.rows.map((r) => [r.execId, sourceEntry(r)])), byCase });
  if (src.rows.length) out(`已记下 ${src.rows.length} 条来源（时间、用户消息、线上回复），结果报告里对照用：${file}`);
  out(`下一步：md test run ${set.name} --bot ${shortId(t.botId)}`);
  return EXIT.OK;
}
