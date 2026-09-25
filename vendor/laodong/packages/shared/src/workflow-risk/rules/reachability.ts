// D 组：链路/接缝断裂与可达性。
//   D2 有入边但整簇不连回任何入口（死节点）—— validator 只查直接入边，查不出整簇孤立
//   D3 LLM/JS 输出无人消费（漏接 / 算力浪费）—— 低置信 info
//   D4 无入边孤儿节点（对齐 validator node.orphan-no-inbound）
//   D5 触发器未接入主链（无出边）
// D6/D7（rule-center 分支）在 rule-center.ts 里。

import type { RiskFinding } from '../types';
import { type AnalysisContext, type RiskNode } from '../context';

type Add = (f: RiskFinding) => void;

const COMPUTE_TYPES = new Set(['llm-completion', 'javascript-code']);

export function checkReachability(ctx: AnalysisContext, add: Add): void {
  for (const node of ctx.nodes) {
    if (node.category === 'comment') continue;
    const isEntry = ctx.entryNodeIds.has(node.id);
    const hasInbound = (ctx.backward.get(node.id)?.size ?? 0) > 0;

    // D4：非入口节点没有任何入边
    if (!isEntry && !hasInbound) {
      add({
        code: 'D4',
        rule: 'orphan-no-inbound',
        category: 'reachability',
        severity: 'warn',
        nodeId: node.id,
        message: `节点「${node.name}」没有任何入边，流程无法到达（非入口节点必须有上游连线）。`,
        fix: { summary: '接一条上游→该节点的边，或删除该节点' },
      });
    } else if (!isEntry && hasInbound && !ctx.reachableFromEntry.has(node.id)) {
      // D2：有入边，但整簇连不回任何入口
      add({
        code: 'D2',
        rule: 'node-unreachable-from-trigger',
        category: 'reachability',
        severity: 'warn',
        nodeId: node.id,
        message: `节点「${node.name}」虽有入边，但所在链路连不回任何触发器/事件入口，永远执行不到。`,
        fix: { summary: '把这条链接回主流程（触发器→…→该节点），或删除' },
      });
    }

    // D5：消息触发器无出边（没接进主链）
    if (isEntry && /^receive-.+-message$/.test(node.shape)) {
      const hasOutbound = (ctx.forward.get(node.id)?.size ?? 0) > 0;
      if (!hasOutbound) {
        add({
          code: 'D5',
          rule: 'trigger-not-merged',
          category: 'reachability',
          severity: 'warn',
          nodeId: node.id,
          message: `触发器「${node.name}」没有任何出边，收到消息后不会进入任何流程。`,
          fix: { summary: '把触发器接入下游（如 JS-合并各参数 节点）' },
        });
      }
    }

    // D3：计算类节点（LLM/JS）的输出无人引用
    if (COMPUTE_TYPES.has(node.type) || COMPUTE_TYPES.has(node.shape)) {
      const outputs = ctx.outputNamesById.get(node.id);
      if (outputs && outputs.size > 0 && !isReferencedByAnyone(ctx, node)) {
        add({
          code: 'D3',
          rule: 'llm-output-never-consumed',
          category: 'reachability',
          severity: 'info',
          nodeId: node.id,
          message: `${node.type === 'javascript-code' ? 'JS' : 'LLM'} 节点「${node.name}」的输出没有被任何下游节点引用，可能是漏接线或多余计算。`,
          fix: { summary: '让下游节点通过 referenceNodeId 引用它的输出，或删除该节点' },
        });
      }
    }
  }
}

function isReferencedByAnyone(ctx: AnalysisContext, node: RiskNode): boolean {
  for (const site of ctx.refSites) {
    if (site.referenceNodeId === node.id) return true;
  }
  return false;
}
