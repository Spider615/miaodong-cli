// 有状态的假秒懂：草稿存在内存里，save 会改它。用来测 pull → apply → push → rebase / restore 全流程。
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { runCli, tempHome } from './run-cli.mjs';
import { SEED_BOT, seedIdentity } from './seed.mjs';
import { sampleCanvas, sampleEvents, sampleSessions } from './fixtures.mjs';

export const PROMPT_FIX = "export default ({ h }) => { h.insertAfter(h.node('00000002'), 'data.nodePayload.systemPrompt', '你是客服。', '\\n发热≠发烧。'); };\n";
export const planCodeOf = (stdout) => stdout.match(/计划码：([0-9a-f]{8})/)[1];

export async function startBotServer() {
  const state = {};
  const reset = () => {
    state.draft = sampleCanvas();
    state.v400 = sampleCanvas();
    state.saves = 0;
    state.dropOnSave = false;
    state.onSave = null;
  };
  reset();
  const server = await startFakeMiaodong({
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: SEED_BOT, name: '太极2.0重构' }] : []),
    'GET /api/canvas/get': ({ query }) => (query.canvasId === 'ver-400'
      ? ok({ canvasId: 'ver-400', rawCanvas: state.v400, version: 'v1.0.400', updatedAt: '2026-09-20T00:00:00.000Z' })
      : ok({ canvasId: 'main-1', rawCanvas: state.draft, version: 'v1.0.401', updatedAt: `2026-09-23T00:00:0${state.saves}.000Z` })),
    'GET /api/canvas/list-version': () => ok([{ canvasId: 'ver-400', version: 'v1.0.400', name: '400', versionType: 'online' }]),
    'GET /api/session-memory/list': () => ok(sampleSessions),
    'GET /api/canvas/event/list': () => ok(sampleEvents),
    'POST /api/canvas/save': ({ body }) => {
      state.saves++;
      const saved = state.dropOnSave ? body.rawCanvas.slice(1) : body.rawCanvas;
      state.draft = state.onSave ? state.onSave(saved) : saved;
      return { status: 201, body: { code: 0, data: null } };
    },
  });
  let seq = 0;
  return {
    server,
    state,
    reset,
    async pulled(extraArgs = []) {
      const home = tempHome();
      seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
      const r = await runCli(['pull', '--bot', '太极2.0重构', ...extraArgs], { home });
      assert.equal(r.code, 0, r.stderr);
      return { home, dir: r.stdout.match(/工作副本：(.+)/)[1].trim() };
    },
    async apply(home, source) {
      const file = join(home, `fix-${++seq}.mjs`);
      writeFileSync(file, source);
      const r = await runCli(['apply', file], { home });
      assert.equal(r.code, 0, r.stderr);
    },
  };
}
