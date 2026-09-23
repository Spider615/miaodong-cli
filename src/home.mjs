// md 的全部本地状态都在 $MD_HOME（默认 ~/.miaodong/md）：身份、缓存、工作副本、账本。
// 不写仓库、不写 cwd：画布和执行记录含真实用户数据，写进仓库迟早被 commit。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MdError } from './errors.mjs';

export function mdHome() {
  return process.env.MD_HOME ? resolve(process.env.MD_HOME) : join(homedir(), '.miaodong', 'md');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJson(file, fallback, { secret = false } = {}) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    // 身份文件损坏时不能带出 e.message：Node 22 的 JSON 报错会附带原文片段，可能含 token
    if (secret) throw new MdError('corrupt_file', `本地身份文件损坏：${file}`, { hint: '删掉它后重新取身份' });
    throw new MdError('corrupt_file', `JSON 文件损坏：${file}（${error.message}）`);
  }
}

export function writeJson(file, value, { secret = false } = {}) {
  ensureDir(dirname(file));
  // 先写临时文件再改名：写到一半被打断也不会留下半个 JSON
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
  renameSync(tmp, file);
  if (secret) chmodSync(file, 0o600);
}
