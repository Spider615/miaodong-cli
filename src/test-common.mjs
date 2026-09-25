// md test 各子命令共用：目标智能体、按名字 / id 找测试集、本机文件。
// 本机文件在 $MD_HOME/tests/<区>/<智能体 id 前 8 位>/ 下：
//   sources/<测试集 id>.json   从执行记录导入时记下的来源（时间、用户消息、线上回复、花费），结果报告的「线上回复」列用它
//   tasks/<任务 id>.json       md test run 建的任务：预估、账本那一笔的 id、止损额度
//   exports/ backups/ results/  导出的用例、删测试集前的备份、结果明细

import { join } from 'node:path';
import { EXIT, MdError, usage } from './errors.mjs';
import { ensureDir, mdHome, readJson, writeJson } from './home.mjs';
import { resolveBot, targetArgs } from './target.mjs';
import { shortId } from './output.mjs';
import { listTestSets } from './testcenter.mjs';

const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');

export const testTarget = (args) => resolveBot(targetArgs(args));

export function testsDir(t, ...parts) {
  return ensureDir(join(mdHome(), 'tests', safe(t.identityKey), safe(t.botId.slice(0, 8)), ...parts));
}

// 找测试集：完整 id → id 前缀（看起来像 id 才试）→ 名字完全相同
export async function resolveTestSet(t, query, sets = null) {
  const q = String(query ?? '').trim();
  if (!q) throw usage('缺测试集：md test <子命令> <测试集名字或 id> --bot <智能体>');
  const rows = sets ?? await listTestSets(t);
  const exact = rows.filter((s) => s.testSetId === q);
  const byPrefix = exact.length ? exact : /^[0-9a-f-]{4,}$/i.test(q) ? rows.filter((s) => String(s.testSetId).startsWith(q)) : [];
  const hits = byPrefix.length ? byPrefix : rows.filter((s) => s.name === q);
  if (hits.length === 1) return hits[0];
  if (!hits.length) {
    throw new MdError('testset_not_found', `${t.botName} 下没有测试集「${q}」`, { exitCode: EXIT.TARGET, hint: `md test sets --bot ${shortId(t.botId)} 看有哪些` });
  }
  throw new MdError('testset_ambiguous', `「${q}」匹配到 ${hits.length} 个测试集：${hits.slice(0, 10).map((s) => `${s.name}(${shortId(s.testSetId)})`).join('、')}`, { exitCode: EXIT.TARGET, hint: '用 id 前缀指定' });
}

const sourcesFile = (t, testSetId) => join(testsDir(t, 'sources'), `${testSetId}.json`);
export const readSources = (t, testSetId) => readJson(sourcesFile(t, testSetId), {});
export function mergeSources(t, testSetId, entries) {
  const file = sourcesFile(t, testSetId);
  writeJson(file, { ...readJson(file, {}), ...entries });
  return file;
}

const taskFile = (t, testTaskId) => join(testsDir(t, 'tasks'), `${testTaskId}.json`);
export const readTaskRecord = (t, testTaskId) => readJson(taskFile(t, testTaskId), null);
export const writeTaskRecord = (t, record) => writeJson(taskFile(t, record.testTaskId), record);
