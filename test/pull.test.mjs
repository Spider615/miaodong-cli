import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { U, sampleCanvas, sampleEvents, sampleSessions } from './helpers/fixtures.mjs';

const BOT = '181fc177-0000-4000-8000-000000000000';
const draft = sampleCanvas();
const v400 = sampleCanvas().map((c) => (c.id === U(2) ? { ...c, data: { ...c.data, nodePayload: { ...c.data.nodePayload, systemPrompt: '旧版提示词' } } } : c));

let server;
before(async () => {
  server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: BOT, name: '太极2.0重构' }] : []),
    'GET /api/canvas/get': ({ query }) => (query.canvasId === 'ver-400'
      ? ok({ canvasId: 'ver-400', rawCanvas: v400, version: 'v1.0.400', updatedAt: '2026-09-20T00:00:00.000Z' })
      : ok({ canvasId: 'main-1', rawCanvas: draft, version: 'v1.0.401', updatedAt: '2026-09-23T01:00:00.000Z' })),
    'GET /api/canvas/list-version': () => ok([{ canvasId: 'ver-400', version: 'v1.0.400', name: '400', versionType: 'online' }]),
    'GET /api/session-memory/list': () => ok(sampleSessions),
    'GET /api/canvas/event/list': () => ok(sampleEvents),
  });
});
after(() => server.close());

function homeWithIdentity() {
  const home = tempHome();
  seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return home;
}
const wsDirOf = (stdout) => stdout.match(/工作副本：(.+)/)[1].trim();
const readJsonFile = (file) => JSON.parse(readFileSync(file, 'utf-8'));

test('拉草稿：写 meta / base / 索引，LAST 指向它，事件列表带 eventListFilter=all', async () => {
  const home = homeWithIdentity();
  const r = await runCli(['pull', '--bot', '太极2.0重构'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0重构 \(181fc177\) \/ 草稿/);
  assert.match(r.stdout, /节点 6 · 连线 4 · 事件跳转 1 · 节点引用 2 · 会话变量 1 · 事件 1/);
  const dir = wsDirOf(r.stdout);
  const meta = readJsonFile(join(dir, 'meta.json'));
  assert.equal(meta.mainCanvasId, 'main-1');
  assert.deepEqual(meta.source, { kind: 'draft' });
  assert.equal(meta.draft.updatedAt, '2026-09-23T01:00:00.000Z');
  assert.equal(readJsonFile(join(dir, 'base.json')).canvas.length, draft.length);
  const edges = readFileSync(join(dir, 'index', 'edges.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(edges.some((e) => e.kind === 'event' && e.eventName === '延时回复'));
  assert.equal(readFileSync(join(home, 'md', 'work', 'LAST'), 'utf-8').trim(), dir);
  assert.equal(server.requests.find((q) => q.path === '/api/canvas/event/list').query.eventListFilter, 'all');
});

test('拉版本：base 是该版本，另存草稿，并提示草稿与版本不同', async () => {
  const home = homeWithIdentity();
  const r = await runCli(['pull', '--bot', '太极2.0重构', '--version', '1.0.400'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\/ v1\.0\.400（400）/);
  assert.match(r.stdout, /⚠️ 草稿与 v1\.0\.400 不同：草稿多 0 个节点、少 0 个节点、1 个节点内容不同/);
  const dir = wsDirOf(r.stdout);
  const base = readJsonFile(join(dir, 'base.json'));
  assert.equal(base.canvas.find((c) => c.id === U(2)).data.nodePayload.systemPrompt, '旧版提示词');
  assert.ok(existsSync(join(dir, 'draft.json')));
  assert.equal(readJsonFile(join(dir, 'meta.json')).source.canvasId, 'ver-400');
});

test('事件列表接口不支持时照样拉，给出说明', async () => {
  server.routes['GET /api/canvas/event/list'] = () => ({ status: 404, body: { message: 'Cannot GET', statusCode: 404 } });
  const r = await runCli(['pull', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /读不到事件列表/);
  server.routes['GET /api/canvas/event/list'] = () => ok(sampleEvents);
});

test('pull 总是刷新智能体目录：缓存之后新出现的同名智能体也会被发现', async () => {
  const home = homeWithIdentity();
  assert.equal((await runCli(['bots'], { home })).code, 0);
  const original = server.routes['GET /api/bot/list'];
  server.routes['GET /api/bot/list'] = ({ query }) => ok(query.orgId === 'org-1' ? [{ id: BOT, name: '太极2.0重构' }, { id: 'b785966b-0000-4000-8000-000000000000', name: '太极2.0重构' }] : []);
  const r = await runCli(['pull', '--bot', '太极2.0重构'], { home });
  server.routes['GET /api/bot/list'] = original;
  assert.equal(r.code, 4);
  assert.match(r.stderr, /匹配到 2 个智能体/);
});
