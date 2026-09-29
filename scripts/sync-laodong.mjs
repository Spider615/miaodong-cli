// npm run sync:laodong -- <老懂仓库的本地检出> [--force]
// 按 vendor/laodong/SOURCE.json 的清单，把老懂里这些文件原样拷过来，列出变了哪些；有变化就跑一遍测试。
// vendor 里的文件不在本仓库改：要改就去老懂改，再同步过来（spec §4）。
// 只拷老懂已提交的内容（HEAD 里的），SOURCE.json 记的提交号才对得上内容；上次同步的提交必须在当前 HEAD 的历史里，
// 不然多半切到了别的分支，拷过来会悄悄退回那边没有的修正（审查 I5）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testNodeProblem } from './check-node.mjs';
import { isMain } from './is-main.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function syncVendor({ from, root = ROOT, force = false }) {
  const src = resolve(from);
  if (!existsSync(join(src, '.git'))) throw new Error(`${src} 不是 git 仓库：要给老懂仓库的本地检出`);
  const git = (args) => spawnSync('git', ['-C', src, ...args]);
  const text = (args) => git(args).stdout.toString('utf-8').trim();
  const vendor = join(root, 'vendor', 'laodong');
  const sourceFile = join(vendor, 'SOURCE.json');
  const source = JSON.parse(readFileSync(sourceFile, 'utf-8'));
  const commit = text(['rev-parse', 'HEAD']);
  const branch = text(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!force && source.commit && source.commit !== commit) {
    const last = String(source.commit).slice(0, 7);
    if (git(['cat-file', '-e', `${source.commit}^{commit}`]).status !== 0) {
      throw new Error(`上次同步的提交 ${last} 在 ${src} 里找不到：给的是不是老懂仓库？确认要同步就加 --force`);
    }
    if (git(['merge-base', '--is-ancestor', source.commit, 'HEAD']).status !== 0) {
      throw new Error(`上次同步的提交 ${last}${source.branch ? `（${source.branch}）` : ''} 不在老懂当前 HEAD（${branch}）的历史里：多半切到了别的分支。确认要从这条线同步就加 --force`);
    }
  }
  const contents = source.files.map((file) => {
    const r = git(['show', `HEAD:${file}`]);
    return [file, r.status === 0 ? r.stdout : null];
  });
  const missing = contents.filter(([, data]) => data === null).map(([file]) => file);
  if (missing.length) return { changed: [], missing, commit: null, branch, dirty: false, sourceUpdated: false };
  const changed = [];
  for (const [file, next] of contents) {
    const target = join(vendor, file);
    if (existsSync(target) && readFileSync(target).equals(next)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, next);
    changed.push(file);
  }
  const dirty = text(['status', '--porcelain', '--', ...source.files]) !== '';
  const sourceUpdated = changed.length > 0 || source.commit !== commit || source.branch !== branch;
  if (sourceUpdated) {
    writeFileSync(sourceFile, `${JSON.stringify({ ...source, commit, branch, syncedAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
  }
  return { changed, missing: [], commit, branch, dirty, sourceUpdated };
}

// 同步结果怎么跟人说。只改了 SOURCE.json（老懂往前提交了、清单里的文件没变）也是要提交的改动，不能说「没有变化」（审查 M7）
export function syncReport(r) {
  const at = `老懂 ${r.branch} ${r.commit.slice(0, 7)}`;
  if (r.changed.length) return [`更新了 ${r.changed.length} 个文件（${at}）：`, ...r.changed.map((file) => `  ${file}`)];
  if (r.sourceUpdated) return [`清单里的文件内容都一样，只有 vendor/laodong/SOURCE.json 改了（现在记着${at}）：这也是要提交的改动`];
  return [`没有变化（${at}）`];
}

if (isMain(import.meta.url)) {
  // 同步完要跑测试：Node 不够新就先说清楚，什么都不动（审查 M3）
  const node = testNodeProblem();
  if (node) {
    console.error(node);
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const from = args.find((a) => !a.startsWith('--'));
  if (!from) {
    console.error('用法：npm run sync:laodong -- <老懂仓库的本地检出> [--force]');
    process.exit(2);
  }
  let r;
  try {
    r = syncVendor({ from, force: args.includes('--force') });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (r.missing.length) {
    console.error(`老懂仓库的 HEAD 里找不到：${r.missing.join('、')}。文件挪了或删了：先在老懂里确认，再改 SOURCE.json 的清单`);
    process.exit(1);
  }
  if (r.dirty) console.log('⚠️ 老懂工作区里这些文件有没提交的改动：拷的是已提交的版本（HEAD），没提交的没拷');
  for (const line of syncReport(r)) console.log(line);
  if (!r.changed.length) process.exit(0);
  console.log('跑测试……');
  const t = spawnSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' });
  process.exit(t.status ?? 1);
}
