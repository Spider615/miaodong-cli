// 自检只报「这次新引入的」问题：真实画布上原本就有几百条风险（实测 779 条），全报等于没报。
// - 类型突变：数组被改成对象这类改坏，老懂的校验器和风险分析都查不出来（实测），这里单独查；
// - 悬空：连线端点、节点引用指向不存在的节点，只报 after 有而 base 没有的；
// - 结构校验：用老懂的「按改动范围校验」，逐个节点校验：老懂的校验器一次只回第一个错误，整个范围一起校验时，
//   只报得出第一个；范围内原本就不合格的（触发器没有 nodePayload 等）还会盖住别的节点新引入的错误。原本就有的不算新问题；
// - 风险：前后各跑一遍全图（D 组可达性是全图语义），按「code|rule|节点|连线|路径」多重集比对。
//   key 不含 message：message 里带节点名，改个名就会全变成「新风险」。

import { collectChangedScopeNodeIds, validateWorkflowJsonCandidateWithWarnings } from '../vendor/laodong/apps/api/lib/chat-agent/validate-workflow.ts';
import { analyzeWorkflowRisks } from '../vendor/laodong/packages/shared/src/workflow-risk/index.ts';
import { edgeKey, isEdgeCell } from './canvas.mjs';
import { diffEnvelopes, kindOf } from './diff.mjs';
import { buildIndex, edgesOf } from './graph.mjs';
import { shortId } from './output.mjs';

function flattenRisks(report) {
  return [...report.nodeGroups.flatMap((group) => group.findings), ...report.globalFindings];
}

function riskKey(finding) {
  const path = String(finding.path ?? '').replace(/^canvas\[\d+\]/, 'canvas[*]').replace(/^events\[\d+\]/, 'events[*]');
  return [finding.code, finding.rule, finding.nodeId ?? '', finding.edgeId ?? '', path].join('|');
}

export function newRisks(baseEnv, afterEnv) {
  const before = analyzeWorkflowRisks(baseEnv);
  const after = analyzeWorkflowRisks(afterEnv);
  if (!before.ok || !after.ok) return { added: [], resolved: 0, error: after.parseError ?? before.parseError };
  const count = (list) => {
    const counts = new Map();
    for (const finding of list) counts.set(riskKey(finding), (counts.get(riskKey(finding)) ?? 0) + 1);
    return counts;
  };
  const baseCounts = count(flattenRisks(before));
  const seen = new Map();
  const added = [];
  for (const finding of flattenRisks(after)) {
    const key = riskKey(finding);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > (baseCounts.get(key) ?? 0)) added.push(finding);
  }
  const afterCounts = count(flattenRisks(after));
  let resolved = 0;
  for (const [key, n] of baseCounts) resolved += Math.max(0, n - (afterCounts.get(key) ?? 0));
  return { added, resolved };
}

// 图上的「断头」：连线端点 / 端口不存在、引用指向不存在的节点、节点引用自己。
// 调用方只关心「新出现的」：拿两份画布各算一遍，做集合差。
export function graphProblems(env) {
  const nodes = new Map(env.canvas.filter((c) => c && typeof c === 'object' && !isEdgeCell(c)).map((c) => [c.id, c]));
  const hasPort = (node, port) => !Array.isArray(node.ports?.items) || node.ports.items.some((p) => p?.id === port);
  const problems = [];
  for (const edge of edgesOf(env.canvas)) {
    const source = nodes.get(edge.source?.cell);
    const target = nodes.get(edge.target?.cell);
    if (!source || !target) problems.push(`连线 ${edgeKey(edge)} 的端点节点不存在`);
    else if (!hasPort(source, edge.source?.port) || !hasPort(target, edge.target?.port)) problems.push(`连线 ${edgeKey(edge)} 的端口不存在`);
  }
  for (const ref of buildIndex(env.canvas, env.events).refs) {
    if (!nodes.has(ref.to)) problems.push(`节点 [${shortId(ref.from)}] 的 ${ref.path} 引用了不存在的节点 ${shortId(ref.to)}`);
    else if (ref.from === ref.to) problems.push(`节点 [${shortId(ref.from)}] 的 ${ref.path} 引用了自己`);
  }
  return problems;
}

export function runCheck(baseEnv, afterEnv) {
  const errors = [];
  const warnings = [];
  const notes = [];

  for (const change of diffEnvelopes(baseEnv, afterEnv).changed) {
    for (const field of change.fields) {
      if (field.kind === 'typechange') {
        errors.push(`${change.name} [${shortId(change.id)}] 的 ${field.path} 类型从 ${kindOf(field.before)} 变成了 ${kindOf(field.after)}（多半是改坏了）`);
      } else if (field.kind === 'reshape') {
        warnings.push(`${change.name} [${shortId(change.id)}] 的 ${field.path} 类型从 ${kindOf(field.before)} 变成了 ${kindOf(field.after)}（确认是有意的）`);
      }
    }
  }

  const baseProblems = new Set(graphProblems(baseEnv));
  for (const problem of graphProblems(afterEnv)) if (!baseProblems.has(problem)) errors.push(problem);

  const scope = collectChangedScopeNodeIds(baseEnv, afterEnv);
  if (!scope) {
    notes.push('有节点缺 id，跳过结构校验');
  } else {
    // 同一条连线两头都在范围里时两个节点都会报它：去重
    const found = { errors: new Set(), notes: new Set(), warnings: new Set() };
    for (const id of scope) {
      const one = new Set([id]);
      const afterReport = validateWorkflowJsonCandidateWithWarnings(afterEnv, one);
      const baseReport = validateWorkflowJsonCandidateWithWarnings(baseEnv, one);
      if (afterReport.hardError) {
        if (afterReport.hardError === baseReport.hardError) found.notes.add(`改动范围内原本就有的问题（不是这次引入的）：${afterReport.hardError}`);
        else found.errors.add(afterReport.hardError);
      } else {
        const old = new Set(baseReport.warnings);
        // 老懂校验器的提示里带着老懂 Agent 的工具名（wire_input），md 用户用不了，换成通用说法
        for (const warning of afterReport.warnings) if (!old.has(warning)) found.warnings.add(warning.replace('或用 wire_input 改接到正确节点', '或把这个输入改接到正确的节点'));
      }
    }
    errors.push(...found.errors);
    notes.push(...found.notes);
    warnings.push(...found.warnings);
  }

  const risks = newRisks(baseEnv, afterEnv);
  if (risks.error) notes.push(`风险分析失败：${risks.error}`);
  for (const finding of risks.added) {
    const line = `[${finding.code}] ${finding.message}`;
    if (finding.severity === 'error') errors.push(line);
    else if (finding.severity === 'warn') warnings.push(line);
    else notes.push(line);
  }
  if (risks.resolved) notes.push(`顺带消除了 ${risks.resolved} 条原有风险`);
  return { errors, warnings, notes };
}
