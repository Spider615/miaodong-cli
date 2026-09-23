import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedWorkspace } from './helpers/seed.mjs';
import { sampleCanvas, sampleEvents } from './helpers/fixtures.mjs';

async function seeded() {
  const home = tempHome();
  await seedWorkspace(home, { canvas: sampleCanvas(), events: sampleEvents });
  return home;
}

test('md node：目标行、完整 prompt、上下游与被引用计数', async () => {
  const r = await runCli(['node', '00000002'], { home: await seeded() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0重构 \(181fc177\) \/ 草稿/);
  assert.match(r.stdout, /你是客服。\\n请礼貌回答。/);
  assert.match(r.stdout, /上游 1 条 · 下游 2 条 · 被 1 处引用/);
});

test('md node：同名报歧义，退出码 4', async () => {
  const r = await runCli(['node', '回答生成'], { home: await seeded() });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /匹配到 2 个节点/);
});

test('md trace --up：回溯到触发器', async () => {
  const r = await runCli(['trace', '发送文本', '--up'], { home: await seeded() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /▶ 发送文本[\s\S]*↳ 回答生成[\s\S]*↳ 收到文本/);
});

test('md refs：列出引用方与字段路径', async () => {
  const r = await runCli(['refs', '00000002'], { home: await seeded() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /回答生成 \[00000002\] 被引用 1 处/);
  assert.match(r.stdout, /发送文本 \[00000003\] data\.nodePayload\.inputs\[0\] ← output/);
});

test('没有工作副本时退出码 4 并提示先 pull', async () => {
  const r = await runCli(['trace', 'x'], { home: tempHome() });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /还没有工作副本/);
});
