import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { SEED_BOT, seedWorkspace } from './helpers/seed.mjs';
import { sampleCanvas } from './helpers/fixtures.mjs';

test('latestWorkspaceFor：取这个智能体最近拉的工作副本；别的智能体没有就是 null', async () => {
  const home = tempHome();
  const older = await seedWorkspace(home, { canvas: sampleCanvas(), meta: { pulledAt: '2026-09-20T00:00:00.000Z' } });
  const newer = await seedWorkspace(home, { canvas: sampleCanvas(), meta: { pulledAt: '2026-09-24T00:00:00.000Z' } });
  const { latestWorkspaceFor, listWorkspaces } = await import('../src/workspace.mjs');
  assert.equal(listWorkspaces()[0].dir, newer);
  assert.equal(latestWorkspaceFor(SEED_BOT).dir, newer);
  assert.notEqual(latestWorkspaceFor(SEED_BOT).dir, older);
  assert.equal(latestWorkspaceFor('00000000-no-such-bot'), null);
  assert.equal((await runCli(['status'], { home })).code, 0);
});
