import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/http.mjs';
import { MdError } from '../src/errors.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';

let server;
let identity;
before(async () => {
  server = await startFakeMiaodong();
  identity = { key: 'test', label: '测试区', origin: server.origin, token: 'tok-SECRET-123' };
});
after(() => server.close());

test('成功时返回完整外壳，带 Bearer，undefined 参数不上送', async () => {
  server.routes['GET /api/bot/list'] = () => ok([{ id: 'b1' }], { page: { total: 1 } });
  const payload = await request(identity, '/api/bot/list', { query: { orgId: 'o1', skip: undefined } });
  assert.deepEqual(payload.data, [{ id: 'b1' }]);
  const req = server.requests.at(-1);
  assert.equal(req.auth, 'Bearer tok-SECRET-123');
  assert.deepEqual(req.query, { orgId: 'o1' });
});

test('HTTP 201 + code 非 0 视为业务错误', async () => {
  server.routes['POST /api/canvas/save'] = () => ({ status: 201, body: { code: -1, message: 'invalid' } });
  await assert.rejects(
    request(identity, '/api/canvas/save', { method: 'POST', body: {} }),
    (e) => e instanceof MdError && e.code === 'business' && /code=-1/.test(e.message),
  );
});

test('401 → 身份失效，退出码 3，提示重新取身份，且不含 token', async () => {
  server.routes['GET /api/x'] = () => ({ status: 401, body: { statusCode: 401, message: 'Authentication failed' } });
  await assert.rejects(request(identity, '/api/x'), (e) =>
    e.code === 'auth_expired' && e.exitCode === 3 && e.hint.includes(server.origin) && !`${e.message}${e.hint}`.includes('SECRET'));
});

test('403：企业到期与身份失效分开', async () => {
  server.routes['GET /api/y'] = () => ({ status: 403, body: { code: -7, message: 'org expired' } });
  await assert.rejects(request(identity, '/api/y'), (e) => e.code === 'org_expired');
  server.routes['GET /api/z'] = () => ({ status: 403, body: { message: 'forbidden' } });
  await assert.rejects(request(identity, '/api/z'), (e) => e.code === 'auth_expired');
});

test('非 2xx 带出秒懂的 message（数组也能拼）', async () => {
  server.routes['POST /api/v'] = () => ({ status: 400, body: { statusCode: 400, message: ['a must be string', 'b must be uuid'] } });
  await assert.rejects(request(identity, '/api/v', { method: 'POST', body: {} }), (e) =>
    e.code === 'upstream' && /a must be string；b must be uuid/.test(e.message));
});

test('不跟随重定向（防止把 token 带到别的域名）', async () => {
  server.routes['GET /api/r'] = () => ({ status: 302, headers: { Location: 'http://127.0.0.1:1/steal' }, body: '' });
  await assert.rejects(request(identity, '/api/r'), (e) => e.code === 'network');
});
