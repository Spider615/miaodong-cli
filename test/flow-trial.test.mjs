import test from 'node:test';
import assert from 'node:assert/strict';
import { U, edge, node } from './helpers/fixtures.mjs';
import {
  assertRunnable, buildEventData, buildSessionData, describeActions, entryNodes, eventSchedules, flowCostOf, flowPreflight,
  actionLines, followCommand, graphFingerprint, matchSession, paidProfile, reachableNodes, resolveEvent, scheduleLabel, typedValue,
} from '../src/flow-trial.mjs';

const text = (n) => node(n, { name: '收到文本', type: 'receive-text-message', category: 'trigger' });
const llm = (n, payload = {}) => node(n, { name: `模型${n}`, payload: { modelType: 'doubao', ...payload } });
const act = (n, type, payload = {}) => node(n, { name: `动作${n}`, type, category: 'action', payload });
const entry = (n, eventId) => ({ ...node(n, { name: `入口${n}`, type: 'canvas-event-trigger', category: 'trigger', payload: { eventId } }), shape: eventId });
const plugin = (n) => node(n, { name: '查用户', type: 'plugin-calculation' });
const ids = (cells) => cells.map((c) => c.id).sort();

test('reachableNodes：沿连线和事件跳转走；走不到的不算', () => {
  const canvas = [text(1), llm(2), act(3, 'send-text-message'), act(4, 'canvas-event-action', { eventId: 'ev-a' }), entry(5, 'ev-a'), act(6, 'update-data'), plugin(7),
    edge(101, 1, 2), edge(102, 2, 3), edge(103, 2, 4), edge(104, 5, 6)];
  assert.deepEqual(ids(reachableNodes(canvas, [U(1)])), [U(1), U(2), U(3), U(4), U(5), U(6)].sort());
});

test('reachableNodes：隔两跳事件才走到插件，也算进来', () => {
  const canvas = [text(1), act(2, 'canvas-event-action', { eventId: 'ev-a' }), entry(3, 'ev-a'), act(4, 'canvas-event-action', { eventId: 'ev-b' }), entry(5, 'ev-b'), plugin(6),
    edge(101, 1, 2), edge(102, 3, 4), edge(103, 5, 6)];
  assert.deepEqual(flowPreflight(reachableNodes(canvas, [U(1)])).plugins.map((p) => p.id), [U(6)]);
});

test('reachableNodes：循环体里的子节点（parent / parentLoopBodyNodeId / children）也算', () => {
  const inner = llm(4);
  const canvas = [
    text(1), node(2, { name: '循环', type: 'loop' }), { ...plugin(3), parent: U(2) },
    { ...inner, data: { ...inner.data, parentLoopBodyNodeId: U(2) } },
    { ...node(5, { name: '容器', type: 'loop' }), children: [U(6)] }, plugin(6),
    edge(101, 1, 2), edge(102, 2, 5),
  ];
  assert.deepEqual(ids(reachableNodes(canvas, [U(1)])), [U(1), U(2), U(3), U(4), U(5), U(6)].sort());
});

test('entryNodes：--text 是所有「收到文本」；--event 是这个事件的所有入口', () => {
  const canvas = [text(1), text(2), entry(3, 'ev-a'), entry(4, 'ev-b'), entry(5, 'ev-a')];
  assert.deepEqual(ids(entryNodes(canvas, { kind: 'text' })), [U(1), U(2)]);
  assert.deepEqual(ids(entryNodes(canvas, { kind: 'event', eventId: 'ev-a' })), [U(3), U(5)]);
});

test('两个「收到文本」入口，只有一个能走到插件：整体也拒跑', () => {
  const canvas = [text(1), text(2), llm(3), plugin(4), edge(101, 1, 3), edge(102, 2, 4)];
  const pre = flowPreflight(reachableNodes(canvas, entryNodes(canvas, { kind: 'text' }).map((c) => c.id)));
  assert.throws(() => assertRunnable(pre), (e) => e.code === 'trial_flow_plugin' && e.exitCode === 5 && /查用户/.test(e.message) && /测试中心/.test(e.hint));
});

test('flowPreflight：插件（含插件动作、挂外部工具的大模型）、不认识的类型、动作计数', () => {
  const cells = [text(1), llm(2), llm(3, { tools: [{ type: 'query_kb' }] }), llm(4, { tools: [{ type: 'plugin', name: '写多维表' }] }), act(5, 'plugin-action'),
    act(6, 'send-text-message'), act(7, 'send-text-message'), act(8, 'handover'), node(9, { type: 'ai-sop', category: 'action' }), node(10, { type: 'rule-center' })];
  const pre = flowPreflight(cells);
  assert.deepEqual(pre.plugins.map((p) => p.id), [U(4), U(5)]);
  assert.deepEqual(pre.plugins[0].calls, ['写多维表']);
  assert.deepEqual(pre.unknown.map((p) => p.type), ['ai-sop']);
  assert.equal(describeActions(pre.actions), '发文本 2、转人工 1');
});

test('assertRunnable：没有插件和不认识的类型才放行；不认识的类型拒跑并列出类型', () => {
  assert.doesNotThrow(() => assertRunnable(flowPreflight([text(1), llm(2), act(3, 'smart-tag')])));
  assert.throws(() => assertRunnable(flowPreflight([text(1), node(2, { type: 'loop' })])), (e) => e.code === 'trial_flow_unknown' && e.exitCode === 5 && /loop/.test(e.message));
});

test('typedValue：文字原样；数字、布尔按字面；其它按 JSON；转不了报用法错误', () => {
  assert.equal(typedValue('0', 'string', 'x'), '0');
  assert.equal(typedValue('2026-09-29 10:00', 'datetime', 'x'), '2026-09-29 10:00');
  assert.equal(typedValue('12.5', 'number', 'x'), 12.5);
  assert.equal(typedValue('false', 'boolean', 'x'), false);
  assert.deepEqual(typedValue('["a"]', 'array', 'x'), ['a']);
  for (const [raw, type] of [['abc', 'number'], ['', 'number'], ['yes', 'boolean'], ['[a', 'array']]) {
    assert.throws(() => typedValue(raw, type, '变量'), (e) => e.exitCode === 2, `${type} ${raw}`);
  }
});

const SESSIONS = [
  { id: 'v-stage', name: '客户阶段', isDefault: false, type: { type: 'string' } },
  { id: 'v-vip', name: '是否会员', isDefault: false, type: { type: 'boolean' } },
  { id: 'v-src', name: '最后一条消息来源', isDefault: true, type: { type: 'string' } },
  { id: 'v-d1', name: '重名', isDefault: false, type: { type: 'string' } },
  { id: 'v-d2', name: '重名', isDefault: false, type: { type: 'string' } },
];

test('buildSessionData：自定义变量按 id 写、按类型转；内置、找不到、重名、给两次、没写等号都拒绝', () => {
  assert.deepEqual(buildSessionData(['客户阶段=已报名', '是否会员=true'], SESSIONS), { 'v-stage': '已报名', 'v-vip': true });
  assert.throws(() => buildSessionData(['最后一条消息来源=PHONE'], SESSIONS), (e) => e.exitCode === 2 && /内置/.test(e.message) && /--session/.test(e.hint));
  assert.throws(() => buildSessionData(['不存在=1'], SESSIONS), (e) => e.exitCode === 2 && /没有叫「不存在」/.test(e.message));
  assert.throws(() => buildSessionData(['重名=1'], SESSIONS), (e) => e.exitCode === 2 && /2 个/.test(e.message));
  assert.throws(() => buildSessionData(['客户阶段=a', '客户阶段=b'], SESSIONS), (e) => e.exitCode === 2 && /两次/.test(e.message));
  assert.throws(() => buildSessionData(['客户阶段'], SESSIONS), (e) => e.exitCode === 2 && /名=值/.test(e.message));
});

const EVENT = { eventId: 'ev-delay-0001', name: '延时回复', variables: [{ name: 'text', type: 'string' }, { name: 'count', type: { type: 'number' } }] };

test('buildEventData：按事件声明的变量写、按类型转；多给的、缺的（空字符串也算缺）都不跑', () => {
  assert.deepEqual(buildEventData(['text=你好', 'count=3'], EVENT), { text: '你好', count: 3 });
  assert.throws(() => buildEventData(['text=你好', 'count=3', 'extra=1'], EVENT), (e) => e.exitCode === 2 && /没有变量「extra」/.test(e.message));
  assert.throws(() => buildEventData(['text=你好'], EVENT), (e) => e.exitCode === 2 && /缺 count/.test(e.message));
  assert.throws(() => buildEventData(['text=', 'count=1'], EVENT), (e) => e.exitCode === 2 && /缺 text/.test(e.message));
});

test('resolveEvent：id > id 前缀（至少 8 位）> 名字；找不到、重名都报出来', () => {
  const events = [EVENT, { eventId: 'ev-other-0002', name: '发送' }, { eventId: 'ev-dup-1', name: '重名' }, { eventId: 'ev-dup-2', name: '重名' }];
  assert.equal(resolveEvent(events, '延时回复').eventId, 'ev-delay-0001');
  assert.equal(resolveEvent(events, 'ev-delay').eventId, 'ev-delay-0001');
  assert.throws(() => resolveEvent(events, '没有'), (e) => e.code === 'event_not_found' && e.exitCode === 4);
  assert.throws(() => resolveEvent(events, '重名'), (e) => e.code === 'event_ambiguous' && e.exitCode === 4);
});

test('flowCostOf：有 totalCostInCny 用它；用了 token 却报 0、超时算不知道；没有字段看跑过的节点', () => {
  const free = [{ type: 'receive-text-message', category: 'trigger' }, { type: 'rule-center' }, { type: 'send-text-message' }];
  const paid = [...free, { type: 'llm-completion' }];
  assert.equal(flowCostOf({ totalCostInCny: 0.05, tokenCount: { m: {} } }, paid, false), 0.05);
  assert.equal(flowCostOf({ totalCostInCny: 0, tokenCount: {} }, free, false), 0);
  assert.equal(flowCostOf({ totalCostInCny: 0, tokenCount: { doubao: { prompt: 10 } } }, paid, false), null);
  assert.equal(flowCostOf({ totalCostInCny: 0.05 }, paid, true), null);
  assert.equal(flowCostOf({}, free, false), 0);
  assert.equal(flowCostOf({}, paid, false), null);
  assert.equal(flowCostOf({}, [{ type: 'smart-tag' }], false), null);
});

test('matchSession：只认本机记着的、这个智能体的试跑会话；前缀至少 8 位、要唯一', () => {
  const records = [{ botId: 'b1', sessionId: 'aaaaaaaa-1111' }, { botId: 'b1', sessionId: 'aaaaaaaa-2222' }, { botId: 'b1', sessionId: 'cccccccc-3333' }, { botId: 'b2', sessionId: 'dddddddd-4444' }];
  assert.equal(matchSession(records, 'cccccccc', 'b1'), 'cccccccc-3333');
  assert.equal(matchSession(records, 'aaaaaaaa-2222', 'b1'), 'aaaaaaaa-2222');
  assert.throws(() => matchSession(records, 'cccc', 'b1'), (e) => e.exitCode === 2 && /8 位/.test(e.message));
  assert.throws(() => matchSession(records, 'aaaaaaaa', 'b1'), (e) => e.exitCode === 2 && /2 个/.test(e.message));
  assert.throws(() => matchSession(records, 'dddddddd', 'b1'), (e) => e.code === 'trial_session_unknown');
  assert.throws(() => matchSession(records, '0f3c9a1e-5b2d-4c7e-9a8b-1234567890ab', 'b1'), (e) => e.code === 'trial_session_unknown' && /真实客户/.test(e.hint));
});

test('eventSchedules / scheduleLabel / followCommand：延时写进说明；接着跑的命令带会话和事件参数，太长的截断', () => {
  const canvas = [act(1, 'canvas-event-action', { eventId: 'ev-a', triggerType: 'SCHEDULE', delaySeconds: 10 }), act(2, 'canvas-event-action', { eventId: 'ev-b', triggerType: 'INSTANT' })];
  const schedules = eventSchedules(canvas);
  assert.deepEqual(schedules.get('ev-a'), { mode: 'SCHEDULE', delaySeconds: 10 });
  assert.equal(scheduleLabel(schedules.get('ev-a')), '（延时 10 秒）');
  assert.equal(scheduleLabel(schedules.get('ev-b')), '');
  const short = followCommand({ eventId: 'ev-a', eventName: '延时回复', params: { text: "我想'退款'", n: 2 } }, { bot: '147bd600', session: 'sess-1234' });
  assert.equal(short.command, `md trial --event ev-a --bot 147bd600 --session sess-1234 --data 'text=我想'\\''退款'\\''' --data n=2`);
  assert.equal(short.clipped, false);
  const long = followCommand({ eventId: 'ev-a', eventName: '', params: { text: 'x'.repeat(300) } }, { bot: 'b', session: 's' });
  assert.equal(long.clipped, true);
  assert.match(long.command, /--event ev-a /);
  assert.ok(long.command.length < 300);
});


test('reachableNodes：打标签会触发「标签变化」触发器、改自定义属性会触发「自定义属性变化」触发器，这两条连锁也算（保守，审查 I4）', () => {
  const canvas = [text(1), act(2, 'tag-user'), node(3, { name: '标签变化', type: 'tag-event', category: 'trigger' }), plugin(4),
    act(5, 'update-custom-attr'), node(6, { name: '属性变化', type: 'custom-attr-event', category: 'trigger' }), llm(7),
    edge(101, 1, 2), edge(102, 3, 4), edge(103, 1, 5), edge(104, 6, 7)];
  const reached = reachableNodes(canvas, [U(1)]).map((c) => c.id);
  assert.ok(reached.includes(U(4)) && reached.includes(U(7)), reached.join(','));
  assert.throws(() => assertRunnable(flowPreflight(reachableNodes(canvas, [U(1)]))), (e) => e.code === 'trial_flow_plugin');
});

test('flowPreflight：不管什么类型，挂了知识库以外工具的都算插件（审查 M5）', () => {
  const pre = flowPreflight([node(2, { name: '搜一搜', type: 'chat-search', payload: { tools: [{ type: 'query_kb' }, { type: 'plugin', name: '查订单' }] } })]);
  assert.deepEqual(pre.plugins.map((p) => p.calls), [['查订单']]);
});

test('paidProfile：要花钱的节点按类型和模型记成一个指纹（顺序无关），并数一数有几个', () => {
  const a = paidProfile([text(1), llm(2, { modelType: 'doubao' }), node(3, { type: 'rule-center' }), act(4, 'send-text-message'), llm(5, { modelType: 'gemini' })]);
  const b = paidProfile([llm(5, { modelType: 'gemini' }), llm(2, { modelType: 'doubao' })]);
  assert.equal(a.key, b.key);
  assert.equal(a.count, 2);
  assert.notEqual(a.key, paidProfile([llm(2, { modelType: 'doubao' })]).key);
  assert.deepEqual(paidProfile([text(1), act(2, 'send-text-message'), act(3, 'update-data')]), { key: '', count: 0 });
});

test('graphFingerprint：能走到的节点内容、连线变了就变；只挪位置不变', () => {
  const canvas = [text(1), llm(2), act(3, 'send-text-message'), edge(101, 1, 2), edge(102, 2, 3)];
  const fp = (c) => graphFingerprint(c, reachableNodes(c, [U(1)]));
  const base = fp(canvas);
  assert.equal(fp(canvas.map((c) => (c.id === U(2) ? { ...c, position: { x: 999, y: 999 } } : c))), base);
  assert.notEqual(fp(canvas.map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '改了' } } } : c))), base);
  assert.notEqual(fp([...canvas, plugin(4), edge(103, 3, 4)]), base);
});

test('followCommand：给了事件声明的变量表，就只带这些变量（平台会往参数里加字段）；缺了的列出来（审查 M3）', () => {
  const r = followCommand({ eventId: 'ev-a', eventName: '延时回复', params: { text: '你好', userLastMsgId: 'm-1', empty: '' } }, { bot: 'b', session: 's', variables: ['text', 'count', 'empty'] });
  assert.equal(r.command, "md trial --event ev-a --bot b --session s --data 'text=你好'");
  assert.deepEqual(r.missing, ['count', 'empty']);
});

test('actionLines：发图片、语音、素材也算回复；什么都没发才说没有；其它动作单列（审查 M4）', () => {
  assert.deepEqual(actionLines([{ type: 'send-image-message', payload: {} }]), { reply: '发图片', others: '' });
  assert.deepEqual(actionLines([{ type: 'send-text-message', payload: { text: '你好' } }, { type: 'handover', payload: {} }, { type: 'update-data', payload: { operations: [{}] } }]),
    { reply: '发文本「你好」；转人工', others: '写 1 个字段' });
  assert.deepEqual(actionLines([{ type: 'canvas-event-action', payload: { eventId: 'e' } }]), { reply: '', others: '' });
});
