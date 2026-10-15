import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { listEvents, listSessions, saveCanvas } from '../src/api.mjs';
import { U, sampleCanvas } from './helpers/fixtures.mjs';

test('canvas/save 封装也拒绝超长名称，任何调用方都不能发出这样的写请求', async () => {
  const fake = await startFakeMiaodong({ 'POST /api/canvas/save': () => ok(null) });
  try {
    const canvas = sampleCanvas();
    canvas.find((c) => c.id === U(2)).data.name = '名'.repeat(21);
    const identity = { key: 'k', label: '测试区', origin: fake.origin, token: 't' };
    await assert.rejects(async () => saveCanvas(identity, 'org-1', 'main-1', canvas), (e) => e.exitCode === 5 && /21.*20/.test(e.message));
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('canvas/save 在唯一写入口拒绝事件动作错 shape、事件入口缺显示信息', async () => {
  const fake = await startFakeMiaodong({ 'POST /api/canvas/save': () => ok(null) });
  try {
    const identity = { key: 'k', label: '测试区', origin: fake.origin, token: 't' };
    for (const kind of ['action', 'trigger']) {
      const canvas = sampleCanvas();
      if (kind === 'action') canvas.find((c) => c.id === U(4)).shape = 'canvas-event-action';
      else delete canvas.find((c) => c.id === U(5)).data.eventItem;
      await assert.rejects(async () => saveCanvas(identity, 'org-1', 'main-1', canvas), (e) => e.exitCode === 5 && /事件.*格式/.test(e.message));
    }
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('事件 / 会话变量列表偶发失败（超时、5xx）先重试，重试还不行才当取不到；4xx 不重试（跑前检查偶发「取不到」就是取列表超时）', async () => {
  let calls = 0;
  const fake = await startFakeMiaodong({
    'GET /api/canvas/event/list': () => (++calls < 3 ? { status: 502, body: { message: 'Bad Gateway' } } : ok([{ eventId: 'e1', name: '甲' }])),
    'GET /api/session-memory/list': () => ({ status: 404, body: { message: 'Cannot GET' } }),
  });
  try {
    const identity = { key: 'k', label: '测试区', origin: fake.origin, token: 't' };
    assert.deepEqual(await listEvents(identity, 'org-1', 'bot-1'), [{ eventId: 'e1', name: '甲' }]);
    assert.equal(calls, 3);
    assert.equal(await listSessions(identity, 'org-1', 'bot-1'), null);
    assert.equal(fake.requests.filter((q) => q.path === '/api/session-memory/list').length, 1);
    fake.routes['GET /api/canvas/event/list'] = () => ({ status: 503, body: {} });
    assert.equal(await listEvents(identity, 'org-1', 'bot-1'), null);
  } finally {
    await fake.close();
  }
});
