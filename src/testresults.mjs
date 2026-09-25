// 测试结果：逐条整理成报告的一行，多个任务按用例对齐（spec §6.6）。字段形状见 spec §2.3。

import { asArray } from './api.mjs';
import { clip } from './execs.mjs';
import { execIdOfCase } from './testcases.mjs';

// 实际回复：同一条链里的发送动作；没有就看转人工；再没有，看断言结果里带出来的发出事件参数
// （回复在下游事件链里时，测试项里没有发送，spec §2.3）。都没有返回空，由 --deep 去详情里取
export function replyOfItem(item) {
  const actions = asArray(item?.executedActions);
  const sends = actions.filter((a) => a?.type === 'send-text-message' || a?.type === 'send-combination-message').map((a) => String(a?.summary ?? '')).filter(Boolean);
  if (sends.length) return sends.join(' / ');
  const handover = actions.find((a) => a?.type === 'handover');
  if (handover) return `转人工${handover.summary ? `：${handover.summary}` : ''}`;
  for (const r of asArray(item?.canvasActionOutputAssertionResult)) {
    const payload = r?.actualOutput?.payload;
    const text = payload?.params?.text;
    if (typeof text === 'string' && text.trim()) return `（事件「${payload.eventName ?? ''}」）${text}`;
  }
  return '';
}

// 空跑：秒懂显示成功，但没有执行、花费为空（spec §2.3 核对 6）
export const isNoop = (item) => item?.canvasExecAvailable === false && (item?.costInCny === null || item?.costInCny === undefined);

export function itemRow(item, sources = {}) {
  const execId = execIdOfCase(item?.testCaseName) ?? '';
  const content = item?.triggerContent?.content ?? {};
  const results = asArray(item?.canvasActionOutputAssertionResult);
  const describe = (r) => String(r?.assertionDetailedInfo || r?.type || '');
  const noop = isNoop(item);
  return {
    name: String(item?.testCaseName ?? ''),
    caseId: String(item?.testCaseId ?? ''),
    execId,
    scenario: String(item?.scenarioPath ?? ''),
    user: String(content.text ?? content.data?.text ?? content.data?.userOriginalText ?? ''),
    expect: results.map(describe).filter(Boolean).join('；'),
    passed: item?.passed === true,
    verdict: noop
      ? '没有真正执行：触发器、事件或会话变量对不上（秒懂仍显示成功）'
      : results.filter((r) => r?.passed === false).map((r) => `${describe(r)}：${r?.message || `期望「${clip(r?.expectedValue ?? '', 80)}」实际「${clip(r?.actualValue ?? '', 80)}」`}`).join('；'),
    reply: replyOfItem(item),
    actions: asArray(item?.executedActions).map((a) => a?.summary || a?.type).filter(Boolean).join('；'),
    cost: typeof item?.costInCny === 'number' ? item.costInCny : null,
    ms: typeof item?.processDuration === 'number' ? item.processDuration : null,
    testExecId: String(item?.canvasExecId ?? ''),
    noop,
    online: execId && sources[execId] ? String(sources[execId].reply ?? '') : '',
  };
}

export function taskSummary(detail, rows) {
  const passed = rows.filter((r) => r.passed).length;
  return {
    name: String(detail?.name ?? ''),
    id: String(detail?.testTaskId ?? ''),
    status: String(detail?.status ?? ''),
    version: String(detail?.canvasVersion ?? ''),
    runs: rows.length,
    passed,
    noop: rows.filter((r) => r.noop).length,
    rate: rows.length ? passed / rows.length : null,
    cost: typeof detail?.totalCostInCny === 'number' ? detail.totalCostInCny : rows.reduce((sum, r) => sum + (r.cost ?? 0), 0),
    durationMs: typeof detail?.taskDuration === 'number' ? detail.taskDuration : null,
  };
}

// 多个任务按用例对齐：同一条用例（按用例 id，没有就按名字）一行；每个任务一组「通过 k/n」和第一条非空回复
export function alignTasks(tasks) {
  const keys = [];
  const byKey = new Map();
  tasks.forEach(({ rows }, i) => {
    for (const row of rows) {
      const key = row.caseId || row.name;
      if (!byKey.has(key)) {
        byKey.set(key, { base: row, per: [] });
        keys.push(key);
      }
      const slot = (byKey.get(key).per[i] ??= { runs: 0, passed: 0, reply: '' });
      slot.runs++;
      if (row.passed) slot.passed++;
      if (!slot.reply && row.reply) slot.reply = row.reply;
    }
  });
  return keys.map((key) => byKey.get(key));
}

export const ROW_HEAD = ['用例名', '调优中心执行ID', '场景', '用户消息', '期望', '是否通过', '断言结论', '实际回复', '实际动作', '花费', '耗时ms', '测试执行ID', '线上回复'];
export const rowCells = (r) => [r.name, r.execId, r.scenario, r.user, r.expect, r.noop ? '空跑' : r.passed ? '通过' : '不通过', r.verdict, r.reply, r.actions, r.cost ?? '', r.ms ?? '', r.testExecId, r.online];

export function alignedTable(tasks, aligned) {
  const head = ['用例名', '调优中心执行ID', '用户消息', '线上回复', ...tasks.flatMap(({ summary }) => [`${summary.name} 通过`, `${summary.name} 回复`])];
  const rows = aligned.map(({ base, per }) => [base.name, base.execId, base.user, base.online, ...tasks.flatMap((_, i) => (per[i] ? [`${per[i].passed}/${per[i].runs}`, per[i].reply] : ['-', '']))]);
  return { head, rows };
}

// CSV：带 BOM（Excel 才认得出 UTF-8 中文）；含逗号、引号、换行的格子加引号
export function toCsv(head, rows) {
  const cell = (value) => {
    const s = String(value ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
