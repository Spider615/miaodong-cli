// npm run release 的扫描：dist/ 和 skill/ 里不能带本机路径、身份串、token（spec §6、§8 第 8 条）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanForLeaks } from '../release.mjs';
import { tempHome } from './helpers/run-cli.mjs';

test('release：扫出本机路径、身份串和 token；正常的 ~/ 路径、代码里的 Bearer ${token} 不报', () => {
  const dir = tempHome();
  writeFileSync(join(dir, 'a.md'), '装到 ~/.local/bin/md；请求头是 Authorization: `Bearer ${identity.token}`');
  assert.deepEqual(scanForLeaks([dir], dir), []);
  writeFileSync(join(dir, 'b.mjs'), "const p = '/Users/somebody/x'; const t = 'Bearer abcdefghijklmnopqrstuvwxyz0123'; const a = 'md-auth:eyJhbGciOiJIUzI1NiJ9abcd';");
  assert.deepEqual(scanForLeaks([dir], dir).map((h) => h.what).sort(), ['token', '本机路径', '身份串'].sort());
});
