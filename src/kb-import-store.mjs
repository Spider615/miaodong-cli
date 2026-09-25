// 导入记录（spec 3b §6）：$MD_HOME/kb-imports/<区>/<知识库 id 前 8 位>/<导入id>/。
// 记下导入包的拷贝、执行前的快照、要删内容的备份、做到哪一步和认下了哪些 id（state.json）、每个写请求（log.jsonl，不记内容）。
// 续跑和撤回全靠它；备份里有客户资料，只存本机：目录 0700，内容文件 0600，不自动清理。
// 同一个库同一时间只许一个 md 在写：<区>/<知识库 id 前 8 位>/.lock（审查 C2：两个续跑同时跑会重复建）。
import { appendFileSync, chmodSync, existsSync, linkSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { EXIT, MdError } from './errors.mjs';
import { ensureDir, ensureNewDir, mdHome, readJson, writeJson } from './home.mjs';
import { stamp } from './workspace.mjs';

const safe = (v) => String(v).replace(/[^\w.@-]+/g, '_');
const PACKAGE_FILES = ['manifest.json', 'faqs.jsonl', 'docs.jsonl', 'deletes.jsonl'];
export const importsRoot = () => join(mdHome(), 'kb-imports');
const kbDir = (regionKey, kbId) => join(importsRoot(), safe(regionKey), safe(String(kbId).slice(0, 8)));
const dirsIn = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);

function writeSecret(file, content) {
  ensureDir(dirname(file));
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const jsonl = (rows) => (rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');

// 新建一条导入记录。包拷的是 pkg 里读到、对过计划码的原文（raw），不回头读目录（审查 I1）；
// 解析好的内容另存一份 parsed.json，续跑、撤回按它来，不拿以后可能改严的校验规则重新校验一遍（审查 M7）
export function createRecord({ region, org, kb, pkg, now = new Date() }) {
  const base = join(kbDir(region.identityKey, kb.id), `${stamp(now)}-${pkg.fingerprint.slice(0, 4)}`);
  const dir = ensureNewDir(base);
  const importId = basename(dir);
  for (const name of PACKAGE_FILES) {
    if (typeof pkg.raw?.[name] === 'string') writeSecret(join(dir, 'package', name), pkg.raw[name]);
  }
  const parsed = { fingerprint: pkg.fingerprint, kb: pkg.kb, source: pkg.source, faqs: pkg.faqs, docs: pkg.docs, deletes: pkg.deletes };
  writeJson(join(dir, 'package', 'parsed.json'), parsed, { secret: true });
  const state = {
    schema: 1,
    importId,
    region: { identityKey: region.identityKey, label: region.label },
    org: { id: org.id, name: org.name },
    kb: { id: kb.id, name: kb.name },
    fingerprint: pkg.fingerprint,
    createdAt: now.toISOString(),
    status: 'new',
    steps: {},
    stopped: null,
    faqIds: {},
    docIds: {},
    deleted: { faq: [], doc: [] },
    indexed: { faq: [], doc: [] },
    open: null,
    revoke: null,
  };
  saveState(dir, state);
  return { dir, importId, state, pkg: { dir: join(dir, 'package'), ...parsed } };
}

export function saveState(dir, state) {
  writeJson(join(dir, 'state.json'), state, { secret: true });
}

export function appendLog(dir, entry) {
  const file = join(dir, 'log.jsonl');
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function saveSnapshot(dir, snapshot) {
  writeJson(join(dir, 'snapshot.json'), snapshot, { secret: true });
}

export function saveBackupFaqs(dir, rows) {
  writeSecret(join(dir, 'backup', 'faqs.jsonl'), jsonl(rows));
}

export function readBackupFaqs(dir) {
  return readJsonl(join(dir, 'backup', 'faqs.jsonl'));
}

// 一个要删的文件：详情、全部段落、原文件（没有原文件的手工文件，original 为 null）
export function saveBackupDoc(dir, { detail, paragraphs, original }) {
  const docDir = join(dir, 'backup', 'docs', String(detail.id));
  writeJson(join(docDir, 'detail.json'), detail, { secret: true });
  writeSecret(join(docDir, 'paragraphs.jsonl'), jsonl(paragraphs));
  if (original) writeSecret(join(docDir, `original${safe(extname(detail.name ?? '') || (detail.extension ? `.${detail.extension}` : ''))}`), original);
}

// 只认数字名的子目录（文件 id）：用户照撤回预演给的路径在 Finder 里取原文件，会留下 .DS_Store（审查 I5）
export function readBackupDocs(dir) {
  const root = join(dir, 'backup', 'docs');
  return dirsIn(root).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b)).map((id) => {
    const docDir = join(root, id);
    const original = readdirSync(docDir).find((n) => n.startsWith('original'));
    return {
      detail: readJson(join(docDir, 'detail.json'), {}),
      paragraphs: readJsonl(join(docDir, 'paragraphs.jsonl')),
      originalFile: original ? join(docDir, original) : null,
    };
  });
}

// 每一层只看子目录（.DS_Store、.lock 这些文件跳过，审查 I5）
function recordDirs() {
  const root = importsRoot();
  const dirs = [];
  for (const region of dirsIn(root)) {
    for (const kb of dirsIn(join(root, region))) {
      for (const id of dirsIn(join(root, region, kb))) {
        if (existsSync(join(root, region, kb, id, 'state.json'))) dirs.push(join(root, region, kb, id));
      }
    }
  }
  return dirs;
}

export function loadRecord(importId) {
  const dir = recordDirs().find((d) => basename(d) === importId);
  if (!dir) throw new MdError('kb_import_not_found', `本机没有导入记录 ${importId}`, { exitCode: EXIT.TARGET, hint: 'md kb imports 看本机有哪些导入记录' });
  const state = readJson(join(dir, 'state.json'), null);
  const parsed = readJson(join(dir, 'package', 'parsed.json'), null);
  if (!state || !parsed || parsed.fingerprint !== state.fingerprint) {
    throw new MdError('kb_import_corrupt', `导入记录 ${importId} 不完整或被改过（state.json 和 package/parsed.json 对不上）`, { hint: `别手动改导入记录；看一眼 ${dir}` });
  }
  return { dir, state, pkg: { dir: join(dir, 'package'), ...parsed }, snapshot: readJson(join(dir, 'snapshot.json'), null) };
}

export function listRecords() {
  return recordDirs()
    .map((dir) => ({ dir, state: readJson(join(dir, 'state.json'), null) }))
    .filter((r) => r.state)
    .sort((a, b) => String(b.state.createdAt).localeCompare(String(a.state.createdAt)));
}

// 本机这个库的全部导入记录认下的 id（导入建的、撤回重建的）：认 id 时一律排除，免得把别的导入建的认成自己的（审查 C1）
export function claimedIds(regionKey, kbId) {
  const ids = { faq: new Set(), doc: new Set() };
  for (const { state } of listRecords()) {
    if (state.region?.identityKey !== regionKey || state.kb?.id !== kbId) continue;
    for (const book of [state, state.revoke].filter(Boolean)) {
      for (const id of Object.values(book.faqIds ?? {})) ids.faq.add(id);
      for (const id of Object.values(book.docIds ?? {})) ids.doc.add(id);
    }
  }
  return ids;
}

// 同一个库上、同一个导入包（指纹一样）还没撤回的导入记录：有就不许再导一次（审查 I2：同一个计划码能用两次）
export function activeImport(regionKey, kbId, fingerprint) {
  return listRecords().find(({ state }) => state.region?.identityKey === regionKey && state.kb?.id === kbId
    && state.fingerprint === fingerprint && state.status !== 'revoked') ?? null;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// 锁文件的内容：读不出来（正在被别的进程写、坏了）就当不知道是谁
function lockHolder(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// 给这个库上锁，返回解锁函数。先写好临时文件再硬链接成锁文件：锁一出现就带着 pid，不会被读到半截。
// 锁里记着的进程已经不在了（被杀、崩了）就接过来
export function lockKb(regionKey, kbId, what) {
  const file = join(kbDir(regionKey, kbId), '.lock');
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, file);
        return () => {
          if (lockHolder(file)?.pid === process.pid) rmSync(file, { force: true });
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const held = lockHolder(file);
      if (attempt === 0 && Number.isInteger(held?.pid) && !alive(held.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      throw new MdError('kb_locked', `另一个 md 进程（pid ${held?.pid ?? '?'}）正在写这个库（${held?.what ?? '不知道在做什么'}${held?.at ? `，${held.at} 开始` : ''}）`, {
        exitCode: EXIT.BLOCKED,
        hint: `等它做完再来。确认那个进程已经不在了，就删掉 ${file}`,
      });
    }
    throw new MdError('kb_locked', `这个库的锁文件接不过来：${file}`, { exitCode: EXIT.BLOCKED, hint: `确认没有别的 md 在写这个库，就删掉 ${file}` });
  } finally {
    rmSync(tmp, { force: true });
  }
}
