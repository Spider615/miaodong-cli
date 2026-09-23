// 把 skill 发布到它自己的 git 仓库（github.com/magic-skills/miaodong 的本地检出）：
// 清掉除 .git 以外的全部内容，换成 skill/ 的文件和新构建的 scripts/md.mjs。
// 只生成文件，不提交、不推送：推之前要人看一眼 git diff（这是对外发布）。
import { chmodSync, cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle } from './build.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));

export async function publish({ repoDir }) {
  const dir = resolve(repoDir);
  if (!existsSync(join(dir, '.git'))) throw new Error(`${dir} 不是 git 仓库（先 git clone 那个 skill 仓库）`);
  for (const name of readdirSync(dir)) if (name !== '.git') rmSync(join(dir, name), { recursive: true, force: true });
  cpSync(join(KIT, 'skill'), dir, { recursive: true });
  const { tag } = await buildBundle({ outfile: join(dir, 'scripts', 'md.mjs') });
  chmodSync(join(dir, 'scripts', 'install.sh'), 0o755);
  return { dir, tag };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoDir = process.argv[2];
  if (!repoDir) {
    console.error('用法：npm run md:publish -- <skill 仓库的本地目录>');
    process.exit(2);
  }
  const { dir, tag } = await publish({ repoDir });
  console.log(`已生成 ${dir}（${tag}）。先 git -C ${dir} diff --stat 看一眼，再提交推送。`);
}
