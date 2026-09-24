// 执行记录的本地落盘：$MD_HOME/execs/<区>/<智能体 id 前 8 位>/。
// 一条详情约 20MB（执行时的画布出现了两份），只存一份；已经结束的执行不会再变，第二次直接读缓存。

import { existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { asArray } from './api.mjs';
import { ensureDir, mdHome, readJson, writeJson } from './home.mjs';
import { stamp } from './workspace.mjs';

export const TERMINAL_STATUSES = new Set(['success', 'error', 'cancelled', 'interrupted', 'merged_skipped', 'terminated', 'continued']);
const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');

export function execRoot(target) {
  return join(mdHome(), 'execs', safe(target.identityKey), safe(String(target.botId).slice(0, 8)));
}

export function execDir(target, execId) {
  return join(execRoot(target), safe(execId));
}

function writeCompact(file, value) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

export function saveSearch(target, meta, rows, file) {
  const path = file ? resolve(file) : join(execRoot(target), `search-${stamp()}.jsonl`);
  ensureDir(dirname(path));
  // 会话变量快照占每条的八成，搜索结果里用不到，不存
  const lines = [JSON.stringify({ kind: 'md-exec-search', ...meta }), ...rows.map(({ sessionMemorySnapshot, ...rest }) => JSON.stringify(rest))];
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

export function loadCachedDetail(dir) {
  const detail = readJson(join(dir, 'detail.json'), null);
  return detail && TERMINAL_STATUSES.has(String(detail.canvasExec?.status)) ? detail : null;
}

export function saveDetail(dir, target, detail) {
  const { rawCanvas, ...canvasExec } = detail.canvasExec ?? {};
  const slim = { ...detail, canvasExec };
  if (!Array.isArray(slim.canvas?.rawCanvas) && Array.isArray(rawCanvas)) slim.canvas = { ...(slim.canvas ?? {}), rawCanvas };
  writeCompact(join(dir, 'detail.json'), slim);
  const { identity, ...where } = target;
  writeJson(join(dir, 'target.json'), where);
  return slim;
}

export function findCachedExec(execId) {
  const root = join(mdHome(), 'execs');
  if (!existsSync(root)) return null;
  const subdirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
  for (const region of subdirs(root)) {
    for (const bot of subdirs(region)) {
      const dir = join(bot, safe(execId));
      const detail = loadCachedDetail(dir);
      const target = readJson(join(dir, 'target.json'), null);
      if (detail && target) return { dir, detail, target };
    }
  }
  return null;
}

export function saveNodes(dir, nodes) {
  const lines = nodes.map(({ metadata, ...node }) => JSON.stringify({
    ...node,
    reasoning: metadata?.reasoningMessage ?? null,
    tokenUsage: metadata?.tokenUsage ?? null,
    promptChars: asArray(metadata?.prompt).reduce((sum, m) => sum + String(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')).length, 0),
    toolCalls: asArray(metadata?.toolCallResults).length,
  }));
  writeFileSync(join(ensureDir(dir), 'nodes.jsonl'), `${lines.join('\n')}\n`);
}
