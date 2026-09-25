// B 组：悬空引用。现有 validator 完全不校验 referenceNodeId / dataPath —— 这是最大盲区。
//
// 覆盖：
//   B1 referenceNodeId 指向不存在的节点
//   B2 dataPath 不在上游 outputTypes（含真实 KB content bug）/ 引用了无输出的节点
//   B3 有引用但无上游边（执行序拿不到值）
//   B4 模板 {{x}} 无对应 input
//   B5 声明的 input 从未被引用（卫生）
//   B6 edge 端口不存在

import type { RiskFinding } from '../types';
import { asArray, asObject, asString, extractTemplateVars, type AnalysisContext, type RiskNode } from '../context';

type Add = (f: RiskFinding) => void;

/** 无 outputTypes、不能作为数据源的节点类型。 */
const NON_PRODUCER_TYPES = new Set([
  'rule-center',
  'update-data',
  'update-custom-attr',
  'send-text-message',
  'send-image-message',
  'send-audio-message',
  'send-combination-message',
  'send-material',
  'handover',
  'action-event',
  'tag-user',
  'invite-room',
  'plugin-action',
]);

export function checkBrokenRef(ctx: AnalysisContext, add: Add): void {
  for (const site of ctx.refSites) {
    const refId = site.referenceNodeId;
    if (!refId) continue; // session 引用由 C 组负责

    // B1：引用的节点不存在
    if (!ctx.nodeIds.has(refId)) {
      add({
        code: 'B1',
        rule: 'ref-node-missing',
        category: 'broken-ref',
        severity: 'warn',
        nodeId: site.node.id,
        path: `${site.path}.referenceNodeId`,
        message: `节点「${site.node.name}」的 ${site.label} 引用了不存在的上游节点（${refId.slice(0, 8)}…），运行时取值恒空。`,
        fix: { summary: '建出该上游节点，或把 referenceNodeId 改指正确节点' },
      });
      continue;
    }

    const producer = ctx.nodeById.get(refId)!;
    // jsonLlm 的子字段引用由 A3 负责，这里不重复
    const isJsonLlm = ctx.jsonLlmIds.has(refId);

    // B2：dataPath 首段不在上游 outputTypes；或引用了无输出的节点
    const dp = site.dataPath ?? '';
    if (!isJsonLlm) {
      if (NON_PRODUCER_TYPES.has(producer.type) || NON_PRODUCER_TYPES.has(producer.shape)) {
        add({
          code: 'B2',
          rule: 'ref-datapath-not-in-output',
          category: 'broken-ref',
          severity: 'warn',
          nodeId: site.node.id,
          path: `${site.path}.referenceNodeId`,
          message: `节点「${site.node.name}」的 ${site.label} 引用了「${producer.name}」（${producer.type}），但这类节点没有可被引用的输出。`,
          fix: { summary: '改引一个有 outputTypes 的上游（触发器 / LLM / JS / 知识库）' },
          relatedNodeIds: [refId],
        });
      } else if (dp) {
        const firstSeg = dp.split('.')[0];
        const outputs = ctx.outputNamesById.get(refId) ?? new Set<string>();
        if (outputs.size > 0 && !outputs.has(firstSeg)) {
          add({
            code: 'B2',
            rule: 'ref-datapath-not-in-output',
            category: 'broken-ref',
            severity: 'warn',
            nodeId: site.node.id,
            path: `${site.path}.dataPath`,
            message: `节点「${site.node.name}」的 ${site.label} 读取「${producer.name}」的字段「${dp}」，但该节点输出里没有「${firstSeg}」（可用：${[...outputs].join('、') || '无'}），取值恒空。`,
            fix: buildDataPathFix(site.path, dp, outputs),
            relatedNodeIds: [refId],
          });
        }
      }
    }

    // B3：引用节点存在，但不是消费节点的祖先（无上游边，执行序拿不到值）
    if (refId !== site.node.id) {
      const anc = ctx.ancestors.get(site.node.id);
      if (anc && !anc.has(refId)) {
        add({
          code: 'B3',
          rule: 'ref-without-upstream-edge',
          category: 'broken-ref',
          severity: 'warn',
          nodeId: site.node.id,
          path: `${site.path}.referenceNodeId`,
          message: `节点「${site.node.name}」的 ${site.label} 引用了「${producer.name}」，但两者之间没有连线路径，运行到这里时该值还没产出。`,
          fix: { summary: `补一条「${producer.name}」→「${site.node.name}」的边（或经中转节点），保证执行顺序` },
          relatedNodeIds: [refId],
        });
      }
    }
  }

  // B4 / B5：模板变量 vs inputs
  for (const node of ctx.nodes) {
    checkTemplateVars(node, add);
  }

  // B6：edge 端口不存在
  for (const edge of ctx.edges) {
    if (!edge.sourceId || !edge.targetId) continue; // 悬空 cell 由 edge.unresolved 覆盖，这里只查 port
    const sourceNode = ctx.nodeById.get(edge.sourceId);
    const targetNode = ctx.nodeById.get(edge.targetId);
    if (!sourceNode || !targetNode) continue;
    const badSource = edge.sourcePort && !portIds(sourceNode).has(edge.sourcePort);
    const badTarget = edge.targetPort && !portIds(targetNode).has(edge.targetPort);
    if (badSource || badTarget) {
      add({
        code: 'B6',
        rule: 'edge-port-missing',
        category: 'broken-ref',
        severity: 'error',
        nodeId: badSource ? sourceNode.id : targetNode.id,
        edgeId: edge.id,
        path: `canvas[${edge.index}]`,
        message: `连线引用了不存在的端口：${badSource ? `源节点「${sourceNode.name}」无端口 ${edge.sourcePort}` : `目标节点「${targetNode.name}」无端口 ${edge.targetPort}`}。平台导入会失败。`,
        fix: { summary: '把 source.port / target.port 指到对应节点 ports.items 里真实存在的端口 id' },
        relatedNodeIds: [sourceNode.id, targetNode.id],
      });
    }
  }
}

function buildDataPathFix(sitePath: string, dp: string, outputs: Set<string>) {
  // KB 特例：content → knowledge.content
  if (dp === 'content' && (outputs.has('knowledge') || outputs.has('highestFaq'))) {
    return {
      summary: '知识库没有裸 content 字段，改为 knowledge.content（或 highestFaq.answer）',
      path: `${sitePath}.dataPath`,
      before: 'content',
      after: 'knowledge.content',
    };
  }
  return { summary: `把 dataPath 改成上游真实输出名之一：${[...outputs].join('、')}` };
}

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

function checkTemplateVars(node: RiskNode, add: Add): void {
  // 收集 inputs[].name
  const inputNames = new Set<string>();
  asArray(node.payload.inputs).forEach((inp) => {
    const nm = asString(asObject(inp)?.name);
    if (nm && nm.trim()) inputNames.add(nm);
  });

  // 确定要检查的模板文本 + 字段
  const texts: { text: string; path: string }[] = [];
  const isLlm = node.shape === 'llm-completion' || node.type === 'llm-completion';
  const isSendText = node.shape === 'send-text-message';
  if (isLlm) {
    const sp = asString(node.payload.systemPrompt);
    const up = asString(node.payload.userPrompt);
    if (sp) texts.push({ text: sp, path: 'data.nodePayload.systemPrompt' });
    if (up) texts.push({ text: up, path: 'data.nodePayload.userPrompt' });
  } else if (isSendText) {
    const tpl = asString(node.payload.template);
    if (tpl) texts.push({ text: tpl, path: 'data.nodePayload.template' });
  } else {
    return;
  }

  const usedVars = new Set<string>();
  for (const { text, path } of texts) {
    for (const v of extractTemplateVars(text)) {
      usedVars.add(v);
      if (!inputNames.has(v)) {
        add({
          code: 'B4',
          rule: 'template-var-no-input',
          category: 'broken-ref',
          severity: 'warn',
          nodeId: node.id,
          path,
          message: `节点「${node.name}」的模板里有占位符 {{${v}}}，但 inputs 里没有同名输入，平台不会插值，{{${v}}} 会被原样输出。`,
          fix: { summary: `补一个 name="${v}" 的 input，或改正占位符名` },
        });
      }
    }
  }

  // B5：声明了 input 但模板从不引用（卫生，info）。
  // 只对 send-text 生效：send-text 的 inputs 纯为 {{}} 插值服务，未引用即冗余。
  // LLM 的 inputs 可能作为上下文注入（不一定经 {{}}），带空格的输入名根本无法做占位符，故不判定为「未用」。
  if (!isSendText) return;
  for (const name of inputNames) {
    if (!usedVars.has(name)) {
      add({
        code: 'B5',
        rule: 'input-name-unused',
        category: 'hygiene',
        severity: 'info',
        nodeId: node.id,
        path: 'data.nodePayload.inputs',
        message: `节点「${node.name}」声明了输入「${name}」但模板/提示词里从未用 {{${name}}} 引用。`,
        fix: { summary: '删除无用输入，或在模板里引用它' },
      });
    }
  }
}
