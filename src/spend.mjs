// 花费：门槛（单次、每日）和账本。
// 账本只追加：开跑前记预估，跑完再追加一行实际花费（同一个 id），读的时候按 id 合并。
// 「今天已花」按本地日期算，有实际用实际，没有用预估——跑到一半中断的也不会漏算。

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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

export const amountOf = (row) => (typeof row.actual === 'number' ? row.actual : typeof row.estimate === 'number' ? row.estimate : 0);

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
