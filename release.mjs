// npm run release：发版。先查前提（Node 够新、设了 MD_E2E_NODE、工作区干净），
// 再跑全部测试（含 Node 18 上的产物测试）→ 构建 dist/md.mjs → 扫本机路径（dist/、skill/）和身份串、token（全部会进仓库的文件）→ 列出改了什么。
// 不提交、不推送：人看过 git diff 再提交 dist/md.mjs，再推。同事 git pull 拿到的就是这一版。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle } from './build.mjs';
import { testNodeProblem } from './scripts/check-node.mjs';

const REPO = dirname(fileURLToPath(import.meta.url));
// 本机路径只查 dist/ 和 skill/：同事直接用到的就是这两处；文档和历史里的本机路径是有意留的（私有仓库）。
// 身份串、token、JWT 查全部会进仓库的文件：同事 clone 下来的是整个仓库（审查 M2）
const LOCAL = [[/\/Users\/[^/\s'"`]+/, '本机路径']];
const SECRETS = [
  [/md-auth:[A-Za-z0-9+/=]{16,}/, '身份串'],
  [/Bearer [A-Za-z0-9._-]{20,}/, 'token'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/, 'JWT'],
];

// 发版前提（审查 M3）：Node 够新（测试要它）；设了 MD_E2E_NODE（产物要在同事默认的 Node 18 上验证）；
// 工作区干净——dist/md.mjs 要从已提交的代码构建，构建号就是那个提交，带着没提交的改动构建，构建号就对不上内容。
// dist/md.mjs 自己不算：上一次发版检查构建出来、还没提交，再跑一次会重新构建
export function releaseBlockers({ root = REPO, env = process.env, nodeVersion = process.versions.node } = {}) {
  const blockers = [];
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const blockers = releaseBlockers();
  if (blockers.length) {
    for (const b of blockers) console.error(`❌ ${b}`);
    process.exit(2);
  }
  const t = spawnSync('npm', ['test'], { cwd: REPO, stdio: 'inherit' });
  if (t.status !== 0) process.exit(t.status ?? 1);
  const { outfile, tag } = await buildBundle();
  const hits = scanForLeaks();
  if (hits.length) {
    for (const h of hits) console.error(`❌ ${h.file}:${h.line}：${h.what}（${h.sample}）`);
    process.exit(1);
  }
  console.log(`已构建 ${relative(REPO, outfile)}（${tag}），扫描干净。这次的改动：`);
  console.log(execFileSync('git', ['status', '--short'], { cwd: REPO, encoding: 'utf-8' }));
  console.log('看过 git diff dist/md.mjs 后：git add dist/md.mjs，git commit，再 git push。同事 git pull 拿到的就是这一版');
}
