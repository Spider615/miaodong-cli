import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';

function seedSpends(home, rows) {
  mkdirSync(join(home, 'md'), { recursive: true });
  writeFileSync(join(home, 'md', 'spend.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('md spend：今天已花、门槛、最近几笔（有实际用实际）', async () => {
  const home = tempHome();
  const now = new Date().toISOString();
  seedSpends(home, [
    { id: 'a', at: now, kind: 'trial', regionLabel: '兴趣岛', botName: '质检革新版', what: '回答生成', count: 3, estimate: 0.03, actual: null, approved: 'auto' },
    { id: 'a', actual: 0.031 },
  ]);
  const r = await runCli(['spend'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /今天已花 ¥0\.031 \/ 每日上限 ¥10\.00（单次门槛 ¥2\.00）/);
  assert.match(r.stdout, /试跑 兴趣岛 \/ 质检革新版「回答生成」×3 预估 ¥0\.030 实际 ¥0\.031（自动）/);
});

test('md spend：没有记录时说清楚', async () => {
  const r = await runCli(['spend'], { home: tempHome() });
  assert.match(r.stdout, /今天已花 ¥0 \/ 每日上限 ¥10\.00/);
  assert.match(r.stdout, /最近 7 天：没有花费/);
});

test('md spend limit：没拿到本人批准就不改（测试里 MD_NO_DIALOG=1），退出码 5', async () => {
  const home = tempHome();
  const r = await runCli(['spend', 'limit', '--per-command', '5', '--per-day', '20'], { home });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /门槛没改/);
  assert.equal(existsSync(join(home, 'md', 'config.json')), false);
});

test('changeLimits：批准了才写配置；金额要是非负数', async () => {
  const home = tempHome();
  process.env.MD_HOME = join(home, 'md');
  const { changeLimits } = await import('../src/commands/spend.mjs');
  const { parseArgs } = await import('../src/args.mjs');
  const seen = [];
  await changeLimits(parseArgs(['limit', '--per-command', '5']), { approve: async (req) => { seen.push(req); return { ok: true, via: 'dialog' }; } });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'md', 'config.json'), 'utf-8')).spend, { perCommand: 5, perDay: 10 });
  assert.match(seen[0].lines.join('\n'), /单次门槛：¥2\.00 → ¥5\.00/);
  await assert.rejects(changeLimits(parseArgs(['limit', '--per-day', '-1']), { approve: async () => ({ ok: true }) }), (e) => e.exitCode === 2);
});
