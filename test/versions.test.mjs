import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVersion } from '../src/target.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { seedIdentity } from './helpers/seed.mjs';

const BOT = '181fc177-0000-4000-8000-000000000000';
const VERSIONS = [
  { canvasId: 'ver-402', version: 'v1.0.402', name: '402', versionType: 'online', isCanary: false, testStatus: 'passed', createdAt: '2026-09-22T10:00:00.000Z', createdBy: '胡同学' },
  { canvasId: 'ver-401', version: 'v1.0.401', name: '先到测试版本', versionType: 'online', isCanary: true, testStatus: 'not-tested', createdAt: '2026-09-21T10:00:00.000Z', createdBy: '胡同学' },
];

let server;
before(async () => {
  server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: BOT, name: '太极2.0重构' }] : []),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: [], version: 'v1.0.402', updatedAt: '2026-09-23T02:00:00.000Z' }),
    'GET /api/canvas/list-version': () => ok(VERSIONS, { page: { total: 2 } }),
    'GET /api/bot/basic-info': () => ok({ name: '太极2.0重构', canvasVersion: 'v1.0.402', enabledCanvasId: 'ver-402', mainCanvasId: 'main-1' }),
  });
});
after(() => server.close());

function homeWithIdentity() {
  const home = tempHome();
  seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return home;
}

test('resolveVersion：带不带 v 都行，也认版本名称', () => {
  const list = VERSIONS.map((v) => ({ ...v, passedRate: null, isLocked: false }));
  assert.equal(resolveVersion(list, 'v1.0.401').canvasId, 'ver-401');
  assert.equal(resolveVersion(list, '1.0.402').canvasId, 'ver-402');
  assert.equal(resolveVersion(list, '先到测试版本').canvasId, 'ver-401');
  assert.throws(() => resolveVersion(list, 'v9.9.9'), (e) => e.code === 'version_not_found' && e.exitCode === 4);
});

test('md versions：版本表标出线上启用与灰度，用主画布 id 查版本', async () => {
  const r = await runCli(['versions', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0重构 \(181fc177\)/);
  assert.match(r.stdout, /线上启用：v1\.0\.402/);
  assert.match(r.stdout, /v1\.0\.402 \| 402 \| 正式 \| 启用 \| passed \| /);
  assert.match(r.stdout, /v1\.0\.401 \| 先到测试版本 \| 正式 \| 灰度 \| not-tested \| /);
  assert.equal(server.requests.find((q) => q.path === '/api/canvas/list-version').query.canvasId, 'main-1');
});

test('md versions：创建人是自己显示「我（名字）」，别人的只有 id（没有成员列表接口）显示「其他成员 id 前 8 位」，本来就是名字的照原样', async () => {
  const original = server.routes['GET /api/canvas/list-version'];
  server.routes['GET /api/canvas/list-version'] = () => ok([
    { ...VERSIONS[0], createdBy: 'u1' },
    { ...VERSIONS[1], createdBy: '8f3a2b1c-0000-4000-8000-000000000000' },
    { ...VERSIONS[1], canvasId: 'ver-400', version: 'v1.0.400', createdBy: '胡同学' },
  ], { page: { total: 3 } });
  try {
    const r = await runCli(['versions', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /v1\.0\.402 .* 我（测试用户）$/m);
    assert.match(r.stdout, /v1\.0\.401 .* 其他成员 8f3a2b1c$/m);
    assert.match(r.stdout, /v1\.0\.400 .* 胡同学$/m);
  } finally {
    server.routes['GET /api/canvas/list-version'] = original;
  }
});

test('basic-info 不支持时说明取不到，不报错', async () => {
  server.routes['GET /api/bot/basic-info'] = () => ({ status: 404, body: { message: 'Cannot GET', statusCode: 404 } });
  const r = await runCli(['versions', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /线上启用：取不到/);
});

test('画布整个是空响应时报清楚', async () => {
  server.routes['GET /api/canvas/get'] = () => ok({});
  const r = await runCli(['versions', '--bot', '太极2.0重构'], { home: homeWithIdentity() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /秒懂没有返回画布内容/);
});
