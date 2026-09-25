// md kb list（spec 3a §3.2）：企业的全部知识库；--bot 时这个智能体怎么用知识库、FAQ 未审核数、被删的库；多个企业时要指定
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';

let server;
before(async () => { server = await startKbServer(); });
after(() => server.close());
function home({ second = false } = {}) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  if (second) seedIdentity(h, { key: 'k2', label: '另一个区', origin: server.origin, token: 't', orgs: [{ id: 'org-2', name: '别的企业' }], currentOrgId: 'org-2' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });

test('md kb list：列出企业的全部知识库和各类数量；第一行是区 / 企业', async () => {
  const r = await md(['kb', 'list']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], '测试区 / 兴趣岛平台');
  assert.match(r.stdout, /共 3 个知识库/);
  assert.match(r.stdout, /售后 FAQ \(aaaa0001\)\s+FAQ 4 · 文件 0 · 网页 0 · 视频 0 · text-embedding-ada-002/);
});

test('md kb list --bot：大模型节点挂的库、知识库查询节点的配置、FAQ 未审核数；被删的库单独标出来', async () => {
  const r = await md(['kb', 'list', '--bot', '太极2.0 质检革新版']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0 质检革新版 \(147bd600\) \/ 草稿\n/);
  assert.match(r.stdout, /回答生成 \[00000002\]：售后 FAQ、财务 FAQ/);
  assert.match(r.stdout, /闲聊 \[00000003\]：❌ 已不存在（dddd0004）/);
  assert.match(r.stdout, /查手册 \[00000004\]：产品手册 · 召回 5 条 · 门槛 80 · 重排 加权（向量 0\.5）/);
  assert.match(r.stdout, /售后 FAQ \(aaaa0001\).*⚠️ 未审核 1 条：这些 FAQ 检索不到/);
  assert.match(r.stdout, /❌ dddd0004：企业里没有这个库（被删了？），引用它的节点永远召回不到/);
});

test('md kb list --bot --version：看指定版本的引用', async () => {
  const r = await md(['kb', 'list', '--bot', '太极2.0 质检革新版', '--version', 'v1.0.402']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /\/ v1\.0\.402$/);
});

test('md kb list：本机能看到两个企业时，不带 --region / --org 就列候选停下（退出码 4）（Review Focus 5）', async () => {
  const h = home({ second: true });
  const r = await md(['kb', 'list'], h);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /能看到 2 个企业，请用 --region 或 --org 指定/);
  const picked = await md(['kb', 'list', '--org', '兴趣岛平台'], h);
  assert.equal(picked.code, 0, picked.stderr);
});

test('md kb：只调读接口；不认识的子命令报用法错误', async () => {
  const r = await md(['kb', 'nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /不认识「md kb nope」/);
  assert.deepEqual(server.unexpected(), []);
});
