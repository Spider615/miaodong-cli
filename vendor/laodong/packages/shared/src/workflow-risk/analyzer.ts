// 逐节点 workflow 风险分析——纯确定性内核入口。
//
// analyzeWorkflowRisks(json) → RiskReport（按节点分组的 findings + 汇总）。
// 前后端、save 门禁、回归脚本都调这一个函数。LLM 复审层（后端）在此之上叠加，不改这里。

import { jsonrepair } from 'jsonrepair';
import type { NodeRiskGroup, RiskFinding, RiskReport, RiskSeverity } from './types';
import { SEVERITY_WEIGHT } from './types';
import { buildContext, type AnalysisContext } from './context';

import { checkLlmJson } from './rules/llm-json';
import { checkBrokenRef } from './rules/broken-ref';
import { checkSession } from './rules/session';
import { checkReachability } from './rules/reachability';
import { checkRuleCenter } from './rules/rule-center';
import { checkCompliance } from './rules/compliance';
import { checkJsRuntime } from './rules/js-runtime';
import { checkContent } from './rules/content';

type RuleModule = (ctx: AnalysisContext, add: (f: RiskFinding) => void) => void;

/** 全部规则模块（A–H）。新增规则组时在此登记。 */
const RULE_MODULES: RuleModule[] = [
  checkLlmJson, // A
  checkBrokenRef, // B
  checkSession, // C
  checkReachability, // D
  checkRuleCenter, // E
  checkCompliance, // F
  checkJsRuntime, // G
  checkContent, // H
];

function maxSeverity(a: RiskSeverity, b: RiskSeverity): RiskSeverity {
  return SEVERITY_WEIGHT[a] >= SEVERITY_WEIGHT[b] ? a : b;
}

function parseWorkflowInput(input: string | Record<string, unknown>): {
  workflow?: Record<string, unknown>;
  parseError?: string;
} {
  if (typeof input !== 'string') {
    if (input && typeof input === 'object' && !Array.isArray(input)) return { workflow: input };
    return { parseError: 'workflow 必须是包含 canvas 的对象。' };
  }
  try {
    return { workflow: JSON.parse(input) as Record<string, unknown> };
  } catch {
    // 与仓库约定一致：先过 jsonrepair 再 parse
    try {
      return { workflow: JSON.parse(jsonrepair(input)) as Record<string, unknown> };
    } catch (err) {
      return { parseError: `workflow 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

export function analyzeWorkflowRisks(input: string | Record<string, unknown>): RiskReport {
  const { workflow, parseError } = parseWorkflowInput(input);
  if (!workflow) {
    return {
      ok: false,
      parseError,
      nodeGroups: [],
      globalFindings: [],
      summary: { total: 0, error: 0, warn: 0, info: 0, affectedNodes: 0 },
      meta: { nodeCount: 0, edgeCount: 0 },
    };
  }
  if (!Array.isArray(workflow.canvas)) {
    return {
      ok: false,
      parseError: 'workflow 缺少 canvas 数组。',
      nodeGroups: [],
      globalFindings: [],
      summary: { total: 0, error: 0, warn: 0, info: 0, affectedNodes: 0 },
      meta: { nodeCount: 0, edgeCount: 0 },
    };
  }

  const ctx = buildContext(workflow);
  const findings: RiskFinding[] = [];
  const add = (f: RiskFinding) => findings.push(f);

  for (const mod of RULE_MODULES) {
    try {
      mod(ctx, add);
    } catch (err) {
      // 单条规则崩溃不应拖垮整份报告
      add({
        code: 'INTERNAL',
        rule: 'rule-module-crashed',
        category: 'hygiene',
        severity: 'info',
        message: `内部：某规则模块执行异常（${err instanceof Error ? err.message : String(err)}），其余规则不受影响。`,
      });
    }
  }

  return buildReport(ctx, findings);
}

function buildReport(ctx: AnalysisContext, findings: RiskFinding[]): RiskReport {
  const byNode = new Map<string, RiskFinding[]>();
  const globalFindings: RiskFinding[] = [];

  for (const f of findings) {
    if (f.nodeId && ctx.nodeById.has(f.nodeId)) {
      if (!byNode.has(f.nodeId)) byNode.set(f.nodeId, []);
      byNode.get(f.nodeId)!.push(f);
    } else {
      globalFindings.push(f);
    }
  }

  const nodeGroups: NodeRiskGroup[] = [];
  for (const [nodeId, fs] of byNode) {
    const node = ctx.nodeById.get(nodeId)!;
    fs.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || a.code.localeCompare(b.code));
    const severity = fs.reduce<RiskSeverity>((acc, f) => maxSeverity(acc, f.severity), 'info');
    nodeGroups.push({
      nodeId,
      shortId: nodeId.slice(0, 8),
      name: node.name,
      shape: node.shape,
      severity,
      findings: fs,
    });
  }

  nodeGroups.sort(
    (a, b) =>
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      b.findings.length - a.findings.length ||
      a.name.localeCompare(b.name),
  );
  globalFindings.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || a.code.localeCompare(b.code));

  const all = [...findings];
  const summary = {
    total: all.length,
    error: all.filter((f) => f.severity === 'error').length,
    warn: all.filter((f) => f.severity === 'warn').length,
    info: all.filter((f) => f.severity === 'info').length,
    affectedNodes: nodeGroups.length,
  };

  return {
    ok: true,
    nodeGroups,
    globalFindings,
    summary,
    meta: { nodeCount: ctx.nodes.length, edgeCount: ctx.edges.length },
  };
}
