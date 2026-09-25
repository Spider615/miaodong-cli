import test from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGER_TYPES, buildCase, buildCases, buildExpect, flattenTree, historyValue, parseCaseLines } from '../src/casefile.mjs';
import { TARGET_BOT, botEvents, botVars, scenarioTreeFixture } from './helpers/testcenter-fixtures.mjs';

const events = botEvents[TARGET_BOT];

test('parseCaseLines：去 BOM 和行尾 \\r、跳过空行；坏行带行号报出来，好行照收', () => {
  const { rows, errors } = parseCaseLines('﻿{"name":"a","text":"你好"}\r\n\r\n{坏的\r\n[1,2]\n{"name":"b","text":"在吗"}\n');
  assert.deepEqual(rows.map((r) => [r.line, r.value.name]), [[1, 'a'], [5, 'b']]);
  assert.deepEqual(errors.map((e) => e.line), [3, 4]);
  assert.match(errors[0].reason, /不是 JSON/);
  assert.match(errors[1].reason, /不是 JSON 对象/);
});

test('触发类型是核对 8 实测的 20 个', () => {
  assert.equal(TRIGGER_TYPES.length, 20);
  assert.ok(TRIGGER_TYPES.includes('canvas-event-trigger'));
});

test('historyValue：字符串记成 user；{role, content} 只认 user / assistant', () => {
  assert.deepEqual(historyValue(['我先问的', 'https://x/a.jpg', { role: 'assistant', content: '好的' }]).value, [
    { role: 'user', content: '我先问的' }, { role: 'user', content: 'https://x/a.jpg' }, { role: 'assistant', content: '好的' },
  ]);
  assert.match(historyValue([{ role: 'system', content: 'x' }]).error, /第 1 项/);
  assert.match(historyValue('一句话').error, /数组/);
});

test('buildExpect：字符串和 reply 生成发文本断言，两份内容一样（形状同核对 8）', () => {
  const { assertions, errors } = buildExpect(['应说明退款流程', { reply: { similar: '已为您登记' } }, { reply: { equal: '好的' } }], { events });
  assert.deepEqual(errors, []);
  assert.deepEqual(assertions.map((a) => a.verifyPayload.text), [
    { verifyType: 'llm', description: '应说明退款流程' },
    { verifyType: 'similarity', value: '已为您登记', threshold: 0.75 },
    { verifyType: 'equal', value: '好的' },
  ]);
  for (const a of assertions) assert.deepEqual(a.actionContent, { type: 'send-text-message', payload: { text: a.verifyPayload.text } });
});

test('buildExpect：转人工只有 type；发事件按名字换 id、带 eventName，params 核对事件变量名', () => {
  const { assertions, errors } = buildExpect([{ handover: true }, { event: '发送4.0', params: { text: '应礼貌', urls: { similar: 'https://x', threshold: 0.9 } } }], { events });
  assert.deepEqual(errors, []);
  assert.deepEqual(assertions[0], { verifyPayload: { type: 'handover' }, actionContent: { type: 'handover' } });
  const params = { text: { verifyType: 'llm', description: '应礼貌', value: '' }, urls: { verifyType: 'similarity', value: 'https://x', threshold: 0.9 } };
  assert.deepEqual(assertions[1], {
    verifyPayload: { type: 'canvas-event-action', eventId: 'tev-send', params },
    actionContent: { type: 'canvas-event-action', payload: { eventId: 'tev-send', eventName: '发送4.0', params } },
  });
});

test('buildExpect：写错的都报出来（写法不认识、事件或变量不存在、raw 两份类型不一致、阈值越界）；取不到事件列表也算错', () => {
  const { errors } = buildExpect([{ handover: false }, { event: '没有的事件' }, { event: '发送4.0', params: { txet: '拼错' } }, { raw: { verifyPayload: { type: 'tag-user' }, actionContent: { type: 'handover' } } }, { reply: { similar: 'x', threshold: 2 } }, { expected: 'x' }], { events });
  assert.equal(errors.length, 6);
  assert.match(errors.join('\n'), /handover: true[\s\S]*没有的事件[\s\S]*txet[\s\S]*type 一样[\s\S]*0 到 1[\s\S]*认不出来/);
  assert.match(buildExpect({ event: '发送4.0' }, { events: null }).errors[0], /取不到事件列表/);
});

test('buildExpect：raw 原样保留（打标签这类 md 不生成的断言用它）', () => {
  const tag = { verifyPayload: { type: 'tag-user', tagOperation: 'add', tagIds: ['t1'] }, actionContent: { type: 'tag-user', payload: { operation: 'add', tags: [{ tagId: 't1', tagName: '意向' }], tagIds: ['t1'] } } };
  assert.deepEqual(buildExpect({ raw: [tag] }, { events }).assertions, [tag]);
});

const ctx = { events, vars: botVars[TARGET_BOT], scenarios: flattenTree(scenarioTreeFixture()) };
const row = (value, line = 1) => ({ line, value });
const llmReply = (description) => ({ verifyPayload: { type: 'send-text-message', text: { verifyType: 'llm', description } }, actionContent: { type: 'send-text-message', payload: { text: { verifyType: 'llm', description } } } });

test('buildCase：文本用例——text 进触发输入，history 进「消息历史」，vars 按名字换 id；name 去空格；_ 开头的字段不管', () => {
  const { testCase, errors, warnings } = buildCase(row({ name: ' 退款-01 ', text: '我想退款', history: ['之前问过价格'], vars: { 客户备注: '老客户', 已发优惠: true }, expect: '应说明退款流程', _row: 12 }), ctx);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(testCase, {
    name: '退款-01', triggerType: 'receive-text-message', triggerInputs: { text: '我想退款' },
    sessionMemoryCustomData: { 'tv-hist': [{ role: 'user', content: '之前问过价格' }], 'tv-note': '老客户', 'tv-flag': true },
    pluginMockOutputs: [], sqlDbMockOutputs: [], testNodeOutputAssertions: [],
    canvasActionOutputAssertions: [llmReply('应说明退款流程')],
    isStrictVerify: false,
  });
});

test('buildCase：图片用例推成 receive-image-message；写了 text 报错并说明文字要进 history', () => {
  const ok = buildCase(row({ name: '图-01', image: 'https://x/b.jpg', history: ['这张图是什么'] }), ctx);
  assert.deepEqual([ok.testCase.triggerType, ok.testCase.triggerInputs], ['receive-image-message', { imageUrl: 'https://x/b.jpg' }]);
  assert.match(buildCase(row({ name: '图-02', image: 'https://x/b.jpg', text: '这是什么' }), ctx).errors.join(), /history/);
});

test('buildCase：事件用例按名字换 eventId；data 的变量名要在事件里有、类型对得上', () => {
  const ok = buildCase(row({ name: '事件-01', event: '延时回复', data: { text: '课程怎么退' }, expect: { event: '发送4.0', params: { text: '应说明退课流程' } } }), ctx);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual([ok.testCase.triggerType, ok.testCase.triggerInputs], ['canvas-event-trigger', { eventId: 'tev-delay', data: { text: '课程怎么退' } }]);
  assert.match(buildCase(row({ name: '事件-02', event: '延时回复', data: { txt: 'x' } }), ctx).errors.join(), /没有变量「txt」/);
  assert.match(buildCase(row({ name: '事件-03', event: '延时回复', data: { text: 1 } }), ctx).errors.join(), /要字符串/);
});

test('buildCase：input 要和 trigger 一起写、不能和简写混用；没有简写的触发只能用 input；不认识的字段报错', () => {
  assert.deepEqual(buildCase(row({ name: 'i-1', trigger: 'receive-other-message', input: { rawContent: 'x' } }), ctx).errors, []);
  assert.match(buildCase(row({ name: 'i-2', input: { text: 'x' } }), ctx).errors.join(), /要写 trigger/);
  assert.match(buildCase(row({ name: 'i-3', trigger: 'receive-text-message', input: { text: 'x' }, text: 'y' }), ctx).errors.join(), /不能和 text 一起写/);
  assert.match(buildCase(row({ name: 'i-4', trigger: 'new-friend' }), ctx).errors.join(), /没有简写/);
  assert.match(buildCase(row({ name: 'i-5', trigger: 'x-invalid', input: {} }), ctx).errors.join(), /不是秒懂的触发类型/);
  assert.match(buildCase(row({ name: 'i-6', text: 'x', expected: 'y' }), ctx).errors.join(), /不认识的字段：expected/);
});

test('buildCase：会话变量不存在、类型不对、和 history 重复都报错；取不到列表时用到了才报错', () => {
  const errs = buildCase(row({ name: 'v-1', text: 'x', vars: { 不存在: 1, 已发优惠: 'true', 消息历史: [] }, history: [] }), ctx).errors.join('\n');
  assert.match(errs, /不存在」在这个智能体里没有/);
  assert.match(errs, /已发优惠」要布尔值/);
  assert.match(errs, /写了两遍/);
  assert.match(buildCase(row({ name: 'v-2', text: 'x', history: ['a'] }), { ...ctx, vars: null }).errors.join(), /取不到会话变量列表/);
  assert.deepEqual(buildCase(row({ name: 'v-3', text: 'x' }), { ...ctx, vars: null, events: null }).errors, []);
});

test('buildCase：场景按名字或路径找；同名要写路径；这个区没有场景树时只提醒', () => {
  assert.equal(buildCase(row({ name: 's-1', text: 'x', scenario: '退款' }), ctx).scenarioNodeId, 'sn-refund');
  assert.equal(buildCase(row({ name: 's-2', text: 'x', scenario: '咨询/课程' }), ctx).scenarioNodeId, 'sn-consult-course');
  assert.match(buildCase(row({ name: 's-3', text: 'x', scenario: '课程' }), ctx).errors.join(), /2 个同名.*写完整路径/);
  assert.match(buildCase(row({ name: 's-4', text: 'x', scenario: '不存在' }), ctx).errors.join(), /没有场景「不存在」/);
  const old = buildCase(row({ name: 's-5', text: 'x', expect: 'y', scenario: '退款' }), { ...ctx, scenarios: null });
  assert.deepEqual([old.errors, old.scenarioNodeId, old.warnings], [[], null, ['这个区没有场景树，scenario 不挂']]);
});

test('buildCases：name 在文件里重复、和集里已有的重复都报出来（带行号）；没写 expect 只提醒', () => {
  const { built, errors } = buildCases([row({ name: 'a', text: 'x' }, 1), row({ name: 'a', text: 'y', expect: 'z' }, 2), row({ name: '旧的', text: 'z', expect: 'z' }, 3)], ctx, { existingNames: ['旧的'] });
  assert.deepEqual(errors.map((e) => [e.line, e.reason]), [[1, 'name「a」在第 1、2 行重复'], [2, 'name「a」在第 1、2 行重复'], [3, 'name「旧的」集里已经有了']]);
  assert.deepEqual(built[0].warnings, ['没写 expect：没有断言，跑了只能看实际回复']);
});
