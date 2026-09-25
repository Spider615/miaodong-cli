// 导入记录（spec 3b §6）：$MD_HOME/kb-imports/<区>/<知识库 id 前 8 位>/<导入id>/。
// 记下导入包的拷贝、执行前的快照、要删内容的备份、做到哪一步和认下了哪些 id（state.json）、每个写请求（log.jsonl，不记内容）。
// 续跑和撤回全靠它；备份里有客户资料，只存本机：目录 0700，内容文件 0600，不自动清理。
// 同一个库同一时间只许一个 md 在写：<区>/<知识库 id 前 8 位>/.lock（审查 C2：两个续跑同时跑会重复建）。
import { appendFileSync, chmodSync, existsSync, linkSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { hostname } from 'node:os';
import { EXIT, MdError } from './errors.mjs';
import { ensureDir, ensureNewDir, mdHome, readJson, writeJson } from './home.mjs';
import { stamp } from './workspace.mjs';

const safe = (v) => String(v).replace(/[^\w.@-]+/g, '_');
const HOST = hostname();
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
  const parsed = { fingerprint: pkg.fingerprint, contentHash: pkg.contentHash, kb: pkg.kb, source: pkg.source, faqs: pkg.faqs, docs: pkg.docs, deletes: pkg.deletes };
  writeJson(join(dir, 'package', 'parsed.json'), parsed, { secret: true });
  const state = {
    schema: 1,
    importId,
    region: { identityKey: region.identityKey, label: region.label },
    org: { id: org.id, name: org.name },
    kb: { id: kb.id, name: kb.name },
    fingerprint: pkg.fingerprint,
    contentHash: pkg.contentHash,
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

// sub：导入删旧的之前备份在 backup/；撤回删这次建的之前，把它们当时的内容备份在 revoke-backup/（被人改过的也能找回来）
export function saveBackupFaqs(dir, rows, sub = 'backup') {
  writeSecret(join(dir, sub, 'faqs.jsonl'), jsonl(rows));
}

export function readBackupFaqs(dir, sub = 'backup') {
  return readJsonl(join(dir, sub, 'faqs.jsonl'));
}

// 一个要删的文件：详情、全部段落、原文件（没有原文件的手工文件，original 为 null）
export function saveBackupDoc(dir, { detail, paragraphs, original }, sub = 'backup') {
  const docDir = join(dir, sub, 'docs', String(detail.id));
  writeJson(join(docDir, 'detail.json'), detail, { secret: true });
  writeSecret(join(docDir, 'paragraphs.jsonl'), jsonl(paragraphs));
  if (original) writeSecret(join(docDir, `original${safe(extname(detail.name ?? '') || (detail.extension ? `.${detail.extension}` : ''))}`), original);
}

// 只认数字名的子目录（文件 id）：用户照撤回预演给的路径在 Finder 里取原文件，会留下 .DS_Store（审查 I5）
export function readBackupDocs(dir, sub = 'backup') {
  const root = join(dir, sub, 'docs');
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
      for (const id of book.extras?.faq ?? []) ids.faq.add(id);
      for (const id of book.extras?.doc ?? []) ids.doc.add(id);
    }
  }
  return ids;
}

// 同一个库上、同一个导入包（内容一样，不看空白）的导入记录
const sameContent = (regionKey, kbId, contentHash) => listRecords().filter(({ state }) => state.region?.identityKey === regionKey
  && state.kb?.id === kbId && (state.contentHash ?? state.fingerprint) === contentHash);

// 还没撤回的那一条：有就不许再导一次（审查 I2）
export function activeImport(regionKey, kbId, contentHash) {
  return sameContent(regionKey, kbId, contentHash).find(({ state }) => state.status !== 'revoked') ?? null;
}

// 这个包在这个库上导过几次（进计划码：导过一次、撤回了，旧计划码也作废，要重新预演、重新问用户，复审 Important 4）
export function importCount(regionKey, kbId, contentHash) {
  return sameContent(regionKey, kbId, contentHash).length;
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

// 锁的主人确实不在了：同一台机器上、进程已经没了（别的机器上的锁判断不了，不接管）
const dead = (held) => Number.isInteger(held?.pid) && (held.host ?? HOST) === HOST && !alive(held.pid);
const sameHolder = (a, b) => a && b && a.pid === b.pid && a.at === b.at && a.host === b.host;

// 给这个库上锁，返回解锁函数。先写好临时文件再硬链接成锁文件：锁一出现就带着 pid，不会被读到半截。
// 锁的主人已经不在了（被杀、崩了）就接过来：先原子地抢一把接管标记（.lock.takeover），抢到了再读一遍锁，
// 还是刚才那条死记录才删——不然两个进程同时接管，一个删掉另一个刚拿到的锁，两个都以为自己拿到了（复审 Important 5）。
// 接管标记本身不自动清（接管的进程死在半路时要人工删），自动清会重新打开同样的竞态
export function lockKb(regionKey, kbId, what) {
  const file = join(kbDir(regionKey, kbId), '.lock');
  const takeover = `${file}.takeover`;
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const me = { pid: process.pid, host: HOST, what, at: new Date().toISOString() };
  writeFileSync(tmp, JSON.stringify(me), { mode: 0o600 });
  const release = () => {
    if (sameHolder(lockHolder(file), me)) rmSync(file, { force: true });
  };
  const blocked = (held) => new MdError('kb_locked', `另一个 md 进程（pid ${held?.pid ?? '?'}${held?.host && held.host !== HOST ? `，在 ${held.host} 上` : ''}）正在写这个库（${held?.what ?? '不知道在做什么'}${held?.at ? `，${held.at} 开始` : ''}）`, {
    exitCode: EXIT.BLOCKED,
    hint: `等它做完再来。确认那个进程已经不在了，就删掉 ${file}`,
  });
  const grab = (path) => {
    try {
      linkSync(tmp, path);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
  };
  try {
    if (grab(file)) return release;
    const held = lockHolder(file);
    if (!dead(held)) throw blocked(held);
    if (!grab(takeover)) {
      // 别人正在接管；或者上一个接管的进程死在了半路（极少见）。接管标记不自动清：自动清又会让两个进程同时接管（复审）
      const taker = lockHolder(takeover);
      if (!dead(taker)) throw blocked(taker ?? held);
      throw new MdError('kb_locked', `这个库的锁上次接管到一半、接管的进程（pid ${taker.pid}）没做完就退出了`, {
        exitCode: EXIT.BLOCKED,
        hint: `确认没有别的 md 在写这个库，就把 ${takeover} 和 ${file} 两个文件都删掉，再运行一次`,
      });
    }
    try {
      if (sameHolder(lockHolder(file), held)) rmSync(file, { force: true });
      if (grab(file)) return release;
      throw blocked(lockHolder(file));
    } finally {
      if (sameHolder(lockHolder(takeover), me)) rmSync(takeover, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}
