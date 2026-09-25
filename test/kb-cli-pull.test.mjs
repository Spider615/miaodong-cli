// md kb pull（spec 3a §3.3）：全部 FAQ（含未审核）、文件和段落拉到本机；条数对不上就报错、不留副本
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ, kbList } from './helpers/kb-fixtures.mjs';

let server;
before(async () => { server = await startKbServer(); });
after(() => server.close());
function home(origin = server.origin) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });

test('md kb pull：FAQ 全部拉到本机（含未审核），摘要里标出未审核；meta 记下条数', async () => {
  const h = home();
  const r = await md(['kb', 'pull', '售后 FAQ'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], '测试区 / 兴趣岛平台 / 售后 FAQ (aaaa0001)');
  assert.match(r.stdout, /FAQ 4（未审核 1 · 疑似重复 0）· 文件 0（未就绪 0）· 段落 0（未就绪 0）· 网页 0/);
  assert.match(r.stdout, /⚠️ 未审核的 1 条 FAQ 检索不到/);
  const dir = r.stdout.match(/已存：(\S+)/)[1];
  assert.ok(dir.startsWith(join(h, 'md', 'kb', 'k1', 'aaaa0001')));
  const rows = readFileSync(join(dir, 'faqs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((f) => f.id), [7001, 7002, 7003, 7004]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')).counts, { faqs: 4, files: 0, paragraphs: 0, webs: 0 });
});

test('md kb pull：文件库拉文件详情和全部段落，标出没处理完的段落', async () => {
  const r = await md(['kb', 'pull', '产品手册']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /文件 1（未就绪 0）· 段落 2（未就绪 1）/);
});

test('md kb pull：拉到的条数和平台显示的对不上就报错、不留副本（接口行为变了的信号）', async () => {
  const drifted = await startKbServer({ kbs: kbList().map((k) => (k.id === KB_FAQ ? { ...k, qaCount: 5 } : k)) });
  try {
    const h = home(drifted.origin);
    const r = await runCli(['kb', 'pull', '售后 FAQ'], { home: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /FAQ 拉到 4 条，平台显示 5 条/);
    assert.equal(existsSync(join(h, 'md', 'kb')), false);
  } finally {
    await drifted.close();
  }
});

test('md kb pull：名字有歧义时列候选（退出码 4）；只调读接口', async () => {
  const r = await md(['kb', 'pull', 'FAQ']);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /「FAQ」匹配到 2 个知识库/);
  assert.deepEqual(server.unexpected(), []);
});
