// 把 md 打成一个 Node 18 可直接运行的单文件。
// 为什么打包：md 还在老懂仓库里时靠 --experimental-strip-types 直接跑 TS，默认 Node 18 下直接报错，
// 会话里 AI 给命令加 Node 22 前缀加了 324 次。打包后没有运行时 flag，也没有 TS。
//
// 命令行入口（npm run build）只出开发构建 build/md.mjs（被 git 忽略）；dist/md.mjs 是发过版、同事装的那份，
// 只有 npm run release 写（它先跑全部测试、再构建、再扫描）。
//
// banner 做三件事：
// 1. shebang 带 --no-warnings：Node 18 的 fetch 会打 ExperimentalWarning，混进 stderr 干扰 AI；
// 2. 同时拦截 process.emitWarning 里的 ExperimentalWarning，覆盖 `node md.mjs` 直接跑的情况；
// 3. Node 18 以文件方式跑 ESM 时没有全局 crypto，而共享代码里有裸 crypto.randomUUID()。

import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
export const BUNDLE_PATH = join(KIT, 'dist', 'md.mjs');
export const DEV_BUNDLE_PATH = join(KIT, 'build', 'md.mjs');

const BANNER = [
  '#!/usr/bin/env -S node --no-warnings',
  "import { webcrypto as __mdWebcrypto } from 'node:crypto';",
  'if (!globalThis.crypto) globalThis.crypto = __mdWebcrypto;',
  'const __mdEmitWarning = process.emitWarning;',
  "process.emitWarning = function (warning, ...rest) { const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type; if (type === 'ExperimentalWarning') return; return __mdEmitWarning.call(process, warning, ...rest); };",
].join('\n');

function buildTag() {
  let sha = 'nogit';
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: KIT, encoding: 'utf-8' }).trim();
  } catch {
    // 不在 git 里构建时照样能出产物
  }
  return `${sha}@${new Date().toISOString().slice(0, 10)}`;
}

export async function buildBundle({ outfile = BUNDLE_PATH } = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  const tag = buildTag();
  await build({
    entryPoints: [join(KIT, 'src', 'cli.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile,
    banner: { js: BANNER },
    define: { __MD_BUILD__: JSON.stringify(tag) },
    logLevel: 'warning',
    legalComments: 'none',
    // 去掉全部注释与源码路径标记：注释里有内部信息，而 dist/md.mjs 进仓库、同事装的就是它（legalComments 只管许可证注释）
    minifyWhitespace: true,
    // 中文按原样输出而不是 \uXXXX，方便人工检查产物里到底带了什么
    charset: 'utf8',
  });
  chmodSync(outfile, 0o755);
  return { outfile, tag };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outfile, tag } = await buildBundle({ outfile: DEV_BUNDLE_PATH });
  console.log(`已构建开发版 ${outfile}（${tag}）。要发给同事用 npm run release`);
}
