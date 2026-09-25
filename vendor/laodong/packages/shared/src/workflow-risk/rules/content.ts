// H 组：内容 / 外部依赖占位（AI 无法凭空生成，需运营填）。
//   H1 空 systemPrompt / 缺模型配置 / temperature 越界
//   H2 外部依赖占位为空（KB / 插件 / 标签 / 素材 id）

import type { RiskFinding } from '../types';
import { asArray, asObject, asString, type AnalysisContext, type RiskNode } from '../context';

type Add = (f: RiskFinding) => void;

export function checkContent(ctx: AnalysisContext, add: Add): void {
  for (const node of ctx.nodes) {
    if (node.shape === 'llm-completion' || node.type === 'llm-completion') checkLlm(node, add);
    checkExternalDeps(node, add);
  }
}

function checkLlm(node: RiskNode, add: Add): void {
  const sp = (asString(node.payload.systemPrompt) ?? '').trim();
  const up = (asString(node.payload.userPrompt) ?? '').trim();
  if (!sp && !up) {
    add({
      code: 'H1',
      rule: 'llm-empty-prompt',
      category: 'content',
      severity: 'warn',
      nodeId: node.id,
      path: 'data.nodePayload.systemPrompt',
      message: `LLM 节点「${node.name}」的 systemPrompt 与 userPrompt 都为空，无法产生有意义的输出。`,
      fix: { summary: '补写 systemPrompt（角色 + 任务 + 输出格式）' },
    });
  }
  if (!asString(node.payload.modelType)) {
    add({
      code: 'H1',
      rule: 'llm-missing-model',
      category: 'content',
      severity: 'warn',
      nodeId: node.id,
      path: 'data.nodePayload.modelType',
      message: `LLM 节点「${node.name}」未配置 modelType。`,
      fix: { summary: '指定 modelType（如 doubao-seed-1.6）' },
    });
  }
  const temp = node.payload.temperature;
  if (typeof temp === 'number' && (temp < 0 || temp > 1)) {
    add({
      code: 'H1',
      rule: 'llm-temperature-out-of-range',
      category: 'content',
      severity: 'info',
      nodeId: node.id,
      path: 'data.nodePayload.temperature',
      message: `LLM 节点「${node.name}」的 temperature=${temp} 超出 [0,1] 范围。`,
      fix: { summary: '把 temperature 调回 0–1' },
    });
  }
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0 || value.every(isEmptyElement);
  return false;
}

/** 数组元素是否「空」：空串/空值算空；非空字符串 id 不算空；对象则看是否有非空 id。 */
function isEmptyElement(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  const o = asObject(v);
  if (o) return isEmpty(o.id) && isEmpty(o.knowledgeBaseId) && isEmpty(o.tagId) && isEmpty(o.materialId);
  return false;
}

function checkExternalDeps(node: RiskNode, add: Add): void {
  const p = node.payload;
  const report = (rule: string, what: string, path: string) =>
    add({
      code: 'H2',
      rule,
      category: 'external-dep',
      severity: 'warn',
      nodeId: node.id,
      path,
      message: `节点「${node.name}」的${what}为空，需要运营在平台填真实 id（AI 无法编造）。`,
      fix: { summary: `补齐${what}` },
    });

  if (node.shape === 'query-knowledge-base') {
    const kbIds = p.knowledgeBaseIds;
    const selectKnowledge = asArray(node.data.selectKnowledge);
    if (isEmpty(kbIds) && selectKnowledge.length === 0) {
      report('kb-ids-empty', '知识库 id（knowledgeBaseIds / selectKnowledge）', 'data.nodePayload.knowledgeBaseIds');
    }
  }
  if (node.shape === 'plugin-calculation' || node.shape === 'plugin-action') {
    if (isEmpty(p.pluginId)) report('plugin-id-empty', '插件 id（pluginId）', 'data.nodePayload.pluginId');
  }
  if (node.shape === 'tag-user') {
    if (isEmpty(p.tagIds)) report('tag-ids-empty', '标签 id（tagIds）', 'data.nodePayload.tagIds');
  }
  if (node.shape === 'send-material') {
    if (isEmpty(p.materialIds)) report('material-ids-empty', '素材 id（materialIds）', 'data.nodePayload.materialIds');
  }
}
