import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './helpers/run-cli.mjs';
import { PROMPT_FIX, planCodeOf, startBotServer } from './helpers/bot-server.mjs';
import { U } from './helpers/fixtures.mjs';

let bot;
before(async () => { bot = await startBotServer(); });
after(() => bot.server.close());

test('推送后 md restore：预演不写，确认后草稿回到推送前，记账', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  await runCli(['push', '--confirm', planCodeOf((await runCli(['push'], { home })).stdout)], { home });
  assert.match(bot.state.draft.find((c) => c.id === U(2)).data.nodePayload.systemPrompt, /发热≠发烧/);

  const dry = await runCli(['restore'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /改回 1 个/);
  assert.equal(bot.state.saves, 1);
  const wrong = await runCli(['restore', '--confirm', 'ffffffff'], { home });
  assert.equal(wrong.code, 5);

  const done = await runCli(['restore', '--confirm', planCodeOf(dry.stdout)], { home });
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /✅ 已回滚草稿（未发布）/);
  assert.equal(bot.state.draft.find((c) => c.id === U(2)).data.nodePayload.systemPrompt, '你是客服。\n请礼貌回答。');
  const ledger = readFileSync(join(home, 'md', 'ledger.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.at(-1).kind, 'restore');
});

test('没推送过就没有备份：退出码 5', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  const r = await runCli(['restore'], { home });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /还没有推送过/);
});
