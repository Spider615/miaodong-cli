// md test audit <集> --from-file <cases.jsonl>：只读对账（旧 skill miaodong-test-case-import 的 audit_cases.py，md 以前只在导入时顺带做一次）。
// 文件按导入时的规则转成用例，和秒懂里这个集存的按 name 逐条逐字段比：秒懂里缺的、关键字段不一样的、没挂对场景的算问题（退出码 1）；
// 集里有、文件里没有的只提醒（--into 导进来的集里本来就可能有别的用例）；非关键字段（这个区可能不保存）按字段汇总提醒。什么都不写

import { existsSync, readFileSync } from 'node:fs';
import { strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { listEvents, listSessions } from '../api.mjs';
import { listCases, scenarioTree } from '../testcenter.mjs';
import { buildCases, flattenTree, parseCaseLines } from '../casefile.mjs';
import { caseDiffs, fieldLabel } from '../testcases.mjs';
import { resolveTestSet, testTarget } from '../test-common.mjs';

export async function audit(args) {
  const t = await testTarget(args);
  const file = strArg(args, 'from-file');
  if (!file) throw usage('缺 --from-file <cases.jsonl>', '拿导入用的那份文件来对账：md test audit <集> --from-file <cases.jsonl> --bot <智能体>');
  if (!existsSync(file)) throw usage(`找不到文件：${file}`);
  const set = await resolveTestSet(t, args._[0]);
  const parsed = parseCaseLines(readFileSync(file, 'utf-8'));
  const [events, vars, tree, stored] = await Promise.all([listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId), scenarioTree(t), listCases(t, set.testSetId)]);
  const scenarios = tree === null ? null : flattenTree(tree.tree);
  const { built, errors } = buildCases(parsed.rows, { events, vars, scenarios });
  out(targetLine(t));
  const invalid = [...parsed.errors.map((e) => ({ ...e, name: '' })), ...errors].sort((a, b) => a.line - b.line);
  if (invalid.length) {
    out(`❌ ${file}：${invalid.length} 处错误，没法按它对账：`);
    for (const p of invalid.slice(0, 50)) out(`  第 ${p.line} 行${p.name ? `「${p.name}」` : ''}：${p.reason}`);
    throw new MdError('invalid_cases', `${file} 有 ${invalid.length} 处错误，没有对账`, { hint: '文件要和导入时一样能通过校验；格式见 skill 的 references/test-cases.md' });
  }

  const byName = new Map();
  for (const c of stored) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const names = new Set(built.map((b) => b.testCase.name));
  const pathOf = new Map((scenarios ?? []).map((n) => [n.id, n.path]));
  const missing = [];
  const hard = [];
  const soft = new Map();
  let matched = 0;
  for (const b of built) {
    const hits = byName.get(b.testCase.name) ?? [];
    if (!hits.length) {
      missing.push(b);
      continue;
    }
    const problems = [];
    if (hits.length > 1) problems.push(`秒懂里有 ${hits.length} 条同名，按名字对不上号`);
    const got = hits[0];
    const diffs = caseDiffs(b.testCase, got);
    for (const d of diffs) if (!d.critical) soft.set(d.field, (soft.get(d.field) ?? 0) + 1);
    const critical = diffs.filter((d) => d.critical).map((d) => fieldLabel(d.field));
    if (critical.length) problems.push(`${critical.join('、')} 和文件不一样`);
    if (b.scenarioNodeId && got.scenarioNodeId !== b.scenarioNodeId) problems.push(`没挂在场景「${pathOf.get(b.scenarioNodeId) ?? b.scenarioNodeId}」上`);
    if (problems.length) hard.push({ b, problems });
    else matched++;
  }
  const extra = stored.filter((c) => !names.has(c.name));

  out(`测试集「${set.name}」(${shortId(set.testSetId)})：文件 ${built.length} 条 · 秒懂 ${stored.length} 条 · 对上 ${matched} 条`);
  if (missing.length) out(`❌ 秒懂里没有：${missing.slice(0, 20).map((b) => `第 ${b.line} 行「${b.testCase.name}」`).join('、')}${missing.length > 20 ? ` 等 ${missing.length} 条` : ''}`);
  for (const h of hard.slice(0, 30)) out(`❌ 第 ${h.b.line} 行「${h.b.testCase.name}」：${h.problems.join('；')}`);
  if (hard.length > 30) out(`  …另有 ${hard.length - 30} 条`);
  for (const [field, n] of soft) out(`⚠️ ${fieldLabel(field)}：${n} 条和文件不一样（这个区可能不保存这个字段）`);
  if (extra.length) out(`⚠️ 文件里没有：${extra.slice(0, 10).map((c) => `「${c.name}」`).join('、')}${extra.length > 10 ? ` 等 ${extra.length} 条` : ''}（集里别的用例，不算问题）`);
  if (scenarios === null && built.some((b) => b.scenarioNodeId)) out('（这个区没有场景树，没核对挂载）');
  const ok = !missing.length && !hard.length;
  out(ok ? '✅ 对账一致' : '❌ 对账不一致');
  return ok ? EXIT.OK : EXIT.ERROR;
}
