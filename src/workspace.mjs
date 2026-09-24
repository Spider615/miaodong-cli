// 工作副本：一次 pull 一个目录，记下「从哪拉的、拉的是什么」。之后改动、推送都只认这里记的目标，
// 不存在「默认智能体」——会话里推错 / 看错智能体的事故都源于默认值。
// 目录：$MD_HOME/work/<区>/<智能体 id 前 8 位>/<draft 或版本号>-<时间>/
//   meta.json   目标与来源；base.json { canvas, sessions, events } 基线；
//   draft.json  以版本为底时拉取那一刻的草稿；after.json 改后快照；
//   index/      nodes / edges / refs 的 jsonl，反映当前状态（有 after 就用 after），给 jq 查。

import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { EXIT, MdError, usage } from './errors.mjs';
import { ensureDir, mdHome, readJson, writeJson } from './home.mjs';
import { buildIndex } from './graph.mjs';
import { loadIdentities } from './identity.mjs';
import { targetLine } from './output.mjs';

export function workRoot() {
  return join(mdHome(), 'work');
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');

export function createWorkspace(target, label) {
  const parent = join(workRoot(), safe(target.identityKey), safe(target.botId.slice(0, 8)));
  const name = `${safe(label)}-${stamp()}`;
  let dir = join(parent, name);
  for (let i = 2; existsSync(dir); i++) dir = join(parent, `${name}-${i}`);
  ensureDir(dir);
  return dir;
}

export function writeIndex(dir, envelope) {
  const index = buildIndex(envelope.canvas, envelope.events);
  const indexDir = ensureDir(join(dir, 'index'));
  const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(join(indexDir, 'nodes.jsonl'), jsonl(index.nodes));
  writeFileSync(join(indexDir, 'edges.jsonl'), jsonl(index.edges));
  writeFileSync(join(indexDir, 'refs.jsonl'), jsonl(index.refs));
  return index;
}

export function writeWorkspace(dir, { meta, base, draft = null }) {
  writeJson(join(dir, 'meta.json'), meta);
  writeJson(join(dir, 'base.json'), base);
  if (draft) writeJson(join(dir, 'draft.json'), draft);
  writeIndex(dir, base);
  writeFileSync(join(ensureDir(workRoot()), 'LAST'), `${dir}\n`);
}

export function resolveWorkspaceDir(args) {
  if (typeof args.ws === 'string') {
    const dir = resolve(args.ws);
    if (!existsSync(join(dir, 'meta.json'))) throw usage(`不是工作副本：${dir}`);
    return dir;
  }
  const lastFile = join(workRoot(), 'LAST');
  if (!existsSync(lastFile)) {
    throw new MdError('no_workspace', '还没有工作副本', { exitCode: EXIT.TARGET, hint: '先 md pull --bot <智能体>' });
  }
  const dir = readFileSync(lastFile, 'utf-8').trim();
  if (!existsSync(join(dir, 'meta.json'))) {
    throw new MdError('no_workspace', `最近的工作副本已不存在：${dir}`, { exitCode: EXIT.TARGET, hint: '重新 md pull' });
  }
  return dir;
}

export function loadWorkspace(args) {
  const dir = resolveWorkspaceDir(args);
  const meta = readJson(join(dir, 'meta.json'));
  const base = readJson(join(dir, 'base.json'));
  const after = readJson(join(dir, 'after.json'), null);
  return { dir, meta, base, after, current: after ?? base };
}

export function versionLabelOf(meta) {
  if (meta.source?.kind !== 'version') return '草稿';
  return `${meta.source.version}${meta.source.name ? `（${meta.source.name}）` : ''}`;
}

export function wsLine(ws) {
  return `${targetLine({ ...ws.meta, versionLabel: versionLabelOf(ws.meta) })}${ws.after ? ' · 含未推送改动' : ''}`;
}

export function targetFromMeta(meta) {
  const identity = loadIdentities()[meta.identityKey];
  if (!identity) {
    throw new MdError('no_identity', `这属于「${meta.regionLabel}」，但本机没有这个区的身份`, {
      exitCode: EXIT.AUTH,
      hint: `md auth snippet ${meta.origin}`,
    });
  }
  return {
    identityKey: meta.identityKey, regionLabel: meta.regionLabel, orgId: meta.orgId, orgName: meta.orgName,
    botId: meta.botId, botName: meta.botName, identity,
  };
}

export function saveMeta(dir, meta) {
  writeJson(join(dir, 'meta.json'), meta);
}

export function saveAfter(dir, envelope) {
  writeJson(join(dir, 'after.json'), envelope);
  writeIndex(dir, envelope);
}

export function clearAfter(dir, base) {
  rmSync(join(dir, 'after.json'), { force: true });
  rmSync(join(dir, 'transforms'), { recursive: true, force: true });
  writeIndex(dir, base);
}

export function listTransforms(dir) {
  const transformsDir = join(dir, 'transforms');
  if (!existsSync(transformsDir)) return [];
  return readdirSync(transformsDir).filter((name) => name.endsWith('.mjs')).sort().map((name) => join(transformsDir, name));
}

export function recordTransform(dir, file) {
  const transformsDir = ensureDir(join(dir, 'transforms'));
  const dest = join(transformsDir, `${String(listTransforms(dir).length + 1).padStart(3, '0')}-${basename(file)}`);
  copyFileSync(file, dest);
  return dest;
}

export function listWorkspaces() {
  const root = workRoot();
  if (!existsSync(root)) return [];
  const subdirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
  const dirs = [];
  for (const region of subdirs(root)) {
    for (const bot of subdirs(region)) {
      for (const ws of subdirs(bot)) if (existsSync(join(ws, 'meta.json'))) dirs.push(ws);
    }
  }
  return dirs
    .map((dir) => ({ dir, meta: readJson(join(dir, 'meta.json')), hasAfter: existsSync(join(dir, 'after.json')) }))
    .sort((a, b) => String(b.meta.pulledAt).localeCompare(String(a.meta.pulledAt)));
}

// 试跑前要知道「本地改了还没推」：看这个智能体最近拉的那个工作副本
export function latestWorkspaceFor(botId) {
  const hit = listWorkspaces().find((w) => w.meta.botId === botId);
  return hit ? loadWorkspace({ ws: hit.dir }) : null;
}
