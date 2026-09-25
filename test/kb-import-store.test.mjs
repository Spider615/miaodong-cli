// 导入记录的本地存储（spec 3b §6）：包拷一份、状态、日志、备份；按导入 id 找回；目录 0700、内容文件 0600
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadPackage } from '../src/kb-package.mjs';
import { activeImport, appendLog, claimedIds, createRecord, listRecords, loadRecord, lockKb, readBackupDocs, readBackupFaqs, saveBackupDoc, saveBackupFaqs, saveState } from '../src/kb-import-store.mjs';
import { tempHome } from './helpers/run-cli.mjs';
import { KB_FAQ } from './helpers/kb-fixtures.mjs';
import { faq, writePackage } from './helpers/kb-import-fixtures.mjs';

const region = { identityKey: 'k1', label: '测试区' };
const org = { id: 'org-1', name: '兴趣岛平台' };
const kb = { id: KB_FAQ, name: '售后 FAQ' };
beforeEach(() => { process.env.MD_HOME = join(tempHome(), 'md'); });
const mode = (p) => statSync(p).mode & 0o777;

test('kb import store：新建记录——导入 id 是时间加包指纹前 4 位，包拷一份，状态从头开始；权限 0700 / 0600', () => {
  const pkg = loadPackage(writePackage({ faqs: [faq('f1', '课程怎么退款')] }));
  const rec = createRecord({ region, org, kb, pkg, now: new Date(2026, 8, 25, 20, 30, 0) });
  assert.equal(rec.importId, `20260925-203000-${pkg.fingerprint.slice(0, 4)}`);
  assert.ok(rec.dir.startsWith(join(process.env.MD_HOME, 'kb-imports', 'k1', KB_FAQ.slice(0, 8))));
  assert.equal(readFileSync(join(rec.dir, 'package', 'faqs.jsonl'), 'utf-8'), readFileSync(join(pkg.dir, 'faqs.jsonl'), 'utf-8'));
  assert.equal(existsSync(join(rec.dir, 'package', 'docs.jsonl')), false);
  assert.deepEqual({ ...rec.state, createdAt: 'x' }, {
    schema: 1, importId: rec.importId, region, org, kb, fingerprint: pkg.fingerprint, contentHash: pkg.contentHash, createdAt: 'x', status: 'new',
    steps: {}, stopped: null, faqIds: {}, docIds: {}, deleted: { faq: [], doc: [] }, indexed: { faq: [], doc: [] }, open: null, revoke: null,
  });
  assert.equal(mode(rec.dir), 0o700);
  assert.equal(mode(join(rec.dir, 'state.json')), 0o600);
  assert.equal(mode(join(rec.dir, 'package', 'faqs.jsonl')), 0o600);
});

test('kb import store：按导入 id 找回记录（包从记录里的拷贝读，不依赖原来的目录）；改状态、写日志', () => {
  const pkg = loadPackage(writePackage({ faqs: [faq('f1', '课程怎么退款')] }));
  const rec = createRecord({ region, org, kb, pkg });
  saveState(rec.dir, { ...rec.state, status: 'running', faqIds: { f1: 90001 } });
  appendLog(rec.dir, { op: 'batch-create', count: 1 });
  appendLog(rec.dir, { op: 'batch-review', count: 1, ids: [90001] });
  const back = loadRecord(rec.importId);
  assert.equal(back.dir, rec.dir);
  assert.deepEqual([back.state.status, back.state.faqIds], ['running', { f1: 90001 }]);
  assert.deepEqual(back.pkg.faqs, [{ key: 'f1', question: '课程怎么退款', answer: '课程怎么退款的答案。' }]);
  const log = readFileSync(join(rec.dir, 'log.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => [l.op, l.count]), [['batch-create', 1], ['batch-review', 1]]);
  assert.ok(log.every((l) => typeof l.at === 'string'));
  assert.equal(mode(join(rec.dir, 'log.jsonl')), 0o600);
  assert.throws(() => loadRecord('20990101-000000-zzzz'), (e) => e.code === 'kb_import_not_found' && e.exitCode === 4);
});

test('kb import store：备份——要删的 FAQ 原始行、文件详情 + 全部段落 + 原文件，原样存、原样读回', () => {
  const pkg = loadPackage(writePackage({ faqs: [faq('f1', 'q')] }));
  const rec = createRecord({ region, org, kb, pkg });
  saveBackupFaqs(rec.dir, [{ id: 7002, question: '退款多久到账', answer: 'a', isReviewed: true, materials: [], mhMaterialIds: [] }]);
  saveBackupDoc(rec.dir, { detail: { id: 501, name: '手册.pdf', abstract: '摘要', paragraphCount: 2, docUrl: 'https://x/手册.pdf', extension: 'pdf' }, paragraphs: [{ id: 9001, index: 0, content: '一' }, { id: 9002, index: 1, content: '二' }], original: Buffer.from('原文件') });
  assert.deepEqual(readBackupFaqs(rec.dir).map((f) => f.id), [7002]);
  const [d] = readBackupDocs(rec.dir);
  assert.deepEqual([d.detail.name, d.paragraphs.map((p) => p.content)], ['手册.pdf', ['一', '二']]);
  assert.equal(readFileSync(d.originalFile, 'utf-8'), '原文件');
  assert.equal(mode(d.originalFile), 0o600);
});

test('kb import store：列出本机全部导入记录，新的在前', () => {
  const a = createRecord({ region, org, kb, pkg: loadPackage(writePackage({ faqs: [faq('f1', 'q1')] })), now: new Date(2026, 8, 25, 10, 0, 0) });
  const b = createRecord({ region, org, kb, pkg: loadPackage(writePackage({ faqs: [faq('f1', 'q2')] })), now: new Date(2026, 8, 25, 11, 0, 0) });
  assert.deepEqual(listRecords().map((r) => r.state.importId), [b.importId, a.importId]);
});

test('kb import store：包拷的是读到、对过指纹的那一份（读完之后目录里的包被改了也不影响，审查 I1）；续跑、撤回按 parsed.json 读，不重新校验', () => {
  const dir = writePackage({ faqs: [faq('f1', '课程怎么退款')] });
  const original = readFileSync(join(dir, 'faqs.jsonl'), 'utf-8');
  const pkg = loadPackage(dir);
  writeFileSync(join(dir, 'faqs.jsonl'), JSON.stringify(faq('f1', '课程怎么退款', '被偷偷改过的答案')));
  const rec = createRecord({ region, org, kb, pkg });
  assert.equal(readFileSync(join(rec.dir, 'package', 'faqs.jsonl'), 'utf-8'), original);
  assert.equal(mode(join(rec.dir, 'package', 'parsed.json')), 0o600);
  const back = loadRecord(rec.importId);
  assert.deepEqual(back.pkg.faqs, [{ key: 'f1', question: '课程怎么退款', answer: '课程怎么退款的答案。' }]);
  // 记录里的包和状态对不上（被人改过）就不认
  writeFileSync(join(rec.dir, 'package', 'parsed.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(rec.dir, 'package', 'parsed.json'), 'utf-8')), fingerprint: 'x' }));
  assert.throws(() => loadRecord(rec.importId), (e) => e.code === 'kb_import_corrupt');
});

test('kb import store：记录目录里的 .DS_Store、锁文件这些不是目录的，列记录、读备份时跳过（审查 I5）', () => {
  const rec = createRecord({ region, org, kb, pkg: loadPackage(writePackage({ faqs: [faq('f1', 'q')] })) });
  saveBackupDoc(rec.dir, { detail: { id: 501, name: '手册.pdf' }, paragraphs: [], original: null });
  writeFileSync(join(rec.dir, 'backup', 'docs', '.DS_Store'), 'x');
  mkdirSync(join(rec.dir, 'backup', 'docs', 'not-an-id'));
  for (const d of [join(process.env.MD_HOME, 'kb-imports'), join(process.env.MD_HOME, 'kb-imports', 'k1'), join(rec.dir, '..')]) writeFileSync(join(d, '.DS_Store'), 'x');
  assert.deepEqual(readBackupDocs(rec.dir).map((d) => d.detail.id), [501]);
  assert.deepEqual(listRecords().map((r) => r.state.importId), [rec.importId]);
});

test('kb import store：本机导入记录认下的 id（导入建的、撤回重建的）按库汇总；同一个包没撤回的导入找得到', () => {
  const pkg = loadPackage(writePackage({ faqs: [faq('f1', 'q')] }));
  const a = createRecord({ region, org, kb, pkg });
  saveState(a.dir, { ...a.state, faqIds: { f1: 90001 }, docIds: { d1: 9001 }, revoke: { faqIds: { 7002: 90005 }, docIds: {} } });
  const other = createRecord({ region, org, kb: { id: `bbbb${KB_FAQ.slice(4)}`, name: '别的库' }, pkg });
  saveState(other.dir, { ...other.state, faqIds: { f1: 1 } });
  const ids = claimedIds('k1', KB_FAQ);
  assert.deepEqual([[...ids.faq].sort(), [...ids.doc]], [[90001, 90005], [9001]]);
  assert.equal(activeImport('k1', KB_FAQ, pkg.contentHash).state.importId, a.importId);
  saveState(a.dir, { ...loadRecord(a.importId).state, status: 'revoked' });
  assert.equal(activeImport('k1', KB_FAQ, pkg.contentHash), null);
});

test('kb import store：一个库同一时间只能有一个 md 在写——锁着就报 kb_locked（退出码 5）；解锁后能再锁；锁的主人不在了就接过来', () => {
  const release = lockKb('k1', KB_FAQ, '导入 a');
  assert.throws(() => lockKb('k1', KB_FAQ, '导入 b'), (e) => e.code === 'kb_locked' && e.exitCode === 5 && e.message.includes(`pid ${process.pid}`) && e.message.includes('导入 a'));
  lockKb('k1', `cccc${KB_FAQ.slice(4)}`, '别的库')();
  release();
  const again = lockKb('k1', KB_FAQ, '导入 b');
  again();
  const file = join(process.env.MD_HOME, 'kb-imports', 'k1', KB_FAQ.slice(0, 8), '.lock');
  writeFileSync(file, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, what: '崩掉的导入' }));
  const taken = lockKb('k1', KB_FAQ, '导入 c');
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).pid, process.pid);
  taken();
  assert.equal(existsSync(file), false);
});

test('kb import store：上一个接管锁的进程死在半路（.lock 和 .lock.takeover 都是死进程留下的）——不自动清接管标记，报 kb_locked，提示人工删', () => {
  const dir = join(process.env.MD_HOME, 'kb-imports', 'k1', KB_FAQ.slice(0, 8));
  mkdirSync(dir, { recursive: true });
  const dead = () => spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: dead(), what: '被杀掉的导入', at: '2026-09-25T00:00:00.000Z' }));
  writeFileSync(join(dir, '.lock.takeover'), JSON.stringify({ pid: dead(), what: '接管到一半被杀掉的', at: '2026-09-25T00:00:01.000Z' }));
  assert.throws(() => lockKb('k1', KB_FAQ, '导入 x'), (e) => e.code === 'kb_locked' && e.exitCode === 5 && e.hint.includes('.lock.takeover'));
  assert.equal(existsSync(join(dir, '.lock.takeover')), true);
});
