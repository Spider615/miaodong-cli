// A 组：LLM 输出 JSON、下游不解析/不守卫（用户头号诉求）。
//
// 核心索引：ctx.jsonLlmIds = { jsonOutput===true 的 llm 节点 }。
// canonical 正确链：LLM(jsonOutput) → JS 节点 JSON.parse 拆字段 → 下游按具名字段引用。
// 任何「跳过 JS 解析 / JS 里不 parse / prompt 与 jsonOutput 不一致」都是风险。

import type { RiskFinding } from '../types';
import { asArray, asObject, asString, type AnalysisContext } from '../context';

type Add = (f: RiskFinding) => void;

/** 成员访问：<arg>.<field>（用于判断 JS 是否把字符串当对象取属性）。 */
function hasMemberAccess(code: string, argName: string): boolean {
  return new RegExp(`\\b${argName}\\s*\\.\\s*[A-Za-z_$]`).test(code);
}

export function checkLlmJson(ctx: AnalysisContext, add: Add): void {
  const { jsonLlmIds } = ctx;

  // ---- 逐 LLM 节点：A4（prompt/flag 不一致）、A5（outputTypes 欠声明）、A7（推理链泄漏）----
  for (const node of ctx.nodes) {
    if (node.shape !== 'llm-completion' && node.type !== 'llm-completion') continue;
    const jsonOutput = node.payload.jsonOutput === true;
    const systemPrompt = asString(node.payload.systemPrompt) ?? '';
    const userPrompt = asString(node.payload.userPrompt) ?? '';
    const promptText = `${systemPrompt}\n${userPrompt}`;

    const promptAsksJson = /严格\s*JSON|```json|输出[^。\n]{0,12}JSON|标准\s*JSON|JSON\s*格式|以\s*JSON|返回\s*JSON/i.test(
      promptText,
    );
    const promptAsksText = /纯文本|不要输出\s*JSON|不输出[^。\n]{0,8}JSON|禁止[^。\n]{0,8}JSON/i.test(promptText);

    if (promptAsksJson && !jsonOutput) {
      add({
        code: 'A4',
        rule: 'jsonoutput-prompt-flag-mismatch',
        category: 'llm-json',
        severity: 'warn',
        nodeId: node.id,
        path: 'data.nodePayload.jsonOutput',
        message: `LLM「${node.name}」提示词要求输出 JSON，但 jsonOutput=false。平台不会按 JSON 处理，下游解析会错位。`,
        fix: {
          summary: '把 jsonOutput 设为 true，或删掉提示词里的 JSON 格式要求',
          path: 'data.nodePayload.jsonOutput',
          before: 'false',
          after: 'true',
        },
      });
    } else if (promptAsksText && jsonOutput) {
      add({
        code: 'A4',
        rule: 'jsonoutput-prompt-flag-mismatch',
        category: 'llm-json',
        severity: 'warn',
        nodeId: node.id,
        path: 'data.nodePayload.jsonOutput',
        message: `LLM「${node.name}」提示词要求纯文本，但 jsonOutput=true。`,
        fix: {
          summary: '把 jsonOutput 设为 false',
          path: 'data.nodePayload.jsonOutput',
          before: 'true',
          after: 'false',
        },
      });
    }

    // A7：开了推理（thinkingType=enabled）且输出直连 send-text，未经清洗层 → 推理链可能泄漏给用户
    if (node.payload.thinkingType === 'enabled') {
      for (const downId of ctx.forward.get(node.id) ?? []) {
        const down = ctx.nodeById.get(downId);
        if (down && down.shape === 'send-text-message') {
          add({
            code: 'A7',
            rule: 'reasoning-chain-leak',
            category: 'llm-json',
            severity: 'info',
            nodeId: node.id,
            path: 'data.nodePayload.thinkingType',
            message: `LLM「${node.name}」开启了推理（thinkingType=enabled）且输出直连发送节点，推理过程可能被原样发给用户。`,
            fix: { summary: '发送前加一层清洗/整理 LLM，或关闭 thinkingType' },
            relatedNodeIds: [downId],
          });
          break;
        }
      }
    }
  }

  // ---- A1 / A6：JS 节点消费 jsonLlm.message ----
  for (const node of ctx.nodes) {
    if (node.shape !== 'javascript-code' && node.type !== 'javascript-code') continue;
    const code = asString(node.payload.code) ?? '';
    const hasParse = /JSON\s*\.\s*parse/.test(code) || /jsonrepair/.test(code);

    // 收集引用了 jsonLlm 的输入形参名
    const jsonArgs: { name: string; refId: string }[] = [];
    asArray(node.payload.inputs).forEach((inp) => {
      const o = asObject(inp);
      if (!o) return;
      const ref = asString(o.referenceNodeId);
      const nm = asString(o.name);
      if (ref && jsonLlmIds.has(ref) && nm) jsonArgs.push({ name: nm, refId: ref });
    });

    if (jsonArgs.length > 0 && !hasParse) {
      const memberAbuse = jsonArgs.some((a) => hasMemberAccess(code, a.name));
      add({
        code: 'A1',
        rule: 'llm-json-consumed-without-parse',
        category: 'llm-json',
        severity: memberAbuse ? 'error' : 'warn',
        nodeId: node.id,
        path: 'data.nodePayload.code',
        message: memberAbuse
          ? `JS 节点「${node.name}」引用了输出 JSON 的 LLM，却没有 JSON.parse 就直接取属性（把字符串当对象），运行时会取到 undefined 甚至抛错。`
          : `JS 节点「${node.name}」引用了输出 JSON 的 LLM，但代码里没有 JSON.parse/jsonrepair，可能把整段 JSON 当普通字符串处理。`,
        fix: {
          summary: '加防御性解析：for(3){ if(typeof x==="string"){try{x=JSON.parse(x)}catch{break}} else break } if(!x||typeof x!=="object")x={}',
        },
        relatedNodeIds: jsonArgs.map((a) => a.refId),
      });
    }

    // A6：有 JSON.parse 但没有 try/catch —— LLM 偶发非法 JSON 会让整节点抛异常
    if (/JSON\s*\.\s*parse/.test(code) && !/\bcatch\b/.test(code)) {
      add({
        code: 'A6',
        rule: 'json-parse-no-try-catch',
        category: 'llm-json',
        severity: 'warn',
        nodeId: node.id,
        path: 'data.nodePayload.code',
        message: `JS 节点「${node.name}」调用了 JSON.parse 但没有 try/catch，LLM 输出非法 JSON（多余文字/markdown 包裹）时整个节点会抛异常。`,
        fix: {
          summary: '用 try/catch 包裹 JSON.parse，或先 String(x).replace(/```json\\n?/,"").replace(/```/,"") 再 parse',
        },
      });
    }
  }

  // ---- A2 / A3：非 JS 消费者直接引用 jsonLlm 输出 ----
  for (const site of ctx.refSites) {
    const refId = site.referenceNodeId;
    if (!refId || !jsonLlmIds.has(refId)) continue;
    if (site.node.shape === 'javascript-code') continue; // JS 由 A1 负责

    const dp = site.dataPath ?? '';
    const firstSeg = dp.split('.')[0];
    const llmOutputs = ctx.outputNamesById.get(refId) ?? new Set<string>();
    const llmName = ctx.nodeById.get(refId)?.name ?? refId.slice(0, 8);

    if (firstSeg && firstSeg !== 'message' && !llmOutputs.has(firstSeg)) {
      // A3：想读 JSON 子字段，却把 referenceNodeId 直接指到 LLM 本体（其 outputTypes 只有 message）
      add({
        code: 'A3',
        rule: 'llm-json-subfield-ref-on-llm-node',
        category: 'llm-json',
        severity: 'warn',
        nodeId: site.node.id,
        path: `${site.path}.dataPath`,
        message: `节点「${site.node.name}」在 ${site.label} 上直接读 LLM「${llmName}」的子字段「${dp}」，但该 LLM 只输出 message 整段 JSON，子字段解析不出来（取值恒空）。`,
        fix: { summary: `中间加一个 JS 节点 JSON.parse 出「${firstSeg}」，再把 referenceNodeId 改指该 JS 节点` },
        relatedNodeIds: [refId],
      });
    } else {
      // A2：把整段 JSON blob 当标量用（rule 等值判断永不命中 / send-text 发出乱码 / 喂给下游 LLM）
      add({
        code: 'A2',
        rule: 'llm-json-referenced-as-scalar',
        category: 'llm-json',
        severity: 'warn',
        nodeId: site.node.id,
        path: site.path,
        message: `节点「${site.node.name}」在 ${site.label} 直接引用了输出 JSON 的 LLM「${llmName}」的 message（整段 JSON 未解析）：${describeScalarRisk(site.kind, site.node.shape)}`,
        fix: { summary: '中间插一个 JS 解析节点，改引它拆出的具名字段（如 action / 已清洗文本）' },
        relatedNodeIds: [refId],
      });
    }
  }
}

function describeScalarRisk(kind: string, shape: string): string {
  if (kind === 'rule-field' || kind === 'rule-value') return '拿 JSON 串做等值/包含判断，分支永不命中。';
  if (shape === 'send-text-message') return '会把 {"...":...} 原样发给用户。';
  return '会把整段 JSON 当自然语言使用。';
}
