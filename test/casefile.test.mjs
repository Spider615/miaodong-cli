import test from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGER_TYPES, buildExpect, historyValue, parseCaseLines } from '../src/casefile.mjs';
import { TARGET_BOT, botEvents } from './helpers/testcenter-fixtures.mjs';

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
