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
  const failed = itemRow(item({ passed: false, canvasActionOutputAssertionResult: [{ type: 'update-data', passed: false, assertionDetailedInfo: '写字段 - 已发优惠', message: '字段值不一致' }] }), { [SAME_EXEC]: { reply: '线上回复 1' } });
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
    { name: '任务', id: 't1', status: 'finished', version: 'v1', runs: 2, passed: 1, noop: 1, rate: 0.5, cost: 0.05, durationMs: 45000 },
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
