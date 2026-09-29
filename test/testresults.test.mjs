import test from 'node:test';
import assert from 'node:assert/strict';
import { ROW_HEAD, alignTasks, alignedTable, itemRow, replyOfItem, rowCells, taskSummary, toCsv } from '../src/testresults.mjs';
import { CROSS_EXEC, SAME_EXEC } from './helpers/testcenter-fixtures.mjs';

const item = (patch = {}) => ({
  testCaseId: 'c1', testCaseName: `调优中心导入(${SAME_EXEC})`, scenarioPath: '退款', status: 'success', passed: true,
  costInCny: 0.02, processDuration: 1200, canvasExecId: 'd1', canvasExecAvailable: true, triggerExists: true,
  triggerContent: { triggerType: 'canvas-event-trigger', content: { eventName: '延时回复', data: { text: '我想退款' } } },
  executedActions: [{ type: 'send-text-message', summary: '已为您登记退款' }],
  canvasActionOutputAssertionResult: [{ type: 'send-text-message', passed: true, assertionDetailedInfo: '发送 - 文本', expectedValue: '已为您登记', actualValue: '已为您登记退款' }],
  ...patch,
});

test('replyOfItem：发送动作 → 转人工 → 断言里带出来的发出事件参数 → 空', () => {
  assert.equal(replyOfItem(item()), '已为您登记退款');
  assert.equal(replyOfItem(item({ executedActions: [{ type: 'handover', summary: '转给人工客服' }] })), '转人工：转给人工客服');
  const viaEvent = item({
    executedActions: [{ type: 'canvas-event-action', summary: '触发 发送4.0 事件' }],
    canvasActionOutputAssertionResult: [{ type: 'canvas-event-action', passed: false, actualOutput: { type: 'canvas-event-action', payload: { eventName: '发送4.0', params: { text: '事件里的回复' } } } }],
  });
  assert.equal(replyOfItem(viaEvent), '（事件「发送4.0」）事件里的回复');
  assert.equal(replyOfItem(item({ executedActions: [], canvasActionOutputAssertionResult: [] })), '');
});

test('itemRow：执行 id 从用例名取；用户消息、期望、没通过的断言结论；线上回复从来源取；空跑单独标出', () => {
  const failed = itemRow(item({ passed: false, canvasActionOutputAssertionResult: [{ type: 'update-data', passed: false, assertionDetailedInfo: '写字段 - 已发优惠', message: '字段值不一致' }] }), { execs: { [SAME_EXEC]: { reply: '线上回复 1' } } });
  assert.deepEqual([failed.execId, failed.user, failed.expect, failed.verdict, failed.online, failed.passed], [SAME_EXEC, '我想退款', '写字段 - 已发优惠', '写字段 - 已发优惠：字段值不一致', '线上回复 1', false]);
  const diff = itemRow(item({ passed: false, canvasActionOutputAssertionResult: [{ type: 'send-text-message', passed: false, assertionDetailedInfo: '发送 - 文本', expectedValue: '期望的话', actualValue: '实际的话' }] }));
  assert.equal(diff.verdict, '发送 - 文本：期望「期望的话」实际「实际的话」');
  const noop = itemRow(item({ testCaseName: `调优中心导入(${CROSS_EXEC})`, passed: false, canvasExecAvailable: false, costInCny: null, processDuration: null, executedActions: [], canvasActionOutputAssertionResult: [] }));
  assert.equal(noop.noop, true);
  assert.match(noop.verdict, /没有真正执行/);
  assert.equal(rowCells(noop)[5], '空跑');
  assert.equal(ROW_HEAD.length, rowCells(noop).length);
});

test('taskSummary：通过数、通过率、空跑数、花费（跑完用总花费，没有就逐条加）', () => {
  const rows = [itemRow(item()), itemRow(item({ passed: false, canvasExecAvailable: false, costInCny: null }))];
  assert.deepEqual(
    taskSummary({ testTaskId: 't1', name: '任务', status: 'finished', canvasVersion: 'v1', totalCostInCny: 0.05, taskDuration: 45000 }, rows),
    { name: '任务', id: 't1', status: 'finished', version: 'v1', runs: 2, passed: 1, noop: 1, notRun: 0, rate: 0.5, cost: 0.05, durationMs: 45000 },
  );
  assert.equal(taskSummary({ status: 'paused' }, rows).cost, 0.02);
});

test('alignTasks / alignedTable：多个任务按用例对齐，每个任务「通过 k/n」和第一条回复；没跑到的写 -', () => {
  const a = { summary: { name: '改前' }, rows: [itemRow(item({ passed: false })), itemRow(item({ testCaseId: 'c2', testCaseName: '另一条' }))] };
  const b = { summary: { name: '改后' }, rows: [itemRow(item()), itemRow(item())] };
  const table = alignedTable([a, b], alignTasks([a, b]));
  assert.deepEqual(table.head, ['用例名', '调优中心执行ID', '用户消息', '线上回复', '改前 通过', '改前 回复', '改后 通过', '改后 回复']);
  assert.deepEqual(table.rows[0].slice(4), ['0/1', '已为您登记退款', '2/2', '已为您登记退款']);
  assert.deepEqual(table.rows[1].slice(4), ['1/1', '已为您登记退款', '-', '']);
});

test('toCsv：带 BOM（Excel 才认中文）；含逗号、引号、换行的格子加引号', () => {
  const csv = toCsv(['a', 'b'], [['1,2', 'x"y'], ['多\n行', 3]]);
  assert.ok(csv.startsWith('﻿a,b\r\n'));
  assert.ok(csv.endsWith('"1,2","x""y"\r\n"多\n行",3\r\n'));
});

test('还没跑的条目（任务被暂停或还在跑）：和空跑分开，标「未跑」，不进通过率（审查 I1）', () => {
  const pending = itemRow(item({ status: 'pending', passed: null, canvasExecAvailable: false, costInCny: null, processDuration: null, executedActions: [], canvasActionOutputAssertionResult: [] }));
  assert.deepEqual([pending.notRun, pending.noop, pending.passed], [true, false, false]);
  assert.match(pending.verdict, /还没跑/);
  assert.equal(rowCells(pending)[5], '未跑');
  const rows = [itemRow(item()), pending, itemRow(item({ status: 'processing', passed: null, canvasExecAvailable: false, costInCny: null }))];
  const s = taskSummary({ status: 'paused' }, rows);
  assert.deepEqual([s.runs, s.passed, s.noop, s.notRun, s.rate], [1, 1, 0, 2, 1]);
  const aligned = alignTasks([{ summary: { name: 'a' }, rows }]);
  assert.deepEqual(aligned.map(({ per }) => per[0]?.runs), [1]);
});

test('改过名的用例：执行 id 按导入时记下的「用例 id → 执行」查，线上回复跟着对上（审查 I6）', () => {
  const renamed = itemRow(item({ testCaseName: '退款-课程-01' }), { execs: { [SAME_EXEC]: { reply: '线上回复 1' } }, byCase: { c1: SAME_EXEC } });
  assert.deepEqual([renamed.execId, renamed.online], [SAME_EXEC, '线上回复 1']);
  assert.equal(itemRow(item({ testCaseName: '退款-课程-01' }), {}).execId, '');
});

test('toCsv：以 = + - @ 开头的格子前面加单引号，Excel 不会当公式执行（审查 M4）', () => {
  const csv = toCsv(['a'], [['=HYPERLINK("x")'], ['+1+1'], ['-2'], ['@SUM(A1)'], ['正常 -中间的减号']]);
  assert.match(csv, /\r\n"'=HYPERLINK\(""x""\)"\r\n'\+1\+1\r\n'-2\r\n'@SUM\(A1\)\r\n正常 -中间的减号\r\n$/);
});

test('没通过的断言：结论里带上判定的原因（llmReason，秒懂页面上的「原因」），没有才写期望和实际', () => {
  const failed = (r) => itemRow(item({ passed: false, canvasActionOutputAssertionResult: [{ type: 'send-text-message', passed: false, assertionDetailedInfo: '发送 - 文本', expectedValue: '要提到退款', actualValue: '你好', ...r }] })).verdict;
  assert.equal(failed({ llmReason: '回复没有提到退款', message: '' }), '发送 - 文本：回复没有提到退款');
  assert.equal(failed({ message: '相似度不够' }), '发送 - 文本：相似度不够');
  assert.equal(failed({}), '发送 - 文本：期望「要提到退款」实际「你好」');
});
