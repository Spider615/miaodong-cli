// npm run release 的扫描：dist/ 和 skill/ 里不能带本机路径、身份串、token（spec §6、§8 第 8 条）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseBlockers, scanForLeaks } from '../release.mjs';
import { testNodeProblem } from '../scripts/check-node.mjs';
import { gitCommitAll, gitInit, useSigningGitConfig } from './helpers/git.mjs';
import { tempHome } from './helpers/run-cli.mjs';

useSigningGitConfig();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 测试用的假身份串、假 token、假 JWT：运行时拼出来，源码里不出现像真 token 的串——
// 发版扫描查全部会进仓库的文件，连这个测试文件也查（审查 M2）
const FAKE = {
  bearer: `Bearer ${'abcdefghij'.repeat(3)}`,
  auth: `md-auth:${'eyJ'}${'Q'.repeat(24)}`,
  jwt: [`eyJ${'h'.repeat(16)}`, `eyJ${'p'.repeat(16)}`, 's'.repeat(16)].join('.'),
};
function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

test('release：扫出本机路径、身份串和 token；正常的 ~/ 路径、代码里的 Bearer ${token} 不报', () => {
  const dir = tempHome();
  write(dir, { 'skill/a.md': '装到 ~/.local/bin/md；请求头是 Authorization: `Bearer ${identity.token}`' });
  assert.deepEqual(scanForLeaks(dir, ['skill/a.md']), []);
  write(dir, { 'skill/b.mjs': `const p = '/Users/somebody/x'; const t = '${FAKE.bearer}'; const a = '${FAKE.auth}';` });
  assert.deepEqual(scanForLeaks(dir, ['skill/a.md', 'skill/b.mjs']).map((h) => h.what).sort(), ['token', '本机路径', '身份串'].sort());
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

test('release：扫出裸 JWT（审查 M2）', () => {
  const root = tempHome();
  write(root, { 'skill/c.md': `示例：${FAKE.jwt}` });
  assert.deepEqual(scanForLeaks(root, ['skill/c.md']).map((h) => h.what), ['JWT']);
});

test('release：身份串、token 查全部会进仓库的文件，本机路径只查 dist/ 和 skill/；被 .gitignore 忽略的不查（审查 M2）', () => {
  const root = tempHome();
  gitInit(root);
  write(root, {
    '.gitignore': 'local-secret.txt\n',
    'docs/a.md': `/Users/somebody/x ${FAKE.bearer}`,
    'test/x.mjs': `const a = '${FAKE.auth}';`,
    'skill/y.md': '/Users/somebody/y',
    'local-secret.txt': FAKE.bearer,
  });
  const hits = scanForLeaks(root).map((h) => `${h.file} ${h.what}`).sort();
  assert.deepEqual(hits, ['docs/a.md token', 'skill/y.md 本机路径', 'test/x.mjs 身份串']);
});

test('release：扫到的 token 不整段打出来，只给位置和开头几个字符（审查 M2）', () => {
  const root = tempHome();
  write(root, { 'skill/z.md': `第一行\n${FAKE.bearer}` });
  const [hit] = scanForLeaks(root, ['skill/z.md']);
  assert.equal(hit.line, 2);
  assert.ok(!hit.sample.includes(FAKE.bearer), hit.sample);
});

test('release：仓库自己扫出来是干净的，测试和文档里的假 token 都是拼出来的（审查 M2）', () => {
  assert.deepEqual(scanForLeaks(ROOT), []);
});
