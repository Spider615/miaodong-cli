// 花费：门槛（单次、每日）和账本。
// 账本只追加：开跑前记预估，跑完再追加一行实际花费（同一个 id），读的时候按 id 合并。
// 「今天已花」按本地日期算，有实际用实际，没有用预估——跑到一半中断的也不会漏算。

import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MdError } from './errors.mjs';
import { ensureDir, mdHome, readJson, writeJson } from './home.mjs';

export const DEFAULT_LIMITS = Object.freeze({ perCommand: 2, perDay: 10 });

const configPath = () => join(mdHome(), 'config.json');
const spendPath = () => join(mdHome(), 'spend.jsonl');

export function loadLimits() {
  const spend = readJson(configPath(), {})?.spend ?? {};
  const pick = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  return { perCommand: pick(spend.perCommand, DEFAULT_LIMITS.perCommand), perDay: pick(spend.perDay, DEFAULT_LIMITS.perDay) };
}

export function saveLimits({ perCommand, perDay }) {
  const config = readJson(configPath(), {});
  writeJson(configPath(), { ...config, spend: { perCommand, perDay } });
}

export function recordSpend(entry) {
  const row = { id: randomUUID(), at: new Date().toISOString(), actual: null, ...entry };
  ensureDir(mdHome());
  appendFileSync(spendPath(), `${JSON.stringify(row)}\n`);
  return row.id;
}

export function updateSpend(id, patch) {
  ensureDir(mdHome());
  appendFileSync(spendPath(), `${JSON.stringify({ id, ...patch })}\n`);
}

export function readSpends() {
  if (!existsSync(spendPath())) return [];
  const byId = new Map();
  for (const line of readFileSync(spendPath(), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row?.id) continue;
    byId.set(row.id, { ...(byId.get(row.id) ?? {}), ...row });
  }
  return [...byId.values()];
}

// 一笔算多少钱：跑完的 = 实际 + 花费不知道那几次的保守估计（assumed）；还没跑完的按开跑前的预留（估不出时也有预留）
export function amountOf(row) {
  if (typeof row.actual === 'number') return row.actual + (typeof row.assumed === 'number' ? row.assumed : 0);
  if (typeof row.reserve === 'number') return row.reserve;
  return typeof row.estimate === 'number' ? row.estimate : 0;
}

export const dayKey = (value = Date.now()) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function spentOn(rows, when = Date.now()) {
  const key = dayKey(when);
  return rows.filter((r) => dayKey(r.at) === key).reduce((sum, r) => sum + amountOf(r), 0);
}

// 要不要用户确认。estimate 为 null = 估不出花费
export function spendDecision({ estimate, externalCalls = [] }, { limits, today }) {
  const reasons = [];
  if (externalCalls.length) reasons.push(`会真的调用外部系统：${externalCalls.join('、')}`);
  if (estimate === null) {
    reasons.push('估不出花费');
    if (today >= limits.perDay) reasons.push(`今天已到每日上限 ¥${limits.perDay}`);
  } else {
    if (estimate > limits.perCommand) reasons.push(`预计 ¥${estimate.toFixed(2)}，超过单次门槛 ¥${limits.perCommand}`);
    if (today + estimate > limits.perDay) reasons.push(`今天已花 ¥${today.toFixed(2)}，加上这次超过每日上限 ¥${limits.perDay}`);
  }
  return { needApproval: reasons.length > 0, reasons };
}

// 「查今天已花 → 判断 → 记一笔」要一个一个来（审查 I3）：几条命令同时读到同一个「今天已花」，会一起越过每日上限。
// 锁是 $MD_HOME/spend.lock（O_EXCL 建文件）；里面不做网络请求，毫秒级。进程被杀留下的锁 30 秒后清掉
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;

export async function withSpendLock(fn) {
  ensureDir(mdHome());
  const lock = join(mdHome(), 'spend.lock');
  const started = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue;
      }
      if (stale) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new MdError('spend_locked', `另一条花钱的命令正在记账，等了 ${LOCK_WAIT_MS / 1000} 秒还没好`, { hint: `过一会儿再试；一直这样就删掉 ${lock}` });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
