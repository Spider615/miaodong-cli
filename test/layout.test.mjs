import test from 'node:test';
import assert from 'node:assert/strict';
import {
  node,
  edge,
  sampleCanvas,
  sampleEvents,
  U,
} from './helpers/fixtures.mjs';

const engine = async (input) =>
  (await import('../src/layout.mjs')).optimizeLayout(input);
const envelope = (canvas) => ({
  canvas,
  events: structuredClone(sampleEvents),
  sessions: [{ id: 's1', name: '保留属性' }],
});
const eventAction = (id, eid) =>
  node(id, {
    shape: 'action-event',
    type: 'canvas-event-action',
    category: 'action',
    payload: { eventId: eid },
  });
const trigger = (id, eid) => ({
  ...node(id, {
    shape: eid,
    type: 'canvas-event-trigger',
    category: 'trigger',
    payload: { eventId: eid },
  }),
  data: {
    type: 'canvas-event-trigger',
    category: 'trigger',
    name: '同名事件',
    nodePayload: { eventId: eid },
    eventItem: { eventId: eid, name: '同名事件', variables: [] },
  },
});
const withoutGeometry = (cells) =>
  cells.map((c) => {
    const x = structuredClone(c);
    if (c.source) delete x.vertices;
    else delete x.position;
    return x;
  });

// Breaks caught: input mutation, lost payload/ports/edges, guessed dimensions, overlapping ranks.
test('布局使用实际尺寸，输入不变，业务字段和数组顺序保留，仅清理旧绝对拐点', async () => {
  const input = envelope(sampleCanvas());
  input.canvas[1].size.height = 560;
  input.canvas.find((c) => c.source).vertices = [{ x: 10000, y: 10000 }];
  const before = structuredClone(input);
  const { envelope: result, report } = await engine(input);
  assert.deepEqual(input, before);
  assert.deepEqual(
    withoutGeometry(result.canvas),
    withoutGeometry(before.canvas),
  );
  assert.deepEqual(result.events, before.events);
  assert.deepEqual(result.sessions, before.sessions);
  assert.equal(result.canvas.find((c) => c.id === U(2)).size.height, 560);
  assert.equal(result.canvas.find((c) => c.source).vertices, undefined);
  assert.equal(report.after.overlapPairs, 0);
  assert.equal(report.after.nodes, 6);
});

test('事件下游入口靠近上游动作，不生成真实连线，不依赖节点名字', async () => {
  const a = eventAction(1, 'ev-1'),
    b = trigger(2, 'ev-1');
  a.data.name = '任意上游';
  b.data.name = '任意下游';
  b.position = { x: 18000, y: 9000 };
  const { envelope: result, report } = await engine(
    envelope([a, b, node(3), edge(101, 2, 3)]),
  );
  const map = new Map(result.canvas.map((n) => [n.id, n]));
  const s = map.get(U(1)),
    t = map.get(U(2));
  assert.ok(
    Math.hypot(
      t.position.x - s.position.x - s.size.width,
      t.position.y - s.position.y,
    ) < 500,
  );
  assert.equal(result.canvas.filter((c) => c.source).length, 1);
  assert.equal(report.eventLinks.length, 1);
  assert.equal(report.eventLinks[0].eventId, 'ev-1');
});

test('多个上游共用入口保留一份，并兼顾全部调用方', async () => {
  const input = envelope([
    eventAction(1, 'ev-1'),
    eventAction(2, 'ev-1'),
    trigger(3, 'ev-1'),
    node(4),
    edge(101, 3, 4),
  ]);
  const { envelope: result, report } = await engine(input);
  assert.equal(result.canvas.length, input.canvas.length);
  assert.equal(
    result.canvas.filter((c) => c.data?.type === 'canvas-event-trigger').length,
    1,
  );
  assert.equal(report.eventLinks.length, 2);
  assert.equal(report.after.overlapPairs, 0);
  const m = new Map(result.canvas.map((c) => [c.id, c])),
    t = m.get(U(3));
  for (const id of [U(1), U(2)]) {
    const s = m.get(id);
    assert.ok(
      Math.hypot(
        t.position.x - s.position.x - s.size.width,
        t.position.y - s.position.y,
      ) < 1200,
    );
  }
});

test('同名不同 ID 不关联，一个事件多个入口全部保留，缺入口只报告', async () => {
  const input = envelope([
    eventAction(1, 'ev-1'),
    trigger(2, 'ev-1'),
    trigger(3, 'ev-1'),
    trigger(4, 'other'),
    eventAction(5, 'missing'),
  ]);
  const { report, envelope: result } = await engine(input);
  assert.deepEqual(
    report.eventLinks.map((l) => [l.from, l.to]),
    [
      [U(1), U(2)],
      [U(1), U(3)],
    ],
  );
  assert.deepEqual(
    report.unmatchedEventActions.map((l) => l.from),
    [U(5)],
  );
  assert.equal(result.canvas.length, 5);
});

test('仅有 eventItem 的合法事件入口也按其 ID 关联', async () => {
  const t = trigger(2, 'ev-1');
  delete t.data.nodePayload.eventId;
  const { report } = await engine(envelope([eventAction(1, 'ev-1'), t]));
  assert.equal(report.eventLinks.length, 1);
});

test('分支根节点按真实端口从上到下排列，端口与规则顺序不变', async () => {
  const r = node(1, {
    type: 'rule-center',
    payload: {
      branches: [
        { branchId: 'upper', name: '上' },
        { branchId: 'lower', name: '下' },
      ],
    },
  });
  r.size = { width: 350, height: 200 };
  r.ports.items = [
    { id: 'in', group: 'left' },
    { id: 'upper', group: 'right', args: { x: 350, y: 50 } },
    { id: 'lower', group: 'right', args: { x: 350, y: 150 } },
  ];
  const e1 = edge(101, 1, 3),
    e2 = edge(102, 1, 2);
  e1.source.port = 'upper';
  e2.source.port = 'lower';
  const input = envelope([r, node(2), node(3), e2, e1]);
  const { envelope: result } = await engine(input);
  const m = new Map(result.canvas.map((c) => [c.id, c]));
  assert.ok(m.get(U(3)).position.y < m.get(U(2)).position.y);
  assert.deepEqual(m.get(U(1)).ports, r.ports);
  assert.deepEqual(m.get(U(1)).data, r.data);
});

test('实线环和事件回跳可终止，坐标有效，不复制节点', async () => {
  const input = envelope([
    trigger(1, 'ev-1'),
    eventAction(2, 'ev-1'),
    edge(101, 1, 2),
    edge(102, 2, 1),
  ]);
  const { envelope: result, report } = await engine(input);
  assert.equal(result.canvas.length, 4);
  assert.equal(report.eventLinks.length, 1);
  for (const n of result.canvas.filter((c) => !c.source)) {
    assert.ok(Number.isFinite(n.position.x));
    assert.ok(Number.isFinite(n.position.y));
  }
});

test('嵌套容器整体移动，子节点偏移、尺寸、父子结构及便签内容保留', async () => {
  const p = node(1, { type: 'loop' }),
    child = node(2),
    next = node(3),
    note = {
      id: U(900),
      shape: 'canvas-tool-comment-node',
      position: { x: 5000, y: 6000 },
      size: { width: 300, height: 90 },
      data: { text: '保留说明' },
    };
  p.position = { x: 1000, y: 2000 };
  p.size = { width: 700, height: 600 };
  p.children = [U(2)];
  child.parent = U(1);
  child.position = { x: 1150, y: 2200 };
  const { envelope: result, report } = await engine(
    envelope([p, child, next, edge(101, 2, 3), note]),
  );
  const m = new Map(result.canvas.map((c) => [c.id, c]));
  assert.equal(m.get(U(2)).position.x - m.get(U(1)).position.x, 150);
  assert.equal(m.get(U(2)).position.y - m.get(U(1)).position.y, 200);
  assert.deepEqual(m.get(U(1)).size, p.size);
  assert.deepEqual(m.get(U(1)).children, p.children);
  assert.deepEqual(m.get(U(900)).data, note.data);
  assert.equal(report.after.overlapPairs, 0);
});

test('重复 ID、无效尺寸、悬空连线、无效端口及容器环在修改输入前停止', async () => {
  const badSize = node(1);
  badSize.size.width = 0;
  const badPort = edge(101, 1, 2);
  badPort.target.port = 'missing';
  const p = node(1),
    c = node(2);
  p.parent = U(2);
  c.parent = U(1);
  for (const canvas of [
    [node(1), node(1)],
    [badSize],
    [node(1), edge(101, 1, 2)],
    [node(1), node(2), badPort],
    [p, c],
  ]) {
    const input = envelope(canvas),
      copy = structuredClone(input);
    await assert.rejects(engine(input), /ID|尺寸|端口|悬空|容器|父子/);
    assert.deepEqual(input, copy);
  }
});

test('空画布安全返回，重复计算和对已排画布再次计算产生相同坐标', async () => {
  const empty = await engine(envelope([]));
  assert.equal(empty.report.after.nodes, 0);
  const input = envelope(sampleCanvas());
  const a = await engine(input),
    b = await engine(input),
    c = await engine(a.envelope);
  assert.deepEqual(a.envelope, b.envelope);
  assert.deepEqual(a.envelope, c.envelope);
});

test('容器子节点的小数偏移保持精度', async () => {
  const p = node(1, { type: 'loop' }),
    c = node(2);
  p.position = { x: 1000.25, y: 2000.25 };
  p.size = { width: 700, height: 600 };
  p.children = [U(2)];
  c.parent = U(1);
  c.position = { x: 1150.5, y: 2200.75 };
  const { envelope: result } = await engine(envelope([p, c]));
  const m = new Map(result.canvas.map((n) => [n.id, n]));
  assert.equal(m.get(U(2)).position.x - m.get(U(1)).position.x, 150.25);
  assert.equal(m.get(U(2)).position.y - m.get(U(1)).position.y, 200.5);
});

test('超出几何安全范围的数值、重复端口在排版前拒绝', async () => {
  const huge = node(1);
  huge.position.x = 1e20;
  await assert.rejects(engine(envelope([huge])), /范围|坐标/);
  const duplicate = node(1);
  duplicate.ports.items.push(structuredClone(duplicate.ports.items[0]));
  await assert.rejects(engine(envelope([duplicate])), /端口/);
});

test('事件布局不允许曲线从节点对角穿过，也不允许实线共线重叠', async () => {
  const { hitsRect, intersects, occupancy } =
    await import('../src/layout-geometry.mjs');
  assert.equal(
    hitsRect(
      { x: 0, y: 0 },
      { x: 1000, y: 1000 },
      { x: 300, y: 300, width: 100, height: 100 },
    ),
    true,
  );
  assert.equal(
    hitsRect(
      { x: 0, y: 300 },
      { x: 1000, y: 300 },
      { x: 300, y: 300, width: 100, height: 100 },
    ),
    false,
  );
  assert.equal(
    intersects(
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 300, y: 0 },
      { x: 600, y: 0 },
    ),
    true,
  );
  const index = occupancy();
  index.add({
    x: 0,
    y: 0,
    rects: [],
    segments: [{ id: 'line', a: { x: 0, y: 0 }, b: { x: 1000, y: 1000 } }],
  });
  assert.equal(
    index.fits(
      {
        rects: [{ id: 'new', x: 0, y: 0, width: 100, height: 100 }],
        segments: [],
      },
      300,
      300,
    ),
    false,
  );
});

test('dot 给出相反分支顺序时，按端口重排同列私有入口且不改其他节点', async () => {
  const { orderBranchRoots } = await import('../src/layout-branches.mjs');
  const { layoutGraph } = await import('../src/layout-graph.mjs');
  const r = node(1, { type: 'rule-center' });
  r.ports.items = [
    { id: 'top', group: 'right', args: { x: 200, y: 20 } },
    { id: 'bottom', group: 'right', args: { x: 200, y: 60 } },
  ];
  const upper = node(2),
    lower = node(3);
  upper.position = { x: 500, y: 300 };
  upper.size.height = 140;
  lower.position = { x: 500, y: 0 };
  lower.size.height = 80;
  const a = edge(101, 1, 2),
    b = edge(102, 1, 3);
  a.source.port = 'top';
  b.source.port = 'bottom';
  const g = layoutGraph(envelope([r, upper, lower, a, b])),
    m = g.modules[0];
  m.nodes = structuredClone([r, upper, lower]);
  orderBranchRoots(g, m);
  const map = new Map(m.nodes.map((n) => [n.id, n]));
  assert.ok(map.get(U(2)).position.y < map.get(U(3)).position.y);
  assert.deepEqual(map.get(U(1)), r);
  assert.equal(map.get(U(2)).size.height, 140);
});

test('容器内不同源节点的分支按端口绝对高度排列', async () => {
  const { orderBranchRoots } = await import('../src/layout-branches.mjs');
  const { layoutGraph } = await import('../src/layout-graph.mjs');
  const p = node(1, { type: 'loop' }),
    a = node(2),
    b = node(3),
    t = node(4),
    u = node(5);
  p.position = { x: 0, y: 0 };
  p.size = { width: 600, height: 700 };
  p.children = [U(2), U(3)];
  a.parent = U(1);
  b.parent = U(1);
  a.position = { x: 50, y: 0 };
  b.position = { x: 50, y: 300 };
  a.size.height = 300;
  a.ports.items = [{ id: 'a', group: 'right', args: { x: 200, y: 200 } }];
  b.ports.items = [{ id: 'b', group: 'right', args: { x: 200, y: 40 } }];
  t.position = { x: 1000, y: 0 };
  u.position = { x: 1000, y: 200 };
  const e = edge(101, 2, 4),
    f = edge(102, 3, 5);
  e.source.port = 'a';
  f.source.port = 'b';
  const g = layoutGraph(envelope([p, a, b, t, u, e, f])),
    m = g.modules[0];
  m.nodes = structuredClone([p, a, b, t, u]);
  assert.equal(orderBranchRoots(g, m), 0);
  assert.equal(m.nodes.find((n) => n.id === U(4)).position.y, 0);
  assert.equal(m.nodes.find((n) => n.id === U(5)).position.y, 200);
});

test('同一 rank 的不同宽度分支按中心对齐识别，不改变横坐标', async () => {
  const { orderBranchRoots } = await import('../src/layout-branches.mjs');
  const { layoutGraph } = await import('../src/layout-graph.mjs');
  const r = node(1, { type: 'rule-center' }),
    a = node(2),
    b = node(3);
  r.ports.items = [
    { id: 'top', group: 'right', args: { x: 200, y: 20 } },
    { id: 'bottom', group: 'right', args: { x: 200, y: 60 } },
  ];
  a.position = { x: 500, y: 300 };
  b.position = { x: 450, y: 0 };
  b.size.width = 300;
  const e = edge(101, 1, 2),
    f = edge(102, 1, 3);
  e.source.port = 'top';
  f.source.port = 'bottom';
  const g = layoutGraph(envelope([r, a, b, e, f])),
    m = g.modules[0];
  m.nodes = structuredClone([r, a, b]);
  assert.equal(orderBranchRoots(g, m), 1);
  assert.ok(m.nodes[1].position.y < m.nodes[2].position.y);
  assert.equal(m.nodes[1].position.x, 500);
  assert.equal(m.nodes[2].position.x, 450);
});
