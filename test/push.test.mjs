import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from './helpers/run-cli.mjs';
import { PROMPT_FIX, planCodeOf, startBotServer } from './helpers/bot-server.mjs';
import { U, sampleCanvas } from './helpers/fixtures.mjs';

let bot;
before(async () => { bot = await startBotServer(); });
after(() => bot.server.close());

const draftNode = (id) => bot.state.draft.find((c) => c.id === id);
const setDraftNode = (id, fn) => { bot.state.draft = bot.state.draft.map((c) => (c.id === id ? fn(structuredClone(c)) : c)); };

test('预演不写；错的计划码被拦；对的计划码写入、回读、记账、换基线；只调 save', async () => {
  bot.reset();
  const { home, dir } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const dry = await runCli(['push'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(bot.state.saves, 0);
  assert.match(dry.stdout, /推送方式：把你的改动合进当前草稿/);
  assert.match(dry.stdout, /\+ 发热≠发烧。/);
  const code = planCodeOf(dry.stdout);

  const wrong = await runCli(['push', '--confirm', '00000000'], { home });
  assert.equal(wrong.code, 5);
  assert.equal(bot.state.saves, 0);

  const done = await runCli(['push', '--confirm', code], { home });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(bot.state.saves, 1);
  assert.match(draftNode(U(2)).data.nodePayload.systemPrompt, /发热≠发烧/);
  assert.match(done.stdout, /✅ 已推送到草稿（未发布）/);
  assert.match(done.stdout, /回答生成 \[00000002\]/);
  assert.equal(existsSync(join(dir, 'after.json')), false);
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
  const ledger = readFileSync(join(home, 'md', 'ledger.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.at(-1).kind, 'push');
  assert.deepEqual(ledger.at(-1).changed.map((c) => c.id), [U(2)]);
  const save = bot.server.requests.filter((q) => q.path === '/api/canvas/save').at(-1);
  assert.equal(save.query.orgId, 'org-1');
  assert.equal(save.body.canvasId, 'main-1');
  assert.ok(Array.isArray(save.body.nodes) && Array.isArray(save.body.edges));
  assert.ok(!bot.server.requests.some((q) => /import|publish|enable|promote/.test(q.path)), '只许调 canvas/save');
});

test('预演后草稿又变了（编辑页自动保存）→ 计划码不符被拦，什么都不写', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const code = planCodeOf((await runCli(['push'], { home })).stdout);
  setDraftNode(U(6), (c) => { c.position = { x: 999, y: 999 }; return c; });
  const r = await runCli(['push', '--confirm', code], { home });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /计划码对不上/);
  assert.equal(bot.state.saves, 0);
});

test('别人改了别的节点 → 合并保留；随后双方改同一节点 → 冲突停下', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  setDraftNode(U(6), (c) => { c.data.nodePayload.systemPrompt = '别人改的'; return c; });
  const dry = await runCli(['push'], { home });
  assert.match(dry.stdout, /草稿在你拉取后被改过：改 1 \/ 增 0 \/ 删 0 个节点/);
  assert.equal((await runCli(['push', '--confirm', planCodeOf(dry.stdout)], { home })).code, 0);
  assert.equal(draftNode(U(6)).data.nodePayload.systemPrompt, '别人改的');
  assert.match(draftNode(U(2)).data.nodePayload.systemPrompt, /发热≠发烧/);

  await bot.apply(home, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.modelType', 'luna'); };\n");
  setDraftNode(U(2), (c) => { c.data.nodePayload.temperature = 0.1; return c; });
  const conflict = await runCli(['push'], { home });
  assert.equal(conflict.code, 5);
  assert.match(conflict.stderr, /1 处冲突/);
  assert.match(conflict.stderr, /你和别人都改了这个节点/);
});

test('冲突后 md rebase 在最新草稿上重跑脚本，再推成功', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.modelType', 'luna'); };\n");
  setDraftNode(U(2), (c) => { c.data.nodePayload.temperature = 0.1; return c; });
  assert.equal((await runCli(['push'], { home })).code, 5);
  const rb = await runCli(['rebase'], { home });
  assert.equal(rb.code, 0, rb.stderr);
  assert.match(rb.stdout, /已在最新草稿上重跑 1 个改动脚本/);
  const dry = await runCli(['push'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal((await runCli(['push', '--confirm', planCodeOf(dry.stdout)], { home })).code, 0);
  assert.equal(draftNode(U(2)).data.nodePayload.modelType, 'luna');
  assert.equal(draftNode(U(2)).data.nodePayload.temperature, 0.1);
});

test('以版本为底、草稿与该版不同：不选方式就拦；--onto-draft 合进草稿', async () => {
  bot.reset();
  bot.state.v400 = sampleCanvas().map((c) => (c.id === U(6) ? { ...c, data: { ...c.data, name: '旧名字' } } : c));
  const { home } = await bot.pulled(['--version', 'v1.0.400']);
  await bot.apply(home, PROMPT_FIX);
  const blocked = await runCli(['push'], { home });
  assert.equal(blocked.code, 5);
  assert.match(blocked.stderr, /--onto-draft/);
  const dry = await runCli(['push', '--onto-draft'], { home });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /--onto-draft --confirm/);
  assert.equal((await runCli(['push', '--onto-draft', '--confirm', planCodeOf(dry.stdout)], { home })).code, 0);
  assert.equal(draftNode(U(6)).data.name, '回答生成');
  assert.match(draftNode(U(2)).data.nodePayload.systemPrompt, /发热≠发烧/);
});

test('自检有新问题时拦住推送', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, "export default ({ h }) => { h.set(h.node('00000002'), 'data.nodePayload.inputs', { 0: 'x' }); };\n");
  const r = await runCli(['push'], { home });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /自检有 \d+ 个问题/);
  assert.equal(bot.state.saves, 0);
});

test('回读不一致时报警（退出码 5）', async () => {
  bot.reset();
  const { home } = await bot.pulled();
  await bot.apply(home, PROMPT_FIX);
  const code = planCodeOf((await runCli(['push'], { home })).stdout);
  bot.state.dropOnSave = true;
  const r = await runCli(['push', '--confirm', code], { home });
  assert.equal(r.code, 5);
  assert.match(r.stdout, /回读核对有 \d+ 处不一致/);
  assert.match(r.stdout, /1 个节点没写进去/);
});
