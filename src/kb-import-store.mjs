// 导入记录（spec 3b §6）：$MD_HOME/kb-imports/<区>/<知识库 id 前 8 位>/<导入id>/。
// 记下导入包的拷贝、执行前的快照、要删内容的备份、做到哪一步（state.json）、每个写请求（log.jsonl，不记内容）。
// 续跑和撤回全靠它；备份里有客户资料，只存本机：目录 0700，内容文件 0600，不自动清理。
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { EXIT, MdError } from './errors.mjs';
import { ensureDir, ensureNewDir, mdHome, readJson, writeJson } from './home.mjs';
import { loadPackage } from './kb-package.mjs';
import { stamp } from './workspace.mjs';

const safe = (v) => String(v).replace(/[^\w.@-]+/g, '_');
const PACKAGE_FILES = ['manifest.json', 'faqs.jsonl', 'docs.jsonl', 'deletes.jsonl'];
export const importsRoot = () => join(mdHome(), 'kb-imports');

function writeSecret(file, content) {
  ensureDir(dirname(file));
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const jsonl = (rows) => (rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');

export function createRecord({ region, org, kb, pkg, now = new Date() }) {
  const base = join(importsRoot(), safe(region.identityKey), safe(kb.id.slice(0, 8)), `${stamp(now)}-${pkg.fingerprint.slice(0, 4)}`);
  const dir = ensureNewDir(base);
  const importId = basename(dir);
  for (const name of PACKAGE_FILES) {
    const src = join(pkg.dir, name);
    if (existsSync(src)) writeSecret(join(dir, 'package', name), readFileSync(src));
  }
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
    revoke: null,
  };
  saveState(dir, state);
  return { dir, importId, state };
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

export function readBackupDocs(dir) {
  const root = join(dir, 'backup', 'docs');
  if (!existsSync(root)) return [];
  return readdirSync(root).sort((a, b) => Number(a) - Number(b)).map((id) => {
    const docDir = join(root, id);
    const original = readdirSync(docDir).find((n) => n.startsWith('original'));
    return {
      detail: readJson(join(docDir, 'detail.json'), {}),
      paragraphs: readJsonl(join(docDir, 'paragraphs.jsonl')),
      originalFile: original ? join(docDir, original) : null,
    };
  });
}

function recordDirs() {
  const root = importsRoot();
  if (!existsSync(root)) return [];
  const dirs = [];
  for (const region of readdirSync(root)) {
    for (const kb of readdirSync(join(root, region))) {
      for (const id of readdirSync(join(root, region, kb))) {
        if (existsSync(join(root, region, kb, id, 'state.json'))) dirs.push(join(root, region, kb, id));
      }
    }
  }
  return dirs;
}

export function loadRecord(importId) {
  const dir = recordDirs().find((d) => basename(d) === importId);
  if (!dir) throw new MdError('kb_import_not_found', `本机没有导入记录 ${importId}`, { exitCode: EXIT.TARGET, hint: 'md kb imports 看本机有哪些导入记录' });
  return {
    dir,
    state: readJson(join(dir, 'state.json'), null),
    pkg: loadPackage(join(dir, 'package')),
    snapshot: readJson(join(dir, 'snapshot.json'), null),
  };
}

export function listRecords() {
  return recordDirs()
    .map((dir) => ({ dir, state: readJson(join(dir, 'state.json'), null) }))
    .filter((r) => r.state)
    .sort((a, b) => String(b.state.createdAt).localeCompare(String(a.state.createdAt)));
}
