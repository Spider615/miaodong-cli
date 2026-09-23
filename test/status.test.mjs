import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers/run-cli.mjs';
import { PROMPT_FIX, planCodeOf, startBotServer } from './helpers/bot-server.mjs';
import { sampleCanvas } from './helpers/fixtures.mjs';

let bot;
before(async () => { bot = await startBotServer(); });
after(() => bot.server.close());

test('status 显示未推送改动；log 列出推送的节点；status --remote 能发现被旧编辑页覆盖', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const s1 = await runCli(['status'], { home });
  assert.equal(s1.code, 0, s1.stderr);
  assert.match(s1.stdout, /未推送改动：改 1 \/ 增 0 \/ 删 0 个节点/);

  await runCli(['push', '--confirm', planCodeOf((await runCli(['push'], { home })).stdout)], { home });
  const log = await runCli(['log'], { home });
  assert.match(log.stdout, /推送 测试区 \/ 太极2\.0重构 \(181fc177\) · 改 1 增 0 删 0/);
  assert.match(log.stdout, /~ 回答生成 \[00000002\]/);

  const ok = await runCli(['status', '--remote'], { home });
  assert.match(ok.stdout, /✅ 测试区 \/ 太极2\.0重构：.*推送的 1 个节点都还在/);

  bot.state.draft = sampleCanvas();   // 模拟没刷新的旧编辑页把推送前的内容自动保存了回去
  const lost = await runCli(['status', '--remote'], { home });
  assert.match(lost.stdout, /⚠️ 测试区 \/ 太极2\.0重构：.*有 1 个节点被覆盖/);
});

test('没有记录时的提示', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  assert.match((await runCli(['log'], { home })).stdout, /还没有推送记录/);
});
