# miaodong-cli：把 md 拆成独立仓库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 md 带着历史搬进新的私有仓库 `Spider615/miaodong-cli`。换一台没有 Agentflow 的机器，clone 下来就能测试、构建、安装、使用。

**Architecture:**
- **搬历史**：用 `git filter-repo` 从 `feat/miaodong-cli` 分支里只抽出 md 的文件和 md 的文档。
- **老懂的代码**：md 用到的 19 个文件原样复制进 `vendor/laodong/`，配同步脚本和测试兜底。
- **安装**：同事和开发者共用一个 `install.sh`，用软链，认得旧装法。
- **发版**：打包好的 `dist/md.mjs` 放进仓库，由 `npm run release` 检查后提交。
- **老懂、`magic-skills`**：都不动。

**Tech Stack:** Node ESM（产物跑在 Node 18+，源码测试用 Node 22 + `--experimental-strip-types`）、node:test、esbuild 0.27.7、jsonrepair 3.14.0、bash（macOS 自带的 3.2 也要能跑）、git-filter-repo、gh。

**Spec:** `docs/superpowers/specs/2026-09-25-miaodong-cli-extraction-design.md`

## Global Constraints

- **路径**：
  - 新仓库在 `/Users/hukui/Desktop/workspace/miaodong-cli`（下文写 `$NEW`）；
  - 老懂仓库在 `/Users/hukui/Desktop/workspace/Agentflow`（下文写 `$AF`）。
  - 命令一律写绝对路径，不要 `cd` 进 `$AF`。
- **老懂只读**：
  - 只有 Task 1 之前，在 worktree `$AF/.worktrees/miaodong-cli` 里提交本计划和 spec；
  - 除此之外不往老懂写任何东西。
- **`magic-skills` 组织和它下面的仓库一律不动**：不读写仓库内容，不改名，不改可见性。
- **测试用 Node 22**：
  - `PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm test`；
  - 产物验证另加 `MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node`；
  - 这台机器默认的 node 是 18。
- **vendor 文件**：内容必须和老懂 `4967e17` 的版本逐字节一致；本仓库里不改它们。
- **安全**：
  - 不读 `~/.miaodong/md/identities.json`，不打印 token；
  - 真机只跑只读命令（`md --version`、`md bots`）。
- **对外操作只在指定的任务里做**：
  - `brew install git-filter-repo`：Task 1；
  - `gh repo create` 并推送：Task 8；
  - 加协作者：Task 9，名单由用户给。
- 中文注释、中文文案、英文标识符。提交信息结尾带 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`。

## Review Focus

1. **同事按老习惯把新仓库直接 clone 进 `~/.claude/skills/miaodong`**：`install.sh` 必须明确报错并说怎么做。否则 Claude Code 在那里找不到 `SKILL.md`。测试在 Task 4。
2. **旧装法的各种残留**，都要迁移，并且不碰别人的东西。测试在 Task 4。
   - 同事的旧 clone；
   - 开发者的旧真身（带 `.md-cli-skill` 标记）；
   - 指向已删除目录的悬空软链。
3. **路径里有空格**（仓库放在 `my tools/` 下）：`install.sh` 照样装对。测试在 Task 4。
4. **老懂那 19 个文件以后新增了依赖**：同步之后 `vendor.test.mjs` 要红，不能等到用户的机器上才炸。测试在 Task 2（依赖完整）、Task 3（同步）。
5. **`dist/md.mjs` 缺失，或者被 `.gitignore` 误忽略没进仓库**：`install.sh` 要说清楚；全新 clone 的验收能发现。测试在 Task 4，核对在 Task 7。

## 执行顺序

- Task 1 在老懂的 worktree 里执行（账本也在那里）。
- 从 Task 2 起在 `$NEW` 里执行：把 Task 1 的账本行抄进 `$NEW/.superpowers/sdd/…` 的新账本，`.superpowers/` 已经写进 `.gitignore`。
- Task 1–7 做完后先做整支审查、修一轮，再做 Task 8（推到 GitHub）和 Task 9（本机切换）。推送之前的问题都在本地修掉。

---

### Task 1: 带历史抽出新仓库

**Files:**
- Create: `$NEW`（整个仓库，由 filter-repo 生成）

- [ ] **Step 1: 装 git-filter-repo，确认 worktree 干净、计划和 spec 已提交**

```bash
brew install git-filter-repo
git filter-repo --version
git -C $AF/.worktrees/miaodong-cli status --short
git -C $AF/.worktrees/miaodong-cli log --oneline -1
```

Expected:
- `git filter-repo --version` 打出版本号；
- `status` 没有输出；
- 最后一个提交包含本计划。

- [ ] **Step 2: clone 分支到 `$NEW`，只留 md 的文件，挪到根目录**

```bash
git clone --no-local --single-branch --branch feat/miaodong-cli $AF $NEW
git -C $NEW filter-repo \
  --path miaodong-kit/src/ --path miaodong-kit/test/ --path miaodong-kit/skill/ \
  --path miaodong-kit/lib/summarize.mjs \
  --path miaodong-kit/build.mjs --path miaodong-kit/install.mjs --path miaodong-kit/publish.mjs \
  --path-glob 'docs/superpowers/specs/2026-09-2*-miaodong-cli*' \
  --path-glob 'docs/superpowers/plans/2026-09-2*-miaodong-cli*' \
  --path-rename miaodong-kit/: \
  --path-rename docs/superpowers/specs/:docs/specs/ \
  --path-rename docs/superpowers/plans/:docs/plans/
git -C $NEW branch -m feat/miaodong-cli main
```

- [ ] **Step 3: 核对结果**

```bash
ls $NEW; ls $NEW/lib; ls $NEW/docs/specs $NEW/docs/plans
git -C $NEW log --oneline | wc -l
git -C $NEW ls-files src | wc -l
git -C $NEW ls-files | grep -E '^(bin/|lib/client|lib/credentials|PLAYBOOK|README.md$)' | wc -l
git -C $NEW remote -v | wc -l
git -C $NEW log --format='%s' | head -3
```

Expected:
- 根目录只有 `build.mjs docs install.mjs lib publish.mjs skill src test`；`lib/` 下只有 `summarize.mjs`；
- `docs/specs` 有 3 份 md 的 spec（2026-09-23、09-24、09-25 拆分设计）；`docs/plans` 有 6 份计划（step1、2a、2b、2c1、2c2、拆分）；
- 提交数不少于 90；
- `src` 下 59 个文件；
- 旧 kit 的文件 0 个；
- 没有 remote；
- 最新几个提交的标题是 md 的提交（最后一个是本计划）。

有任何一项不对就停下，按 systematic-debugging 查 filter-repo 的参数；不要在老懂里改东西凑结果。

- [ ] **Step 4: 记账**（这是搬家，不改代码，没有 RED/GREEN）

在 `$AF/.worktrees/miaodong-cli/.superpowers/sdd/…/progress.md` 记一行：`Task 1: complete（$NEW 由 filter-repo 生成，<提交数> 个提交，main=<短 sha>）`。

---

### Task 2: 带上老懂的代码，让测试在新仓库里独立跑通

**Files:**
- Create:
  - `$NEW/package.json`、`$NEW/.gitignore`、`$NEW/.nvmrc`
  - `$NEW/scripts/ts-resolve-loader.mjs`
  - `$NEW/vendor/laodong/**`（19 个文件）、`$NEW/vendor/laodong/SOURCE.json`
  - `$NEW/test/vendor.test.mjs`
- Move: `$NEW/lib/summarize.mjs` → `$NEW/src/summarize.mjs`
- Modify:
  - 10 个源码文件里的 12 行 import：`src/exec-detail.mjs`、`src/identity.mjs`、`src/api.mjs`、`src/trial-run.mjs`、`src/canvas.mjs`、`src/check.mjs`、`src/execs.mjs`、`src/exec-chain.mjs`、`src/commands/test-import.mjs`、`src/commands/trial.mjs`
  - `src/output.mjs`、`src/commands/inspect.mjs`：改引用 summarize
  - `test/helpers/run-cli.mjs`、`test/cli.test.mjs`、`test/bundle.test.mjs`

**Interfaces:**
- Produces:
  - `vendor/laodong/SOURCE.json`：`{ from, commit, syncedAt, files: string[] }`，Task 3 读写；
  - `package.json` 的 `test` / `build` / `install:local` 脚本。

- [ ] **Step 1: 仓库骨架**

`$NEW/package.json`：

```json
{
  "name": "miaodong-cli",
  "version": "0.0.0",
  "private": true,
  "description": "md：让 Claude Code / Codex 读写秒懂（JZ Insight）智能体的命令行工具",
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/*.test.mjs",
    "build": "node build.mjs",
    "install:local": "node install.mjs"
  },
  "dependencies": { "jsonrepair": "3.14.0" },
  "devDependencies": { "esbuild": "0.27.7" }
}
```

`$NEW/.gitignore`（**不要**忽略 `dist/`，产物要入库）：

```
node_modules/
.superpowers/
.DS_Store
*.log
```

`$NEW/.nvmrc`：`22`

`$NEW/scripts/ts-resolve-loader.mjs`：从老懂那份改来，去掉只有老懂用得上的 `@/` 别名：

```js
// 测试用：Node 22 用 --experimental-strip-types 跑源码时，让不带扩展名的相对引用能找到 .ts 文件
// （vendor/laodong 里老懂的 TS 文件是这样写的）。打包不走这里，esbuild 自己会解析。
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function resolveExistingTsUrl(baseUrl) {
  for (const candidate of [baseUrl, new URL(`${baseUrl.href}.ts`), new URL(`${baseUrl.href}.tsx`)]) {
    try {
      await access(fileURLToPath(candidate));
      return { url: candidate.href, shortCircuit: true };
    } catch {
      // 试下一个扩展名
    }
  }
  return null;
}

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
    if (!isRelative || specifier.endsWith('.ts')) throw error;
    const resolved = await resolveExistingTsUrl(new URL(specifier, context.parentURL));
    if (resolved) return resolved;
    throw error;
  }
}
```

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm install
```

Expected: 生成 `node_modules/` 和 `package-lock.json`，没有报错。

- [ ] **Step 2: 写失败的测试** `$NEW/test/vendor.test.mjs`

```js
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
```

- [ ] **Step 3: 跑，确认失败**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/vendor.test.mjs
```

Expected: FAIL。报错是读 `vendor/laodong/SOURCE.json` 时 `ENOENT`。

- [ ] **Step 4: 按老懂 `4967e17` 原样复制 19 个文件，写 `SOURCE.json`**

```bash
FILES="apps/api/lib/chat-agent/validate-workflow.ts
apps/api/lib/miaodong/badcase-normalize.ts
apps/api/lib/miaodong/canvas-content-patch.ts
apps/api/lib/miaodong/canvas-derive.ts
apps/api/lib/miaodong/trial-core.ts
packages/shared/src/miaodong-regions.ts
packages/shared/src/workflow-risk/analyzer.ts
packages/shared/src/workflow-risk/context.ts
packages/shared/src/workflow-risk/index.ts
packages/shared/src/workflow-risk/rules/broken-ref.ts
packages/shared/src/workflow-risk/rules/compliance.ts
packages/shared/src/workflow-risk/rules/content.ts
packages/shared/src/workflow-risk/rules/js-runtime.ts
packages/shared/src/workflow-risk/rules/llm-json.ts
packages/shared/src/workflow-risk/rules/reachability.ts
packages/shared/src/workflow-risk/rules/rule-center.ts
packages/shared/src/workflow-risk/rules/session.ts
packages/shared/src/workflow-risk/types.ts
packages/shared/src/workflowParser.ts"
SHA=$(git -C $AF rev-parse 4967e17)
for f in $FILES; do mkdir -p "$NEW/vendor/laodong/$(dirname "$f")"; git -C $AF show "$SHA:$f" > "$NEW/vendor/laodong/$f"; done
```

再写 `SOURCE.json`（`files` 按路径排序，正好是上面那 19 个）：

```bash
python3 - "$SHA" "$NEW" <<'PY'
import json, sys, pathlib
sha, new = sys.argv[1], sys.argv[2]
root = pathlib.Path(new) / 'vendor' / 'laodong'
files = sorted(str(p.relative_to(root)) for p in root.rglob('*.ts'))
assert len(files) == 19, files
(root / 'SOURCE.json').write_text(json.dumps({'from': '句子老懂仓库（Agentflow）', 'commit': sha, 'syncedAt': '2026-09-25', 'files': files}, ensure_ascii=False, indent=2) + '\n')
print(len(files), 'files')
PY
```

Expected: 打出 `19 files`。

- [ ] **Step 5: 改引用，挪 summarize，修测试里写死的路径**

```bash
cd $NEW && git mv lib/summarize.mjs src/summarize.mjs && python3 - <<'PY'
import pathlib, re
root = pathlib.Path('.')
n = 0
for path in list(root.glob('src/*.mjs')) + list(root.glob('src/commands/*.mjs')):
    s = path.read_text()
    depth = '../' if path.parent.name == 'src' else '../../'
    old = s
    # 老懂的路径 → vendor/laodong 下的同一路径
    s = re.sub(r"from '(?:\.\./)+(apps|packages)/", lambda m: f"from '{depth}vendor/laodong/{m.group(1)}/", s)
    # 旧 kit 的 summarize → src/summarize.mjs
    s = s.replace("from '../lib/summarize.mjs'", "from './summarize.mjs'").replace("from '../../lib/summarize.mjs'", "from '../summarize.mjs'")
    if s != old:
        path.write_text(s); n += 1
print('changed files', n)
p = root / 'src' / 'summarize.mjs'
s = p.read_text()
s = s.replace('// miaodong-kit/lib/summarize.mjs', '// src/summarize.mjs：画布摘要（从旧 kit 带过来，md 只用 shortId、describeNode）', 1)
p.write_text(s)
PY
grep -rn "from '\(\.\./\)\+\(apps\|packages\|lib\)/" src | wc -l
```

Expected:
- `changed files 13`：10 个改 vendor 引用的文件，加上 `output.mjs`、`commands/inspect.mjs`、`summarize.mjs` 自己；
- 最后一行输出 `0`。

`test/helpers/run-cli.mjs`：

```js
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOADER_URL = pathToFileURL(join(REPO, 'scripts', 'ts-resolve-loader.mjs')).href;
const CLI = join(REPO, 'src', 'cli.mjs');
```

`test/cli.test.mjs`：
- `join(REPO, 'miaodong-kit/src/output.mjs')` 改成 `join(REPO, 'src/output.mjs')`；
- 「lib/credentials.mjs 与 src/args.mjs 共用同一份 parseArgs」这条测的是旧 kit 和 md 共用代码，新仓库里没有旧 kit，换成：

```js
test('parseArgs：--confirm false 当布尔 false', async () => {
  const { parseArgs } = await import('../src/args.mjs');
  assert.equal(parseArgs(['--confirm', 'false']).confirm, false);
});
```

`test/bundle.test.mjs` 里「产物不带源码注释和源码路径」那条：
- `/\/\/ (apps|packages|miaodong-kit)\//` 改成 `/\/\/ (src|vendor|apps|packages)\//`。

`install.mjs` 第 3 行注释里的「切到没有 miaodong-kit 的分支时」改成「切到没有 md 代码的分支时」。这个文件 Task 5 会整个重写，这里先让独立测试不误报。

- [ ] **Step 6: 跑，确认通过；再跑全套**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/vendor.test.mjs
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node npm test > /tmp/md-t2.log 2>&1; tail -8 /tmp/md-t2.log
```

Expected:
- vendor.test 3 条全过；
- 全套全过：原来 320 条加上这 3 条 = 323 条。

独立测试（第 3 条）如果报出别的文件，说明还有注释或字符串写着老懂的路径：
- 注释改成不带路径的说法；
- 测试里的正则按上面 bundle.test 的方式改；
- 每处改动记一行 Ruling。

- [ ] **Step 7: 提交**

```bash
cd $NEW && git add -A && git commit -q -F - <<'EOF'
feat: 带上老懂的 19 个文件（vendor/laodong），测试在本仓库独立跑通

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: 同步脚本 `npm run sync:laodong`

**Files:**
- Create: `$NEW/scripts/sync-laodong.mjs`、`$NEW/test/sync-laodong.test.mjs`
- Modify: `$NEW/package.json`（加 `sync:laodong`）

**Interfaces:**
- Consumes: Task 2 的 `SOURCE.json`。
- Produces: `syncVendor({ from, root }) → { changed: string[], missing: string[], commit: string | null, dirty: boolean }`。

- [ ] **Step 1: 写失败的测试** `$NEW/test/sync-laodong.test.mjs`

```js
// 同步老懂的代码（spec §4）：按 SOURCE.json 的清单原样拷贝，报出变了哪些、缺了哪些，记下老懂的提交号。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncVendor } from '../scripts/sync-laodong.mjs';
import { tempHome } from './helpers/run-cli.mjs';

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
// 一个假的老懂仓库：git init、写文件、提交
function fakeLaodong(files) {
  const dir = tempHome();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, files);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}
// 一个假的本仓库：vendor/laodong 下有 SOURCE.json 和旧文件
function fakeRoot(files, vendorFiles) {
  const root = tempHome();
  write(join(root, 'vendor', 'laodong'), { 'SOURCE.json': JSON.stringify({ commit: 'old', files }), ...vendorFiles });
  return root;
}

test('sync：内容一样就不动；老懂改了的拷过来并报出来；SOURCE.json 记下老懂的提交号', () => {
  const from = fakeLaodong({ 'a/x.ts': 'export const x = 1;\n', 'b/y.ts': 'export const y = 2;\n' });
  const root = fakeRoot(['a/x.ts', 'b/y.ts'], { 'a/x.ts': 'export const x = 1;\n', 'b/y.ts': 'export const y = 1;\n' });
  const r = syncVendor({ from, root });
  assert.deepEqual([r.changed, r.missing, r.dirty], [['b/y.ts'], [], false]);
  assert.equal(readFileSync(join(root, 'vendor', 'laodong', 'b', 'y.ts'), 'utf-8'), 'export const y = 2;\n');
  const source = JSON.parse(readFileSync(join(root, 'vendor', 'laodong', 'SOURCE.json'), 'utf-8'));
  assert.equal(source.commit, execFileSync('git', ['-C', from, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim());
  assert.deepEqual(syncVendor({ from, root }).changed, []);
});

test('sync：老懂里找不到清单上的文件就报出来、一个都不拷；工作区有没提交的改动要说；给的不是 git 仓库就报错', () => {
  const from = fakeLaodong({ 'a/x.ts': 'x' });
  const root = fakeRoot(['a/x.ts', 'gone.ts'], { 'a/x.ts': 'old' });
  const r = syncVendor({ from, root });
  assert.deepEqual([r.missing, r.changed], [['gone.ts'], []]);
  assert.equal(readFileSync(join(root, 'vendor', 'laodong', 'a', 'x.ts'), 'utf-8'), 'old');
  const root2 = fakeRoot(['a/x.ts'], { 'a/x.ts': 'x' });
  writeFileSync(join(from, 'a', 'x.ts'), 'x 改了没提交');
  assert.equal(syncVendor({ from, root: root2 }).dirty, true);
  assert.throws(() => syncVendor({ from: tempHome(), root }), /不是 git 仓库/);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/sync-laodong.test.mjs
```

Expected: FAIL，找不到 `../scripts/sync-laodong.mjs`。

- [ ] **Step 3: 实现** `$NEW/scripts/sync-laodong.mjs`

```js
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
```

`package.json` 的 `scripts` 加一行：`"sync:laodong": "node scripts/sync-laodong.mjs"`。

- [ ] **Step 4: 跑，确认通过；对着真的老懂跑一次（验收第 3 条）**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/sync-laodong.test.mjs
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm run sync:laodong -- $AF
git -C $NEW status --short
```

Expected:
- 2 条测试通过；
- 同步输出「没有变化（老懂 4967e17）」；
- `git status` 只有这个任务新加的文件，vendor 里没有改动。

- [ ] **Step 5: 提交**

```bash
cd $NEW && git add scripts/sync-laodong.mjs test/sync-laodong.test.mjs package.json && git commit -q -F - <<'EOF'
feat: npm run sync:laodong——按清单从老懂同步 vendor，列出变化并跑测试

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: `install.sh`：软链安装，认得旧装法

**Files:**
- Create: `$NEW/install.sh`、`$NEW/test/install-sh.test.mjs`

**Interfaces:**
- Consumes: 仓库布局 `skill/`、`dist/md.mjs`；`build.mjs` 的 `buildBundle({ outfile })`。
- Produces:
  - `install.sh` 的约定：以自己所在目录为仓库根；读 `HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`AGENTS_SKILLS_DIR`；
  - 旧装法的备份放在 `$HOME/.miaodong/old-installs/<时间>/<位置名>`，例如 `claude-skills-miaodong`。

- [ ] **Step 1: 写失败的测试** `$NEW/test/install-sh.test.mjs`

```js
// install.sh：同事和开发者共用的安装脚本（spec §6）。以「新同事」和「装过旧版的人」的身份各跑一遍：HOME 指向临时目录。
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../build.mjs';
import { tempHome } from './helpers/run-cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let bundle;
before(async () => { ({ outfile: bundle } = await buildBundle({ outfile: join(tempHome(), 'md.mjs') })); });

// 一份「仓库」：和真仓库同样的布局（install.sh、skill/、dist/md.mjs）
function repoCopy(parent = tempHome(), name = 'miaodong-cli') {
  const dir = join(parent, name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  cpSync(join(ROOT, 'install.sh'), join(dir, 'install.sh'));
  cpSync(join(ROOT, 'skill'), join(dir, 'skill'), { recursive: true });
  cpSync(bundle, join(dir, 'dist', 'md.mjs'));
  return realpathSync(dir);
}
function runInstall(repo, home) {
  const r = spawnSync('bash', [join(repo, 'install.sh')], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const SKILL_ROOTS = ['.claude/skills', '.codex/skills', '.agents/skills'];
const assertInstalled = (home, repo) => {
  for (const root of SKILL_ROOTS) assert.equal(readlinkSync(join(home, root, 'miaodong')), join(repo, 'skill'), root);
  assert.equal(readlinkSync(join(home, '.local', 'bin', 'md')), join(repo, 'dist', 'md.mjs'));
};

test('install.sh：新装——三个 skills 位置指向 skill/，~/.local/bin/md 指向 dist/md.mjs，装完能跑；重复执行不出错', () => {
  const repo = repoCopy();
  const home = tempHome();
  const first = runInstall(repo, home);
  assert.equal(first.code, 0, first.out);
  assertInstalled(home, repo);
  assert.match(execFileSync(join(home, '.local', 'bin', 'md'), ['--version'], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '' } }), /^md /);
  assert.match(first.out, /完成/);
  const again = runInstall(repo, home);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /已存在/);
});

test('install.sh：别人的东西不动、只提示；zsh 里 md 是别名时提醒', () => {
  const repo = repoCopy();
  const home = tempHome();
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'md'), '别人的 md');
  mkdirSync(join(home, '.codex', 'skills', 'miaodong'), { recursive: true });
  writeFileSync(join(home, '.codex', 'skills', 'miaodong', 'SKILL.md'), '---\nname: other\n---\n');
  writeFileSync(join(home, '.zshrc'), "alias md='mkdir -p'\n");
  const r = runInstall(repo, home);
  assert.equal(readFileSync(join(home, '.local', 'bin', 'md'), 'utf-8'), '别人的 md');
  assert.equal(readFileSync(join(home, '.codex', 'skills', 'miaodong', 'SKILL.md'), 'utf-8'), '---\nname: other\n---\n');
  assert.match(r.out, /跳过 .*\.local\/bin\/md/);
  assert.match(r.out, /跳过 .*\.codex\/skills\/miaodong/);
  assert.match(r.out, /md 是个别名/);
});

// 同事的旧装法：magic-skills/miaodong clone 在 ~/.claude/skills/miaodong，另两处软链指向它，md 指向其中的 scripts/md.mjs
function oldColleagueInstall(home) {
  const old = join(home, '.claude', 'skills', 'miaodong');
  mkdirSync(join(old, 'scripts'), { recursive: true });
  writeFileSync(join(old, 'SKILL.md'), '---\nname: miaodong\ndescription: 旧版\n---\n');
  writeFileSync(join(old, 'scripts', 'md.mjs'), '旧的 md');
  for (const root of ['.codex/skills', '.agents/skills']) {
    mkdirSync(join(home, root), { recursive: true });
    symlinkSync(old, join(home, root, 'miaodong'));
  }
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(join(old, 'scripts', 'md.mjs'), join(home, '.local', 'bin', 'md'));
}
// 开发者的旧装法（旧版 npm run md:install）：带 .md-cli-skill 标记的真身目录，codex 和 md 是指向它的软链；~/.agents 里是个悬空软链
function oldDeveloperInstall(home) {
  const old = join(home, '.claude', 'skills', 'miaodong');
  mkdirSync(join(old, 'scripts'), { recursive: true });
  writeFileSync(join(old, '.md-cli-skill'), 'f47b58d@2026-09-25\n');
  writeFileSync(join(old, 'SKILL.md'), '---\nname: miaodong\n---\n');
  writeFileSync(join(old, 'scripts', 'md.mjs'), '旧的 md');
  mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
  symlinkSync(old, join(home, '.codex', 'skills', 'miaodong'));
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  symlinkSync(join(home, '已经删掉的旧目录'), join(home, '.agents', 'skills', 'miaodong'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(join(old, 'scripts', 'md.mjs'), join(home, '.local', 'bin', 'md'));
}
const backupOf = (home) => {
  const dirs = readdirSync(join(home, '.miaodong', 'old-installs'));
  assert.equal(dirs.length, 1);
  return join(home, '.miaodong', 'old-installs', dirs[0], 'claude-skills-miaodong');
};

test('install.sh：认得同事的旧装法——旧 clone 挪去 ~/.miaodong/old-installs 备份，所有链接改指新位置', () => {
  const repo = repoCopy();
  const home = tempHome();
  oldColleagueInstall(home);
  const r = runInstall(repo, home);
  assert.equal(r.code, 0, r.out);
  assertInstalled(home, repo);
  assert.equal(readFileSync(join(backupOf(home), 'scripts', 'md.mjs'), 'utf-8'), '旧的 md');
  assert.match(r.out, /备份/);
});

test('install.sh：认得开发者的旧装法（带标记的真身目录）；悬空的软链直接换成新的', () => {
  const repo = repoCopy();
  const home = tempHome();
  oldDeveloperInstall(home);
  const r = runInstall(repo, home);
  assert.equal(r.code, 0, r.out);
  assertInstalled(home, repo);
  assert.ok(existsSync(join(backupOf(home), '.md-cli-skill')));
});

test('install.sh：把仓库直接 clone 进 ~/.claude/skills/miaodong 的，明确报错、说清怎么做', () => {
  const home = tempHome();
  const repo = repoCopy(join(home, '.claude', 'skills'), 'miaodong');
  const r = runInstall(repo, home);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /不要把仓库 clone 到/);
});

test('install.sh：路径里有空格也能装；缺 dist/md.mjs 时说清楚', () => {
  const repo = repoCopy(join(tempHome(), 'my tools'));
  const home = tempHome();
  const ok = runInstall(repo, home);
  assert.equal(ok.code, 0, ok.out);
  assertInstalled(home, repo);
  const bare = repoCopy();
  rmSync(join(bare, 'dist', 'md.mjs'));
  const r = runInstall(bare, tempHome());
  assert.notEqual(r.code, 0);
  assert.match(r.out, /缺 dist\/md\.mjs/);
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/install-sh.test.mjs
```

Expected: 6 条都 FAIL（复制 `install.sh` 时报 `ENOENT`）。

- [ ] **Step 3: 实现** `$NEW/install.sh`（写完 `chmod +x`）

```bash
#!/usr/bin/env bash
# 安装 md：给 Claude Code / Codex / ~/.agents 接上使用说明（skill/），把 md 命令放上 PATH（~/.local/bin/md）。
# 全用软链：git pull 之后自动生效；可以重复执行。
# 认得旧装法（从 magic-skills/miaodong 装的、旧版 npm run md:install 装的）：旧目录挪去 ~/.miaodong/old-installs/<时间>/ 备份，
# 链接改指新位置。备份不放在 skills 目录里：那里的东西会被当成 skill 加载。别人的东西一律不动，只提示。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NAME="miaodong"
SKILL_SRC="$ROOT/skill"
BIN_SRC="$ROOT/dist/md.mjs"
CLAUDE_SKILLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
CODEX_SKILLS="${CODEX_HOME:-$HOME/.codex}/skills"
AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
BIN_LINK="$HOME/.local/bin/md"
BACKUP_DIR="$HOME/.miaodong/old-installs/$(date +%Y%m%d-%H%M%S)"

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$major" -lt 18 ]; then
  echo "需要 Node.js 18 或更高（当前：$(node -v 2>/dev/null || echo 未安装)）"
  exit 1
fi
if [ ! -f "$BIN_SRC" ]; then
  echo "缺 dist/md.mjs：仓库不完整。重新 git clone 一次；开发者可以先 npm run build"
  exit 1
fi
if [ -d "$CLAUDE_SKILLS/$NAME" ] && [ "$(cd "$CLAUDE_SKILLS/$NAME" && pwd -P)" = "$ROOT" ]; then
  echo "不要把仓库 clone 到 $CLAUDE_SKILLS/$NAME：那里要放的是仓库里的 skill/ 目录。"
  echo "换个地方 clone（例如 ~/tools/miaodong-cli），再在那里运行 ./install.sh"
  exit 1
fi

# 这个目录是不是 md 的旧装法：有 .md-cli-skill 标记（旧版 npm run md:install），或者 SKILL.md 写着 name: miaodong
is_old_md_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] && { [ -f "$1/.md-cli-skill" ] || grep -Eq '^name:[[:space:]]*miaodong[[:space:]]*$' "$1/SKILL.md" 2>/dev/null; }
}
# 这个软链是不是指向旧装法（旧 skill 目录，或者其中的 scripts/md.mjs）
points_to_old() {
  local target
  target="$(readlink "$1")"
  case "$target" in */scripts/md.mjs) target="${target%/scripts/md.mjs}" ;; esac
  is_old_md_dir "$target"
}
# 备份目录里用的名字：.claude/skills/miaodong → claude-skills-miaodong
label_of() {
  printf '%s' "${1#"$HOME"/}" | sed -e 's#^\.##' -e 's#/\.#/#g' -e 's#/#-#g'
}

# 先认一遍（挪走旧目录之前）：哪些软链指向旧装法
old_links="|"
for dest in "$CLAUDE_SKILLS/$NAME" "$CODEX_SKILLS/$NAME" "$AGENTS_SKILLS/$NAME" "$BIN_LINK"; do
  if [ -L "$dest" ] && points_to_old "$dest"; then old_links="$old_links$dest|"; fi
done
# 旧目录挪去备份
for dest in "$CLAUDE_SKILLS/$NAME" "$CODEX_SKILLS/$NAME" "$AGENTS_SKILLS/$NAME"; do
  if is_old_md_dir "$dest"; then
    mkdir -p "$BACKUP_DIR"
    mv "$dest" "$BACKUP_DIR/$(label_of "$dest")"
    echo "  旧版挪到 $BACKUP_DIR/$(label_of "$dest")（备份；确认新版能用后可以删掉）"
  fi
done

link() {
  local target="$1" dest="$2" current
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ]; then
    current="$(readlink "$dest")"
    if [ "$current" = "$target" ]; then echo "  已存在 $dest"; return; fi
    case "$old_links" in
      *"|$dest|"*) rm "$dest"; ln -s "$target" "$dest"; echo "  改指 $dest -> $target（原来指向旧版）"; return ;;
    esac
    if [ ! -e "$dest" ]; then
      rm "$dest"; ln -s "$target" "$dest"; echo "  改指 $dest -> $target（原来指向的地方已经不在了）"; return
    fi
    echo "  ⚠️ 跳过 $dest：它指向 $current，不是 md，没动它"
    return
  fi
  if [ -e "$dest" ]; then
    echo "  ⚠️ 跳过 $dest：那里已有别的文件，没动它"
    return
  fi
  ln -s "$target" "$dest"
  echo "  链接 $dest -> $target"
}

chmod +x "$BIN_SRC"
echo "安装 md（$ROOT）"
link "$SKILL_SRC" "$CLAUDE_SKILLS/$NAME"
link "$SKILL_SRC" "$CODEX_SKILLS/$NAME"
link "$SKILL_SRC" "$AGENTS_SKILLS/$NAME"
link "$BIN_SRC" "$BIN_LINK"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "⚠️ $HOME/.local/bin 不在 PATH 里：在 ~/.zshrc 加一行 export PATH=\"\$HOME/.local/bin:\$PATH\"，然后重开终端" ;;
esac
# oh-my-zsh 默认有 alias md='mkdir -p'：md auth import 会变成建两个目录，而且不报错
if command -v zsh >/dev/null 2>&1 && [ -n "$(zsh -ic 'alias md' 2>/dev/null)" ]; then
  echo "⚠️ 你的 zsh 里 md 是个别名（多半是 oh-my-zsh 的 alias md='mkdir -p'），会盖住这个命令。"
  echo "   在 ~/.zshrc 里 oh-my-zsh 那一行之后加一行 unalias md，然后重开终端。"
fi

echo
node "$BIN_SRC" --version
echo "完成。Claude Code 里描述秒懂任务会自动触发（或输入 /$NAME）；Codex 用 \$$NAME。更新：git pull 之后再跑一次 ./install.sh"
```

- [ ] **Step 4: 跑，确认通过**

```bash
cd $NEW && chmod +x install.sh && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/install-sh.test.mjs
```

Expected: 6 条全过。

- [ ] **Step 5: 提交**

```bash
cd $NEW && git add install.sh test/install-sh.test.mjs && git commit -q -F - <<'EOF'
feat: install.sh——同事和开发者共用的软链安装，认得旧装法并备份到 ~/.miaodong/old-installs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: `install:local`、`release`、给同事看的 README，去掉旧的发布方式

**Files:**
- Rewrite: `$NEW/install.mjs`、`$NEW/test/install.test.mjs`
- Create: `$NEW/release.mjs`、`$NEW/test/release.test.mjs`、`$NEW/README.md`
- Move: `$NEW/skill/THIRD_PARTY_NOTICES.md` → `$NEW/THIRD_PARTY_NOTICES.md`
- Delete: `$NEW/publish.mjs`、`$NEW/test/publish.test.mjs`、`$NEW/skill/scripts/install.sh`、`$NEW/skill/README.md`、`$NEW/skill/.gitignore`
- Modify: `$NEW/package.json`（加 `release`）

**Interfaces:**
- Consumes: Task 4 的 `install.sh`；`buildBundle({ outfile })`。
- Produces:
  - `installLocal({ root, home, exportDir }) → { tag, logs }`；
  - `scanForLeaks(dirs, root) → [{ file, what, sample }]`。

- [ ] **Step 1: 写失败的测试**

`$NEW/test/install.test.mjs` 整个换成：

```js
// npm run install:local（开发者）：构建、跑 install.sh、放一份桌面副本（spec §6）。只在临时目录里装。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLocal } from '../install.mjs';
import { tempHome } from './helpers/run-cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 一份仓库副本：构建产物写进副本，不碰真仓库的 dist/
function repoCopy() {
  const dir = join(tempHome(), 'miaodong-cli');
  mkdirSync(dir, { recursive: true });
  for (const name of ['install.sh', 'README.md', 'THIRD_PARTY_NOTICES.md']) cpSync(join(ROOT, name), join(dir, name));
  cpSync(join(ROOT, 'skill'), join(dir, 'skill'), { recursive: true });
  return realpathSync(dir);
}

test('install:local：构建进仓库的 dist/、用 install.sh 装、放一份桌面副本（布局同仓库，拿到的人跑 ./install.sh 就能装）；重复安装不出错', async () => {
  const root = repoCopy();
  const home = tempHome();
  const exportDir = join(home, 'Desktop', 'miaodong');
  const { logs } = await installLocal({ root, home, exportDir });
  assert.equal(readlinkSync(join(home, '.claude', 'skills', 'miaodong')), join(root, 'skill'));
  assert.equal(readlinkSync(join(home, '.local', 'bin', 'md')), join(root, 'dist', 'md.mjs'));
  for (const file of ['install.sh', 'README.md', 'skill/SKILL.md', 'dist/md.mjs']) assert.ok(existsSync(join(exportDir, file)), `桌面副本缺 ${file}`);
  assert.match(logs.join('\n'), /已放一份到/);
  await installLocal({ root, home, exportDir });
});

test('install:local：桌面那个位置已有别人的东西时不覆盖', async () => {
  const home = tempHome();
  const exportDir = join(home, 'Desktop', 'miaodong');
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, '别人的.txt'), '别动');
  await assert.rejects(installLocal({ root: repoCopy(), home, exportDir }), /不是 md 放的/);
  assert.equal(readFileSync(join(exportDir, '别人的.txt'), 'utf-8'), '别动');
});

test('SKILL.md 头部合规：name 为 miaodong，description 不超过 1024 字', () => {
  const text = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
  const head = text.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(head, /^name: miaodong$/m);
  assert.ok(head.match(/^description: (.*)$/m)[1].length <= 1024);
});
```

`$NEW/test/release.test.mjs`：

```js
// npm run release 的扫描：dist/ 和 skill/ 里不能带本机路径、身份串、token（spec §6、§8 第 8 条）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanForLeaks } from '../release.mjs';
import { tempHome } from './helpers/run-cli.mjs';

test('release：扫出本机路径、身份串和 token；正常的 ~/ 路径、代码里的 Bearer ${token} 不报', () => {
  const dir = tempHome();
  writeFileSync(join(dir, 'a.md'), '装到 ~/.local/bin/md；请求头是 Authorization: `Bearer ${identity.token}`');
  assert.deepEqual(scanForLeaks([dir], dir), []);
  writeFileSync(join(dir, 'b.mjs'), `const p = '/Users/somebody/x'; const t = 'Bearer ${'abcdefghij'.repeat(3)}'; const a = 'md-auth:${'eyJ'}${'Q'.repeat(24)}';`); // 假 token 拼出来：发版扫描查全部会进仓库的文件
  assert.deepEqual(scanForLeaks([dir], dir).map((h) => h.what).sort(), ['token', '本机路径', '身份串'].sort());
});
```

- [ ] **Step 2: 跑，确认失败**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/install.test.mjs test/release.test.mjs
```

Expected: FAIL：
- `install.mjs` 没有导出 `installLocal`；
- 找不到 `../release.mjs`；
- 复制 `README.md` 时 `ENOENT`。

- [ ] **Step 3: 实现**

`$NEW/install.mjs` 整个换成：

```js
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
```

`$NEW/release.mjs`：

```js
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
```

`package.json` 的 `scripts` 加 `"release": "node release.mjs"`。

搬文件、删文件：

```bash
cd $NEW && git mv skill/THIRD_PARTY_NOTICES.md THIRD_PARTY_NOTICES.md \
  && git rm -q publish.mjs test/publish.test.mjs skill/scripts/install.sh skill/README.md skill/.gitignore \
  && sed -i '' 's#`scripts/md.mjs` 是打包产物#`dist/md.mjs` 是打包产物#' THIRD_PARTY_NOTICES.md
```

`$NEW/README.md`：拿原来的 `skill/README.md` 改写。上一步已经 `git rm` 了它，还没提交，用 `git show HEAD:skill/README.md` 看原文。
- **原样保留**：功能清单、「第一次用」、「它怎么保证不出事」三节。
- **改掉的地方**：
  - 标题：`# miaodong-cli（秒懂 md）`。
  - 第一段：`一个命令行工具 md，外加一份给 AI 看的使用说明。装上以后，Claude Code 或 Codex 会用 md 直接读写秒懂智能体画布，完成修 bot 的整个流程：`。
  - 「## 安装」换成：

````markdown
## 安装

前提：
- **Node.js 18 或更高版本**（用 `node -v` 查看）。
- 能访问这个仓库：它是私有仓库，找 Spider615 把你的 GitHub 账号加成协作者，并在本机登录 GitHub（`gh auth login`，或者配好 SSH 后把下面的地址换成 `git@github.com:Spider615/miaodong-cli.git`）。没有权限时 GitHub 只会报 `Repository not found`。
- **macOS**：取身份时读剪贴板。Linux 也能用，只是导入身份要在自己的终端运行 `md auth import --stdin` 再粘贴；Windows 请在 WSL 里用。

```bash
git clone https://github.com/Spider615/miaodong-cli.git ~/tools/miaodong-cli
~/tools/miaodong-cli/install.sh
```

clone 到哪都行，就是**不要 clone 到 `~/.claude/skills/` 下面**（`install.sh` 会拦）。`install.sh` 做三件事：
- 把使用说明（仓库里的 `skill/`）接到 Claude Code（`~/.claude/skills`）、Codex（`~/.codex/skills`）和通用位置（`~/.agents/skills`）；
- 把 `md` 命令放到 `~/.local/bin`；
- 以前从 `magic-skills/miaodong` 装过的，它会把旧的挪到 `~/.miaodong/old-installs/` 备份，换成新的。

它可以反复运行；那些位置上如果有不属于 md 的东西，它不会动，只会提示。

如果它提示 `~/.local/bin 不在 PATH 里`（macOS 默认就不在），在 `~/.zshrc` 里加一行 `export PATH="$HOME/.local/bin:$PATH"`。**装完重开终端，并重启 Claude Code / Codex**，它们才能找到 `md`。

**更新**：`git -C ~/tools/miaodong-cli pull`，然后再跑一次 `install.sh`。
````

  - 「## 常见问题」里「clone 时报 destination path already exists…」那条换成：`- **以前从 magic-skills/miaodong 装过**：直接按上面的步骤装新版，install.sh 会把旧版挪去备份。`
  - 「## 维护」换成：

````markdown
## 开发

源码在 `src/`，测试在 `test/`，开发说明见 `CLAUDE.md`。
- 测试：Node 22 下 `npm test`（`.nvmrc` 写着 22）。
- 发版：`MD_E2E_NODE=<Node 18 的 node 路径> npm run release`，看过 diff 后把 `dist/md.mjs` 一起提交、推送。同事 `git pull` 拿到的就是这一版。
- `vendor/laodong/` 是句子老懂仓库的代码，原样拷贝，不在这里改：`npm run sync:laodong -- <老懂仓库路径>` 同步。

第三方软件声明见 `THIRD_PARTY_NOTICES.md`。
````

- [ ] **Step 4: 跑，确认通过；再跑全套**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/install.test.mjs test/release.test.mjs
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node npm test > /tmp/md-t5.log 2>&1; tail -8 /tmp/md-t5.log
```

Expected:
- 新测试全过；
- 全套全过。旧的 publish 测试删掉了 4 条，install 测试从 3 条变成 3 条，新加 release 1 条；以 `# fail 0` 为准。

- [ ] **Step 5: 提交**

```bash
cd $NEW && git add -A && git commit -q -F - <<'EOF'
feat: install:local 走 install.sh、npm run release 发版检查、给同事看的 README；去掉往 skill 仓库发布的脚本

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: 给 AI 助手的开发说明，改掉使用说明里的旧说法

**Files:**
- Create: `$NEW/CLAUDE.md`、`$NEW/AGENTS.md`（两份内容相同）
- Modify: `$NEW/skill/SKILL.md`（「开场」里让用户「按 README 的常见问题处理」那句）

- [ ] **Step 1: 写 `CLAUDE.md`**（`AGENTS.md` 复制同一份）

```markdown
# CLAUDE.md

面向 Claude / Codex 等自动化助手的开发说明。给同事看的介绍和安装见 README.md。

## 这是什么

md：让 Claude Code / Codex 读写秒懂（JZ Insight）智能体的命令行工具，外加一份给 AI 看的使用说明（`skill/`，装好后叫 miaodong）。
2026-09-25 从句子老懂仓库（Agentflow）的 `miaodong-kit/` 拆出来，历史一起带过来了。设计文档在 `docs/specs/`，实现计划在 `docs/plans/`。

## 目录

- `src/`：md 源码（`src/cli.mjs` 是入口，子命令在 `src/commands/`）
- `test/`：测试。全部对着假秒懂 server 跑，绝不连真实秒懂
- `skill/`：给 AI 看的使用说明，`install.sh` 把它软链到每个人的 `~/.claude/skills/miaodong`
- `vendor/laodong/`：句子老懂仓库的 19 个文件，原样拷贝（见下面第 3 条）
- `dist/md.mjs`：打包好的单文件，**已发布的版本**，同事装的就是它
- `install.sh`：同事和开发者共用的安装脚本
- `build.mjs` / `install.mjs` / `release.mjs`：构建、本机安装、发版检查
- `scripts/`：测试用的 TS 加载器、`sync-laodong.mjs`

## 常用命令

```bash
npm test                                   # 全部测试。要 Node 22（这台机器默认是 18）：先 nvm use，或者把 Node 22 的 bin 放到 PATH 前面
MD_E2E_NODE=<Node 18 的 node> npm test     # 同时验证打包产物在 Node 18 上能跑
npm run build                              # 构建 dist/md.mjs
npm run install:local                      # 构建 + install.sh + 桌面副本（MD_EXPORT_DIR='' 不放）
MD_E2E_NODE=<Node 18 的 node> npm run release   # 发版检查；看过 diff 后连同 dist/md.mjs 一起提交、推送
npm run sync:laodong -- <老懂仓库路径>       # 同步 vendor/laodong
```

## 改之前必读

1. **身份只从浏览器控制台取**（`md auth snippet` → 剪贴板 → `md auth import`），不存密码。token 不进对话、不进报错。身份按区存在 `~/.miaodong/md/identities.json`（0600），不要读它。
2. **写秒懂只调 `canvas/save`**，默认预演，带 `--confirm <计划码>` 才写。推送是元素级三方合并（`src/merge.mjs`），不是全量覆盖。
3. **`vendor/laodong/` 不在本仓库改**：它是老懂代码的原样拷贝，`SOURCE.json` 记着来源提交和文件清单。要改就去老懂改，再 `npm run sync:laodong`。`test/vendor.test.mjs` 守着依赖是否完整，也守着 vendor 以外的代码不再指向老懂仓库。
4. **花钱、调插件、调高门槛要用户确认**（`src/confirm.mjs`）：需要确认时 md 不跑，只给预估和确认码（退出码 5）。AI 单独问用户，同意后在同一条命令加 `--confirm <码>`。这是约定不是锁：不要加「跳过确认」的开关，也不要把确认码写进任何自动流程。
5. **测试中心**（`src/testcenter.mjs` 接口，`src/testcases.mjs` 换 id 与跑前检查）：秒懂对事件、会话变量对不上的用例不报错，显示成功但其实空跑，所以跑前检查必须拦。导入的撤回只按导入前后的差集删，不碰集里原有的用例。
6. **外部用例与批量改**（`src/casefile.mjs` 解析与校验，`src/caseedit.mjs` 改动脚本）：写秒懂之前先在本地校验全部，外部用例先写 1 条读回来核对。断言只生成实测过的形状（发文本、发事件、转人工），别的用 raw。批量改走计划码，先备份再写。
7. **`dist/md.mjs` 只在发版时更新**：`npm run release` 构建、扫过之后再提交；平时开发别把 dist 的改动混进别的提交。
8. **`skill/` 改了就对所有人生效**：它是软链装的，同事 `git pull` 之后马上用上新说明。
9. **本仓库必须保持私有**：`vendor/laodong/packages/shared/src/miaodong-regions.ts` 里有独立部署客户的名单。
```

- [ ] **Step 2: 改 `skill/SKILL.md`**

先找出那句话：

```bash
grep -n "README" $NEW/skill/SKILL.md
```

「开场」里那句「这次会话改用 `~/.local/bin/md`，并提醒用户按 README 的常见问题处理」，改成：

「这次会话改用 `~/.local/bin/md`，并提醒用户：在 `~/.zshrc` 里 oh-my-zsh 那一行之后加一行 `unalias md`，然后重开终端」。

原因：`skill/` 里已经没有 README 了，AI 读不到它。

`skill/` 下别的文件如果提到 `scripts/md.mjs`、`magic-skills`、`md:publish`，一并改成新说法。

```bash
grep -rn "scripts/md.mjs\|magic-skills\|md:publish\|README" $NEW/skill
```

Expected: 改完之后没有输出。

- [ ] **Step 3: 跑全套，提交**

```bash
cd $NEW && cp CLAUDE.md AGENTS.md && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm test > /tmp/md-t6.log 2>&1; tail -4 /tmp/md-t6.log
cd $NEW && git add -A && git commit -q -F - <<'EOF'
docs: 开发说明（CLAUDE.md / AGENTS.md），使用说明里去掉指向旧 README 的说法

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

Expected: 全套全过。

---

### Task 7: 第一次发版，全新 clone 验收

**Files:**
- Create: `$NEW/dist/md.mjs`（由 release 构建）

- [ ] **Step 1: 发版检查**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node npm run release > /tmp/md-release.log 2>&1; tail -6 /tmp/md-release.log
```

Expected:
- 测试全过；
- 打出「已构建 dist/md.mjs（<sha>@2026-09-25），扫描干净」；
- `git status` 里有 `dist/md.mjs`。

- [ ] **Step 2: 提交产物**

```bash
cd $NEW && git add dist/md.mjs && git commit -q -F - <<'EOF'
release: 第一次在独立仓库发版（dist/md.mjs）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git -C $NEW ls-files dist/md.mjs
```

Expected: 打出 `dist/md.mjs`，说明它已经进了仓库，没被忽略。

- [ ] **Step 3: 全新 clone 验收（验收第 1、2、8 条）**

在一个看不到 Agentflow 的临时目录里 clone 一份，装依赖、跑全部测试。验收第 2 条（不再指向老懂）由其中的 `test/vendor.test.mjs` 覆盖：

```bash
T=$(mktemp -d) && git clone -q $NEW $T/repo && cd $T/repo \
  && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm ci > /dev/null \
  && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node npm test > $T/test.log 2>&1; tail -6 $T/test.log
```

Expected: `# fail 0`，其中「独立：vendor 以外的代码和脚本不再指向老懂仓库」这条通过。

- [ ] **Step 4: 用 Node 18 在临时 HOME 里装一遍（验收第 4 条）**

```bash
H=$(mktemp -d) && PATH=$HOME/.nvm/versions/node/v18.20.8/bin:/usr/bin:/bin HOME=$H bash $T/repo/install.sh | tail -3
PATH=$HOME/.nvm/versions/node/v18.20.8/bin:/usr/bin:/bin $H/.local/bin/md --version
```

Expected:
- 打出 `md <sha>@2026-09-25` 和「完成」；
- 第二条命令打出同一个版本号。

- [ ] **Step 5: 记账**

记下 Task 7 的验收结果：测试条数、版本号，以及第 1、2、4、8 条都已通过。

---

### Task 8: 推到 GitHub（整支审查、修复之后再做）

- [ ] **Step 1: 建私有仓库并推送**

```bash
cd $NEW && gh repo create Spider615/miaodong-cli --private --description "md：让 Claude Code / Codex 读写秒懂（JZ Insight）智能体的命令行工具" --source . --remote origin --push
```

Expected: 输出里有仓库地址，推送成功。

- [ ] **Step 2: 核对（验收第 6 条）**

```bash
gh repo view Spider615/miaodong-cli --json visibility,defaultBranchRef --jq '{visibility, branch: .defaultBranchRef.name}'
git -C $NEW ls-remote origin main | cut -c1-12
git -C $NEW rev-parse HEAD | cut -c1-12
gh repo list magic-skills --limit 20 --json name,visibility,pushedAt --jq '.[] | "\(.name) \(.visibility) \(.pushedAt)"'
```

Expected:
- `visibility` 是 `PRIVATE`，分支是 `main`；
- 远端 main 和本地 HEAD 一致；
- `magic-skills` 下仍是原来的 4 个仓库，可见性、最后推送时间和之前一样：
  - `miaodong`：PUBLIC，2026-09-24T17:13:37Z；
  - `miaodong-test-case-import`、`rag-file-ingestion`、`miaohui-bulk-file-links`：PUBLIC。

---

### Task 9: 本机切换到新仓库，收尾

- [ ] **Step 1: 从新仓库装到本机（验收第 7 条，也是真机上的旧装法迁移）**

```bash
cd $NEW && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm run install:local 2>&1 | tail -12
~/.local/bin/md --version
readlink ~/.claude/skills/miaodong ~/.codex/skills/miaodong ~/.local/bin/md
~/.local/bin/md bots 2>&1 | head -3
```

Expected:
- 输出里有「旧版挪到 ~/.miaodong/old-installs/…」：这是旧版 `npm run md:install` 装的真身目录；
- `md --version` 是新仓库的提交号；
- 三个 readlink 分别指向 `$NEW/skill`、`$NEW/skill`、`$NEW/dist/md.mjs`；
- `md bots` 正常列出智能体，没有身份错误。

- [ ] **Step 2: 更新记忆**
  - `/Users/hukui/.claude/projects/-Users-hukui-Desktop-workspace-Agentflow/memory/miaodong-cli-plan.md`：
    - md 已独立成 `Spider615/miaodong-cli`（私有），本机检出在 `$NEW`，从这里改、测、发版；
    - 老懂 worktree 只作对照，待删；
    - `magic-skills` 没动，`magic-skills/miaodong` 停在 2b 那一版。
  - `MEMORY.md` 那一行同步。
  - 用户级记忆 `/Users/hukui/.claude/projects/-Users-hukui/memory/` 里有提到 md 的位置的，一并改。

- [ ] **Step 3: 问用户（只有用户能定）**
  - 要把哪些同事加成协作者（GitHub 账号）？给了名单就逐个执行 `gh api -X PUT repos/Spider615/miaodong-cli/collaborators/<账号> -f permission=pull`。
  - 验收都过了，能不能删掉老懂里的 worktree `.worktrees/miaodong-cli` 和分支 `feat/miaodong-cli`？同意后再执行：
    - `git -C $AF worktree remove .worktrees/miaodong-cli`；
    - `git -C $AF branch -D feat/miaodong-cli`。
