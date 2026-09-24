// 起子进程跑 md。默认跑源码（Node 22 + strip-types），传 bundle 时跑打包产物，
// 并可用 MD_E2E_NODE 指定别的 node（用来验证 Node 18）。
// HOME 与 MD_HOME 都指向临时目录，保证测试碰不到真实身份与工作副本。
// 测试里绝不真弹窗：默认 MD_NO_DIALOG=1（只会让批准直接失败）；轮询间隔压到 5ms。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const LOADER_URL = pathToFileURL(join(REPO, 'scripts', 'ts-resolve-loader.mjs')).href;
const CLI = join(REPO, 'miaodong-kit', 'src', 'cli.mjs');

export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'md-test-'));
}

export function runCli(args, { home, env = {}, input, bundle } = {}) {
  const nodeBin = bundle ? process.env.MD_E2E_NODE || process.execPath : process.execPath;
  const argv = bundle
    ? [bundle, ...args]
    : ['--no-warnings', '--experimental-strip-types', '--loader', LOADER_URL, CLI, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, argv, {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? '', HOME: home, MD_HOME: join(home, 'md'), MD_NO_DIALOG: '1', MD_POLL_MS: '5', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`md ${args.join(' ')} 超时`)); }, 20000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}
