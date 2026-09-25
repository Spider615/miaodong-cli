# miaodong-cli 开发说明

面向 Claude / Codex 等自动化助手的开发说明。CLAUDE.md 和 AGENTS.md 是同一份，改了一份就拷到另一份。给同事看的介绍和安装见 README.md。

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
npm test                                   # 全部测试。要 Node 22（Node 18 下直接报 bad option）：先 nvm use（.nvmrc 写着 22），或者把 Node 22 的 bin 放到 PATH 前面
MD_E2E_NODE=<Node 18 的 node> npm test     # 同时验证打包产物在 Node 18 上能跑
npm run build                              # 只构建开发版 build/md.mjs（被忽略，不碰 dist）
./install.sh                               # 用发过版的 dist/md.mjs 装（和同事一样）；日常修 bot 用这个
npm run install:local                      # 试新构建：开发版构建进 build/md.mjs（被忽略）+ install.sh 链过去 + 桌面副本（MD_EXPORT_DIR='' 不放）
MD_E2E_NODE=<Node 18 的 node> npm run release   # 发版检查；看过 diff 后连同 dist/md.mjs 一起提交、推送
npm run sync:laodong -- <老懂仓库路径>       # 同步 vendor/laodong
```

## 改之前必读

1. **身份只从浏览器控制台取**（`md auth snippet` → 剪贴板 → `md auth import`），不存密码。token 不进对话、不进报错。身份按区存在 `~/.miaodong/md/identities.json`（0600），不要读它。
2. **写秒懂只调 `canvas/save`**，默认预演，带 `--confirm <计划码>` 才写。推送是元素级三方合并（`src/merge.mjs`），不是全量覆盖。
3. **`vendor/laodong/` 不在本仓库改**：它是老懂代码的原样拷贝，`SOURCE.json` 记着来源提交和文件清单。要改就去老懂改，再 `npm run sync:laodong`。`test/vendor.test.mjs` 守着依赖是否完整，也守着 vendor 以外的代码不再指向老懂仓库。往清单里加老懂的文件时，只加不依赖数据库的纯函数：老懂的 `canvas-sync.ts`、`client.ts` 这类会带起 SQLite 的模块不要拷。md 是单文件，同事机器上只有 Node，带上数据库就跑不起来（`test/bundle.test.mjs` 查产物里没有 better-sqlite3 / drizzle-orm）。
4. **花钱、调插件、调高门槛要用户确认**（`src/confirm.mjs`）：需要确认时 md 不跑，只给预估和确认码（退出码 5）。AI 单独问用户，同意后在同一条命令加 `--confirm <码>`。码绑定这次操作的全部要素（智能体、节点、次数、输入、预估、插件、日期），任何一样变了就对不上；同一笔操作每确认一次换一个码；试跑每跑完一次按实际花费重算，超了就停，剩下的几次要重新确认。这是约定不是锁（用户 2026-09-25 决定不用弹窗）：不要加「跳过确认」的开关，也不要把确认码写进任何自动流程。
5. **测试中心**（`src/testcenter.mjs` 接口，`src/testcases.mjs` 换 id 与跑前检查）：秒懂对事件、会话变量对不上的用例不报错，显示成功但其实空跑（实测见 `docs/specs/2026-09-24-miaodong-cli-step2-design.md` §2.3），所以跑前检查必须拦。导入的撤回只按导入前后的差集删，不碰集里原有的用例。
6. **外部用例与批量改**（`src/casefile.mjs` 解析与校验，`src/caseedit.mjs` 改动脚本）：写秒懂之前先在本地校验全部，外部用例先写 1 条读回来核对。断言只生成实测过的形状（同一份 spec §2.3 的核对 8：发文本、发事件、转人工），别的用 raw：断言写错时秒懂不报错，只是永远不生效。批量改走计划码，先备份再写。
7. **main 就是同事拿到的版本**：同事 `git pull` 之后，说明来自 main 上的 `skill/`（软链，立即生效），命令来自 main 上的 `dist/md.mjs`。所以改 `src/`、`vendor/` 的活在分支上做，合进 main 时带上 `npm run release` 重新构建的 `dist/md.mjs`；只改说明文字、不涉及新命令的，可以直接进 main。
8. **`dist/md.mjs` 只有 `npm run release` 写**：`npm run build` 和 `npm run install:local` 都把开发构建放进被忽略的 `build/md.mjs`，不碰 dist。
9. **本仓库必须保持私有**：`vendor/laodong/packages/shared/src/miaodong-regions.ts` 里有独立部署客户的名单。
10. **`install.sh` 里的变量一律写成 `${VAR}`**：UTF-8 locale 下，macOS 自带的 bash 3.2 会把紧跟在变量后面的中文标点字节读进变量名，`set -u` 时直接报 unbound variable。C locale 下没事，所以 `test/install-sh.test.mjs` 固定在 `zh_CN.UTF-8` 下跑，别改回去。
