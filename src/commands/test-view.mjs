// md test sets / cases / tree：只读

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strArg } from '../args.mjs';
import { EXIT, MdError } from '../errors.mjs';
import { writeJson } from '../home.mjs';
import { DATA_NOTE, formatTime, out, shortId, targetLine } from '../output.mjs';
import { clip } from '../execs.mjs';
import { stamp } from '../workspace.mjs';
import { listEvents } from '../api.mjs';
import { listCases, listTestSets, scenarioCases, scenarioTree } from '../testcenter.mjs';
import { flattenTree, resolveScenario } from '../casefile.mjs';
import { caseText, summarizeCases } from '../testcases.mjs';
import { resolveTestSet, testTarget, testsDir } from '../test-common.mjs';

const countNodes = (nodes) => nodes.reduce((sum, n) => sum + 1 + countNodes(n?.children ?? []), 0);

export async function sets(args) {
  const t = await testTarget(args);
  const [rows, tree] = await Promise.all([listTestSets(t), scenarioTree(t)]);
  out(targetLine(t));
  out(tree === null ? '场景树：这个区没有（老一代测试中心）' : `场景树：${countNodes(tree.tree)} 个节点`);
  if (!rows.length) out('还没有测试集');
  for (const s of rows.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
    out(`  ${s.name} (${shortId(s.testSetId)}) · ${s.testCaseCount ?? '?'} 条 · 更新 ${formatTime(s.updatedAt)}`);
  }
  return EXIT.OK;
}

// 一条用例的触发：事件触发写事件名。取不到事件列表时说「取不到」，不能说成「没有」（审查 I4）
function triggerLabel(c, events) {
  if (c.triggerType !== 'canvas-event-trigger') return c.triggerType;
  const eventId = String(c.triggerInputs?.eventId ?? '');
  const hit = (events ?? []).find((e) => e?.eventId === eventId);
  return `事件「${hit?.name ?? `${eventId.slice(0, 8)}${events === null ? '（取不到事件列表）' : '（这个智能体里没有）'}`}」`;
}

// 完整用例存本机一份；--out 另存 JSONL
function saveRows(t, args, key, rows) {
  const file = join(testsDir(t, 'exports'), `${key}-${stamp()}.json`);
  writeJson(file, rows);
  const outFile = strArg(args, 'out');
  if (outFile) writeFileSync(outFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  out(`完整用例：${outFile ?? file}`);
}

// --scenario：挂在这个场景节点上的用例（场景树是整个智能体共用的，跨测试集）；给了集就只看这个集的
async function casesOfScenario(t, args, query) {
  const tree = await scenarioTree(t);
  if (tree === null) throw new MdError('no_scenario_tree', '这个区没有场景树（老一代测试中心，只有测试集和用例）', { exitCode: EXIT.TARGET });
  const { hit, error } = resolveScenario(flattenTree(tree.tree), query);
  if (error) throw new MdError('scenario_not_found', error, { exitCode: EXIT.TARGET, hint: `md test tree --bot ${shortId(t.botId)} 看有哪些场景` });
  const set = args._[0] ? await resolveTestSet(t, args._[0]) : null;
  const [all, sets, events] = await Promise.all([scenarioCases(t, hit.id), listTestSets(t), listEvents(t.identity, t.orgId, t.botId)]);
  const rows = set ? all.filter((c) => c.testSetId === set.testSetId) : all;
  const setName = new Map(sets.map((s) => [s.testSetId, s.name]));
  out(targetLine(t));
  out(DATA_NOTE);
  out(`场景「${hit.path}」${set ? `、测试集「${set.name}」` : ''}：${rows.length} 条用例`);
  for (const c of rows.slice(0, 30)) {
    const where = setName.get(c.testSetId) ?? (c.testSetId ? shortId(c.testSetId) : '?');
    out(`  ${c.name} · 测试集「${where}」 · ${triggerLabel(c, events)} · ${clip(caseText(c), 40) || '-'}`);
  }
  if (rows.length > 30) out(`  …另有 ${rows.length - 30} 条`);
  saveRows(t, args, `scenario-${shortId(hit.id)}`, rows);
  return EXIT.OK;
}

export async function cases(args) {
  const t = await testTarget(args);
  const scenario = strArg(args, 'scenario');
  if (scenario) return casesOfScenario(t, args, scenario);
  const set = await resolveTestSet(t, args._[0]);
  const [rows, events] = await Promise.all([listCases(t, set.testSetId), listEvents(t.identity, t.orgId, t.botId)]);
  const s = summarizeCases(rows);
  out(targetLine(t));
  out(DATA_NOTE);
  out(`测试集「${set.name}」(${shortId(set.testSetId)})：${s.total} 条 · ${Object.entries(s.byTrigger).map(([k, v]) => `${k} ${v}`).join('、') || '无'} · 未审核 ${s.unreviewed} · 挂了场景 ${s.attached}`);
  for (const c of rows.slice(0, 30)) out(`  ${c.name} · ${triggerLabel(c, events)} · ${clip(caseText(c), 40) || '-'}`);
  if (rows.length > 30) out(`  …另有 ${rows.length - 30} 条`);
  saveRows(t, args, shortId(set.testSetId), rows);
  return EXIT.OK;
}

export async function tree(args) {
  const t = await testTarget(args);
  const got = await scenarioTree(t);
  out(targetLine(t));
  if (got === null) {
    out('这个区没有场景树（老一代测试中心，只有测试集和用例）');
    return EXIT.OK;
  }
  if (!got.tree.length) {
    out(`场景树是空的（未分类用例 ${got.unclassified} 条）`);
    return EXIT.OK;
  }
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      out(`${'  '.repeat(depth + 1)}${n.name} · 本节点 ${n.ownCaseCount ?? 0} · 含子节点 ${n.totalCaseCount ?? 0}`);
      walk(n.children ?? [], depth + 1);
    }
  };
  walk(got.tree, 0);
  out(`未分类：${got.unclassified} 条`);
  return EXIT.OK;
}
