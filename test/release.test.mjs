// npm run release 的扫描：dist/ 和 skill/ 里不能带本机路径、身份串、token（spec §6、§8 第 8 条）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { releaseBlockers, scanForLeaks } from '../release.mjs';
import { testNodeProblem } from '../scripts/check-node.mjs';
import { gitCommitAll, gitInit, useSigningGitConfig } from './helpers/git.mjs';
import { tempHome } from './helpers/run-cli.mjs';

useSigningGitConfig();
function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

test('release：扫出本机路径、身份串和 token；正常的 ~/ 路径、代码里的 Bearer ${token} 不报', () => {
  const dir = tempHome();
  writeFileSync(join(dir, 'a.md'), '装到 ~/.local/bin/md；请求头是 Authorization: `Bearer ${identity.token}`');
  assert.deepEqual(scanForLeaks([dir], dir), []);
  writeFileSync(join(dir, 'b.mjs'), "const p = '/Users/somebody/x'; const t = 'Bearer abcdefghijklmnopqrstuvwxyz0123'; const a = 'md-auth:eyJhbGciOiJIUzI1NiJ9abcd';");
  assert.deepEqual(scanForLeaks([dir], dir).map((h) => h.what).sort(), ['token', '本机路径', '身份串'].sort());
});

test('release：Node 不够跑测试时说清楚要多少（审查 M3：Node 18 下原来只看到一句 bad option）', () => {
  for (const v of ['18.20.8', '20.11.0', '22.5.1']) assert.match(testNodeProblem(v) ?? '', /Node 22\.6/, v);
  for (const v of ['22.6.0', '22.23.1', '24.1.0']) assert.equal(testNodeProblem(v), null, v);
});

test('release：没设 MD_E2E_NODE、Node 不够新、工作区有没提交的改动时不发版；只有 dist/md.mjs 改了不算（审查 M3）', () => {
  const root = tempHome();
  gitInit(root);
  write(root, { 'src/a.mjs': 'a', 'dist/md.mjs': 'old' });
  gitCommitAll(root);
  const ok = { root, env: { MD_E2E_NODE: '/x/node' }, nodeVersion: '22.23.1' };
  assert.deepEqual(releaseBlockers(ok), []);
  assert.match(releaseBlockers({ ...ok, env: {} }).join('\n'), /MD_E2E_NODE/);
  assert.match(releaseBlockers({ ...ok, nodeVersion: '18.20.8' }).join('\n'), /Node 22\.6/);
  // 上一次发版检查构建出来、还没提交的 dist/md.mjs 不算：再跑一次会重新构建
  writeFileSync(join(root, 'dist', 'md.mjs'), 'rebuilt');
  assert.deepEqual(releaseBlockers(ok), []);
  // 改了源码没提交：构建号（提交号）会对不上产物内容
  writeFileSync(join(root, 'src', 'a.mjs'), 'changed');
  assert.match(releaseBlockers(ok).join('\n'), /没提交的改动[\s\S]*src\/a\.mjs/);
  gitCommitAll(root);
  // 新文件没提交也一样
  writeFileSync(join(root, 'src', 'new.mjs'), 'new');
  assert.match(releaseBlockers(ok).join('\n'), /src\/new\.mjs/);
});
