import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { ok } from './helpers/fake-miaodong.mjs';
import { EVENTS_BOT, eid, event, startEventsServer } from './helpers/events-server.mjs';

let fake;
before(async () => { fake = await startEventsServer(); });
after(() => fake.server.close());
function home(key = 'k1') {
  const h = tempHome();
  seedIdentity(h, { key, label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '测试企业' }], currentOrgId: 'org-1' });
  return h;
}
const BOT = ['--bot', '测试智能体'];
const md = (args, h = home()) => runCli(['events', ...args, ...BOT], { home: h });
const codeOf = (r) => r.stdout.match(/计划码：([0-9a-f]{8})/)?.[1];
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const file = (h, name, value) => { const p = join(h, name); writeFileSync(p, JSON.stringify(value)); return p; };
const confirm = (args, dry, h) => md([...args, '--confirm', codeOf(dry)], h);

test('事件列表包含隐藏事件，可导出完整定义；详情和引用检查只读', async () => {
  fake.reset();
  const h = home();
  const output = join(h, 'events.json');
  const list = await md(['--out', output], h);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /跟进/);
  assert.match(list.stdout, /隐藏的事件/);
  assert.deepEqual(json(output).events, fake.state.events);
  assert.equal(fake.server.requests.at(-1).query.eventListFilter, 'all');
  const get = await md(['get', eid(1).slice(0, 8), '--out', join(h, 'one.json')], h);
  assert.equal(get.code, 0, get.stderr);
  assert.deepEqual(json(join(h, 'one.json')), event(1, '跟进'));
  const used = await md(['used', '跟进'], h);
  assert.equal(used.code, 0, used.stderr);
  assert.match(used.stdout, /服务端.*未被引用/);
  assert.deepEqual(fake.state.posts, []);
  const request = fake.server.requests.findLast((x) => x.path.endsWith('/event-used'));
  assert.deepEqual(request.query, { orgId: 'org-1', botId: EVENTS_BOT, eventId: eid(1) });
});

test('禁止所有事件删除入口：即使带确认码也在联网前拒绝', async () => {
  fake.reset();
  for (const op of ['rm', 'delete', 'drop', 'remove', 'del']) {
    const before = fake.server.requests.length;
    const result = await md([op, '跟进', '--confirm', '12345678']);
    assert.equal(result.code, 5, result.stderr);
    assert.match(result.stderr, /禁止删除事件/);
    assert.equal(fake.server.requests.length, before);
  }
});

test('新建事件先预演，确认后只发一次准确请求并回读，日志包含实际操作', async () => {
  fake.reset();
  const h = home();
  const args = ['add', '新事件', '--input', 'text=string', '--input', 'score=number'];
  const dry = await md(args, h);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /这是预演/);
  assert.deepEqual(fake.state.posts, []);
  const result = await confirm(args, dry, h);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fake.state.posts.length, 1);
  const request = fake.state.posts[0];
  assert.equal(request.path, '/api/canvas/event/create');
  assert.deepEqual(request.query, { orgId: 'org-1' });
  assert.deepEqual(request.body, {
    botId: EVENTS_BOT, name: '新事件', variables: [{ name: 'text', type: { type: 'string' } }, { name: 'score', type: { type: 'number' } }],
    triggerTimesType: 'unlimited', maxTriggerTimes: 0, effectiveDateType: 'always', effectiveDateConfig: [],
    effectiveTimeType: 'always', effectiveTimeConfig: [], triggerIntervalType: 'no_interval', triggerIntervalSeconds: 0,
  });
  assert.match(result.stdout, /读回核对过/);
  const log = await runCli(['log'], { home: h });
  assert.match(log.stdout, /事件 新增.*新事件/);
});

test('修改保留事件 id、未改字段和服务端元数据；写前备份，不能删除重建', async () => {
  fake.reset();
  fake.state.events[0].triggerTimesType = 'limited';
  fake.state.events[0].maxTriggerTimes = 3;
  const h = home();
  const old = structuredClone(fake.state.events[0]);
  const args = ['edit', '跟进', '--name', '跟进课程'];
  const dry = await md(args, h);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(fake.state.posts, []);
  const result = await confirm(args, dry, h);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fake.state.posts.map((x) => x.path), ['/api/canvas/event/update']);
  assert.deepEqual(fake.state.posts[0].body, { ...old, name: '跟进课程' });
  assert.equal(fake.state.events.length, 2);
  const backup = result.stdout.match(/备份：([^\n]+)/)?.[1];
  assert.deepEqual(json(backup).events[0], old);
});

test('已引用事件禁止改名和更改已有输入，允许追加变量；草稿引用也受保护', async () => {
  fake.reset({ used: true });
  for (const args of [['edit', '跟进', '--name', '换名字'], ['edit', '跟进', '--input', 'text=number']]) {
    const result = await md(args);
    assert.equal(result.code, 5, result.stderr);
  }
  const h = home();
  const args = ['edit', '跟进', '--input', 'text=string', '--input', 'answer=boolean'];
  const dry = await md(args, h);
  assert.equal(dry.code, 0, dry.stderr);
  const result = await confirm(args, dry, h);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fake.state.events[0].variables.length, 2);
  fake.reset({ draft: fake.draftUse() });
  const blocked = await md(['edit', '跟进', '--name', '草稿不可断']);
  assert.equal(blocked.code, 5, blocked.stderr);
  assert.deepEqual(fake.state.posts, []);
});

test('隐藏、显示都需要确认，设置目标状态且回读；不是不确定的翻转操作', async () => {
  fake.reset();
  const h = home();
  for (const [op, hidden] of [['hide', true], ['show', false]]) {
    const args = [op, '跟进'];
    const before = fake.state.posts.length;
    const dry = await md(args, h);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(fake.state.posts.length, before);
    const result = await confirm(args, dry, h);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.state.posts.at(-1).body, { eventId: eid(1), isHidden: hidden });
    assert.equal(fake.state.events[0].isHidden, hidden);
  }
  const noop = await md(['show', '跟进'], h);
  assert.equal(noop.code, 0, noop.stderr);
  assert.equal(fake.state.posts.length, 2);
});

test('导入校验整包后预演，确认后保存完整 ID 映射并核对每条，不改画布', async () => {
  fake.reset();
  const h = home();
  const source = [event(40, '源事件甲'), event(41, '源事件乙')];
  const input = file(h, 'import.json', { events: source });
  const output = join(h, 'map.json');
  const args = ['import', input, '--out', output];
  const dry = await md(args, h);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(fake.state.posts, []);
  const result = await confirm(args, dry, h);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fake.state.posts.map((x) => x.path), ['/api/canvas/event/import']);
  assert.equal(fake.state.posts[0].body.botId, EVENTS_BOT);
  const map = json(output).eventIdMap;
  assert.equal(Object.keys(map).length, 2);
  assert.equal(fake.state.events.find((x) => x.eventId === map[eid(40)]).name, '源事件甲');
  assert.equal(fake.state.events.find((x) => x.eventId === map[eid(41)]).name, '源事件乙');
  assert.match(result.stdout, /画布.*映射/);
});

test('坏定义、重名、重复输入、陌生字段、未知参数和非法导入在写前拦下', async () => {
  fake.reset();
  const h = home();
  const badConfig = file(h, 'config.json', { triggerTimesType: 'single' });
  const unknown = file(h, 'unknown.json', { operation: 'delete' });
  const badImport = file(h, 'bad.json', [event(40, '可以'), event(41, '错误', { variables: [{ name: 'a', type: { type: 'unknown' } }] })]);
  for (const args of [
    ['add', '跟进', '--input', 'text=string'], ['add', '新', '--input', 'a=string', '--input', 'a=number'],
    ['add', '新', '--input', 'a=unknown'], ['add', '新', '--input', 'a=string', '--config', badConfig],
    ['edit', '跟进', '--config', unknown], ['edit', '跟进', '--naem', '错字'], ['import', badImport],
  ]) {
    const result = await md(args, h);
    assert.notEqual(result.code, 0, JSON.stringify(args));
    assert.deepEqual(fake.state.posts, []);
  }
});

test('确认码绑定完整远端列表和身份；重排不失效，内容改变或换身份失效', async () => {
  fake.reset();
  const h = home();
  const args = ['hide', '跟进'];
  const dry = await md(args, h);
  const other = await confirm(args, dry, home('k2'));
  assert.equal(other.code, 5, other.stderr);
  fake.state.events[1].name = '被别人改过';
  const stale = await confirm(args, dry, h);
  assert.equal(stale.code, 5, stale.stderr);
  assert.deepEqual(fake.state.posts, []);
  const fresh = await md(args, h);
  fake.state.events.reverse();
  const reordered = await confirm(args, fresh, h);
  assert.equal(reordered.code, 0, reordered.stderr);
});

test('写入前再次读取，备份期间事件发生变化时不发送写请求', async () => {
  fake.reset();
  const h = home();
  const args = ['hide', '跟进'];
  const dry = await md(args, h);
  const route = fake.server.routes['GET /api/canvas/event/list'];
  let reads = 0;
  fake.server.routes['GET /api/canvas/event/list'] = () => {
    if (++reads === 2) fake.state.events[1].name = '临写前发生变化';
    return ok(fake.state.events);
  };
  try {
    const result = await confirm(args, dry, h);
    assert.equal(result.code, 5, result.stderr);
    assert.deepEqual(fake.state.posts, []);
  } finally { fake.server.routes['GET /api/canvas/event/list'] = route; }
});

test('同一事件隐藏再显示恢复原状态后，用过的确认码仍然不能再用', async () => {
  fake.reset();
  const h = home();
  const args = ['hide', '跟进'];
  const dry = await md(args, h);
  assert.equal((await confirm(args, dry, h)).code, 0);
  const show = await md(['show', '跟进'], h);
  assert.equal((await confirm(['show', '跟进'], show, h)).code, 0);
  const old = await confirm(args, dry, h);
  assert.equal(old.code, 5, old.stderr);
  assert.equal(fake.state.posts.length, 2);
});

test('回读不一致或导入映射不完整不能报告成功；不会补删或重试写入', async () => {
  fake.reset();
  const h = home();
  const args = ['hide', '跟进'];
  const dry = await md(args, h);
  const route = fake.server.routes['POST /api/canvas/event/toggle-visibility'];
  fake.server.routes['POST /api/canvas/event/toggle-visibility'] = (q) => { fake.state.posts.push(q); return ok(null); };
  try {
    const result = await confirm(args, dry, h);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout, /✅/);
    assert.equal(fake.state.posts.length, 1);
  } finally { fake.server.routes['POST /api/canvas/event/toggle-visibility'] = route; }
  fake.reset();
  const input = file(h, 'source.json', [event(40, '导入甲'), event(41, '导入乙')]);
  const importArgs = ['import', input];
  const preview = await md(importArgs, h);
  const importRoute = fake.server.routes['POST /api/canvas/event/import'];
  fake.server.routes['POST /api/canvas/event/import'] = (q) => {
    const reply = importRoute(q);
    delete reply.body.data.eventIdMap[eid(41)];
    return reply;
  };
  try {
    const result = await confirm(importArgs, preview, h);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout, /✅/);
    assert.equal(fake.state.posts.length, 1);
  } finally { fake.server.routes['POST /api/canvas/event/import'] = importRoute; }
});

test('取不到可靠事件列表或引用信息就停，HTTP 200 业务失败也不能算成功', async () => {
  fake.reset();
  const listRoute = fake.server.routes['GET /api/canvas/event/list'];
  fake.server.routes['GET /api/canvas/event/list'] = () => ok({ changed: [] });
  try {
    const result = await md(['add', '不可盲建', '--input', 'a=string']);
    assert.notEqual(result.code, 0);
    assert.deepEqual(fake.state.posts, []);
  } finally { fake.server.routes['GET /api/canvas/event/list'] = listRoute; }
  const usedRoute = fake.server.routes['GET /api/canvas/event/event-used'];
  fake.server.routes['GET /api/canvas/event/event-used'] = () => ok({});
  try {
    assert.notEqual((await md(['edit', '跟进', '--name', '不可盲改'])).code, 0);
  } finally { fake.server.routes['GET /api/canvas/event/event-used'] = usedRoute; }
  const h = home();
  const args = ['hide', '跟进'];
  const dry = await md(args, h);
  const writeRoute = fake.server.routes['POST /api/canvas/event/toggle-visibility'];
  fake.server.routes['POST /api/canvas/event/toggle-visibility'] = (q) => { fake.state.posts.push(q); return { status: 200, body: { code: 2, message: '拒绝修改' } }; };
  try {
    const result = await confirm(args, dry, h);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout, /✅/);
    assert.equal(fake.state.posts.length, 1);
  } finally { fake.server.routes['POST /api/canvas/event/toggle-visibility'] = writeRoute; }
});

test('完整配置覆盖日期、时间、次数、间隔与复合类型；跨智能体导入保留源定义的附加字段', async () => {
  fake.reset();
  const h = home();
  const config = {
    variables: [{ name: 'data', type: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } }],
    triggerTimesType: 'limited', maxTriggerTimes: 2, triggerIntervalType: 'interval', triggerIntervalSeconds: 60,
    effectiveDateType: 'specific', effectiveDateConfig: [{ startTimestamp: 1792022400000, endTimestamp: 1792627200000 }],
    effectiveTimeType: 'specific', effectiveTimeConfig: [{ startTime: '08:00', endTime: '18:00' }],
  };
  const configPath = file(h, 'complete.json', config);
  const args = ['add', '完整配置', '--config', configPath];
  const dry = await md(args, h);
  assert.equal(dry.code, 0, dry.stderr);
  const result = await confirm(args, dry, h);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fake.state.posts.at(-1).body, { ...config, name: '完整配置', botId: EVENTS_BOT });
  const source = event(40, '从其他智能体导入', { botId: eid(80), orgId: 'other-org', description: '源描述', ...config });
  const input = file(h, 'source-extra.json', { events: [source] });
  const preview = await md(['import', input], h);
  const imported = await confirm(['import', input], preview, h);
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(fake.state.posts.at(-1).body.events[0].description, '源描述');
  assert.equal(fake.state.posts.at(-1).body.events[0].botId, EVENTS_BOT);
  assert.equal(fake.state.posts.at(-1).body.events[0].orgId, 'org-1');
});

test('写响应失败也消耗确认码，不重试；重名和歧义绝不自动挑事件', async () => {
  fake.reset();
  const h = home();
  const args = ['hide', '跟进'];
  const dry = await md(args, h);
  const route = fake.server.routes['POST /api/canvas/event/toggle-visibility'];
  fake.server.routes['POST /api/canvas/event/toggle-visibility'] = (q) => { fake.state.posts.push(q); return { status: 503, body: { message: '响应结果不明' } }; };
  try {
    assert.notEqual((await confirm(args, dry, h)).code, 0);
    assert.equal((await confirm(args, dry, h)).code, 5);
    assert.equal(fake.state.posts.length, 1);
    const log = await runCli(['log'], { home: h });
    assert.match(log.stdout, /结果未确认/);
  } finally { fake.server.routes['POST /api/canvas/event/toggle-visibility'] = route; }
  fake.reset({ events: [event(1, '重名'), event(2, '重名')] });
  assert.equal((await md(['hide', '重名'])).code, 4);
  assert.equal((await md(['get', '不存在'])).code, 4);
  assert.deepEqual(fake.state.posts, []);
});

test('导入同名冲突和重复源 ID 整包拒绝；列表归属错误不能拿来写别的智能体', async () => {
  fake.reset();
  const h = home();
  const conflict = file(h, 'conflict.json', [event(40, '新事件'), event(41, '跟进')]);
  assert.equal((await md(['import', conflict], h)).code, 5);
  const duplicated = file(h, 'duplicate-id.json', [event(40, '甲'), event(40, '乙')]);
  assert.equal((await md(['import', duplicated], h)).code, 2);
  fake.state.events[0].botId = eid(90);
  assert.notEqual((await md(['hide', '跟进'], h)).code, 0);
  assert.deepEqual(fake.state.posts, []);
});

test('草稿形状不可靠时不能当成零引用', async () => {
  fake.reset();
  const route = fake.server.routes['GET /api/canvas/get'];
  fake.server.routes['GET /api/canvas/get'] = () => ok({ canvasId: 'main-1', rawCanvas: { unrecognized: true } });
  try {
    const result = await md(['edit', '跟进', '--name', '不得盲改']);
    assert.notEqual(result.code, 0);
    assert.deepEqual(fake.state.posts, []);
  } finally { fake.server.routes['GET /api/canvas/get'] = route; }
});

test('导入预演展示实际写入的隐藏状态和附加字段', async () => {
  fake.reset();
  const h = home();
  const input = file(h, 'hidden.json', [event(40, '隐身的源事件', { isHidden: true, description: '需要展示的源描述' })]);
  const preview = await md(['import', input], h);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /"isHidden": true/);
  assert.match(preview.stdout, /需要展示的源描述/);
});
