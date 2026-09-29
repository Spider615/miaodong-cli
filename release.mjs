// npm run release：发版。先查前提（Node 够新、设了 MD_E2E_NODE、工作区干净），
// 再跑全部测试（含 Node 18 上的产物测试）→ 构建 dist/md.mjs → 扫本机路径（dist/、skill/）和身份串、token（全部会进仓库的文件）→ 列出改了什么。
// 不提交、不推送：人看过 git diff 再提交 dist/md.mjs，再推。同事 git pull 拿到的就是这一版。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './build.mjs';
import { testNodeProblem } from './scripts/check-node.mjs';
import { isMain } from './scripts/is-main.mjs';

const REPO = dirname(fileURLToPath(import.meta.url));
// 本机路径只查 dist/ 和 skill/：同事直接用到的就是这两处；文档和历史里的本机路径是有意留的（私有仓库）。
// 身份串、token、JWT 查全部会进仓库的文件：同事 clone 下来的是整个仓库（审查 M2）
const LOCAL = [[/\/Users\/[^/\s'"`]+/, '本机路径']];
const SECRETS = [
  [/md-auth:[A-Za-z0-9+/=]{16,}/, '身份串'],
  [/Bearer [A-Za-z0-9._-]{20,}/, 'token'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/, 'JWT'],
];

// package.json 里的版本号；没有 package.json 是 null
function readVersion(root) {
  const file = join(root, 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')).version ?? null : null;
}

// main 上已经发出去的版本号：先看 origin/main（同事拿到的），没有再看本地 main；都没有是 null
function versionOnMain(root) {
  for (const ref of ['origin/main', 'main']) {
    try {
      return JSON.parse(execFileSync('git', ['-C', root, 'show', `${ref}:package.json`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })).version ?? null;
    } catch {
      // 这个引用不存在，或者那时还没有 package.json
    }
  }
  return null;
}

const parts = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// 发版前提（审查 M3）：Node 够新（测试要它）；设了 MD_E2E_NODE（产物要在同事默认的 Node 18 上验证）；
// 工作区干净——dist/md.mjs 要从已提交的代码构建，构建号就是那个提交，带着没提交的改动构建，构建号就对不上内容。
// dist/md.mjs 自己不算：上一次发版检查构建出来、还没提交，再跑一次会重新构建。
// 版本号（package.json）要写成 1.2.3 这样，而且比 main 上已经发出去的大：每发一版换一个号，同事报的版本号才对得上内容
export function releaseBlockers({ root = REPO, env = process.env, nodeVersion = process.versions.node, version = readVersion(root), released = versionOnMain(root) } = {}) {
  const blockers = [];
  if (version !== null && !/^\d+\.\d+\.\d+$/.test(String(version))) {
    blockers.push(`package.json 的 version 要写成 1.2.3 这样：现在是 ${version}`);
  } else if (version !== null && released !== null && /^\d+\.\d+\.\d+$/.test(String(released)) && !newer(version, released)) {
    blockers.push(`版本号没改：package.json 的 version 是 ${version}，main 上已经是 ${released}。发版前先把它改大：新功能加中间那位（比如 1.0.0 → 1.1.0），只修问题加最后一位（比如 1.0.0 → 1.0.1），不兼容的大改加第一位`);
  }
  const node = testNodeProblem(nodeVersion);
  if (node) blockers.push(node);
  if (!env.MD_E2E_NODE) blockers.push('先设 MD_E2E_NODE 指向 Node 18 的 node 再发版：同事机器上默认就是它，产物要在它上面验证');
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf-8' })
    .split('\n')
    .filter((line) => line && line.slice(3) !== 'dist/md.mjs');
  if (dirty.length) blockers.push(`工作区有没提交的改动：先提交（或收起来）再发版。dist/md.mjs 要从已提交的代码构建，构建号就是那个提交\n${dirty.join('\n')}`);
  return blockers;
}

// 会进仓库的文件（相对 root 的路径）：已跟踪的，加上没被 .gitignore 忽略的新文件
export function committableFiles(root = REPO) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf-8' })
    .split('\0')
    .filter(Boolean);
}

// 报出来的只有位置和开头几个字符：扫到的要是真 token，整段打到终端里（AI 看得到）本身就是一次泄露
export function scanForLeaks(root = REPO, files = committableFiles(root)) {
  const hits = [];
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path) || !statSync(path).isFile()) continue; // 删了还没提交的文件
    const text = readFileSync(path, 'utf-8');
    const rules = /^(dist|skill)\//.test(file) ? [...LOCAL, ...SECRETS] : SECRETS;
    for (const [re, what] of rules) {
      const m = re.exec(text);
      if (!m) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ file, line, what, sample: what === '本机路径' ? m[0] : `${m[0].slice(0, 12)}…（共 ${m[0].length} 个字符）` });
    }
  }
  return hits;
}

if (isMain(import.meta.url)) {
  const blockers = releaseBlockers();
  if (blockers.length) {
    for (const b of blockers) console.error(`❌ ${b}`);
    process.exit(2);
  }
  const t = spawnSync('npm', ['test'], { cwd: REPO, stdio: 'inherit' });
  if (t.status !== 0) process.exit(t.status ?? 1);
  const { outfile, tag, version } = await buildBundle();
  const hits = scanForLeaks();
  if (hits.length) {
    for (const h of hits) console.error(`❌ ${h.file}:${h.line}：${h.what}（${h.sample}）`);
    process.exit(1);
  }
  console.log(`已构建 ${relative(REPO, outfile)}（${version}，${tag}），扫描干净。这次的改动：`);
  console.log(execFileSync('git', ['status', '--short'], { cwd: REPO, encoding: 'utf-8' }));
  console.log(`看过 git diff dist/md.mjs 后：git add dist/md.mjs，git commit，合进 main 再 git push；然后给这个提交打标签：git tag -a v${version} -m "md ${version}"，git push origin v${version}。同事 git pull 拿到的就是这一版`);
}
