import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from './helpers/run-cli.mjs';
import {
  startBotServer,
  planCodeOf,
  PROMPT_FIX,
} from './helpers/bot-server.mjs';
import { U } from './helpers/fixtures.mjs';
let bot;
before(async () => {
  bot = await startBotServer();
});
after(() => bot.server.close());

test('layout 只生成本地快照及可离线查看的 SVG/HTML，确认后才能保存位置', async () => {
  bot.reset();
  const { home, dir } = await bot.pulled();
  const output = join(home, 'preview');
  const r = await runCli(['layout', '--out', output], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(bot.state.saves, 0);
  assert.match(r.stdout, /push.*--layout-only/);
  for (const f of [
    'preview.html',
    'optimized.svg',
    'before.svg',
    'report.json',
    'candidate.json',
  ])
    assert.ok(existsSync(join(output, f)), f);
  const html = readFileSync(join(output, 'preview.html'), 'utf8');
  assert.doesNotMatch(
    html,
    /你是客服|systemPrompt|referenceNodeId|<script[^>]+src=/,
  );
  const staged = JSON.parse(readFileSync(join(dir, 'after.json'), 'utf8')),
    candidate = JSON.parse(
      readFileSync(join(output, 'candidate.json'), 'utf8'),
    );
  assert.deepEqual(staged, candidate);
  const dry = await runCli(['push', '--layout-only'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(bot.state.saves, 0);
  bot.state.draft.find((n) => n.id === U(2)).data.nodePayload.systemPrompt =
    '最新远端话术';
  const changed = await runCli(['push', '--layout-only'], { home });
  assert.equal(changed.code, 0, changed.stderr);
  const done = await runCli(
    ['push', '--layout-only', '--confirm', planCodeOf(changed.stdout)],
    { home },
  );
  assert.equal(done.code, 0, done.stderr);
  assert.equal(bot.state.saves, 1);
  assert.equal(
    bot.state.draft.find((n) => n.id === U(2)).data.nodePayload.systemPrompt,
    '最新远端话术',
  );
  for (const n of staged.canvas.filter((c) => !c.source))
    assert.deepEqual(
      bot.state.draft.find((c) => c.id === n.id).position,
      n.position,
    );
});

test('layout 不把已有业务修改混进布局，非法图失败时不生成 after 或输出目录', async () => {
  bot.reset();
  let { home, dir } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const prior = readFileSync(join(dir, 'after.json'), 'utf8');
  let r = await runCli(['layout'], { home });
  assert.equal(r.code, 5, r.stderr);
  assert.equal(readFileSync(join(dir, 'after.json'), 'utf8'), prior);
  bot.reset();
  bot.state.draft[0].size.width = 0;
  ({ home, dir } = await bot.pulled());
  const output = join(home, 'failed');
  r = await runCli(['layout', '--out', output], { home });
  assert.equal(r.code, 5, r.stderr);
  assert.ok(!existsSync(join(dir, 'after.json')));
  assert.ok(!existsSync(output));
  assert.equal(bot.state.saves, 0);
});

test('layout 输出目录不覆盖已有文件，拒绝 --bot 误用；旧坐标不能 rebase 到新图', async () => {
  bot.reset();
  const { home, dir } = await bot.pulled();
  const output = mkdtempSync(join(tmpdir(), 'md-layout-existing-'));
  writeFileSync(join(output, 'keep'), '保留');
  let r = await runCli(['layout', '--out', output], { home });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(readFileSync(join(output, 'keep'), 'utf8'), '保留');
  assert.ok(!existsSync(join(dir, 'after.json')));
  r = await runCli(['layout', '--bot', '另一个智能体'], { home });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /pull|工作副本/);
  r = await runCli(['layout'], { home });
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(['rebase'], { home });
  assert.equal(r.code, 5, r.stderr);
  assert.equal(bot.state.saves, 0);
});

test('预览中的不可信名称转义为文本，不泄露 prompt，保留预览事件关联', async () => {
  const { renderLayoutPreview } = await import('../src/layout-preview.mjs');
  bot.reset();
  const canvas = structuredClone(bot.state.draft);
  canvas[0].data.name = '</text><script>attack()</script>';
  const result = renderLayoutPreview(
    { canvas },
    { canvas },
    {
      eventLinks: [
        { from: U(4), to: U(5), eventId: 'ev-1', eventName: '<事件>' },
      ],
      before: {},
      after: {},
      eventDistances: { before: { mean: 0 }, after: { mean: 0 } },
    },
    '测试预览',
  );
  assert.doesNotMatch(result.svg, /<script>|<事件>/);
  assert.match(result.svg, /&lt;script&gt;/);
  assert.doesNotMatch(result.html, /systemPrompt|你是客服/);
  assert.match(result.svg, /data-event/);
});
