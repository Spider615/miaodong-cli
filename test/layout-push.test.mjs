import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const MOVE =
  "export default ({ h }) => { h.node('00000002').position = { x: 1234, y: 5678 }; };\n";
const get = (id) => bot.state.draft.find((c) => c.id === id);

test('layout-only：预演不写，确认只保存位置并保留远端最新话术，回读和账本识别布局', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, MOVE);
  get(U(2)).data.nodePayload.systemPrompt = '远端刚改的话术';
  const dry = await runCli(['push', '--layout-only'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(bot.state.saves, 0);
  assert.match(dry.stdout, /布局.*1.*节点/);
  assert.match(dry.stdout, /--layout-only.*--confirm/);
  const done = await runCli(
    ['push', '--layout-only', '--confirm', planCodeOf(dry.stdout)],
    { home },
  );
  assert.equal(done.code, 0, done.stderr);
  assert.equal(bot.state.saves, 1);
  assert.deepEqual(get(U(2)).position, { x: 1234, y: 5678 });
  assert.equal(get(U(2)).data.nodePayload.systemPrompt, '远端刚改的话术');
  const ledger = readFileSync(join(home, 'md', 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .at(-1);
  assert.deepEqual(ledger.layout.nodes, [U(2)]);
  assert.equal(ledger.changed.length, 0);
});

test('layout-only：混入话术变化、节点尺寸、端口或结构变化一律拒绝，确认码不能放行', async () => {
  for (const source of [
    PROMPT_FIX,
    "export default ({ h }) => { h.node('00000002').size.width = 333; };",
    "export default ({ h }) => { h.node('00000002').ports.items.reverse(); };",
    "export default ({ h }) => { h.removeNode('00000006'); };",
  ]) {
    bot.reset();
    const { home } = await bot.pulled();
    await bot.apply(home, source);
    const r = await runCli(['push', '--layout-only', '--confirm', '00000000'], {
      home,
    });
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /布局|layout-only/);
    assert.equal(bot.state.saves, 0);
  }
});

test('layout-only：远端移动、尺寸、端口或连接变化要求重新排版，不能覆盖', async () => {
  for (const mutate of [
    () => {
      get(U(2)).position.x = 888;
    },
    () => {
      get(U(2)).size.height = 1000;
    },
    () => {
      get(U(2)).ports.items.reverse();
    },
    () => {
      get(U(101)).target.cell = U(6);
    },
    () => {
      get(U(4)).data.nodePayload.eventId = 'another-event';
    },
  ]) {
    bot.reset();
    const { home } = await bot.pulled();
    await bot.apply(home, MOVE);
    mutate();
    const r = await runCli(['push', '--layout-only'], { home });
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /布局|排版/);
    assert.equal(bot.state.saves, 0);
  }
});

test('layout-only：清除旧 vertices 时只改拐点，端点、端口和远端连线样式保留', async () => {
  bot.reset();
  get(U(101)).vertices = [{ x: 100, y: 200 }];
  const { home } = await bot.pulled();
  await bot.apply(
    home,
    "export default ({ canvas }) => { delete canvas.find(c => c.id.startsWith('00000101')).vertices; };",
  );
  get(U(101)).attrs = { line: { stroke: 'blue' } };
  const dry = await runCli(['push', '--layout-only'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /计划码/);
  const r = await runCli(
    ['push', '--layout-only', '--confirm', planCodeOf(dry.stdout)],
    { home },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(Object.hasOwn(get(U(101)), 'vertices'), false);
  assert.deepEqual(get(U(101)).source, { cell: U(1), port: 'p1-out' });
  assert.deepEqual(get(U(101)).target, { cell: U(2), port: 'p2-in' });
  assert.deepEqual(get(U(101)).attrs, { line: { stroke: 'blue' } });
});

test('layout-only：服务端丢失位置不能当成回读通过，status remote 能发现坐标被覆盖', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, MOVE);
  const dry = await runCli(['push', '--layout-only'], { home });
  assert.match(dry.stdout, /计划码/);
  bot.state.onSave = (saved) =>
    saved.map((c) =>
      c.id === U(2) ? { ...c, position: { x: 200, y: 0 } } : c,
    );
  const r = await runCli(
    ['push', '--layout-only', '--confirm', planCodeOf(dry.stdout)],
    { home },
  );
  assert.equal(r.code, 5);
  assert.match(r.stdout, /布局|坐标/);
  const status = await runCli(['status', '--remote'], { home });
  assert.match(status.stdout, /⚠️.*布局/);
});

test('layout-only：布局预演后仅远端话术变化也使原计划码失效', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, MOVE);
  const dry = await runCli(['push', '--layout-only'], { home });
  assert.match(dry.stdout, /计划码/);
  get(U(6)).data.nodePayload.systemPrompt = '预演后修改';
  const r = await runCli(
    ['push', '--layout-only', '--confirm', planCodeOf(dry.stdout)],
    { home },
  );
  assert.equal(r.code, 5);
  assert.equal(bot.state.saves, 0);
});

test('layout-only：撤回只恢复布局，保留推送之后的新话术', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, MOVE);
  const dry = await runCli(['push', '--layout-only'], { home });
  assert.match(dry.stdout, /计划码/);
  assert.equal(
    (
      await runCli(
        ['push', '--layout-only', '--confirm', planCodeOf(dry.stdout)],
        { home },
      )
    ).code,
    0,
  );
  get(U(2)).data.nodePayload.systemPrompt = '保存布局之后的新话术';
  const preview = await runCli(['restore', '--layout-only'], { home });
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /--layout-only.*--confirm/);
  const restored = await runCli(
    ['restore', '--layout-only', '--confirm', planCodeOf(preview.stdout)],
    { home },
  );
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(get(U(2)).position, { x: 200, y: 0 });
  assert.equal(get(U(2)).data.nodePayload.systemPrompt, '保存布局之后的新话术');
});

test('普通 push 仍保留远端坐标，layout-only 不能和整份替换混用', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, MOVE);
  const ordinary = await runCli(['push'], { home });
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.equal(bot.state.saves, 0);
  const r = await runCli(['push', '--layout-only', '--replace-draft'], {
    home,
  });
  assert.equal(r.code, 5, r.stderr);
  assert.equal(bot.state.saves, 0);
});

test('layout-only：回读和 status 检查完整布局，未移动节点被服务端改位或改尺寸也失败', async () => {
  for (const mutate of [
    (c) => {
      c.position = { x: 1234, y: 5678 };
    },
    (c) => {
      c.size.height = 999;
    },
  ]) {
    bot.reset();
    const { home } = await bot.pulled();
    await bot.apply(home, MOVE);
    const dry = await runCli(['push', '--layout-only'], { home });
    bot.state.onSave = (saved) => {
      mutate(saved.find((c) => c.id === U(3)));
      return saved;
    };
    const done = await runCli(
      ['push', '--layout-only', '--confirm', planCodeOf(dry.stdout)],
      { home },
    );
    assert.equal(done.code, 5, done.stdout + done.stderr);
    const status = await runCli(['status', '--remote'], { home });
    assert.match(status.stdout, /⚠️.*布局/);
  }
});
