import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from './helpers/run-cli.mjs';

test('入口判断比真实路径：脚本放在软链目录下（macOS 的 /tmp、/var 就是）照样认得自己是入口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'md-is-main-'));
  mkdirSync(join(dir, 'real'));
  const helper = pathToFileURL(join(REPO, 'scripts', 'is-main.mjs')).href;
  writeFileSync(join(dir, 'real', 'entry.mjs'), `import { isMain } from ${JSON.stringify(helper)};\nconsole.log(isMain(import.meta.url) ? 'main' : 'imported');\n`);
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  for (const path of [join(dir, 'link', 'entry.mjs'), join(dir, 'real', 'entry.mjs')]) {
    const r = spawnSync(process.execPath, [path], { encoding: 'utf-8' });
    assert.equal(r.stdout.trim(), 'main', `${path}\n${r.stderr}`);
  }
  writeFileSync(join(dir, 'real', 'importer.mjs'), `import ${JSON.stringify(pathToFileURL(join(dir, 'real', 'entry.mjs')).href)};\n`);
  assert.equal(spawnSync(process.execPath, [join(dir, 'link', 'importer.mjs')], { encoding: 'utf-8' }).stdout.trim(), 'imported');
});

test('构建、安装、发版、同步老懂的脚本都用 isMain 判断入口：以前直接拿 import.meta.url 比 argv[1]，在软链目录下静默什么都不做、退出码 0', () => {
  for (const file of ['build.mjs', 'install.mjs', 'release.mjs', 'scripts/sync-laodong.mjs']) {
    const text = readFileSync(join(REPO, file), 'utf-8');
    assert.match(text, /if \(isMain\(import\.meta\.url\)\)/, file);
    assert.doesNotMatch(text, /import\.meta\.url === pathToFileURL/, file);
  }
});
