// md kb pull 的本机副本：$MD_HOME/kb/<区>/<知识库 id 前 8 位>/<时间>/（spec 3a §3.3、§4）。
// 知识库内容可能有客户资料：只存本机，不进仓库、不写 cwd；目录 0700（和 md 其他本地数据一样），内容文件 0600。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureNewDir, mdHome, readJson, writeJson } from './home.mjs';
import { stamp } from './workspace.mjs';

const safe = (v) => String(v).replace(/[^\w.@-]+/g, '_');
const jsonl = (rows) => (rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');

function regionRoot(org) {
  return join(mdHome(), 'kb', safe(org.identityKey));
}

export function kbRoot(org, kbId) {
  return join(regionRoot(org), safe(String(kbId).slice(0, 8)));
}

export function savePull(org, kb, data) {
  const dir = ensureNewDir(join(kbRoot(org, kb.id), stamp()));
  for (const [name, rows] of Object.entries(data)) writeFileSync(join(dir, `${name}.jsonl`), jsonl(rows), { mode: 0o600 });
  writeJson(join(dir, 'meta.json'), {
    schema: 1, identityKey: org.identityKey, regionLabel: org.regionLabel, orgId: org.orgId, orgName: org.orgName, kb,
    counts: Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])),
    pulledAt: new Date().toISOString(),
  });
  return dir;
}

// 最近一次写完的副本。目录名是 stamp()（YYYYMMDD-HHMMSS，同一秒再加 -2、-3），按名字排序就是时间顺序；
// meta.json 最后写：没有它就是那次 pull 没写完，跳过、用之前完整的那份（整支审查小问题 8）
function latestIn(root) {
  let names;
  try {
    names = readdirSync(root).filter((n) => /^\d{8}-\d{6}/.test(n)).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = join(root, name);
    const meta = readJson(join(dir, 'meta.json'), null);
    if (!meta?.counts) continue;
    const read = (file) => {
      try {
        return readFileSync(join(dir, `${file}.jsonl`), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    return { dir, meta, faqs: read('faqs'), files: read('files'), paragraphs: read('paragraphs'), webs: read('webs') };
  }
  return null;
}

// 这个企业每个知识库最近一次的副本（md kb find --local 用，不发请求）
export function localCopies(org) {
  let names;
  try {
    names = readdirSync(regionRoot(org));
  } catch {
    return [];
  }
  return names.map((n) => latestIn(join(regionRoot(org), n))).filter((c) => c?.meta?.orgId === org.orgId && c.meta.kb);
}
