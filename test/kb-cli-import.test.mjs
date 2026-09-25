// md kb import 的预演和闸门（spec 3b §4.1）：只读、0 个写请求；闸门没过就一条都不写；计划码不对就停
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { doc, faq, manifestFor, writePackage } from './helpers/kb-import-fixtures.mjs';
import { goodPackage, importServerOptions } from './helpers/kb-import-data.mjs';

let server;
before(async () => { server = await startKbServer(importServerOptions()); });
after(() => server.close());
function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });

test('md kb import 预演：目标库、来源、增删条数、会备份什么、引用这个库的智能体、很像的 FAQ、计划码；一个写请求都不发', async () => {
  const dir = writePackage(goodPackage());
  const before = server.writes().length;
  const r = await md(['kb', 'import', dir]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], '测试区 / 兴趣岛平台 / 售后 FAQ (aaaa0001) · 导入包 pkg');
  assert.match(r.stdout, /来源资料：售后手册\.docx（aaaaaaaa）；说明：客户 9 月给的售后手册/);
  assert.match(r.stdout, /要加：FAQ 1 条 · 文件 1 个（2 段）/);
  assert.match(r.stdout, /要删：FAQ 1 条 · 文件 1 个（2 段；原文件 1 个，先下载进备份）/);
  assert.match(r.stdout, /引用这个库的智能体（写进去就对它们生效）：\n  太极2\.0 质检革新版 \(147bd600\)：线上版 v1\.0\.402：回答生成；草稿：回答生成/);
  assert.match(r.stdout, /很像的 FAQ（≥ 0\.9，只提醒，不拦）：\n  新「课程怎么退款呀」≈ 库里 #7001「课程怎么退款」0\.909/);
  assert.match(r.stdout, /闸门：全部通过/);
  const code = r.stdout.match(/计划码：([0-9a-f]{8})/)[1];
  assert.match(r.stdout, new RegExp(`用户明确同意后执行：md kb import ${dir.replace(/[/\\.]/g, '\\$&')} --confirm ${code}`));
  assert.equal(server.writes().length, before);
});

test('md kb import 预演：闸门没过（要删的对不上、找不到、带素材、带标签；新 FAQ 和库里完全一样）——全列出来，退出码 1，不给计划码，一条都不写', async () => {
  const dir = writePackage({
    faqs: [faq('f1', '怎么修改收货地址')],
    deletes: [
      { type: 'faq', id: 7002, question: '退款要多久' },
      { type: 'faq', id: 7999, question: '不存在的' },
      { type: 'faq', id: 7010, question: '带图的问题' },
      { type: 'doc', id: 602, name: '带标签的文件' },
    ],
  });
  const before = server.writes().length;
  const r = await md(['kb', 'import', dir]);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /计划码/);
  assert.match(r.stderr, /闸门没过（一条都不会写）/);
  assert.match(r.stderr, /要删的 FAQ #7002 的问题和包里写的不一样：库里是「退款多久到账」，包里是「退款要多久」/);
  assert.match(r.stderr, /要删的 FAQ #7999 在库里找不到（可能已经被删了，或者 id 写错了）/);
  assert.match(r.stderr, /要删的 FAQ #7010 带图片或素材，md 恢复不了它，不能删/);
  assert.match(r.stderr, /要删的文件 #602「带标签的文件」带知识标签，md 恢复不了标签，不能删/);
  assert.match(r.stderr, /新 FAQ「怎么修改收货地址」（f1）和库里 #7003 完全一样：要替换就把 #7003 写进 deletes\.jsonl，要保留就从包里去掉/);
  assert.equal(server.writes().length, before);
});

test('md kb import 预演：要删的旧 FAQ 和新 FAQ 问题一样（删旧的重建）不算重复', async () => {
  const dir = writePackage({ faqs: [faq('f1', '退款多久到账', '新的答案')], deletes: [{ type: 'faq', id: 7002, question: '退款多久到账' }] });
  const r = await md(['kb', 'import', dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /闸门：全部通过/);
});

test('md kb import 预演：库找不到、库名和包里写的不一样——退出码 4', async () => {
  const other = await md(['kb', 'import', writePackage({ manifest: manifestFor(undefined, '别的库'), faqs: [faq('f1', '新问题')] })]);
  assert.equal(other.code, 4);
  assert.match(other.stderr, /包里写的库名是「别的库」，秒懂上 aaaa0001 叫「售后 FAQ」/);
  const missing = await md(['kb', 'import', writePackage({ manifest: manifestFor(`ffff${'0'.repeat(28)}`, 'x'), faqs: [faq('f1', '新问题')] })]);
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /本机身份能看到的企业里都没有知识库 ffff0000/);
});

test('md kb import：包格式不对——列出错误，退出码 1', async () => {
  const r = await md(['kb', 'import', writePackage({ docs: [doc('d1', '价格表', [])] })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /导入包有 1 处不对/);
  assert.match(r.stderr, /docs\.jsonl 第 1 行：至少要有一段/);
});

test('md kb import：计划码不对就停（退出码 5），一条都不写', async () => {
  const dir = writePackage(goodPackage());
  const before = server.writes().length;
  const r = await md(['kb', 'import', dir, '--confirm', 'deadbeef']);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /计划码对不上/);
  assert.equal(server.writes().length, before);
  assert.deepEqual(server.unexpected(), []);
});
