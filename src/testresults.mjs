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

// 还没跑的条目（任务被暂停或还在跑）：秒懂给的数据和空跑长得一样（未执行、花费为空），只能按条目状态分开（审查 I1）
const NOT_RUN = new Set(['pending', 'processing', 'running', 'queued', 'waiting']);
export const isNotRun = (item) => NOT_RUN.has(String(item?.status ?? ''));

// 空跑：跑完了、秒懂显示成功，但没有执行、花费为空（spec §2.3 核对 6）
export const isNoop = (item) => !isNotRun(item) && item?.canvasExecAvailable === false && (item?.costInCny === null || item?.costInCny === undefined);

// sources 是导入时记下的来源：execs（执行 id → 时间、用户消息、线上回复）和 byCase（用例 id → 执行 id）。
// 执行 id 先按用例 id 查——用户常在页面上给用例改名，改了名就解析不出来（审查 I6）；查不到再从默认名里解析
export function itemRow(item, sources = {}) {
  const execId = sources.byCase?.[item?.testCaseId] ?? execIdOfCase(item?.testCaseName) ?? '';
  const content = item?.triggerContent?.content ?? {};
  const results = asArray(item?.canvasActionOutputAssertionResult);
  const describe = (r) => String(r?.assertionDetailedInfo || r?.type || '');
  const noop = isNoop(item);
  const notRun = isNotRun(item);
  return {
    name: String(item?.testCaseName ?? ''),
    caseId: String(item?.testCaseId ?? ''),
    execId,
    scenario: String(item?.scenarioPath ?? ''),
    user: String(content.text ?? content.data?.text ?? content.data?.userOriginalText ?? ''),
    expect: results.map(describe).filter(Boolean).join('；'),
    passed: item?.passed === true,
    verdict: notRun
      ? '还没跑（任务被暂停或还在跑）'
      : noop
      ? '没有真正执行：触发器、事件或会话变量对不上（秒懂仍显示成功）'
      : results.filter((r) => r?.passed === false).map((r) => `${describe(r)}：${r?.message || `期望「${clip(r?.expectedValue ?? '', 80)}」实际「${clip(r?.actualValue ?? '', 80)}」`}`).join('；'),
    reply: replyOfItem(item),
    actions: asArray(item?.executedActions).map((a) => a?.summary || a?.type).filter(Boolean).join('；'),
    cost: typeof item?.costInCny === 'number' ? item.costInCny : null,
    ms: typeof item?.processDuration === 'number' ? item.processDuration : null,
    testExecId: String(item?.canvasExecId ?? ''),
    noop,
    notRun,
    online: execId && sources.execs?.[execId] ? String(sources.execs[execId].reply ?? '') : '',
  };
}

// 次数、通过率只算跑过的条目；没跑的单独数（任务被暂停或还在跑时）
export function taskSummary(detail, rows) {
  const ran = rows.filter((r) => !r.notRun);
  const passed = ran.filter((r) => r.passed).length;
  return {
    name: String(detail?.name ?? ''),
    id: String(detail?.testTaskId ?? ''),
    status: String(detail?.status ?? ''),
    version: String(detail?.canvasVersion ?? ''),
    runs: ran.length,
    passed,
    noop: ran.filter((r) => r.noop).length,
    notRun: rows.length - ran.length,
    rate: ran.length ? passed / ran.length : null,
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
      if (row.notRun) continue;
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
export const rowCells = (r) => [r.name, r.execId, r.scenario, r.user, r.expect, r.notRun ? '未跑' : r.noop ? '空跑' : r.passed ? '通过' : '不通过', r.verdict, r.reply, r.actions, r.cost ?? '', r.ms ?? '', r.testExecId, r.online];

export function alignedTable(tasks, aligned) {
  const head = ['用例名', '调优中心执行ID', '用户消息', '线上回复', ...tasks.flatMap(({ summary }) => [`${summary.name} 通过`, `${summary.name} 回复`])];
  const rows = aligned.map(({ base, per }) => [base.name, base.execId, base.user, base.online, ...tasks.flatMap((_, i) => (per[i] ? [`${per[i].passed}/${per[i].runs}`, per[i].reply] : ['-', '']))]);
  return { head, rows };
}

// CSV：带 BOM（Excel 才认得出 UTF-8 中文）；含逗号、引号、换行的格子加引号。
// 以 = + - @ 开头的格子前面加单引号：用户原话进了报告，Excel 会把它当公式执行（审查 M4；xlsx 写的是纯文本，没这个问题）
export function toCsv(head, rows) {
  const cell = (value) => {
    const raw = String(value ?? '');
    const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
