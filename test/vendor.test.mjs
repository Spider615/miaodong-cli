// vendor/laodong 是老懂代码的原样拷贝（清单和来源提交在 SOURCE.json）。这里守三件事：
// 1. 清单里的文件都在，它们之间的相对引用都落在清单里：老懂以后新加了依赖，同步后这里会红；
// 2. 它们用到的 npm 包都写进了 package.json 的 dependencies；
// 3. vendor 以外的代码和脚本不再指向老懂仓库（spec §8 第 2 条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const VENDOR = join(ROOT, 'vendor', 'laodong');
const source = JSON.parse(readFileSync(join(VENDOR, 'SOURCE.json'), 'utf-8'));
const specsOf = (text) => [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

function resolveInVendor(fromFile, spec) {
  const base = normalize(join(dirname(fromFile), spec));
  const candidates = [base, `${base}.ts`, join(base, 'index.ts'), base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : null].filter(Boolean);
  return candidates.find((c) => existsSync(join(VENDOR, c)) && statSync(join(VENDOR, c)).isFile()) ?? null;
}

test('vendor：清单里的文件都在，相互引用都落在清单里', () => {
  assert.ok(source.files.length >= 19, `清单只有 ${source.files.length} 个文件`);
  const listed = new Set(source.files);
  for (const file of source.files) {
    assert.ok(existsSync(join(VENDOR, file)), `缺 vendor/laodong/${file}`);
    for (const spec of specsOf(readFileSync(join(VENDOR, file), 'utf-8')).filter((s) => s.startsWith('.'))) {
      const hit = resolveInVendor(file, spec);
      assert.ok(hit && listed.has(hit), `${file} 引用的 ${spec} 不在清单里：把它加进 SOURCE.json 的 files，再 npm run sync:laodong`);
    }
  }
});

test('vendor：用到的 npm 包都在 dependencies 里', () => {
  const deps = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).dependencies ?? {});
  for (const file of source.files) {
    for (const spec of specsOf(readFileSync(join(VENDOR, file), 'utf-8')).filter((s) => !s.startsWith('.') && !s.startsWith('node:'))) {
      assert.ok(deps.includes(spec), `${file} 用了 ${spec}，要加进 package.json 的 dependencies`);
    }
  }
});

// vendor、依赖、产物、文档、git 目录不查；只查代码和脚本
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['vendor', 'node_modules', 'dist', 'docs', '.git', '.superpowers'].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(mjs|js|ts|sh)$/.test(name) || name === 'package.json') out.push(path);
  }
  return out;
}

test('独立：vendor 以外的代码和脚本不再指向老懂仓库（spec §8 第 2 条）', () => {
  // 指向 vendor/laodong/ 的引用本来就带着老懂的目录名（vendor/laodong/apps/api/…），先剔掉再查
  const offenders = walk(ROOT)
    .filter((file) => file !== SELF)
    .filter((file) => /Agentflow|miaodong-kit|apps\/api|packages\/shared/.test(readFileSync(file, 'utf-8').replace(/vendor\/laodong\/[\w./-]+/g, '')))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(offenders, []);
});
