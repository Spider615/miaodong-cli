import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chainExecFromDetail, chainOf, fetchSessionPool, renderChain } from '../src/exec-chain.mjs';
import { normalizeDetail } from '../src/exec-detail.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { REPLY, SESSION, X, chainRows, delayDetail } from './helpers/exec-fixtures.mjs';

const byId = (rows) => new Map(rows.map((r) => [r.execId, r]));
const OPTS = { windowLabel: '±65 分钟', truncated: false };

test('chainOf：上游按载荷配对，下游跟到「发送」，载荷对不上的干扰项不接', () => {
  const rows = chainRows();
  const chain = chainOf(X(2), rows);
  assert.deepEqual(chain.upstream.map((h) => h.execId), [X(1)]);
  assert.equal(chain.targetHop.link, 'exact');
  assert.deepEqual(chain.downstream.map((h) => h.execId), [X(3)]);
  const text = renderChain(chain, byId(rows), OPTS).join('\n');
  assert.match(text, /← e0000001 .*文本「我想退款」/);
  assert.match(text, /● e0000002 .*事件「延时回复」.*← 本条/);
  assert.match(text, /→ e0000003 .*事件「发送」 → 发文本「已为您登记退款」/);
  assert.match(text, new RegExp(`整条链最终：发文本「${REPLY}」`));
  assert.doesNotMatch(text, /e0000004/);
});

test('上游不在时间窗内：标出来，不接一条错的上游', () => {
  const rows = chainRows().filter((r) => r.execId !== X(1));
  const text = renderChain(chainOf(X(2), rows), byId(rows), OPTS).join('\n');
  assert.match(text, /\? 上游不在时间窗内（事件「延时回复」/);
  assert.doesNotMatch(text, /^ {2}← /m);
});

test('下游没找到、同载荷多个候选、会话执行太多，都如实标出', () => {
  const base = chainRows();
  const noSend = base.filter((r) => r.execId !== X(3));
  assert.match(renderChain(chainOf(X(2), noSend), byId(noSend), OPTS).join('\n'), /→ 事件「发送」的执行没找到/);
  const send = base.find((r) => r.execId === X(3));
  const twins = [...base, { ...send, execId: X(8), createdAt: new Date(Date.parse(send.createdAt) + 6000).toISOString() }];
  const chain = chainOf(X(2), twins);
  assert.equal(chain.downstream[0].execId, X(3));
  const text = renderChain(chain, byId(twins), { windowLabel: '±65 分钟', truncated: true }).join('\n');
  assert.match(text, /同载荷候选还有 1 个，按时间取了最近的/);
  assert.match(text, /超过 500 条，链可能不全/);
});

test('本条不在列表里（测试执行）：用详情补进池子', () => {
  const rows = chainRows().filter((r) => r.execId !== X(2));
  const chain = chainOf(X(2), rows, chainExecFromDetail(normalizeDetail(delayDetail())));
  assert.deepEqual(chain.upstream.map((h) => h.execId), [X(1)]);
  assert.deepEqual(chain.downstream.map((h) => h.execId), [X(3)]);
});

let server;
let withTotal = true;
before(async () => {
  server = await startFakeMiaodong({
    'POST /api/canvas/history/list': ({ body }) => ok(
      Array.from({ length: 100 }, (_, i) => ({ execId: `${body.startTimestamp}-${body.current}-${i}` })),
      withTotal ? { page: { total: 800 } } : {},
    ),
  });
});
after(() => server.close());

test('fetchSessionPool：以本条为界分两段查，本条之前那段先回（截断时丢的是离得最远的）；各最多 5 页，超了标截断', async () => {
  withTotal = true;
  server.requests.length = 0;
  const identity = { key: 'k', label: '测试区', origin: server.origin, token: 't' };
  const pool = await fetchSessionPool(identity, 'org-1', 'bot-1', SESSION, 1_000_000, 60_000);
  assert.equal(pool.rows.length, 1000);
  assert.deepEqual([pool.truncated, pool.truncatedBefore, pool.truncatedAfter], [true, true, true]);
  const windows = [...new Set(server.requests.map((q) => `${q.body.startTimestamp}-${q.body.endTimestamp}`))];
  assert.deepEqual(windows, ['940000-1000000', '1000000-1060000']);
  assert.ok(server.requests.every((q) => q.body.sessionId === SESSION && q.body.pageSize === 100));
});

test('fetchSessionPool：接口不给总数、最后一页又是满页，也算截断（审查 I-3）', async () => {
  withTotal = false;
  const identity = { key: 'k', label: '测试区', origin: server.origin, token: 't' };
  const pool = await fetchSessionPool(identity, 'org-1', 'bot-1', SESSION, 1_000_000, 60_000);
  assert.equal(pool.truncatedBefore, true);
  withTotal = true;
});

test('截断时上游 / 下游没找到：说可能被截掉了、建议缩小时间窗，不再建议放宽（审查 I-3）', () => {
  const noUp = chainRows().filter((r) => r.execId !== X(1));
  const up = renderChain(chainOf(X(2), noUp), byId(noUp), { windowLabel: '±65 分钟', truncated: true, truncatedBefore: true, truncatedAfter: false }).join('\n');
  assert.match(up, /\? 上游可能被截掉了：本条之前的执行超过 500 条/);
  assert.doesNotMatch(up, /上游不在时间窗内/);
  assert.match(up, /缩小 --chain-window/);
  const noSend = chainRows().filter((r) => r.execId !== X(3));
  const down = renderChain(chainOf(X(2), noSend), byId(noSend), { windowLabel: '±65 分钟', truncated: true, truncatedBefore: false, truncatedAfter: true }).join('\n');
  assert.match(down, /本条之后的执行超过 500 条，可能被截掉了/);
});

test('载荷没法比对、按时间猜的链接，标成「猜的」，不冒充精确配对（审查 M-1）', () => {
  const rows = chainRows().map((r) => {
    if (r.execId === X(1)) return { ...r, outputActions: [{ type: 'canvas-event-action', payload: { eventId: 'ev-delay', eventName: '延时回复', params: {} } }] };
    if (r.execId === X(2)) return { ...r, rawTrigger: { ...r.rawTrigger, canvasEvent: { eventId: 'ev-delay', data: {} } }, outputActions: [{ type: 'canvas-event-action', payload: { eventId: 'ev-send', eventName: '发送', params: {} } }] };
    if (r.execId === X(3)) return { ...r, rawTrigger: { ...r.rawTrigger, canvasEvent: { eventId: 'ev-send', data: {} } } };
    return r;
  }).filter((r) => r.execId !== X(4));
  const chain = chainOf(X(2), rows);
  assert.equal(chain.targetHop.link, 'guess');
  assert.equal(chain.downstream[0].link, 'guess');
  const text = renderChain(chain, byId(rows), OPTS).join('\n');
  assert.equal((text.match(/载荷无法比对，按时间猜的/g) ?? []).length, 2);
  assert.doesNotMatch(text, /同载荷候选还有 0 个/);
});
