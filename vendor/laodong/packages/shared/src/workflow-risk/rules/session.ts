// C 组：session / 槽位 读写不匹配。
//   C1 session 读引用未声明（validator 只查了 inputs，这里覆盖 rule.field / update-value 等全部消费点）
//   C2 update-data 写向未声明 session（validator 完全不查 fieldId）
//   C3 session 被读但从未被写（永读空）—— 低置信 info，历史类 session 白名单
//   C4 session 被写但从未被读（漏接）—— 低置信 info

import type { RiskFinding } from '../types';
import { type AnalysisContext, type RiskNode } from '../context';

type Add = (f: RiskFinding) => void;

/** 历史/平台自维护类 session 名（C3 白名单，避免误报「读了没写」）。 */
const HISTORY_NAME = /历史|history|会话记录|聊天记录|chat[_-]?history|context/i;

export function checkSession(ctx: AnalysisContext, add: Add): void {
  // 工作流未在 JSON 内声明任何 session（常见于平台导入的工作流——session 变量在平台侧维护，不落进 canvas JSON）。
  // 此时无法判断某个 sessionMemoryItemId 是否「未声明」，全跳过，避免海量误报。
  if (ctx.sessionIds.size === 0) return;

  const readers = new Map<string, RiskNode[]>(); // sessionId -> 读它的节点
  const writers = new Map<string, RiskNode[]>(); // sessionId -> 写它的节点

  // C1：所有引用点里的 sessionMemoryItemId
  for (const site of ctx.refSites) {
    const sid = site.sessionMemoryItemId;
    if (!sid) continue;
    if (!ctx.sessionIds.has(sid)) {
      add({
        code: 'C1',
        rule: 'session-read-unresolved',
        category: 'session',
        severity: 'warn',
        nodeId: site.node.id,
        path: `${site.path}.sessionMemoryItemId`,
        message: `节点「${site.node.name}」的 ${site.label} 读取的 session（${sid.slice(0, 8)}…）未在顶层 sessions 声明，取值恒空。`,
        fix: { summary: '在 sessions[] 声明该变量，或把 sessionMemoryItemId 改指正确 session' },
      });
    } else {
      if (!readers.has(sid)) readers.set(sid, []);
      readers.get(sid)!.push(site.node);
    }
  }

  // C2：update-data / update-custom-attr 的写目标
  for (const w of ctx.sessionWrites) {
    if (!ctx.sessionIds.has(w.fieldId)) {
      add({
        code: 'C2',
        rule: 'session-write-unresolved',
        category: 'session',
        severity: 'warn',
        nodeId: w.node.id,
        path: w.path,
        message: `节点「${w.node.name}」写回的 session（${w.fieldId.slice(0, 8)}…）未在顶层 sessions 声明。`,
        fix: { summary: '在 sessions[] 声明该变量，或对齐正确的 session id' },
      });
    } else {
      if (!writers.has(w.fieldId)) writers.set(w.fieldId, []);
      writers.get(w.fieldId)!.push(w.node);
    }
  }

  // C3：被读但从未被写（排除历史/平台自维护类）
  for (const sid of ctx.sessionIds) {
    if (!readers.has(sid)) continue;
    if (writers.has(sid)) continue;
    const name = ctx.sessionNameById.get(sid) ?? '';
    if (HISTORY_NAME.test(name)) continue; // 历史类由平台/其他机制写入
    const reader = readers.get(sid)![0];
    add({
      code: 'C3',
      rule: 'session-read-never-written',
      category: 'session',
      severity: 'info',
      nodeId: reader.id,
      message: `session「${name || sid.slice(0, 8)}」被读取但全图没有任何 update-data 写它，每次可能读到空值。`,
      fix: { summary: '补一个 update-data 写回节点，或确认它由平台/其他机制维护' },
    });
  }

  // C4：被写但从未被读（常是漏接下游）
  for (const sid of ctx.sessionIds) {
    if (!writers.has(sid)) continue;
    if (readers.has(sid)) continue;
    const name = ctx.sessionNameById.get(sid) ?? '';
    const writer = writers.get(sid)![0];
    add({
      code: 'C4',
      rule: 'session-write-never-read',
      category: 'session',
      severity: 'info',
      nodeId: writer.id,
      message: `session「${name || sid.slice(0, 8)}」被写入但全图无人读取，可能是漏接了下游读取。`,
      fix: { summary: '确认是否有下游/后续轮次应读取它，否则删除冗余写回' },
    });
  }
}
