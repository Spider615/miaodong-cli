// md test drop <集> [--confirm <计划码>]（spec §6.6）：默认预演；确认后先把全部用例备份到本机，
// 再先删用例、后删测试集（反过来会在场景树上留下孤儿计数），最后回读确认。任务记录秒懂不删，会留着。

import { join } from 'node:path';
import { EXIT, MdError } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { writeJson } from '../home.mjs';
import { stamp } from '../workspace.mjs';
import { hashOf } from '../canvas.mjs';
import { confirmCode, givenCode } from '../confirm.mjs';
import { deleteCases, deleteTestSet, listCases, listTestSets, recentTasks } from '../testcenter.mjs';
import { resolveTestSet, testTarget, testsDir } from '../test-common.mjs';

const ACTIVE = new Set(['pending', 'processing', 'running']);

export async function drop(args) {
  const t = await testTarget(args);
  const given = givenCode(args);
  const set = await resolveTestSet(t, args._[0]);
  const cases = await listCases(t, set.testSetId);
  const tasks = await recentTasks(t, { testSetId: set.testSetId, limit: 50 });
  // 计划码绑定预演时的用例：之后集里的用例变了，确认就对不上
  const code = confirmCode({ kind: 'drop', botId: t.botId, testSetId: set.testSetId, cases: hashOf(cases.map((c) => c.testCaseId).sort()) });
  out(targetLine(t));
  const active = tasks.filter((x) => ACTIVE.has(String(x.status))).length;
  out(`要删的测试集「${set.name}」(${shortId(set.testSetId)})：${cases.length} 条用例 · 挂了场景 ${cases.filter((c) => c.scenarioNodeId).length} 条 · 跑过的任务 ${tasks.length} 个（任务记录会留着）${active ? `；其中 ${active} 个还在跑或排队，删了集它们可能出错` : ''}`);
  if (given === null) {
    out(`这是预演，什么都没删。计划码：${code}`);
    out(`用户明确同意后执行：md test drop ${set.testSetId} --bot ${shortId(t.botId)} --confirm ${code}`);
    return EXIT.OK;
  }
  if (given !== code) {
    throw new MdError('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：测试集里的用例在预演之后变了，或计划码抄错了`, { exitCode: EXIT.BLOCKED, hint: '重新预演一次，把新的清单给用户看' });
  }
  const backup = join(testsDir(t, 'backups'), `${shortId(set.testSetId)}-${stamp()}.json`);
  writeJson(backup, { testSet: set, cases });
  await deleteCases(t, cases.map((c) => c.testCaseId));
  // 用例删干净了才删集：有删不掉的就停在这里（先删集会在场景树上留下孤儿计数，审查 M6）
  const left = await listCases(t, set.testSetId);
  if (left.length) {
    throw new MdError('drop_incomplete', `还剩 ${left.length} 条用例没删掉，测试集先不删`, { hint: `全部用例已备份：${backup}；再运行一次 md test drop（会重新预演）` });
  }
  await deleteTestSet(t, set.testSetId);
  if ((await listTestSets(t)).some((s) => s.testSetId === set.testSetId)) {
    throw new MdError('drop_incomplete', `测试集「${set.name}」删了，但回读还在`, { hint: `用例已备份：${backup}` });
  }
  out(`已删测试集「${set.name}」和 ${cases.length} 条用例；备份：${backup}`);
  return EXIT.OK;
}
