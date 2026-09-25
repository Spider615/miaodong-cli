// F 组：触发器 / 事件 / 发送 / 结构合规（多数导入 400）。
//   F1 send-text 缺标准字段（quoteMessageId / enableMention / mentionUserIds）
//   F3 媒体字段 type.type 非媒体
//   F4 event 缺必填字段（全局）
//   F5 triggerTimesType 非法（全局 + 节点内嵌副本）
//   F6 event-trigger 的 shape≠eventId / eventItem 不一致
//   F7 action-event 的 data.type 写错 / eventId 未声明
//   F8 object/array 缺 schema（properties / items）
//   F10 data.type 非平台枚举

import type { RiskFinding } from '../types';
import { asArray, asObject, asString, KNOWN_NODE_TYPES, type AnalysisContext, type RiskNode } from '../context';

type Add = (f: RiskFinding) => void;

const MEDIA_FIELDS: Record<string, string> = { audioUrl: 'audio', imageUrl: 'image', videoUrl: 'video' };

export function checkCompliance(ctx: AnalysisContext, add: Add): void {
  // ---- 全局：events[] ----
  ctx.events.forEach((event, idx) => {
    for (const field of ['eventId', 'name', 'variables', 'triggerTimesType'] as const) {
      if (event[field] === undefined || event[field] === null) {
        add({
          code: 'F4',
          rule: 'event-missing-required-field',
          category: 'compliance',
          severity: 'error',
          path: `events[${idx}].${field}`,
          message: `events[${idx}] 缺少必填字段「${field}」，平台导入会失败。`,
          fix: { summary: `补齐 events[${idx}].${field}` },
        });
      }
    }
    const tt = asString(event.triggerTimesType);
    if (tt !== undefined && tt !== 'unlimited' && tt !== 'limited') {
      add({
        code: 'F5',
        rule: 'event-triggertimestype-invalid',
        category: 'compliance',
        severity: 'error',
        path: `events[${idx}].triggerTimesType`,
        message: `events[${idx}].triggerTimesType="${tt}" 非法（只能是 unlimited / limited）。`,
        fix: { summary: '改为 unlimited（配 maxTriggerTimes:0/null）或 limited（配正整数）' },
      });
    }
  });

  // ---- 逐节点 ----
  for (const node of ctx.nodes) {
    if (node.category === 'comment') continue;

    // F10：data.type 非枚举
    if (!KNOWN_NODE_TYPES.has(node.type) && !ctx.eventIds.has(node.shape)) {
      add({
        code: 'F10',
        rule: 'datatype-not-platform-enum',
        category: 'compliance',
        severity: 'warn',
        nodeId: node.id,
        path: 'data.type',
        message: `节点「${node.name}」的 data.type="${node.type}" 不是平台已知节点类型。`,
        fix: { summary: '换成合法的 data.type 枚举值' },
      });
    }

    // F1：send-text 标准字段
    if (node.shape === 'send-text-message') checkSendText(node, add);

    // F3：媒体字段 type.type
    checkMediaFields(node, add);

    // F6：event-trigger（仅当声明了 events 时校验；空 events[] 跳过）
    if (node.type === 'canvas-event-trigger' && ctx.eventIds.size > 0) checkEventTrigger(ctx, node, add);

    // F7：action-event
    if (node.shape === 'action-event') {
      if (node.type !== 'canvas-event-action') {
        add({
          code: 'F7',
          rule: 'action-event-type-mismatch',
          category: 'compliance',
          severity: 'error',
          nodeId: node.id,
          path: 'data.type',
          message: `action-event 节点「${node.name}」的 data.type 应为 canvas-event-action，实际是「${node.type}」，平台导入会失败。`,
          fix: { summary: 'data.type 改为 canvas-event-action', path: 'data.type', before: node.type, after: 'canvas-event-action' },
        });
      }
      const eid = asString(node.payload.eventId);
      // 仅当工作流确实声明了 events 时才校验 eventId 存在性（空 events[] 多为平台侧维护，跳过避免误报）。
      if (eid && ctx.eventIds.size > 0 && !ctx.eventIds.has(eid)) {
        add({
          code: 'F7',
          rule: 'action-event-type-mismatch',
          category: 'compliance',
          severity: 'error',
          nodeId: node.id,
          path: 'data.nodePayload.eventId',
          message: `action-event 节点「${node.name}」的 eventId 未在 events[] 声明。`,
          fix: { summary: '把 eventId 指向一个已声明的事件' },
        });
      }
    }

    // F8：object/array 缺 schema
    checkSchemaCompleteness(node, add);
  }
}

function checkSendText(node: RiskNode, add: Add): void {
  const p = node.payload;
  const quote = asObject(p.quoteMessageId);
  if (!quote || quote.name !== 'quoteMessageId' || quote.valueType !== 'reference') {
    pushSendText(node, add, 'quoteMessageId', 'data.nodePayload.quoteMessageId');
  }
  if (typeof p.enableMention !== 'boolean') {
    pushSendText(node, add, 'enableMention', 'data.nodePayload.enableMention');
  }
  const mention = asObject(p.mentionUserIds);
  const mtype = asObject(mention?.type);
  if (!mention || mention.name !== 'mentionUserIds' || mention.valueType !== 'reference' || mtype?.type !== 'array') {
    pushSendText(node, add, 'mentionUserIds', 'data.nodePayload.mentionUserIds');
  }
}

function pushSendText(node: RiskNode, add: Add, field: string, path: string): void {
  add({
    code: 'F1',
    rule: 'send-text-missing-standard-fields',
    category: 'compliance',
    severity: 'warn',
    nodeId: node.id,
    path,
    message: `发送节点「${node.name}」缺少标准字段「${field}」。`,
    fix: { summary: `补齐 ${field}（send-text-message 必带 quoteMessageId / enableMention / mentionUserIds）` },
  });
}

function checkMediaFields(node: RiskNode, add: Add): void {
  const scan = (arr: unknown[], where: string) => {
    arr.forEach((it, i) => {
      const o = asObject(it);
      const name = asString(o?.name);
      if (!name || !(name in MEDIA_FIELDS)) return;
      const t = asString(asObject(o?.type)?.type);
      if (t && t !== MEDIA_FIELDS[name] && t === 'string') {
        add({
          code: 'F3',
          rule: 'media-field-type-not-media',
          category: 'compliance',
          severity: 'warn',
          nodeId: node.id,
          path: `${where}[${i}].type.type`,
          message: `节点「${node.name}」的媒体字段「${name}」的 type.type 应为 ${MEDIA_FIELDS[name]}，实际是 string。`,
          fix: { summary: `改为 ${MEDIA_FIELDS[name]}`, before: 'string', after: MEDIA_FIELDS[name] },
        });
      }
    });
  };
  scan(asArray(node.data.outputTypes), 'data.outputTypes');
  scan(asArray(node.payload.inputs), 'data.nodePayload.inputs');
}

function checkEventTrigger(ctx: AnalysisContext, node: RiskNode, add: Add): void {
  const problems: string[] = [];
  if (!ctx.eventIds.has(node.shape)) problems.push(`shape「${node.shape.slice(0, 8)}…」不是任何 events[] 的 eventId`);
  const eventItem = asObject(node.data.eventItem);
  if (eventItem && asString(eventItem.eventId) !== node.shape) problems.push('data.eventItem.eventId 与 shape 不一致');
  const payloadEid = asString(node.payload.eventId);
  if (payloadEid && payloadEid !== node.shape) problems.push('nodePayload.eventId 与 shape 不一致');
  if (problems.length) {
    add({
      code: 'F6',
      rule: 'event-trigger-shape-eventid-mismatch',
      category: 'compliance',
      severity: 'error',
      nodeId: node.id,
      message: `事件入口节点「${node.name}」配置不一致：${problems.join('；')}。平台导入会失败。`,
      fix: { summary: '事件入口节点的 shape 必须等于 eventId，且 eventItem / nodePayload.eventId 与之一致' },
    });
  }
}

/** 递归检查 type schema：object 缺 properties、array 缺 items。命中即报（每节点最多 3 条）。 */
function checkSchemaCompleteness(node: RiskNode, add: Add): void {
  const hits: string[] = [];
  const visit = (schema: unknown, path: string, depth: number) => {
    if (depth > 6 || hits.length >= 3) return;
    const s = asObject(schema);
    if (!s) return;
    const t = asString(s.type);
    if (t === 'object' && !asObject(s.properties)) hits.push(path);
    if (t === 'array' && s.items == null) hits.push(path);
    const props = asObject(s.properties);
    if (props) for (const [k, v] of Object.entries(props)) visit(v, `${path}.properties.${k}`, depth + 1);
    if (s.items) visit(s.items, `${path}.items`, depth + 1);
  };
  const scanList = (arr: unknown[], where: string) =>
    arr.forEach((it, i) => visit(asObject(it)?.type, `${where}[${i}].type`, 0));

  scanList(asArray(node.data.outputTypes), 'data.outputTypes');
  scanList(asArray(node.payload.inputs), 'data.nodePayload.inputs');

  if (hits.length) {
    add({
      code: 'F8',
      rule: 'object-array-schema-missing',
      category: 'compliance',
      severity: 'error',
      nodeId: node.id,
      path: hits[0],
      message: `节点「${node.name}」有 ${hits.length} 处 type schema 不完整（object 缺 properties 或 array 缺 items），平台 canvas/save 会 400：${hits.join('、')}。`,
      fix: { summary: 'object 补 properties:{}，array 补 items:{type:...}' },
    });
  }
}
