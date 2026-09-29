// 构建脚本的命令行入口（npm run build）。dist/md.mjs 是发过版、同事装的那份，只有 npm run release 写；
// npm run build 和 npm run install:local 一样，只出开发构建 build/md.mjs（被 git 忽略）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './helpers/run-cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('npm run build 只出开发构建 build/md.mjs，不碰 dist/md.mjs', () => {
  // 在临时目录里摆一份仓库布局（源码和依赖用软链），跑 build.mjs 的命令行入口：不动真仓库的 dist/ 和 build/。
  // 故意不取真实路径：macOS 的临时目录在软链 /var 下，入口判断以前直接比 import.meta.url 和 argv[1]，在这里会静默什么都不做
  const root = tempHome();
  cpSync(join(ROOT, 'build.mjs'), join(root, 'build.mjs'));
  for (const name of ['src', 'vendor', 'scripts', 'node_modules', 'package.json']) symlinkSync(join(ROOT, name), join(root, name));
  const r = spawnSync(process.execPath, [join(root, 'build.mjs')], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(root, 'build', 'md.mjs')), r.stdout);
  assert.ok(!existsSync(join(root, 'dist')), '不该写 dist/');
});
