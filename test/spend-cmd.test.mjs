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

const limitsOf = (home) => {
  const file = join(home, 'md', 'config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')).spend : null;
};
const codeIn = (stdout) => stdout.match(/确认码：([0-9a-f]{8})/)?.[1];

test('md spend limit 调高：先给新旧门槛和确认码、不改（退出码 5）；码不对不改；带对的码才改', async () => {
  const home = tempHome();
  const args = ['spend', 'limit', '--per-command', '5', '--per-day', '20'];
  const preview = await runCli(args, { home });
  assert.equal(preview.code, 5);
  assert.match(preview.stdout, /单次门槛：¥2\.00 → ¥5\.00/);
  assert.match(preview.stdout, /每日上限：¥10\.00 → ¥20\.00/);
  assert.match(preview.stderr, /调高门槛要用户确认/);
  const code = codeIn(preview.stdout);
  assert.ok(code, preview.stdout);
  assert.equal(limitsOf(home), null);
  const wrong = await runCli([...args, '--confirm', '00000000'], { home });
  assert.equal(wrong.code, 5);
  assert.match(wrong.stderr, /确认码对不上/);
  assert.equal(limitsOf(home), null);
  const ok = await runCli([...args, '--confirm', code], { home });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /花费门槛已改/);
  assert.deepEqual(limitsOf(home), { perCommand: 5, perDay: 20 });
});

test('md spend limit 调低直接生效（只会更严）；没变就说没变；金额要是非负数', async () => {
  const home = tempHome();
  const lower = await runCli(['spend', 'limit', '--per-command', '1'], { home });
  assert.equal(lower.code, 0, lower.stderr);
  assert.deepEqual(limitsOf(home), { perCommand: 1, perDay: 10 });
  const same = await runCli(['spend', 'limit', '--per-command', '1', '--per-day', '10'], { home });
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /门槛没变/);
  const bad = await runCli(['spend', 'limit', '--per-day', '-1'], { home });
  assert.equal(bad.code, 2);
});
