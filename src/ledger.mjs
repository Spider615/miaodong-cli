// 账本：每次推送 / 回滚一行 JSON。「今天改了哪些节点、推没推、推到哪个智能体」靠它回答，
// 不靠 AI 的记忆——会话里用户为这类问题追问过 14 次。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, mdHome } from './home.mjs';

export function ledgerPath() {
  return join(mdHome(), 'ledger.jsonl');
}

export function appendLedger(entry) {
  ensureDir(mdHome());
  appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`);
}

export function readLedger() {
  if (!existsSync(ledgerPath())) return [];
  return readFileSync(ledgerPath(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
