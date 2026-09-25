# miaodong-cli：把 md 从 Agentflow 拆成独立项目

> 2026-09-25。设计过程在对话里，本文是定稿。

## 1. 背景与目标

**现状**
- md（秒懂 CLI）的代码在 Agentflow（老懂）仓库的 `miaodong-kit/` 下：
  - 分支 `feat/miaodong-cli`，没合并，worktree 在 `.worktrees/miaodong-cli`；
  - 这条分支的 96 个提交只改了 `miaodong-kit/`、md 的设计文档、`CLAUDE.md` / `AGENTS.md`、根 `package.json`，一行老懂代码都没动。
- md 只读地用着老懂的 19 个文件，约 4300 行：
  - 秒懂接口相关：执行记录整理、试跑、画布推导、内容补丁；
  - `md check` 用的 workflow 风险规则；
  - 区表（带独立部署客户名）。
- 以前发布到 `magic-skills/miaodong`。同事把它 clone 到 `~/.claude/skills/miaodong`，再跑 `scripts/install.sh`。

**用户的决定**（2026-09-25）
- 只把 CLI 拆出来，老懂一行不动。
- **新建一个仓库** `miaodong-cli`，把 CLI 放进去。
- **`magic-skills` 组织和它下面的仓库一律不动**，包括 `magic-skills/miaodong`（它的可见性由用户另行决定）。
- 给公司同事用，所以新仓库是私有的。
- 一个仓库放源码、历史、安装，不再分「源码仓库」和「发布仓库」。

**执行者的假设**（用户审 spec 时可以改）
- 新仓库建在用户自己的 GitHub 账号下：`Spider615/miaodong-cli`，私有。
  - 同事以协作者身份加进来，名单由用户给；
  - 以后要挪到组织，GitHub 的转移会保留跳转。
- 给 AI 看的使用说明（`SKILL.md`）仍然叫 `miaodong`：Claude Code / Codex 靠这个名字触发，`/miaodong` 照常能用。变的只是仓库和对外的叫法。

**目标**：换一台没有 Agentflow 的机器，clone 新仓库，就能测试、构建、安装、使用 md。具体验收见 §8。

## 2. 仓库

- 用 `gh repo create Spider615/miaodong-cli --private` 新建，把整理好的历史推上去（见 §5）。
- 不改任何已有仓库：不改名，不强推，不改可见性。
- 本机检出放在 `~/Desktop/workspace/miaodong-cli`。

## 3. 目录

```
src/  test/            md 的源码和测试（原 miaodong-kit/src、miaodong-kit/test）
skill/                 给 AI 看的使用说明：SKILL.md、references/、agents/
vendor/laodong/        老懂的 19 个文件，保持老懂里的目录结构（见 §4）
dist/md.mjs            打包好的单文件，入库，是「已发布的版本」
scripts/               TS 加载器（测试用）、sync-laodong.mjs
install.sh             同事和开发者共用的安装脚本（见 §6）
build.mjs  install.mjs  release.mjs  package.json  package-lock.json  .nvmrc
docs/specs/  docs/plans/   md 的设计文档和实现计划（含本文）
README.md              给同事看：md 能做什么、怎么装、怎么更新
CLAUDE.md  AGENTS.md   给 AI 助手的开发说明（由 Agentflow 里 md 那一节的 7 条「改之前必读」扩写）
THIRD_PARTY_NOTICES.md
```

- 旧 kit 的文件（`miaodong-kit/bin/`、`lib/`、`PLAYBOOK.md`、`README.md`）不搬，留在老懂里。
- 例外：`lib/summarize.mjs` md 在用（`shortId`、`describeNode`），带着历史搬过来，挪进 `src/summarize.mjs`，从此归 md 自己管；老懂里旧 kit 的那份不动。
- 原来 `skill/README.md` 的安装说明挪进根目录的 `README.md`。

## 4. 老懂的代码

- **原样复制**：19 个文件放进 `vendor/laodong/`，保持老懂里的相对路径（例如 `vendor/laodong/apps/api/lib/miaodong/trial-core.ts`）。这样它们之间的相互引用不用改，md 这边只改 10 个文件里的 12 行 import。
- **不在这里改**：`vendor/` 里的文件不许在本仓库改；要改就去老懂改，再同步过来。
- **记来源**：`vendor/laodong/SOURCE.json` 记下取自 Agentflow 哪个提交，以及 19 个文件的清单。
- **同步**：`npm run sync:laodong -- <Agentflow 检出的路径>`
  - 按清单覆盖文件，更新 `SOURCE.json`；
  - 列出哪些文件变了；
  - 跑全部测试。
- **测试兜底**（`test/vendor.test.mjs`）：
  - 清单里每个文件的相对引用，都能在 `vendor/` 里找到；老懂以后新加了依赖，同步后这里就会红；
  - `src/` 里的 import 不许指向 `vendor/` 以外的老懂路径。
- **依赖**：vendor 里的文件要用 `jsonrepair`，放进 `dependencies`，打包时一起打进产物。
- **不选的做法**：
  - 改写成本仓库自己的 JS：以后老懂的检查规则改进了，md 拿不到；
  - 用子模块引用 Agentflow：开发时要 clone 整个老懂。

## 5. 历史

- 用 `git filter-repo`（`brew install git-filter-repo`），在一份临时 clone 上处理：
  - 只留 md 的路径：`miaodong-kit/src`、`miaodong-kit/test`、`miaodong-kit/skill`、`miaodong-kit/lib/summarize.mjs`，以及 `miaodong-kit/` 下的 `build.mjs`、`install.mjs`、`publish.mjs`；
  - 再留 md 的设计文档和计划：`docs/superpowers/specs/2026-09-2*-miaodong-cli*`、`docs/superpowers/plans/2026-09-2*-miaodong-cli*`；
  - `miaodong-kit/` 挪到仓库根目录，`docs/superpowers/specs`、`docs/superpowers/plans` 分别挪到 `docs/specs`、`docs/plans`。
- 之后的改动（vendor、改路径、改脚本、改文档）作为新提交接在后面。
- 提交作者、邮箱不改（私有仓库）。

## 6. 构建、测试、安装、发版

- **开发环境**：Node 22（写进 `.nvmrc`）。
- **测试**：`npm test` 就是现在的 `check:md`。设 `MD_E2E_NODE` 指向 Node 18 时，另外验证打包产物。
- **构建**：`npm run build` 生成 `dist/md.mjs`。
- **`./install.sh`**（同事和开发者用同一个）：
  - 需要 Node 18 以上，不需要 npm。
  - 建软链：`~/.claude/skills/miaodong`、`~/.codex/skills/miaodong`、`~/.agents/skills/miaodong` 指向 `<仓库>/skill`；`~/.local/bin/md` 指向 `<仓库>/dist/md.mjs`。
  - **认得旧装法**（从 `magic-skills/miaodong` 装过的同事、用户本机的 `npm run md:install`）：
    - 怎么认：那个位置的目录里有 `SKILL.md`，而且写着 `name: miaodong`；或者它是指向这样一个目录（或其中 `scripts/md.mjs`）的软链；
    - 是这样的目录（旧的 clone 或旧的真身目录）：挪到 `~/.miaodong/old-installs/<时间>/` 备份，再建新链接。备份不放在 skills 目录里：放在那里，里面的 `SKILL.md` 可能被当成第二个 miaodong 加载；
    - 是这样的软链：改指到新位置。
  - 别人的东西照旧不动，只提示（和现在一样）。
  - PATH 的提醒、zsh 里 `alias md` 的提醒照旧；最后打印 `md --version`。
  - 可以重复执行。
- **同事更新**：`git pull` 后重跑一次 `./install.sh`。
- **`npm run install:local`**（开发者）：先构建，再跑 `install.sh`，再按 `MD_EXPORT_DIR` 放一份桌面副本（保持现在的行为）。
- **`npm run release`**：
  - 跑全部测试（包括 Node 18 上的产物测试）；
  - 构建 `dist/md.mjs`；
  - 扫 `dist/` 和 `skill/`，看有没有本机路径（`/Users/`）和 token（`md-auth:`、`Bearer `）；
  - 列出这次改了什么。
  - 提交、推送由人看过之后再做。
- **`publish.mjs` 删掉**：不再往别的仓库发布。它原来的测试改成 `install.sh` 和 `release` 的测试。

## 7. Agentflow 这边

- 一行不动，md 不合进去。
- `feat/miaodong-cli` 分支和 worktree 先留着；新仓库验收通过、用户点头以后再删。
- 旧 kit（`npm run md:*`）照旧留在老懂里，下线另议。
- 本机记忆里指向 worktree 的路径，改成新仓库。

## 8. 验收

1. **全新 clone 能测试**：在临时目录全新 clone 新仓库，而且机器上找不到 Agentflow：
   - `npm ci && npm test` 全绿（Node 22）；
   - `MD_E2E_NODE` 指向 Node 18 时，产物测试也全绿。
2. **不再依赖 Agentflow**：除了 `vendor/` 和 `SOURCE.json`，代码和脚本里搜不到 `Agentflow`、`apps/api`、`packages/shared` 这类路径。
3. **vendor 和老懂一致**：对着现在的 Agentflow 跑 `npm run sync:laodong`，结果是没有变化。
4. **全新安装**：在临时 HOME 里用 Node 18 跑 `./install.sh`：
   - 三个 skills 位置和 `~/.local/bin/md` 都装好；
   - `md --version` 正确；
   - 再跑一次也不报错。
5. **旧装法迁移**：在临时 HOME 里先摆出两种旧装法，跑 `install.sh` 后，旧目录被备份，所有链接都指向新位置：
   - 同事的装法：`~/.claude/skills/miaodong` 是旧仓库的 clone，另外两个 skills 位置是指向它的软链，`~/.local/bin/md` 指向旧的 `scripts/md.mjs`；
   - 用户本机的装法：`~/.claude/skills/miaodong` 是真身目录，`~/.codex/skills/miaodong` 和 `~/.local/bin/md` 是指向它的软链。
6. **GitHub**：
   - `Spider615/miaodong-cli` 存在，而且是私有的；
   - `magic-skills` 下的仓库没有任何变化：提交、名字、可见性都和之前一样。
7. **用户本机**：`npm run install:local` 之后：
   - `md --version` 显示新仓库的提交号；
   - `md bots` 能列出智能体，说明身份照常可用。
8. **没有泄露**：`dist/` 和 `skill/` 里没有本机路径和 token。区表在私有仓库里，按用户决定留着，不扫。

## 9. 会动到外面的操作

按实现计划执行时逐项做，每一项都经用户同意：
- `brew install git-filter-repo`；
- `gh repo create Spider615/miaodong-cli --private`，推送；
- 按用户给的名单把同事加成协作者；
- 验收通过后，经用户同意，删掉 worktree 和 `feat/miaodong-cli` 分支。

## 10. 不做

- 不动 `magic-skills` 组织和它下面的任何仓库（用户 09-25 决定）；
- 不改老懂的代码；
- 不下线旧 kit；
- 不停用旧 skill `miaodong-test-case-import`（另议）；
- 不改 skill 名；
- 不去掉区表；
- 不改 md 的任何功能：这次只是搬家，外加改安装和发版方式。
