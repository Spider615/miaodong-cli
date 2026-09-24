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
before(async () => {
  server = await startFakeMiaodong({
    'POST /api/canvas/history/list': ({ body }) => ok(Array.from({ length: 100 }, (_, i) => ({ execId: `p${body.current}-${i}` })), { page: { total: 800 } }),
  });
});
after(() => server.close());

test('fetchSessionPool：按会话 ± 时间窗查，最多翻 5 页，超了标截断', async () => {
  const identity = { key: 'k', label: '测试区', origin: server.origin, token: 't' };
  const pool = await fetchSessionPool(identity, 'org-1', 'bot-1', SESSION, 1_000_000, 60_000);
  assert.equal(pool.rows.length, 500);
  assert.equal(pool.truncated, true);
  const first = server.requests[0].body;
  assert.deepEqual([first.sessionId, first.startTimestamp, first.endTimestamp, first.pageSize], [SESSION, 940_000, 1_060_000, 100]);
});
