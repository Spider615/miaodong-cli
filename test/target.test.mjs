import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { filterEntries, pickOne, resolveBot } from '../src/target.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { seedIdentity } from './helpers/seed.mjs';

const BOTS = {
  'org-1': [
    { id: '147bd600-1eef-41ae-85e2-a51d03781503', name: '太极2.0 质检革新版' },
    { id: '181fc177-0000-4000-8000-000000000000', name: '太极2.0重构' },
  ],
  'org-2': [{ id: 'b785966b-0000-4000-8000-000000000000', name: '太极2.0重构', enabled: false }],
};

let server;
before(async () => { server = await startFakeMiaodong({ 'GET /api/bot/list': ({ query }) => ok(BOTS[query.orgId] ?? []) }); });
after(() => server.close());

function homeWithIdentity() {
  const home = tempHome();
  seedIdentity(home, {
    key: 'k1', label: '测试区', origin: server.origin, token: 't',
    orgs: [{ id: 'org-1', name: '兴趣岛平台' }, { id: 'org-2', name: '测试企业' }], currentOrgId: 'org-1',
  });
  return home;
}

test('pickOne：id > id 前缀（≥6 位）> 名字完全一致 > 名字包含，不分大小写', () => {
  const entries = [{ botId: 'abcdef12-x', botName: '太极' }, { botId: 'abcdef99-y', botName: '太极2.0' }];
  const id = (e) => e.botId;
  const name = (e) => e.botName;
  assert.equal(pickOne(entries, 'abcdef12-x', id, name).length, 1);
  assert.equal(pickOne(entries, 'abcdef', id, name).length, 2);
  assert.equal(pickOne(entries, 'ABCDEF12', id, name)[0].botName, '太极');
  assert.equal(pickOne(entries, '太极', id, name).length, 1);
  assert.equal(pickOne(entries, '2.0', id, name)[0].botName, '太极2.0');
  assert.equal(pickOne(entries, 'abc', id, name).length, 0);
});

test('filterEntries：按企业名、按区', () => {
  const entries = [
    { identityKey: 'xingqudao', regionLabel: '兴趣岛（独立部署）', orgId: 'o1', orgName: '兴趣岛平台' },
    { identityKey: 'I', regionLabel: 'I区', orgId: 'o2', orgName: '测试企业' },
  ];
  assert.equal(filterEntries(entries, { org: '兴趣岛平台' }).length, 1);
  assert.equal(filterEntries(entries, { region: 'I' })[0].orgId, 'o2');
});

test('resolveBot：同名跨企业 → 列候选停下（退出码 4）；加 --org 后唯一', async () => {
  const home = homeWithIdentity();
  process.env.MD_HOME = join(home, 'md');
  await assert.rejects(resolveBot({ bot: '太极2.0重构' }), (e) =>
    e.code === 'target_ambiguous' && e.exitCode === 4 && e.message.includes('兴趣岛平台') && e.message.includes('测试企业'));
  const target = await resolveBot({ bot: '太极2.0重构', org: '兴趣岛平台' });
  assert.equal(target.botId, '181fc177-0000-4000-8000-000000000000');
  assert.equal(target.identity.origin, server.origin);
});

test('resolveBot：第二次走缓存；找不到时强制刷新一次再报错', async () => {
  const home = homeWithIdentity();
  process.env.MD_HOME = join(home, 'md');
  await resolveBot({ bot: '质检革新版' });
  const count = server.requests.length;
  await resolveBot({ bot: '147bd600' });
  assert.equal(server.requests.length, count, '命中缓存不应再请求');
  await assert.rejects(resolveBot({ bot: '不存在的智能体' }), (e) => e.code === 'target_not_found' && e.exitCode === 4);
  assert.equal(server.requests.length, count + 2, '刷新一次：两个企业各一个请求');
});

test('md bots / md orgs', async () => {
  const home = homeWithIdentity();
  const b = await runCli(['bots', '太极'], { home });
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, /共 3 个智能体/);
  assert.match(b.stdout, /测试区 \/ 测试企业 \/ 太极2\.0重构 \(b785966b\)  \[已停用\]/);
  const o = await runCli(['orgs'], { home });
  assert.match(o.stdout, /兴趣岛平台 \(org-1\)  ← 取身份时选中的/);
});

test('没有任何身份时退出码 3', async () => {
  const r = await runCli(['bots'], { home: tempHome() });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /还没有任何区的身份/);
});
