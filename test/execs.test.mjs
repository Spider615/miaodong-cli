import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_ALIASES, TRIGGER_ALIASES, actionSummary, actionTexts, buildSearchBody, clip, formatCost, formatRow, resolveAlias, scanSummary, searchExecutions, summarizeRow } from '../src/execs.mjs';
import { cut } from '../src/output.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { ASK, REPLY, X, chainRows } from './helpers/exec-fixtures.mjs';

test('actionTexts：发文本、组合消息、转人工、发出事件、写字段、打标签都说人话', () => {
  const texts = actionTexts([
    { type: 'send-text-message', payload: { text: '你好' } },
    { type: 'send-combination-message', payload: { messages: [{ type: 'text', content: '第一句' }, { type: 'image', content: 'https://x/a.png' }] } },
    { type: 'handover', payload: { handoverMessage: '需要人工' } },
    { type: 'canvas-event-action', payload: { eventId: 'ev-send', eventName: '发送', params: { text: '回复' } } },
    { type: 'update-data', payload: { operations: [{}, {}] } },
    { type: 'tag-user', payload: { operation: 'ADD', tags: [{ tagName: '意向' }] } },
    { type: 'send-material', payload: {} },
  ]);
  assert.deepEqual(texts.map((t) => t.text), [
    '发文本「你好」', '发组合消息「第一句 / https://x/a.png」', '转人工「需要人工」', '发出事件「发送」：回复', '写 2 个字段', '打标签 意向', 'send-material',
  ]);
  assert.deepEqual(texts.map((t) => t.kind), ['reply', 'reply', 'handover', 'event', 'other', 'other', 'other']);
});

test('actionSummary：回复和转人工排前面，多次写字段合成一条（真机上回复常被一串写字段挤出截断范围）', () => {
  const s = actionSummary([
    { type: 'update-data', payload: { operations: [{}, {}] } },
    { type: 'tag-user', payload: { operation: 'ADD', tags: [{ tagName: 'L6' }] } },
    { type: 'update-data', payload: { operations: [{}] } },
    { type: 'canvas-event-action', payload: { eventName: '发送', params: { text: '回复' } } },
    { type: 'handover', payload: {} },
    { type: 'send-text-message', payload: { text: '你好' } },
  ]);
  assert.equal(s, '发文本「你好」；转人工；发出事件「发送」：回复；写 3 个字段；打标签 L6');
  assert.equal(actionSummary(null), '');
});

test('summarizeRow / formatRow：事件名、触发文本、动作、版本、灰度、花费、点踩', () => {
  const rows = chainRows();
  const delay = summarizeRow(rows.find((r) => r.execId === X(2)));
  assert.equal(delay.trigger, '事件「延时回复」');
  assert.equal(delay.triggerText, ASK);
  assert.match(delay.actions, /发出事件「发送」：已为您登记退款/);
  const line = formatRow(summarizeRow(rows.find((r) => r.execId === X(3))));
  assert.match(line, new RegExp(`${X(3)} 事件「发送」 ｜ ${REPLY} ｜ 发文本「${REPLY}」 ｜ v1\\.0\\.403（灰度） ¥0$`));
  assert.match(formatRow(summarizeRow(rows.find((r) => r.execId === X(4)))), / 👎$/);
});

test('字段缺失或为 null 时摘要照常输出，不崩', () => {
  const s = summarizeRow({ execId: X(7), outputActions: null, triggerContent: null, totalCostInCny: null, canvasVersion: null, createdAt: null });
  assert.equal(formatRow(s), `- ${X(7)} - ｜ - ｜ 无动作 ｜ - ¥-`);
});

test('formatCost / clip', () => {
  assert.equal(formatCost(29.35138), '¥29.35');
  assert.equal(formatCost(0.17), '¥0.170');
  assert.equal(formatCost(0.0102), '¥0.010');
  assert.equal(formatCost(0.006), '¥0.0060');
  assert.equal(formatCost(0), '¥0');
  assert.equal(formatCost(null), '¥-');
  assert.equal(clip('a\n  b', 10), 'a b');
  assert.equal(clip('一二三四五', 3), '一二三…');
});

test('resolveAlias：简写、完整类型名；不认识的报用法错误', () => {
  assert.equal(resolveAlias(TRIGGER_ALIASES, 'text', 'trigger'), 'receive-text-message');
  assert.equal(resolveAlias(ACTION_ALIASES, 'send', 'action'), 'send-text-message');
  assert.equal(resolveAlias(ACTION_ALIASES, 'smart-tag', 'action'), 'smart-tag');
  assert.equal(resolveAlias(TRIGGER_ALIASES, undefined, 'trigger'), undefined);
  assert.throws(() => resolveAlias(TRIGGER_ALIASES, 'xx', 'trigger'), (e) => e.exitCode === 2 && /text/.test(e.hint));
});

test('buildSearchBody：条件全部进请求，--event 自带事件触发类型；冲突报用法错误', () => {
  const body = buildSearchBody({ botId: 'b', start: 1, end: 2, keyword: '退款', session: 's', down: true, action: 'send-text-message', versionCanvasId: 'ver-402', canary: false, failed: true, event: '延时回复' });
  assert.deepEqual(body, { botId: 'b', startTimestamp: 1, endTimestamp: 2, keyword: '退款', sessionId: 's', feedbackStatus: 'thumb-down', triggerType: 'canvas-event-trigger', actionType: 'send-text-message', canvasId: 'ver-402', isCanary: false, allNodesSuccess: false });
  assert.throws(() => buildSearchBody({ botId: 'b', start: 1, end: 2, event: '延时回复', trigger: 'receive-text-message' }), (e) => e.exitCode === 2);
  assert.throws(() => buildSearchBody({ botId: 'b', start: 1, end: 2, down: true, up: true }), (e) => e.exitCode === 2);
});

let server;
const pages = [];
// 250 条，新到旧，每秒一条；每 3 条里有 1 条是「延时回复」
const ROWS = Array.from({ length: 250 }, (_, i) => ({
  execId: `r${i}`,
  createdAt: new Date(Date.UTC(2026, 8, 24, 12) - i * 1000).toISOString(),
  triggerContent: { triggerType: 'canvas-event-trigger', content: { eventName: i % 3 === 0 ? '延时回复' : '发送' } },
}));
before(async () => {
  const rows = ROWS;
  server = await startFakeMiaodong({
    'POST /api/canvas/history/list': ({ body }) => {
      pages.push(body.current);
      const from = (body.current - 1) * body.pageSize;
      return ok(rows.slice(from, from + body.pageSize), { page: { total: rows.length } });
    },
  });
});
after(() => server.close());
const identity = () => ({ key: 'k', label: '测试区', origin: server.origin, token: 't' });

test('searchExecutions：按事件名本地筛，够数就停，没扫完如实返回', async () => {
  pages.length = 0;
  const r = await searchExecutions(identity(), 'org-1', { botId: 'b' }, { eventName: '延时回复', limit: 5, scanPages: 3 });
  assert.equal(r.matches.length, 5);
  assert.deepEqual(pages, [1]);
  // 第 5 条命中在第 13 行：只看了 13 条，不能按整页算成 100（审查 I-2）
  assert.equal(r.scanned, 13);
  assert.equal(r.stop, 'limit');
  assert.equal(r.total, 250);
  assert.ok(r.namesSeen.get('发送') > 0);
});

test('searchExecutions：扫到页数上限就停并记下扫到哪；扫完时标 end', async () => {
  pages.length = 0;
  const capped = await searchExecutions(identity(), 'org-1', { botId: 'b' }, { eventName: '没有这个事件', limit: 5, scanPages: 2 });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(capped.matches.length, 0);
  assert.deepEqual([capped.stop, capped.scanned, capped.oldestAt], ['scan', 200, ROWS[199].createdAt]);
  const all = await searchExecutions(identity(), 'org-1', { botId: 'b' }, { eventName: '没有这个事件', limit: 5, scanPages: 5 });
  assert.deepEqual([all.stop, all.scanned], ['end', 250]);
});

test('scanSummary：取满 --limit、扫到 --scan 上限、已扫完，三种说法；接着扫从停下的地方往前，不重扫', () => {
  const start = Date.UTC(2026, 8, 24, 9);
  assert.match(scanSummary({ stop: 'limit', total: 250, scanned: 13, matches: [1, 2, 3, 4, 5] }, { limit: 5, from: start }), /看了 13 条，已取满 --limit 5/);
  const scan = scanSummary({ stop: 'scan', total: 250, scanned: 200, matches: [], oldestAt: ROWS[199].createdAt }, { limit: 5, from: start });
  assert.match(scan, /扫了 200 条（到 --scan 上限），命中 0 条/);
  const to = new Date(Date.parse(ROWS[199].createdAt) - 1).toISOString();
  assert.ok(scan.includes(`--from "${new Date(start).toISOString()}" --to "${to}"`), scan);
  assert.match(scanSummary({ stop: 'end', total: 3, scanned: 3, matches: [1, 2] }, { limit: 5, from: start }), /扫了 3 条，命中 2 条（已扫完）/);
});

test('searchExecutions：不用本地筛时按 --limit 取页', async () => {
  pages.length = 0;
  const r = await searchExecutions(identity(), 'org-1', { botId: 'b' }, { limit: 150 });
  assert.equal(r.matches.length, 150);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(r.stop, 'limit');
});

test('截断不劈开 emoji：截在一对代理项中间时整个字符不要（终端里显示成乱码）', () => {
  assert.equal(clip('ab😀cd', 3), 'ab…');
  assert.equal(clip('ab😀cd', 4), 'ab😀…');
  assert.equal(cut('{"a":"😀😀"}', 7), '{"a":"…');
  assert.equal(cut('短', 7), '短');
});

test('截断文字一律走 output.mjs 的 cut（或 execs.mjs 的 clip）：别处不再自己 slice 再加省略号', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.mjs') ? [join(dir, d.name)] : []));
  const offenders = files(SRC).filter((f) => /\$\{\w+\.slice\(0, [^)]+\)\}…/.test(readFileSync(f, 'utf-8')));
  assert.deepEqual(offenders.map((f) => f.slice(SRC.length)), []);
});

