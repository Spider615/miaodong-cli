import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOADER_URL, REPO, runCli, tempHome } from './helpers/run-cli.mjs';

test('md help 列出用法并退出 0', async () => {
  const r = await runCli(['help'], { home: tempHome() });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /用法：md <命令>/);
  assert.match(r.stdout, /退出码：0 成功/);
});

test('md --version 在开发模式打印 md dev', async () => {
  const r = await runCli(['--version'], { home: tempHome() });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'md dev');
});

test('未知命令退出码 2', async () => {
  const r = await runCli(['nope'], { home: tempHome() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知命令：nope/);
});

test('finish() 在读端很慢的管道上也不截断大输出', async () => {
  const outputUrl = pathToFileURL(join(REPO, 'miaodong-kit/src/output.mjs')).href;
  const script = `import { out, finish } from ${JSON.stringify(outputUrl)};
for (let i = 0; i < 2000; i++) out('x'.repeat(99));
await finish(0);`;
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', '--loader', LOADER_URL, '--input-type=module', '-e', script], { cwd: REPO });
  child.stdout.pause();
  await new Promise((resolve) => setTimeout(resolve, 500));
  let size = 0;
  child.stdout.on('data', (chunk) => { size += chunk.length; });
  child.stdout.resume();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(size, 2000 * 100);
});

test('lib/credentials.mjs 与 src/args.mjs 共用同一份 parseArgs', async () => {
  const a = await import('../src/args.mjs');
  const b = await import('../lib/credentials.mjs');
  assert.equal(a.parseArgs, b.parseArgs);
  assert.equal(a.strArg, b.strArg);
  assert.equal(a.parseArgs(['--confirm', 'false']).confirm, false);
});
