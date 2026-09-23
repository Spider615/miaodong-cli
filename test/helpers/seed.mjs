import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function seedIdentity(home, identity) {
  const dir = join(home, 'md');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'identities.json');
  let all = {};
  try { all = JSON.parse(readFileSync(file, 'utf-8')); } catch { all = {}; }
  all[identity.key] = {
    label: identity.key,
    user: { id: 'u1', name: '测试用户' },
    savedAt: '2026-09-23T00:00:00.000Z',
    expiresAt: null,
    ...identity,
  };
  writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function encodeAuthBlob(payload) {
  return `md-auth:${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')}`;
}

export const SEED_BOT = '181fc177-0000-4000-8000-000000000000';

// 直接写出一个工作副本（不走网络）。会把本进程的 MD_HOME 指向 home/md。
export async function seedWorkspace(home, { canvas, sessions = [], events = [], meta = {}, origin = 'http://127.0.0.1:9' } = {}) {
  process.env.MD_HOME = join(home, 'md');
  const { createWorkspace, writeWorkspace } = await import('../../src/workspace.mjs');
  const target = { identityKey: 'k1', regionLabel: '测试区', orgId: 'org-1', orgName: '兴趣岛平台', botId: SEED_BOT, botName: '太极2.0重构' };
  const dir = createWorkspace(target, 'draft');
  writeWorkspace(dir, {
    meta: {
      schema: 1, ...target, origin, mainCanvasId: 'main-1', source: { kind: 'draft' },
      draft: { updatedAt: '', version: '', hash: '' }, pulledAt: new Date().toISOString(), notes: [], ...meta,
    },
    base: { canvas, sessions, events },
  });
  return dir;
}
