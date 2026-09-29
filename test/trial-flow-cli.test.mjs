import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity, seedWorkspace } from './helpers/seed.mjs';
import { FLOW_BOT, FX, flowDraft, startFlowServer } from './helpers/flow-server.mjs';
import { U, edge, node } from './helpers/fixtures.mjs';

let fake;
before(async () => { fake = await startFlowServer(); });
after(() => fake.server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '测试企业' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const BOT = ['--bot', 'f10b0000'];
const posts = () => fake.state.posts;
const sessionOf = (stdout) => stdout.match(/会话 ([0-9a-f]{8})/)?.[1];
const codeIn = (stdout) => stdout.match(/确认码：([0-9a-f]{8})/)?.[1];
const spends = (h) => {
  const file = join(h, 'md', 'spend.jsonl');
  if (!existsSync(file)) return [];
  const byId = new Map();
  for (const line of readFileSync(file, 'utf-8').trim().split('\n')) { const row = JSON.parse(line); byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row }); }
  return [...byId.values()];
};
const limits = (h, spend) => { mkdirSync(join(h, 'md'), { recursive: true }); writeFileSync(join(h, 'md', 'config.json'), JSON.stringify({ spend })); };

test('--text：请求体、按执行顺序的路径、回复、事件那头接着跑的命令；记账；结果落盘；md exec 不联网能看；md spend 认得', async () => {
  fake.reset();
  const h = home();
  const r = await md(['trial', '--text', '我想退款', ...BOT], h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts().length, 1);
  const body = posts()[0];
  assert.deepEqual([body.canvasId, body.triggerType, body.receiveTextMessage, body.sessionMemoryData], ['main-1', 'receive-text-message', { text: '我想退款', customAttrs: [] }, undefined]);
  assert.match(body.sessionId, /^[0-9a-f-]{36}$/);
  assert.match(r.stdout, /整条试跑：收到文本「我想退款」 × 1/);
  assert.match(r.stdout, /能走到 7 个节点（含事件那头），没有插件；会执行的动作：发文本 1、发事件 1、写会话变量 1/);
  assert.match(r.stdout, /#1 ✅ success 3\.2s ¥0\.012 · 执行 f0000001-0000-4000-8000-000000000000/);
  const order = ['收到文本', '回答生成 \\[llm-completion · doubao\\]', '规则中心 \\[rule-center\\] → 分支「退款」', '发送文本', '触发延时回复'];
  assert.match(r.stdout, new RegExp(order.join('[\\s\\S]*')));
  assert.match(r.stdout, /回复：发文本「回复：我想退款」/);
  assert.match(r.stdout, /发出事件「延时回复」（延时 10 秒）/);
  assert.match(r.stdout, /这次试跑没有接着跑事件那头/);
  const sid = sessionOf(r.stdout);
  assert.ok(body.sessionId.startsWith(sid));
  assert.ok(r.stdout.includes(`md trial --event '延时回复' --bot f10b0000 --session ${sid} --data 'text=我想退款'`), r.stdout);
  const [row] = spends(h);
  assert.deepEqual([row.kind, row.entry, row.actual, row.approved], ['flow', 'text', 0.0123, 'auto']);
  const dir = r.stdout.match(/结果存在 (\S+)（/)[1];
  assert.deepEqual(readdirSync(dir), ['run-1.json']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'run-1.json'), 'utf-8')).execId, FX(1));
  const seen = fake.server.requests.length;
  const ex = await md(['exec', FX(1)], h);
  assert.equal(ex.code, 0, ex.stderr);
  assert.match(ex.stdout, /测试执行/);
  assert.equal(fake.server.requests.length, seen);
  const sp = await md(['spend'], h);
  assert.match(sp.stdout, /整条试跑 测试区/);
});

test('从文本进来，隔一跳事件能走到插件：拒跑（退出码 5），一个 POST 都不发，提示走测试中心', async () => {
  fake.reset({ canvas: [...flowDraft(), node(10, { name: '触发查用户', type: 'canvas-event-action', category: 'action', payload: { eventId: 'ev-plugin-002' } }), edge(107, 3, 10)] });
  const r = await md(['trial', '--text', '你好', ...BOT]);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /兴趣岛用户详情/);
  assert.match(r.stderr, /测试中心/);
  assert.equal(posts().length, 0);
});

test('--event 的入口能走到插件：拒跑，不发请求', async () => {
  fake.reset();
  const r = await md(['trial', '--event', '查用户', '--data', 'uid=u1', ...BOT]);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /兴趣岛用户详情/);
  assert.equal(posts().length, 0);
});

test('能走到 md 不认识的节点类型：拒跑，不发请求', async () => {
  fake.reset({ canvas: [...flowDraft(), node(10, { name: 'AI SOP', type: 'ai-sop', category: 'action' }), edge(107, 4, 10)] });
  const r = await md(['trial', '--text', '你好', ...BOT]);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /不认识的节点类型（ai-sop）/);
  assert.equal(posts().length, 0);
});

test('--event：按名字找；请求体是 canvasEvent；缺变量、多给变量、草稿没入口都不发请求', async () => {
  fake.reset();
  const r = await md(['trial', '--event', '延时回复', '--data', 'text=我想退款', ...BOT]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([posts()[0].triggerType, posts()[0].canvasEvent], ['canvas-event-trigger', { eventId: 'ev-delay-0001', data: { text: '我想退款' } }]);
  assert.match(r.stdout, /整条试跑：事件「延时回复」 × 1/);
  assert.match(r.stdout, /其它动作：写 1 个字段/);
  fake.reset();
  for (const args of [['--event', '延时回复'], ['--event', '延时回复', '--data', 'text=a', '--data', 'x=1']]) {
    const bad = await md(['trial', ...args, ...BOT]);
    assert.equal(bad.code, 2, bad.stderr);
  }
  fake.reset({ canvas: flowDraft().filter((c) => c.id !== U(6)) });
  const noEntry = await md(['trial', '--event', '延时回复', '--data', 'text=a', ...BOT]);
  assert.equal(noEntry.code, 4);
  assert.match(noEntry.stderr, /没有事件「延时回复」的入口/);
  assert.equal(posts().length, 0);
});

test('--var：自定义变量写进 sessionMemoryData；内置变量、找不到的名字拒绝，不发请求', async () => {
  fake.reset();
  const r = await md(['trial', '--text', '你好', '--var', '客户阶段=已报名', ...BOT]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(posts()[0].sessionMemoryData, { 'v-stage': '已报名' });
  fake.reset();
  const builtin = await md(['trial', '--text', '你好', '--var', '最后一条消息来源=PHONE', ...BOT]);
  assert.equal(builtin.code, 2);
  assert.match(builtin.stderr, /内置/);
  const missing = await md(['trial', '--text', '你好', '--var', '不存在=1', ...BOT]);
  assert.equal(missing.code, 2);
  assert.equal(posts().length, 0);
});

test('--session：接着聊时请求里是同一个 sessionId；真实客户的会话 id 拒绝；和 --times 2 不能一起用', async () => {
  fake.reset();
  const h = home();
  const first = await md(['trial', '--text', '第一句', ...BOT], h);
  const sid = sessionOf(first.stdout);
  const second = await md(['trial', '--text', '第二句', ...BOT, '--session', sid], h);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(posts()[1].sessionId, posts()[0].sessionId);
  assert.match(second.stdout, /接着聊/);
  const real = await md(['trial', '--text', '你好', ...BOT, '--session', '0f3c9a1e-5b2d-4c7e-9a8b-1234567890ab'], h);
  assert.equal(real.code, 2);
  assert.match(real.stderr, /不是 md 在这个智能体上开过的试跑会话/);
  const both = await md(['trial', '--text', '你好', ...BOT, '--session', sid, '--times', '2'], h);
  assert.equal(both.code, 2);
  assert.equal(posts().length, 2);
});

test('参数：--text 和 --event 只能给一个；不能再给节点；单节点参数、--allow-plugin 报错；--text 0 被吃成开关要说清楚', async () => {
  fake.reset();
  const cases = [
    [['trial', '--text', 'a', '--event', '延时回复'], /只能给一个/],
    [['trial', '回答生成', '--text', 'a'], /不用给节点/],
    [['trial', '--text', 'a', '--from-exec', FX(9)], /只用于单节点试跑/],
    [['trial', '--text', 'a', '--allow-plugin'], /没法 mock 插件/],
    [['trial', '--text', '0'], /被当成了开关/],
    [['trial', '--text', 'a', '--data', 'text=1'], /--data 只用于 --event/],
  ];
  for (const [args, re] of cases) {
    const r = await md([...args, ...BOT]);
    assert.equal(r.code, 2, `${args.join(' ')}\n${r.stderr}`);
    assert.match(r.stderr, re);
  }
  assert.equal(posts().length, 0);
});

test('花费：估不出先跑 1 次；按上次同入口的实际单价超单次门槛就给确认码、不跑；带对的码才跑', async () => {
  fake.reset({ cost: 0.3 });
  const h = home();
  const first = await md(['trial', '--text', 'a', ...BOT], h);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /估不出，先跑 1 次看实际/);
  limits(h, { perCommand: 0.5, perDay: 10 });
  fake.reset({ cost: 0.3 });
  const blocked = await md(['trial', '--text', 'a', ...BOT, '--times', '2'], h);
  assert.equal(blocked.code, 5);
  const code = codeIn(blocked.stdout);
  assert.ok(code, blocked.stdout);
  assert.equal(posts().length, 0);
  const done = await md(['trial', '--text', 'a', ...BOT, '--times', '2', '--confirm', code], h);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(posts().length, 2);
  assert.equal(spends(h).at(-1).approved, 'confirm');
});

test('花费不知道：用了 token 却报 ¥0，按保守价记账', async () => {
  fake.reset({ cost: 0 });
  const h = home();
  const r = await md(['trial', '--text', 'a', ...BOT], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /#1 ✅ success 3\.2s 花费不知道/);
  const [row] = spends(h);
  assert.equal(row.unknownRuns, 1);
  assert.ok(row.assumed > 0);
});

test('启动结果不明（5xx）：只发一次、退出码非 0、账本记一次花费不知道', async () => {
  fake.reset({ startStatus: 502 });
  const h = home();
  const r = await md(['trial', '--text', 'a', ...BOT], h);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /有没有启动不确定/);
  assert.equal(posts().length, 1);
  assert.equal(spends(h)[0].unknownRuns, 1);
});

test('取完整详情失败（5xx）：照样用轮询结果打出路径和回复，不重发', async () => {
  fake.reset({ detailsStatus: 500 });
  const r = await md(['trial', '--text', '我想退款', ...BOT]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /回答生成 \[llm-completion · doubao\]/);
  assert.match(r.stdout, /回复：发文本「回复：我想退款」/);
  assert.equal(posts().length, 1);
});

test('事件那头：同会话后面有执行就列出来，不再给接着跑的命令', async () => {
  fake.reset({ later: [{ execId: 'later-exec-0001', createdAt: new Date(Date.now() + 60_000).toISOString(), status: 'success', outputActions: [{ type: 'send-text-message', payload: { text: '稍后回复' } }] }] });
  const r = await md(['trial', '--text', '我想退款', ...BOT]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /同一会话后面还有 1 次执行/);
  assert.match(r.stdout, /later-exec-0001 success · 发文本「稍后回复」/);
  assert.doesNotMatch(r.stdout, /md trial --event/);
});

test('--times 2：每次新开会话；路径一样的第二次不再逐个列节点', async () => {
  fake.reset();
  const r = await md(['trial', '--text', 'a', ...BOT, '--times', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.notEqual(posts()[0].sessionId, posts()[1].sessionId);
  assert.match(r.stdout, /路径同 #1/);
});

test('本地工作副本改了能走到的节点还没推：提醒跑的是草稿上的旧版本', async () => {
  fake.reset();
  const h = home();
  const dir = await seedWorkspace(h, { canvas: flowDraft(), meta: { botId: FLOW_BOT, botName: '整条试跑测试机' } });
  const changed = flowDraft().map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '改过了' } } } : c));
  writeFileSync(join(dir, 'after.json'), JSON.stringify({ canvas: changed, sessions: [], events: [] }));
  const r = await md(['trial', '--text', 'a', ...BOT], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /本地改了 1 个能走到的节点还没推/);
});

test('能走到的节点都不花钱（09-29 实测这种链路花费是 0）：预估 ¥0，今天已经超了每日上限也不用确认；有大模型的照旧要确认', async () => {
  fake.reset({ cost: 0.3 });
  const h = home();
  limits(h, { perCommand: 2, perDay: 0.01 });
  const first = await md(['trial', '--text', 'a', ...BOT], h);
  assert.equal(first.code, 0, first.stderr);
  const free = await md(['trial', '--event', '延时回复', '--data', 'text=a', ...BOT], h);
  assert.equal(free.code, 0, free.stdout + free.stderr);
  assert.match(free.stdout, /预计 ¥0（能走到的节点都不花钱） · 今天已花 ¥0\.30/);
  assert.equal(posts().length, 2);
  const paid = await md(['trial', '--text', 'a', ...BOT], h);
  assert.equal(paid.code, 5);
  assert.match(paid.stdout, /超过每日上限/);
  assert.equal(posts().length, 2);
});
