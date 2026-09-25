// 导入包（spec 3b §3）：处理客户资料的产物，也是 md 写知识库的唯一输入。
// 一个目录：manifest.json（目标库、来源资料）+ faqs.jsonl（要加的 FAQ）+ docs.jsonl（要加的文件和段落）+ deletes.jsonl（要删的旧 FAQ、旧文件）。
// 校验从严：不认识的字段、重复、超长都报错，错误一次全列出来；有一处不对，一个写请求都不发。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, MdError } from './errors.mjs';

export const LIMITS = Object.freeze({ key: 64, docName: 30, paragraph: 1000 });
const FILES = ['faqs.jsonl', 'docs.jsonl', 'deletes.jsonl'];
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const MATERIAL_FIELDS = new Set(['materials', 'materialList', 'mhMaterialIds']);

const chars = (s) => [...s].length;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const filled = (v) => typeof v === 'string' && v.trim() !== '';
// 判断「是不是同一个问题」：去掉全部空白后比较
export const textKey = (s) => String(s ?? '').replace(/\s+/g, '');

function unknownFields(obj, allowed) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (!extra.length) return null;
  const hint = extra.some((k) => MATERIAL_FIELDS.has(k)) ? '（图片、素材附件还不支持）' : '';
  return `不认识的字段 ${extra.join('、')}${hint}`;
}

function readText(dir, name) {
  const file = join(dir, name);
  return existsSync(file) ? readFileSync(file, 'utf-8') : null;
}

// 逐行解析 JSONL：空行跳过，行号按文件里的实际行算
function parseLines(text, file, errors) {
  const rows = [];
  if (text === null) return rows;
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${file} 第 ${i + 1} 行`;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push(`${where}：不是合法的 JSON`);
      return;
    }
    if (!isObject(value)) {
      errors.push(`${where}：不是一个 JSON 对象`);
      return;
    }
    rows.push({ line: i + 1, where, value });
  });
  return rows;
}

function checkManifest(manifest, errors) {
  const err = (m) => errors.push(`manifest.json：${m}`);
  const unknown = unknownFields(manifest, ['schema', 'kb', 'source']);
  if (unknown) err(unknown);
  if (manifest.schema !== 1) err('schema 只能是 1');
  const kb = isObject(manifest.kb) ? manifest.kb : {};
  if (isObject(manifest.kb)) {
    const u = unknownFields(kb, ['id', 'name']);
    if (u) err(`kb 里${u}`);
  }
  if (!filled(kb.id) || /\s/.test(kb.id)) err('kb.id 要写目标库的完整 id');
  if (!filled(kb.name)) err('kb.name 要写目标库的名字（用来核对没导错库）');
  const source = isObject(manifest.source) ? manifest.source : {};
  if (isObject(manifest.source)) {
    const u = unknownFields(source, ['note', 'files']);
    if (u) err(`source 里${u}`);
  }
  if (source.note !== undefined && typeof source.note !== 'string') err('source.note 要是文字');
  const files = Array.isArray(source.files) ? source.files : [];
  if (!files.length) err('source.files 至少要有一个来源资料（只有处理客户资料时才写库）');
  files.forEach((f, i) => {
    if (!isObject(f)) return err(`source.files 第 ${i + 1} 个要写 name 和 sha256`);
    const u = unknownFields(f, ['name', 'sha256']);
    if (u) err(`source.files 第 ${i + 1} 个${u}`);
    if (!filled(f.name)) err(`source.files 第 ${i + 1} 个要写 name`);
    if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) err(`source.files 第 ${i + 1} 个的 sha256 要是 64 位十六进制`);
  });
  return {
    kb: { id: filled(kb.id) ? kb.id.trim() : '', name: filled(kb.name) ? kb.name.trim() : '' },
    source: { note: typeof source.note === 'string' ? source.note : '', files: files.filter(isObject).map((f) => ({ name: String(f.name ?? ''), sha256: String(f.sha256 ?? '') })) },
  };
}

export function readPackage(dir) {
  const errors = [];
  if (!existsSync(dir)) return { dir, errors: [`找不到导入包目录 ${dir}`] };
  const texts = { 'manifest.json': readText(dir, 'manifest.json'), ...Object.fromEntries(FILES.map((f) => [f, readText(dir, f)])) };
  const fingerprint = createHash('sha256')
    .update(Object.entries(texts).map(([name, text]) => `${name}\n${text ?? ''}\n`).join(''))
    .digest('hex');

  let head = { kb: { id: '', name: '' }, source: { note: '', files: [] } };
  if (texts['manifest.json'] === null) errors.push('缺 manifest.json');
  else {
    let manifest;
    try {
      manifest = JSON.parse(texts['manifest.json']);
    } catch {
      errors.push('manifest.json：不是合法的 JSON');
    }
    if (manifest !== undefined) {
      if (!isObject(manifest)) errors.push('manifest.json：不是一个 JSON 对象');
      else head = checkManifest(manifest, errors);
    }
  }

  const keys = new Map(); // key → { file, line }
  const checkKey = (row, file, errs) => {
    const k = row.value.key;
    if (typeof k !== 'string' || !KEY.test(k)) {
      errs.push('key 只能用字母、数字、- 和 _，最长 64');
      return;
    }
    const seen = keys.get(k);
    if (seen) errs.push(seen.file === file ? `key ${k} 和第 ${seen.line} 行重复` : `key ${k} 和 ${seen.file} 第 ${seen.line} 行重复`);
    else keys.set(k, { file, line: row.line });
  };

  const faqs = [];
  const questions = new Map();
  for (const row of parseLines(texts['faqs.jsonl'], 'faqs.jsonl', errors)) {
    const errs = [];
    const v = row.value;
    const u = unknownFields(v, ['key', 'question', 'answer']);
    if (u) errs.push(u);
    checkKey(row, 'faqs.jsonl', errs);
    if (!filled(v.question)) errs.push('question 不能是空的');
    if (!filled(v.answer)) errs.push('answer 不能是空的');
    if (filled(v.question)) {
      const q = textKey(v.question);
      if (questions.has(q)) errs.push(`问题和第 ${questions.get(q)} 行重复（去掉空白后一样）`);
      else questions.set(q, row.line);
    }
    errs.forEach((e) => errors.push(`${row.where}：${e}`));
    if (!errs.length) faqs.push({ key: v.key, question: v.question.trim(), answer: v.answer.trim() });
  }

  const docs = [];
  const names = new Map();
  for (const row of parseLines(texts['docs.jsonl'], 'docs.jsonl', errors)) {
    const errs = [];
    const v = row.value;
    const u = unknownFields(v, ['key', 'name', 'paragraphs']);
    if (u) errs.push(u);
    checkKey(row, 'docs.jsonl', errs);
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name) errs.push('文件名不能是空的');
    else if (chars(name) > LIMITS.docName) errs.push(`文件名最多 ${LIMITS.docName} 字（现在 ${chars(name)} 字）`);
    if (name) {
      if (names.has(name)) errs.push(`文件名和第 ${names.get(name)} 行重复`);
      else names.set(name, row.line);
    }
    const paragraphs = Array.isArray(v.paragraphs) ? v.paragraphs : [];
    if (!paragraphs.length) errs.push('至少要有一段');
    paragraphs.forEach((p, i) => {
      if (!filled(p)) errs.push(`第 ${i + 1} 段是空的`);
      else if (chars(p.trim()) > LIMITS.paragraph) errs.push(`第 ${i + 1} 段有 ${chars(p.trim())} 字，最多 ${LIMITS.paragraph} 字`);
    });
    errs.forEach((e) => errors.push(`${row.where}：${e}`));
    if (!errs.length) docs.push({ key: v.key, name, paragraphs: paragraphs.map((p) => p.trim()) });
  }

  const deletes = [];
  const targets = new Map();
  for (const row of parseLines(texts['deletes.jsonl'], 'deletes.jsonl', errors)) {
    const errs = [];
    const v = row.value;
    if (v.type !== 'faq' && v.type !== 'doc') errs.push('type 只能是 faq 或 doc');
    else {
      const label = v.type === 'faq' ? 'question' : 'name';
      const u = unknownFields(v, ['type', 'id', label]);
      if (u) errs.push(u);
      if (!Number.isInteger(v.id) || v.id <= 0) errs.push('id 要是正整数');
      if (!filled(v[label])) errs.push(v.type === 'faq' ? '要删的 FAQ 要写 question（用来核对没删错）' : '要删的文件要写 name（用来核对没删错）');
      const t = `${v.type}#${v.id}`;
      if (!errs.length) {
        if (targets.has(t)) errs.push(`和第 ${targets.get(t)} 行删的是同一个`);
        else targets.set(t, row.line);
      }
    }
    errs.forEach((e) => errors.push(`${row.where}：${e}`));
    if (!errs.length) deletes.push(v.type === 'faq' ? { type: 'faq', id: v.id, question: v.question.trim() } : { type: 'doc', id: v.id, name: v.name.trim() });
  }

  const hasOps = FILES.some((f) => texts[f] !== null && texts[f].trim() !== '');
  if (!hasOps) errors.push('导入包里没有任何操作：faqs.jsonl、docs.jsonl、deletes.jsonl 至少要有一条');
  // raw：读到、算指纹的原文。导入记录拷的就是它，不再回头读目录（确认那一次运行里包被改了也不会拷错，审查 I1）
  return { dir, kb: head.kb, source: head.source, faqs, docs, deletes, fingerprint, raw: texts, errors };
}

export function loadPackage(dir) {
  const pkg = readPackage(dir);
  if (pkg.errors.length) {
    const shown = pkg.errors.slice(0, 30).map((e) => `  - ${e}`).join('\n');
    const more = pkg.errors.length > 30 ? `\n  ……还有 ${pkg.errors.length - 30} 处` : '';
    throw new MdError('kb_package_invalid', `导入包有 ${pkg.errors.length} 处不对（一条都不会写）：\n${shown}${more}`, {
      exitCode: EXIT.ERROR,
      hint: '按上面的文件和行号改导入包，再预演一次',
    });
  }
  return pkg;
}
