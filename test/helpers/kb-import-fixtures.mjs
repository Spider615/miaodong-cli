// 3b 导入包的测试数据：按 spec 3b §3 的格式在临时目录里写一个导入包。默认导入「售后 FAQ」这个库
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './run-cli.mjs';
import { KB_FAQ } from './kb-fixtures.mjs';

export const SOURCE_SHA = 'a'.repeat(64);

export function manifestFor(kbId = KB_FAQ, name = '售后 FAQ', extra = {}) {
  return { schema: 1, kb: { id: kbId, name }, source: { note: '客户 9 月给的售后手册', files: [{ name: '售后手册.docx', sha256: SOURCE_SHA }] }, ...extra };
}

const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');

// rows 里写字符串就原样写一行（用来造坏的 JSON 行）；传 null 表示不写这个文件
export function writePackage({ manifest = manifestFor(), faqs = [], docs = [], deletes = [], dir = join(tempHome(), 'pkg') } = {}) {
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) writeFileSync(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  if (faqs !== null && faqs.length) writeFileSync(join(dir, 'faqs.jsonl'), jsonl(faqs));
  if (docs !== null && docs.length) writeFileSync(join(dir, 'docs.jsonl'), jsonl(docs));
  if (deletes !== null && deletes.length) writeFileSync(join(dir, 'deletes.jsonl'), jsonl(deletes));
  return dir;
}

export const faq = (key, question, answer = `${question}的答案。`) => ({ key, question, answer });
export const doc = (key, name, paragraphs) => ({ key, name, paragraphs });
