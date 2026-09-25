// npm run release：发版前的全套检查。
// 跑全部测试（含 Node 18 上的产物测试）→ 构建 dist/md.mjs → 扫 dist/ 和 skill/ 有没有本机路径、身份串、token → 列出改了什么。
// 不提交、不推送：人看过 git diff 再提交（dist/md.mjs 一起提交），再推。同事 git pull 拿到的就是这一版。
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle } from './build.mjs';

const REPO = dirname(fileURLToPath(import.meta.url));
const LEAKS = [
  [/\/Users\/[^/\s'"`]+/, '本机路径'],
  [/md-auth:[A-Za-z0-9+/=]{16,}/, '身份串'],
  [/Bearer [A-Za-z0-9._-]{20,}/, 'token'],
];

export function scanForLeaks(dirs, root = REPO) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const text = readFileSync(path, 'utf-8');
      for (const [re, what] of LEAKS) {
        const m = text.match(re);
        if (m) hits.push({ file: relative(root, path), what, sample: m[0].slice(0, 40) });
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return hits;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.MD_E2E_NODE) {
    console.error('先设 MD_E2E_NODE 指向 Node 18 的 node 再发版：同事机器上默认就是它，产物要在它上面验证');
    process.exit(2);
  }
  const t = spawnSync('npm', ['test'], { cwd: REPO, stdio: 'inherit' });
  if (t.status !== 0) process.exit(t.status ?? 1);
  const { outfile, tag } = await buildBundle();
  const hits = scanForLeaks([join(REPO, 'dist'), join(REPO, 'skill')]);
  if (hits.length) {
    for (const h of hits) console.error(`❌ ${h.file}：${h.what}（${h.sample}）`);
    process.exit(1);
  }
  console.log(`已构建 ${relative(REPO, outfile)}（${tag}），扫描干净。这次的改动：`);
  console.log(execFileSync('git', ['status', '--short'], { cwd: REPO, encoding: 'utf-8' }));
  console.log('看过 git diff 后：git add -A && git commit（dist/md.mjs 一起提交），再 git push');
}
