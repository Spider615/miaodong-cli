import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdMap, caseText, execIdOfCase, idProblems, leftoverIds, preflight, remapCase, summarizeCases } from '../src/testcases.mjs';
import { CROSS_EXEC, LOST_EXEC, SAME_EXEC, SOURCE_BOT, TARGET_BOT, botEvents, botVars, importable, pluginCanvas, targetCanvas } from './helpers/testcenter-fixtures.mjs';

const maps = () => buildIdMap({ sourceEvents: botEvents[SOURCE_BOT], targetEvents: botEvents[TARGET_BOT], sourceVars: botVars[SOURCE_BOT], targetVars: botVars[TARGET_BOT] });

test('execIdOfCase / caseText / summarizeCases', () => {
  assert.equal(execIdOfCase(`调优中心导入(${SAME_EXEC})`), SAME_EXEC);
  assert.equal(execIdOfCase('手写的用例'), null);
  assert.equal(caseText(importable[SAME_EXEC]), '我想退款');
  assert.equal(caseText({ triggerInputs: { text: '你好' } }), '你好');
  const s = summarizeCases([importable[SAME_EXEC], { ...importable[CROSS_EXEC], isReviewed: true, scenarioNodeId: 'sc-1' }, { triggerType: 'receive-text-message', isReviewed: true }]);
  assert.deepEqual(s, { total: 3, byTrigger: { 'canvas-event-trigger': 2, 'receive-text-message': 1 }, unreviewed: 1, attached: 1 });
});

test('跨智能体换 id：事件 id、会话变量的键和 fieldId、verifyPayload 与 actionContent 两份都换；换完不剩源 bot 的 id；原对象不改', () => {
  const { testCase, problems } = remapCase(importable[CROSS_EXEC], maps());
  assert.deepEqual(problems, []);
  assert.equal(testCase.triggerInputs.eventId, 'tev-delay');
  assert.deepEqual(Object.keys(testCase.sessionMemoryCustomData).sort(), ['tv-flag', 'tv-hist']);
  const [update, event] = testCase.canvasActionOutputAssertions;
  assert.equal(update.verifyPayload.operations[0].fieldId, 'tv-flag');
  assert.equal(update.actionContent.payload.operations[0].fieldId, 'tv-flag');
  assert.equal(event.verifyPayload.eventId, 'tev-send');
  assert.equal(event.actionContent.payload.eventId, 'tev-send');
  assert.deepEqual(leftoverIds(testCase, new Set(['sev-delay', 'sev-send', 'sv-hist', 'sv-flag'])), []);
  assert.equal(importable[CROSS_EXEC].triggerInputs.eventId, 'sev-delay');
});

test('名字在目标里没有、或者有重名：换不了，原因记下来', () => {
  assert.deepEqual(remapCase(importable[LOST_EXEC], maps()).problems, ['事件「只在源里有」在目标里没有']);
  const dup = buildIdMap({ sourceEvents: [{ eventId: 'a', name: '发送' }], targetEvents: [{ eventId: 'b', name: '发送' }, { eventId: 'c', name: '发送' }], sourceVars: [], targetVars: [] });
  assert.deepEqual(remapCase({ triggerInputs: { eventId: 'a' } }, dup).problems, ['事件「发送」在目标里有 2 个同名']);
});

test('idProblems：事件、会话变量在这个智能体里不存在就记下；列表取不到（null）时不查那一项', () => {
  const why = (rows, name) => rows.filter((e) => e.name === name).map((e) => e.reason).join('；');
  const rows = idProblems([importable[SAME_EXEC], importable[CROSS_EXEC]], { events: botEvents[TARGET_BOT], vars: botVars[TARGET_BOT] });
  assert.equal(why(rows, importable[SAME_EXEC].name), '');
  assert.match(why(rows, importable[CROSS_EXEC].name), /事件 sev-dela 在这个智能体里不存在/);
  assert.match(why(rows, importable[CROSS_EXEC].name), /2 个会话变量在这个智能体里不存在/);
  assert.deepEqual(idProblems([importable[CROSS_EXEC]], { events: null, vars: null }), []);
});

test('preflight：事件没入口、画布上没有这种触发器都拦下；列出会真调外部的插件；数未审核', () => {
  const why = (r, name) => r.errors.filter((e) => e.name === name).map((e) => e.reason).join('；');
  const noEntry = { ...importable[SAME_EXEC], name: '没入口', triggerInputs: { eventId: 'tev-send', data: {} } };
  const text = { name: '文本', triggerType: 'receive-text-message', isReviewed: true, sessionMemoryCustomData: {} };
  const r = preflight([importable[SAME_EXEC], importable[CROSS_EXEC], noEntry, text], { canvas: pluginCanvas(), events: botEvents[TARGET_BOT], vars: botVars[TARGET_BOT] });
  assert.equal(why(r, importable[SAME_EXEC].name), '');
  assert.match(why(r, importable[CROSS_EXEC].name), /事件 sev-dela 在这个智能体里不存在/);
  assert.match(why(r, '没入口'), /要跑的画布上没有事件 tev-send 的入口/);
  assert.match(why(r, '文本'), /要跑的画布上没有「receive-text-message」触发器/);
  assert.deepEqual(r.plugins, ['查用户详情']);
  assert.equal(r.unreviewed, 3);
  assert.deepEqual(preflight([importable[SAME_EXEC]], { canvas: targetCanvas(), events: botEvents[TARGET_BOT], vars: botVars[TARGET_BOT] }).plugins, []);
});

test('preflight：取不到事件或会话变量列表时算跑前检查不通过——没法核对就不能当作没问题（审查 I4）', () => {
  const r = preflight([importable[SAME_EXEC]], { canvas: targetCanvas(), events: null, vars: botVars[TARGET_BOT] });
  assert.match(r.errors.map((e) => e.reason).join(), /取不到这个智能体的事件或会话变量列表，没法核对会不会空跑/);
});
