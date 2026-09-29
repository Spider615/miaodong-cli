// npm run install:local（开发者）：构建开发版到 build/md.mjs（被 git 忽略），跑 install.sh（和同事一样的软链装法，
// 用 MD_BIN_SRC 让 md 链到这份开发构建），再放一份桌面副本。dist/md.mjs 是已发布的版本，只有 npm run release 写（审查 I4）。
// 桌面副本（MD_EXPORT_DIR，默认 ~/Desktop/miaodong）是给人看、转给同事用的：布局和仓库一样（install.sh、skill/、dist/md.mjs），
// 拿到的人在里面跑 ./install.sh 就能装。设 MD_EXPORT_DIR='' 就不放。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './build.mjs';
import { isMain } from './scripts/is-main.mjs';

const REPO = dirname(fileURLToPath(import.meta.url));
// 桌面副本的标记。旧版 install 放的副本带 .md-cli-skill，也认
const MARKERS = ['.md-cli-export', '.md-cli-skill'];

// env：传给 install.sh 的环境。默认是当前进程的（开发者真用时要认 CODEX_HOME 这些）；测试要传干净的，免得改到真实链接（审查 I3）
export async function installLocal({ root = REPO, home = homedir(), exportDir = process.env.MD_EXPORT_DIR ?? join(home, 'Desktop', 'miaodong'), env = process.env } = {}) {
  if (exportDir && existsSync(exportDir) && !MARKERS.some((m) => existsSync(join(exportDir, m)))) {
    throw new Error(`${exportDir} 已存在，而且不是 md 放的，没敢覆盖`);
  }
  const bin = join(root, 'build', 'md.mjs');
  const { tag } = await buildBundle({ outfile: bin });
  const r = spawnSync('bash', [join(root, 'install.sh')], { env: { ...env, HOME: home, MD_BIN_SRC: bin }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`install.sh 失败：\n${r.stdout}${r.stderr}`);
  const logs = [r.stdout.trimEnd()];
  if (exportDir) {
    rmSync(exportDir, { recursive: true, force: true });
    mkdirSync(join(exportDir, 'dist'), { recursive: true });
    for (const name of ['install.sh', 'README.md', 'THIRD_PARTY_NOTICES.md']) cpSync(join(root, name), join(exportDir, name));
    cpSync(join(root, 'skill'), join(exportDir, 'skill'), { recursive: true });
    cpSync(bin, join(exportDir, 'dist', 'md.mjs'));
    writeFileSync(join(exportDir, MARKERS[0]), `${tag}\n`);
    logs.push(`已放一份到 ${exportDir}（给人看、转给同事用：在里面跑 ./install.sh 就能装）`);
  }
  return { tag, logs };
}

if (isMain(import.meta.url)) {
  const { logs } = await installLocal();
  for (const line of logs) console.log(line);
  console.log('验证：新开一个终端运行 md --version');
}
