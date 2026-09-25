// md test sets / cases / tree：只读

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { writeJson } from '../home.mjs';
import { formatTime, out, shortId, targetLine } from '../output.mjs';
import { clip } from '../execs.mjs';
import { stamp } from '../workspace.mjs';
import { listEvents } from '../api.mjs';
import { listCases, listTestSets, scenarioTree } from '../testcenter.mjs';
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

export async function cases(args) {
  const t = await testTarget(args);
  const set = await resolveTestSet(t, args._[0]);
  const [rows, events] = await Promise.all([listCases(t, set.testSetId), listEvents(t.identity, t.orgId, t.botId)]);
  const eventName = new Map((events ?? []).map((e) => [e.eventId, e.name]));
  const s = summarizeCases(rows);
  out(targetLine(t));
  out(`测试集「${set.name}」(${shortId(set.testSetId)})：${s.total} 条 · ${Object.entries(s.byTrigger).map(([k, v]) => `${k} ${v}`).join('、') || '无'} · 未审核 ${s.unreviewed} · 挂了场景 ${s.attached}`);
  for (const c of rows.slice(0, 30)) {
    const eventId = String(c.triggerInputs?.eventId ?? '');
    const trigger = c.triggerType === 'canvas-event-trigger' ? `事件「${eventName.get(eventId) ?? `${eventId.slice(0, 8)}（这个智能体里没有）`}」` : c.triggerType;
    out(`  ${c.name} · ${trigger} · ${clip(caseText(c), 40) || '-'}`);
  }
  if (rows.length > 30) out(`  …另有 ${rows.length - 30} 条`);
  const file = join(testsDir(t, 'exports'), `${shortId(set.testSetId)}-${stamp()}.json`);
  writeJson(file, rows);
  const outFile = strArg(args, 'out');
  if (outFile) writeFileSync(outFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  out(`完整用例：${outFile ?? file}`);
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
