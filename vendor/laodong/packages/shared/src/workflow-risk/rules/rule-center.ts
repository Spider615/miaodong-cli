// E 组：rule-center 专项 + D6/D7（分支连线）。
//   E1 规则 type=null（占位规则，永不命中）
//   E2 branchId / defaultBranchId 与 ports.items 不匹配（导入 400）
//   E3 多出口接同一下游
//   E5 operator 与 type 不匹配
//   D6 分支 port 无出边（可能死分支）
//   D7 默认分支接入业务逻辑（应留空或接 handover）

import type { RiskFinding } from '../types';
import { asArray, asObject, asString, type AnalysisContext, type RiskNode } from '../context';

type Add = (f: RiskFinding) => void;

/** 只属于 number 类型的比较符（用于 blocklist 式 E5，避免未知 operator 误报）。 */
const NUMBER_ONLY_OPS = new Set(['GREATER', 'LESS', 'GREATER_EQUALS', 'LESS_EQUALS', 'GREATER_THAN', 'LESS_THAN']);
/** 只属于 tag 类型的比较符。 */
const TAG_ONLY_OPS = new Set(['HAS_TAG', 'NOT_HAS_TAG', 'HAS_IN_TAG_GROUP']);

function portIds(node: RiskNode): Set<string> {
  const ports = asObject(node.raw.ports);
  const items = asArray(ports?.items);
  const ids = new Set<string>();
  for (const it of items) {
    const id = asString(asObject(it)?.id);
    if (id) ids.add(id);
  }
  return ids;
}

function readRules(branch: Record<string, unknown>): Record<string, unknown>[] {
  const rg = asObject(branch.ruleGroup);
  const rules = asArray(rg?.rules).length ? asArray(rg?.rules) : asArray(branch.rules);
  return rules.map(asObject).filter((x): x is Record<string, unknown> => x !== null);
}

export function checkRuleCenter(ctx: AnalysisContext, add: Add): void {
  for (const node of ctx.nodes) {
    if (node.shape !== 'rule-center' && node.type !== 'rule-center') continue;

    const branches = asArray(node.payload.branches)
      .map(asObject)
      .filter((x): x is Record<string, unknown> => x !== null);
    const defaultBranchId = asString(node.payload.defaultBranchId);
    const ports = portIds(node);

    // 出边：sourcePort -> targetIds
    const outByPort = new Map<string, string[]>();
    const outTargets: string[] = [];
    for (const e of ctx.edges) {
      if (e.sourceId !== node.id) continue;
      if (!outByPort.has(e.sourcePort)) outByPort.set(e.sourcePort, []);
      outByPort.get(e.sourcePort)!.push(e.targetId);
      if (e.targetId) outTargets.push(e.targetId);
    }

    // E3：多出口接同一下游
    const seenTargets = new Set<string>();
    const dupTargets = new Set<string>();
    for (const t of outTargets) {
      if (seenTargets.has(t)) dupTargets.add(t);
      seenTargets.add(t);
    }
    for (const t of dupTargets) {
      add({
        code: 'E3',
        rule: 'rule-duplicate-downstream',
        category: 'rule-center',
        severity: 'warn',
        nodeId: node.id,
        message: `规则中心「${node.name}」有多条出口接到同一个下游节点（${t.slice(0, 8)}…），分支会互相覆盖。`,
        fix: { summary: '拆分下游，或合并这些分支' },
        relatedNodeIds: [t],
      });
    }

    branches.forEach((branch, bi) => {
      const branchId = asString(branch.branchId);

      // E2：branchId 不在 ports
      if (branchId && ports.size > 0 && !ports.has(branchId)) {
        add({
          code: 'E2',
          rule: 'rule-branchid-port-mismatch',
          category: 'rule-center',
          severity: 'error',
          nodeId: node.id,
          path: `data.nodePayload.branches[${bi}].branchId`,
          message: `规则中心「${node.name}」的分支 branchId「${branchId}」在 ports.items 里不存在，平台导入会失败。`,
          fix: { summary: '让 branchId 与对应端口 id 一致' },
        });
      }

      // D6：分支 port 无出边
      if (branchId && !(outByPort.get(branchId)?.length)) {
        add({
          code: 'D6',
          rule: 'rule-branch-dead-end',
          category: 'reachability',
          severity: 'info',
          nodeId: node.id,
          path: `data.nodePayload.branches[${bi}]`,
          message: `规则中心「${node.name}」的分支「${asString(branch.name) || branchId}」没有接任何下游节点（若非有意静默，命中后无动作）。`,
          fix: { summary: '接上对应动作节点，或确认是有意留空（如 wait_user）' },
        });
      }

      // E1 / E5：逐条规则
      readRules(branch).forEach((rule, ri) => {
        if (rule.type === null) {
          add({
            code: 'E1',
            rule: 'rule-type-null',
            category: 'rule-center',
            severity: 'warn',
            nodeId: node.id,
            path: `data.nodePayload.branches[${bi}].ruleGroup.rules[${ri}].type`,
            message: `规则中心「${node.name}」有一条规则 type=null（占位规则，永远不会命中）。`,
            fix: { summary: '填写规则类型：string / number / boolean / array / tag' },
          });
        }
        const type = asString(rule.type);
        const op = asString(rule.operator);
        if (type && op) {
          const mismatch =
            ((type === 'string' || type === 'boolean') && NUMBER_ONLY_OPS.has(op)) ||
            (type !== 'tag' && TAG_ONLY_OPS.has(op));
          if (mismatch) {
            add({
              code: 'E5',
              rule: 'rule-operator-type-mismatch',
              category: 'rule-center',
              severity: 'warn',
              nodeId: node.id,
              path: `data.nodePayload.branches[${bi}].ruleGroup.rules[${ri}].operator`,
              message: `规则中心「${node.name}」有一条规则 type=${type} 却用了比较符 ${op}，类型不匹配。`,
              fix: { summary: `换成 ${type} 类型支持的比较符` },
            });
          }
        }
      });
    });

    // E2：defaultBranchId 不在 ports
    if (defaultBranchId && ports.size > 0 && !ports.has(defaultBranchId)) {
      add({
        code: 'E2',
        rule: 'rule-branchid-port-mismatch',
        category: 'rule-center',
        severity: 'error',
        nodeId: node.id,
        path: 'data.nodePayload.defaultBranchId',
        message: `规则中心「${node.name}」的 defaultBranchId「${defaultBranchId}」在 ports.items 里不存在，平台导入会失败。`,
        fix: { summary: '让 defaultBranchId 与默认端口 id 一致' },
      });
    }

    // D7：默认分支接入了业务逻辑（应留空或接 handover）
    if (defaultBranchId) {
      for (const t of outByPort.get(defaultBranchId) ?? []) {
        const target = ctx.nodeById.get(t);
        if (target && target.shape !== 'handover') {
          add({
            code: 'D7',
            rule: 'default-branch-into-business',
            category: 'rule-center',
            severity: 'info',
            nodeId: node.id,
            message: `规则中心「${node.name}」的默认分支接入了业务节点「${target.name}」；默认分支通常应留空或转人工（handover）。`,
            fix: { summary: '默认分支改为留空，或接 handover 节点' },
            relatedNodeIds: [t],
          });
        }
      }
    }
  }
}
