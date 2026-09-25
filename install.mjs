// npm run install:local（开发者）：构建 dist/md.mjs，跑 install.sh（和同事一样的软链装法），再放一份桌面副本。
// 桌面副本（MD_EXPORT_DIR，默认 ~/Desktop/miaodong）是给人看、转给同事用的：布局和仓库一样（install.sh、skill/、dist/md.mjs），
// 拿到的人在里面跑 ./install.sh 就能装。设 MD_EXPORT_DIR='' 就不放。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle } from './build.mjs';

const REPO = dirname(fileURLToPath(import.meta.url));
// 桌面副本的标记。旧版 install 放的副本带 .md-cli-skill，也认
const MARKERS = ['.md-cli-export', '.md-cli-skill'];

export async function installLocal({ root = REPO, home = homedir(), exportDir = process.env.MD_EXPORT_DIR ?? join(home, 'Desktop', 'miaodong') } = {}) {
  if (exportDir && existsSync(exportDir) && !MARKERS.some((m) => existsSync(join(exportDir, m)))) {
    throw new Error(`${exportDir} 已存在，而且不是 md 放的，没敢覆盖`);
  }
  const { tag } = await buildBundle({ outfile: join(root, 'dist', 'md.mjs') });
  const r = spawnSync('bash', [join(root, 'install.sh')], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`install.sh 失败：\n${r.stdout}${r.stderr}`);
  const logs = [r.stdout.trimEnd()];
  if (exportDir) {
    rmSync(exportDir, { recursive: true, force: true });
    mkdirSync(join(exportDir, 'dist'), { recursive: true });
    for (const name of ['install.sh', 'README.md', 'THIRD_PARTY_NOTICES.md']) cpSync(join(root, name), join(exportDir, name));
    cpSync(join(root, 'skill'), join(exportDir, 'skill'), { recursive: true });
    cpSync(join(root, 'dist', 'md.mjs'), join(exportDir, 'dist', 'md.mjs'));
    writeFileSync(join(exportDir, MARKERS[0]), `${tag}\n`);
    logs.push(`已放一份到 ${exportDir}（给人看、转给同事用：在里面跑 ./install.sh 就能装）`);
  }
  return { tag, logs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { logs } = await installLocal();
  for (const line of logs) console.log(line);
  console.log('验证：新开一个终端运行 md --version');
}
