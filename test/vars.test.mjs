// md vars：智能体的会话属性定义——列出、新增（含从别的智能体按名字复制）、修改、删除。
// 写操作按 09-27 的规矩默认只预演，带 --confirm <计划码> 才写；写完读回核对
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { VARS_BOT, startVarsServer, vid } from './helpers/vars-server.mjs';

let fake;
before(async () => { fake = await startVarsServer(); });
after(() => fake.server.close());

function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: fake.server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });
const BOT = ['--bot', '太极2.0重构'];
const codeOf = (stdout) => stdout.match(/计划码：([0-9a-f]{8})/)?.[1];
const varsOf = () => fake.state.vars[VARS_BOT];
const ledger = (h) => readFileSync(join(h, 'md', 'ledger.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));

test('md vars：列出会话属性——自定义的在前，系统默认的标出来；每个说草稿里有几个节点在用', async () => {
  fake.reset();
  const r = await md(['vars', ...BOT]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0重构 \(181fc177\)/);
  assert.match(r.stdout, /会话属性 4 个（系统默认 1 个）/);
  assert.match(r.stdout, / {2}意向 · string · 客户意向 · 草稿里 1 个节点在用 · 5e550002/);
  assert.match(r.stdout, / {2}已报名 · boolean · 是否报过名 · 没有节点在用 · 5e550003/);
  assert.match(r.stdout, / {2}分数 · number · - · 草稿里 1 个节点在用 · 5e550004/);
  assert.match(r.stdout, / {2}消息历史 · array · - · 系统默认 · 5e550001/);
  assert.ok(r.stdout.indexOf('分数') < r.stdout.indexOf('消息历史'), '自定义的在前');
  assert.deepEqual(fake.state.posts, []);
});

test('md vars add：默认只预演、什么都不写；确认后逐个建、读回核对、记账；类型只收 string / number / boolean，重名拦下', async () => {
  fake.reset();
  const h = home();
  const dry = await md(['vars', 'add', '客户阶段', '预算', '--type', 'string', '--desc', '来自迁移', ...BOT], h);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /要新增 2 个会话属性/);
  assert.match(dry.stdout, /\+ 客户阶段 · string · 来自迁移/);
  assert.match(dry.stdout, /写进去立刻对整个智能体生效/);
  assert.match(dry.stdout, /这是预演，什么都没写/);
  assert.deepEqual(fake.state.posts, []);
  const done = await md(['vars', 'add', '客户阶段', '预算', '--type', 'string', '--desc', '来自迁移', ...BOT, '--confirm', codeOf(dry.stdout)], h);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(fake.state.posts.map((p) => p.body), [
    { botId: VARS_BOT, name: '客户阶段', type: { type: 'string' }, description: '来自迁移' },
    { botId: VARS_BOT, name: '预算', type: { type: 'string' }, description: '来自迁移' },
  ]);
  assert.match(done.stdout, /✅ 已新增 2 个，读回核对过：客户阶段（string）5e55\w{4}、预算（string）5e55\w{4}/);
  assert.equal(varsOf().filter((v) => v.name === '客户阶段').length, 1);
  assert.deepEqual([ledger(h).at(-1).kind, ledger(h).at(-1).op, ledger(h).at(-1).items.map((x) => x.name)], ['vars', 'add', ['客户阶段', '预算']]);
  assert.match((await md(['log'], h)).stdout, /会话属性 新增 .*客户阶段、预算/);

  const dup = await md(['vars', 'add', '意向', '--type', 'string', ...BOT]);
  assert.equal(dup.code, 5);
  assert.match(dup.stderr, /已经有会话属性「意向」/);
  const badType = await md(['vars', 'add', '标签们', '--type', 'tag', ...BOT]);
  assert.equal(badType.code, 2);
  assert.match(badType.stderr, /--type 只能是 string、number、boolean/);
});

test('md vars add --from-bot：按名字从别的智能体复制类型和描述（迁移功能时用）；源里没有、源里是系统默认的都报错', async () => {
  fake.reset();
  const h = home();
  const dry = await md(['vars', 'add', '客户阶段', '预算', '--from-bot', '源智能体', ...BOT], h);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /\+ 客户阶段 · string · 售前 \/ 售后（照「源智能体」）/);
  assert.match(dry.stdout, /\+ 预算 · number · 单位：元（照「源智能体」）/);
  const done = await md(['vars', 'add', '客户阶段', '预算', '--from-bot', '源智能体', ...BOT, '--confirm', codeOf(dry.stdout)], h);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(fake.state.posts.map((p) => [p.body.name, p.body.type.type, p.body.description]), [['客户阶段', 'string', '售前 / 售后'], ['预算', 'number', '单位：元']]);
  const missing = await md(['vars', 'add', '不存在的', '--from-bot', '源智能体', ...BOT]);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /「源智能体」里没有会话属性「不存在的」/);
  const builtin = await md(['vars', 'add', '消息历史', '--from-bot', '源智能体', ...BOT]);
  assert.equal(builtin.code, 5);
  assert.match(builtin.stderr, /系统默认/);
  const both = await md(['vars', 'add', '客户阶段', '--from-bot', '源智能体', '--type', 'string', ...BOT]);
  assert.equal(both.code, 2);
});

test('md vars edit：改名、改描述先预演再写（整条带上没改的字段）；有节点在用的不能改类型；系统默认的不能改', async () => {
  fake.reset();
  const h = home();
  const dry = await md(['vars', 'edit', '已报名', '--name', '已报名课程', '--desc', '报过任何一门课', ...BOT], h);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /名字：已报名 → 已报名课程/);
  assert.match(dry.stdout, /描述：是否报过名 → 报过任何一门课/);
  assert.match(dry.stdout, /按名字用它的地方（--var、用例文件里的 vars、跨智能体导入换 id）要改用新名字/);
  assert.deepEqual(fake.state.posts, []);
  const done = await md(['vars', 'edit', '已报名', '--name', '已报名课程', '--desc', '报过任何一门课', ...BOT, '--confirm', codeOf(dry.stdout)], h);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(fake.state.posts.at(-1).body, { botId: VARS_BOT, itemId: vid(3), name: '已报名课程', type: { type: 'boolean' }, description: '报过任何一门课' });
  assert.match(done.stdout, /✅ 已修改，读回核对过/);
  assert.ok(existsSync(done.stdout.match(/改之前的定义备份在 (\S+)/)[1]));

  const typed = await md(['vars', 'edit', '意向', '--type', 'number', ...BOT]);
  assert.equal(typed.code, 5);
  assert.match(typed.stderr, /「意向」有节点在用（草稿 1 个、线上版本 v1\.0\.400 1 个），不能改类型/);
  assert.match(typed.stdout, /草稿：回答生成 \[00000002\]/);
  const builtin = await md(['vars', 'edit', '消息历史', '--desc', 'x', ...BOT]);
  assert.equal(builtin.code, 5);
  assert.match(builtin.stderr, /系统默认的会话属性不能改/);
  const nothing = await md(['vars', 'edit', '分数', ...BOT]);
  assert.equal(nothing.code, 2);
  const clash = await md(['vars', 'edit', '分数', '--name', '意向', ...BOT]);
  assert.equal(clash.code, 5);
  assert.match(clash.stderr, /已经有会话属性「意向」/);
});

test('md vars rm：有节点在用（草稿、线上、灰度任一个）就拦下并列出节点；没人用的先预演，确认后备份、删、读回核对、记账', async () => {
  fake.reset();
  const h = home();
  const used = await md(['vars', 'rm', '分数', ...BOT], h);
  assert.equal(used.code, 5);
  assert.match(used.stderr, /「分数」有节点在用（草稿 1 个），不能删/);
  assert.match(used.stdout, /草稿：按分数分流 \[00000007\]/);
  const dry = await md(['vars', 'rm', '已报名', ...BOT], h);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /要删除 1 个会话属性/);
  assert.match(dry.stdout, /删了就回不来：重建出来是新 id/);
  assert.match(dry.stdout, /这是预演，什么都没写/);
  assert.deepEqual(fake.state.posts, []);
  const done = await md(['vars', 'rm', '已报名', ...BOT, '--confirm', codeOf(dry.stdout)], h);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(fake.state.posts.map((p) => [p.path, p.body]), [['delete', { botId: VARS_BOT, itemId: vid(3) }]]);
  assert.equal(varsOf().some((v) => v.id === vid(3)), false);
  const backup = done.stdout.match(/删之前的定义备份在 (\S+)/)[1];
  assert.equal(JSON.parse(readFileSync(backup, 'utf-8')).items[0].name, '已报名');
  assert.match(done.stdout, /✅ 已删除 1 个，读回核对过/);
  assert.deepEqual([ledger(h).at(-1).kind, ledger(h).at(-1).op], ['vars', 'rm']);
  const builtin = await md(['vars', 'rm', '消息历史', ...BOT]);
  assert.equal(builtin.code, 5);
  assert.match(builtin.stderr, /系统默认的会话属性不能删/);
});

test('md vars：预演之后会话属性被别人改了，原来的计划码对不上，什么都不写', async () => {
  fake.reset();
  const h = home();
  const dry = await md(['vars', 'rm', '已报名', ...BOT], h);
  varsOf().push({ id: vid(9), name: '别人刚加的', type: { type: 'string' }, description: '', isDefault: false });
  const r = await md(['vars', 'rm', '已报名', ...BOT, '--confirm', codeOf(dry.stdout)], h);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /计划码对不上/);
  assert.deepEqual(fake.state.posts, []);
});

test('md vars：名字认不出、重名时用 id；id 前缀也认', async () => {
  fake.reset();
  varsOf().push({ id: vid(8), name: '分数', type: { type: 'number' }, description: '重名的', isDefault: false });
  const ambiguous = await md(['vars', 'rm', '分数', ...BOT]);
  assert.equal(ambiguous.code, 4);
  assert.match(ambiguous.stderr, /「分数」有 2 个同名/);
  const byId = await md(['vars', 'rm', vid(8).slice(0, 8), ...BOT]);
  assert.equal(byId.code, 0, byId.stderr);
  assert.match(byId.stdout, /- 分数 · number · 重名的 · 5e550008/);
  const missing = await md(['vars', 'rm', '没有这个', ...BOT]);
  assert.equal(missing.code, 4);
});
