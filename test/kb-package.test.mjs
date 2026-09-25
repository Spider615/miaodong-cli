// 导入包的读取和严格校验（spec 3b §3）：有一处不对就一条都不写，错误一次全列出来
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPackage, readPackage } from '../src/kb-package.mjs';
import { KB_FAQ } from './helpers/kb-fixtures.mjs';
import { doc, faq, manifestFor, writePackage } from './helpers/kb-import-fixtures.mjs';

const errorsOf = (spec) => readPackage(writePackage(spec)).errors;

test('kb package：读出 manifest、FAQ、文件、要删的；问题、答案、段落去掉首尾空白', () => {
  const dir = writePackage({
    faqs: [faq('f1', '  课程怎么退款 ', ' 在订单页申请。\n')],
    docs: [doc('d1', '价格表', [' 第一段 ', '第二段'])],
    deletes: [{ type: 'faq', id: 7002, question: '退款多久到账' }, { type: 'doc', id: 501, name: '手册.pdf' }],
  });
  const p = loadPackage(dir);
  assert.equal(p.kb.id, KB_FAQ);
  assert.equal(p.kb.name, '售后 FAQ');
  assert.deepEqual(p.faqs, [{ key: 'f1', question: '课程怎么退款', answer: '在订单页申请。' }]);
  assert.deepEqual(p.docs, [{ key: 'd1', name: '价格表', paragraphs: ['第一段', '第二段'] }]);
  assert.deepEqual(p.deletes, [{ type: 'faq', id: 7002, question: '退款多久到账' }, { type: 'doc', id: 501, name: '手册.pdf' }]);
  assert.match(p.fingerprint, /^[0-9a-f]{64}$/);
});

test('kb package：指纹跟着内容走——包里任何一个文件改了，指纹就变', () => {
  const dir = writePackage({ faqs: [faq('f1', '课程怎么退款')] });
  const before = loadPackage(dir).fingerprint;
  assert.equal(loadPackage(dir).fingerprint, before);
  writeFileSync(join(dir, 'faqs.jsonl'), JSON.stringify(faq('f1', '课程怎么退费')));
  assert.notEqual(loadPackage(dir).fingerprint, before);
});

test('kb package：有错时全列出来（文件和行号），loadPackage 报错、一条都不接', () => {
  const dir = writePackage({
    faqs: [faq('f1', '课程怎么退款'), '{不是 JSON', { key: 'f3', question: ' ', answer: '有答案' }, { key: 'f4', question: '课程 怎么退款', answer: 'x' }],
  });
  const { errors } = readPackage(dir);
  assert.deepEqual(errors, [
    'faqs.jsonl 第 2 行：不是合法的 JSON',
    'faqs.jsonl 第 3 行：question 不能是空的',
    'faqs.jsonl 第 4 行：问题和第 1 行重复（去掉空白后一样）',
  ]);
  assert.throws(() => loadPackage(dir), (e) => e.code === 'kb_package_invalid' && /导入包有 3 处不对/.test(e.message) && /第 2 行/.test(e.message));
});

test('kb package：不认识的字段报错，不静默丢掉（比如以为能导图片附件）', () => {
  assert.deepEqual(errorsOf({ faqs: [{ key: 'f1', question: 'q', answer: 'a', materials: [] }] }), ['faqs.jsonl 第 1 行：不认识的字段 materials（图片、素材附件还不支持）']);
  assert.deepEqual(errorsOf({ manifest: { ...manifestFor(), extra: 1 }, faqs: [faq('f1', 'q')] }), ['manifest.json：不认识的字段 extra']);
});

test('kb package：key 唯一（FAQ 和文件共用一套）、格式受限', () => {
  assert.deepEqual(errorsOf({ faqs: [faq('k1', 'q1')], docs: [doc('k1', '文件', ['段'])] }), ['docs.jsonl 第 1 行：key k1 和 faqs.jsonl 第 1 行重复']);
  assert.deepEqual(errorsOf({ faqs: [faq('坏 key', 'q1')] }), ['faqs.jsonl 第 1 行：key 只能用字母、数字、- 和 _，最长 64']);
});

test('kb package：文件名 1～30 字、包内不重复；段落不能空、不超过 1000 字；至少一段', () => {
  const long = '字'.repeat(31);
  assert.deepEqual(errorsOf({
    docs: [
      doc('d1', long, ['段']),
      doc('d2', '价格表', []),
      doc('d3', '价格表', ['   ', '字'.repeat(1001)]),
    ],
  }), [
    'docs.jsonl 第 1 行：文件名最多 30 字（现在 31 字）',
    'docs.jsonl 第 2 行：至少要有一段',
    'docs.jsonl 第 3 行：文件名和第 2 行重复',
    'docs.jsonl 第 3 行：第 1 段是空的',
    'docs.jsonl 第 3 行：第 2 段有 1001 字，最多 1000 字',
  ]);
});

test('kb package：要删的写精确 id 和名字；同一个对象不能写两次', () => {
  assert.deepEqual(errorsOf({
    deletes: [
      { type: 'faq', id: 7002 },
      { type: 'doc', id: 'x', name: '手册.pdf' },
      { type: 'web', id: 1, name: 'x' },
      { type: 'faq', id: 7003, question: '怎么修改收货地址' },
      { type: 'faq', id: 7003, question: '怎么修改收货地址' },
    ],
  }), [
    'deletes.jsonl 第 1 行：要删的 FAQ 要写 question（用来核对没删错）',
    'deletes.jsonl 第 2 行：id 要是正整数',
    'deletes.jsonl 第 3 行：type 只能是 faq 或 doc',
    'deletes.jsonl 第 5 行：和第 4 行删的是同一个',
  ]);
});

test('kb package：必须写明来源资料（文件名 + sha256）：没有来源的包不接；包里至少有一条操作', () => {
  const m = manifestFor();
  assert.deepEqual(errorsOf({ manifest: { ...m, source: { files: [] } }, faqs: [faq('f1', 'q')] }), ['manifest.json：source.files 至少要有一个来源资料（只有处理客户资料时才写库）']);
  assert.deepEqual(errorsOf({ manifest: { ...m, source: { files: [{ name: 'a.docx', sha256: '123' }] } }, faqs: [faq('f1', 'q')] }), ['manifest.json：source.files 第 1 个的 sha256 要是 64 位十六进制']);
  assert.deepEqual(errorsOf({}), ['导入包里没有任何操作：faqs.jsonl、docs.jsonl、deletes.jsonl 至少要有一条']);
  assert.deepEqual(errorsOf({ manifest: null, faqs: [faq('f1', 'q')] }), ['缺 manifest.json']);
  assert.deepEqual(errorsOf({ manifest: { ...m, schema: 2 }, faqs: [faq('f1', 'q')] }), ['manifest.json：schema 只能是 1']);
});
