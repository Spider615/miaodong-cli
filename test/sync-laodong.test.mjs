// 同步老懂的代码（spec §4）：按 SOURCE.json 的清单原样拷贝，报出变了哪些、缺了哪些，记下老懂的提交号。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncVendor } from '../scripts/sync-laodong.mjs';
import { tempHome } from './helpers/run-cli.mjs';

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
// 一个假的老懂仓库：git init、写文件、提交
function fakeLaodong(files) {
  const dir = tempHome();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, files);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}
// 一个假的本仓库：vendor/laodong 下有 SOURCE.json 和旧文件
function fakeRoot(files, vendorFiles) {
  const root = tempHome();
  write(join(root, 'vendor', 'laodong'), { 'SOURCE.json': JSON.stringify({ commit: 'old', files }), ...vendorFiles });
  return root;
}

test('sync：内容一样就不动；老懂改了的拷过来并报出来；SOURCE.json 记下老懂的提交号', () => {
  const from = fakeLaodong({ 'a/x.ts': 'export const x = 1;\n', 'b/y.ts': 'export const y = 2;\n' });
  const root = fakeRoot(['a/x.ts', 'b/y.ts'], { 'a/x.ts': 'export const x = 1;\n', 'b/y.ts': 'export const y = 1;\n' });
  const r = syncVendor({ from, root });
  assert.deepEqual([r.changed, r.missing, r.dirty], [['b/y.ts'], [], false]);
  assert.equal(readFileSync(join(root, 'vendor', 'laodong', 'b', 'y.ts'), 'utf-8'), 'export const y = 2;\n');
  const source = JSON.parse(readFileSync(join(root, 'vendor', 'laodong', 'SOURCE.json'), 'utf-8'));
  assert.equal(source.commit, execFileSync('git', ['-C', from, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim());
  assert.deepEqual(syncVendor({ from, root }).changed, []);
});

test('sync：老懂里找不到清单上的文件就报出来、一个都不拷；工作区有没提交的改动要说；给的不是 git 仓库就报错', () => {
  const from = fakeLaodong({ 'a/x.ts': 'x' });
  const root = fakeRoot(['a/x.ts', 'gone.ts'], { 'a/x.ts': 'old' });
  const r = syncVendor({ from, root });
  assert.deepEqual([r.missing, r.changed], [['gone.ts'], []]);
  assert.equal(readFileSync(join(root, 'vendor', 'laodong', 'a', 'x.ts'), 'utf-8'), 'old');
  const root2 = fakeRoot(['a/x.ts'], { 'a/x.ts': 'x' });
  writeFileSync(join(from, 'a', 'x.ts'), 'x 改了没提交');
  assert.equal(syncVendor({ from, root: root2 }).dirty, true);
  assert.throws(() => syncVendor({ from: tempHome(), root }), /不是 git 仓库/);
});
