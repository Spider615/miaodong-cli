import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { U, sampleCanvas, sampleEvents } from './helpers/fixtures.mjs';

test('md apply：写 after、记录脚本、可叠加；--reset 回到基线', async () => {
  const home = tempHome();
  const dir = await seedWorkspace(home, { canvas: sampleCanvas(), events: sampleEvents });
  const swap = join(home, 'swap.mjs');
  writeFileSync(swap, "export default ({ h }) => { for (const n of h.expectCount(h.select((n) => n.data.type === 'llm-completion'), 2)) h.set(n, 'data.nodePayload.modelType', 'luna'); };\n");
  const r = await runCli(['apply', swap], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /含未推送改动/);
  assert.match(r.stdout, /改了 2 个、连线变化 0 条/);
  assert.ok(existsSync(join(dir, 'transforms', '001-swap.mjs')));

  const prompt = join(home, 'prompt.mjs');
  writeFileSync(prompt, "export default ({ h }) => { h.insertAfter(h.node('00000002'), 'data.nodePayload.systemPrompt', '你是客服。', '\\n发热≠发烧。'); };\n");
  assert.equal((await runCli(['apply', prompt], { home })).code, 0);
  const after = JSON.parse(readFileSync(join(dir, 'after.json'), 'utf-8'));
  const n2 = after.canvas.find((c) => c.id === U(2)).data.nodePayload;
  assert.equal(n2.modelType, 'luna');
  assert.match(n2.systemPrompt, /发热≠发烧/);
  assert.ok(existsSync(join(dir, 'transforms', '002-prompt.mjs')));

  const reset = await runCli(['apply', '--reset'], { home });
  assert.equal(reset.code, 0, reset.stderr);
  assert.equal(existsSync(join(dir, 'after.json')), false);
  assert.equal(existsSync(join(dir, 'transforms')), false);
});

test('md apply：脚本失败时不写 after，退出码 1', async () => {
  const home = tempHome();
  const dir = await seedWorkspace(home, { canvas: sampleCanvas(), events: sampleEvents });
  const broken = join(home, 'broken.mjs');
  writeFileSync(broken, "export default ({ h }) => { h.replaceOnce(h.node('00000002'), 'data.nodePayload.systemPrompt', '没有这句', 'x'); };\n");
  const r = await runCli(['apply', broken], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /出现 0 次/);
  assert.equal(existsSync(join(dir, 'after.json')), false);
});
