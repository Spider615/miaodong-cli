// 同步老懂的代码（spec §4）：按 SOURCE.json 的清单原样拷贝，报出变了哪些、缺了哪些，记下老懂的提交号。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncReport, syncVendor } from '../scripts/sync-laodong.mjs';
import { tempHome } from './helpers/run-cli.mjs';
import { gitCommitAll, gitInit, useSigningGitConfig } from './helpers/git.mjs';

useSigningGitConfig();

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
const head = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
// 一个假的老懂仓库：git init、写文件、提交
function fakeLaodong(files) {
  const dir = tempHome();
  gitInit(dir);
  write(dir, files);
  gitCommitAll(dir);
  return dir;
}
// 一个假的本仓库：vendor/laodong 下有 SOURCE.json（记着上次同步的提交）和旧文件
function fakeRoot(files, vendorFiles, commit) {
  const root = tempHome();
  write(join(root, 'vendor', 'laodong'), { 'SOURCE.json': JSON.stringify({ commit, files }), ...vendorFiles });
  return root;
}

test('sync：内容一样就不动；老懂改了的拷过来并报出来；SOURCE.json 记下老懂的提交号', () => {
  const from = fakeLaodong({ 'a/x.ts': 'export const x = 1;\n', 'b/y.ts': 'export const y = 2;\n' });
  const root = fakeRoot(['a/x.ts', 'b/y.ts'], { 'a/x.ts': 'export const x = 1;\n', 'b/y.ts': 'export const y = 1;\n' }, head(from));
  const r = syncVendor({ from, root });
  assert.deepEqual([r.changed, r.missing, r.dirty], [['b/y.ts'], [], false]);
  assert.equal(readFileSync(join(root, 'vendor', 'laodong', 'b', 'y.ts'), 'utf-8'), 'export const y = 2;\n');
  const source = JSON.parse(readFileSync(join(root, 'vendor', 'laodong', 'SOURCE.json'), 'utf-8'));
  assert.equal(source.commit, execFileSync('git', ['-C', from, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim());
  assert.deepEqual(syncVendor({ from, root }).changed, []);
});

test('sync：老懂里找不到清单上的文件就报出来、一个都不拷；工作区有没提交的改动要说；给的不是 git 仓库就报错', () => {
  const from = fakeLaodong({ 'a/x.ts': 'x' });
  const root = fakeRoot(['a/x.ts', 'gone.ts'], { 'a/x.ts': 'old' }, head(from));
  const r = syncVendor({ from, root });
  assert.deepEqual([r.missing, r.changed], [['gone.ts'], []]);
  assert.equal(readFileSync(join(root, 'vendor', 'laodong', 'a', 'x.ts'), 'utf-8'), 'old');
  const root2 = fakeRoot(['a/x.ts'], { 'a/x.ts': 'x' }, head(from));
  writeFileSync(join(from, 'a', 'x.ts'), 'x 改了没提交');
  assert.equal(syncVendor({ from, root: root2 }).dirty, true);
  assert.throws(() => syncVendor({ from: tempHome(), root }), /不是 git 仓库/);
});

test('sync：只拷已提交的内容，SOURCE.json 记下分支；上次同步的提交不在当前 HEAD 的历史里就拒绝，--force 才越过（审查 I5）', () => {
  const from = fakeLaodong({ 'a/x.ts': 'v1\n' });
  const root = fakeRoot(['a/x.ts'], { 'a/x.ts': 'old\n' }, head(from));
  writeFileSync(join(from, 'a', 'x.ts'), '没提交的改动\n');
  syncVendor({ from, root });
  assert.equal(readFileSync(join(root, 'vendor', 'laodong', 'a', 'x.ts'), 'utf-8'), 'v1\n');
  const source = JSON.parse(readFileSync(join(root, 'vendor', 'laodong', 'SOURCE.json'), 'utf-8'));
  assert.equal(source.branch, execFileSync('git', ['-C', from, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim());
  // 老懂切到一条不含上次同步提交的分支（另起一段历史）
  execFileSync('git', ['checkout', '-q', '--orphan', 'other'], { cwd: from });
  write(from, { 'a/x.ts': 'v0\n' });
  gitCommitAll(from);
  assert.throws(() => syncVendor({ from, root }), /不在.*历史里/);
  assert.deepEqual(syncVendor({ from, root, force: true }).changed, ['a/x.ts']);
});

test('sync：清单里的文件没变、只是老懂往前提交了，SOURCE.json 改记新提交，而且要说出来，不能说「没有变化」（审查 M7）', () => {
  const from = fakeLaodong({ 'a/x.ts': 'x\n' });
  const root = fakeRoot(['a/x.ts'], { 'a/x.ts': 'x\n' }, head(from));
  syncVendor({ from, root }); // 先同步一次，SOURCE.json 记下分支
  let r = syncVendor({ from, root });
  assert.deepEqual([r.changed, r.sourceUpdated], [[], false]);
  assert.match(syncReport(r).join('\n'), /没有变化/);
  // 老懂提交了清单外的文件：清单里的文件没变，但 SOURCE.json 要改记新提交——这是要提交的改动
  write(from, { 'other.ts': 'y\n' });
  gitCommitAll(from);
  r = syncVendor({ from, root });
  assert.deepEqual([r.changed, r.sourceUpdated], [[], true]);
  assert.equal(JSON.parse(readFileSync(join(root, 'vendor', 'laodong', 'SOURCE.json'), 'utf-8')).commit, head(from));
  const report = syncReport(r).join('\n');
  assert.match(report, /SOURCE\.json/);
  assert.doesNotMatch(report, /没有变化/);
});
