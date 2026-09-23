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
