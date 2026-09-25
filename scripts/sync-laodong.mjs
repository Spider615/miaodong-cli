// npm run sync:laodong -- <老懂仓库的本地检出>
// 按 vendor/laodong/SOURCE.json 的清单，把老懂里这些文件原样拷过来，列出变了哪些；有变化就跑一遍测试。
// vendor 里的文件不在本仓库改：要改就去老懂改，再同步过来（spec §4）。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function syncVendor({ from, root = ROOT }) {
  const src = resolve(from);
  if (!existsSync(join(src, '.git'))) throw new Error(`${src} 不是 git 仓库：要给老懂仓库的本地检出`);
  const vendor = join(root, 'vendor', 'laodong');
  const sourceFile = join(vendor, 'SOURCE.json');
  const source = JSON.parse(readFileSync(sourceFile, 'utf-8'));
  const missing = source.files.filter((file) => !existsSync(join(src, file)));
  if (missing.length) return { changed: [], missing, commit: null, dirty: false };
  const changed = [];
  for (const file of source.files) {
    const next = readFileSync(join(src, file));
    const target = join(vendor, file);
    if (existsSync(target) && readFileSync(target).equals(next)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, next);
    changed.push(file);
  }
  const commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  const dirty = execFileSync('git', ['-C', src, 'status', '--porcelain', '--', ...source.files], { encoding: 'utf-8' }).trim() !== '';
  if (changed.length || source.commit !== commit) {
    writeFileSync(sourceFile, `${JSON.stringify({ ...source, commit, syncedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
  }
  return { changed, missing: [], commit, dirty };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const from = process.argv[2];
  if (!from) {
    console.error('用法：npm run sync:laodong -- <老懂仓库的本地检出>');
    process.exit(2);
  }
  const r = syncVendor({ from });
  if (r.missing.length) {
    console.error(`老懂仓库里找不到：${r.missing.join('、')}。文件挪了或删了：先在老懂里确认，再改 SOURCE.json 的清单`);
    process.exit(1);
  }
  if (r.dirty) console.log('⚠️ 老懂仓库里这些文件有没提交的改动：拷过来的是工作区里的版本，不是提交号对应的版本');
  if (!r.changed.length) {
    console.log(`没有变化（老懂 ${r.commit.slice(0, 7)}）`);
    process.exit(0);
  }
  console.log(`更新了 ${r.changed.length} 个文件（老懂 ${r.commit.slice(0, 7)}）：`);
  for (const file of r.changed) console.log(`  ${file}`);
  console.log('跑测试……');
  const t = spawnSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' });
  process.exit(t.status ?? 1);
}
