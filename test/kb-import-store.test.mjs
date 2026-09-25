// 导入记录的本地存储（spec 3b §6）：包拷一份、状态、日志、备份；按导入 id 找回；目录 0700、内容文件 0600
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadPackage } from '../src/kb-package.mjs';
import { appendLog, createRecord, listRecords, loadRecord, readBackupDocs, readBackupFaqs, saveBackupDoc, saveBackupFaqs, saveState } from '../src/kb-import-store.mjs';
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
    schema: 1, importId: rec.importId, region, org, kb, fingerprint: pkg.fingerprint, createdAt: 'x', status: 'new',
    steps: {}, stopped: null, faqIds: {}, docIds: {}, deleted: { faq: [], doc: [] }, indexed: { faq: [], doc: [] }, revoke: null,
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
