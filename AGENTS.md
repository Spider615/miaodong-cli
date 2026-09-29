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
MD_E2E_NODE=<Node 18 的 node> npm run release   # 发版：先把 package.json 的 version 改大、和改动一起提交（工作区要干净）；它跑测试、构建 dist/md.mjs、扫描，之后提交 dist/md.mjs、合进 main、推送，再打 tag v<版本号> 推送
npm run sync:laodong -- <老懂仓库路径>       # 同步 vendor/laodong
```

## 改之前必读

1. **身份只从浏览器控制台取**（`md auth snippet` → 剪贴板 → `md auth import`），不存密码。token 不进对话、不进报错。身份按区存在 `~/.miaodong/md/identities.json`（0600），不要读它。
2. **写秒懂只调 `canvas/save`**，默认预演，带 `--confirm <计划码>` 才写。推送是元素级三方合并（`src/merge.mjs`），不是全量覆盖。
3. **`vendor/laodong/` 不在本仓库改**：它是老懂代码的原样拷贝，`SOURCE.json` 记着来源提交和文件清单。要改就去老懂改，再 `npm run sync:laodong`。`test/vendor.test.mjs` 守着依赖是否完整，也守着 vendor 以外的代码不再指向老懂仓库。往清单里加老懂的文件时，只加不依赖数据库的纯函数：老懂的 `canvas-sync.ts`、`client.ts` 这类会带起 SQLite 的模块不要拷。md 是单文件，同事机器上只有 Node，带上数据库就跑不起来（`test/bundle.test.mjs` 查产物里没有 better-sqlite3 / drizzle-orm）。
4. **花钱、调插件、调高门槛要用户确认**（`src/confirm.mjs`）：需要确认时 md 不跑，只给预估和确认码（退出码 5）。AI 单独问用户，同意后在同一条命令加 `--confirm <码>`。码绑定这次操作的全部要素（智能体、节点、次数、输入、预估、插件、日期），任何一样变了就对不上；同一笔操作每确认一次换一个码；试跑每跑完一次按实际花费重算，超了就停，剩下的几次要重新确认。这是约定不是锁（用户 2026-09-25 决定不用弹窗）：不要加「跳过确认」的开关，也不要把确认码写进任何自动流程。
5. **测试中心**（`src/testcenter.mjs` 接口，`src/testcases.mjs` 换 id 与跑前检查）：秒懂对事件、会话变量对不上的用例不报错，显示成功但其实空跑（实测见 `docs/specs/2026-09-24-miaodong-cli-step2-design.md` §2.3），所以跑前检查必须拦。导入的撤回只按导入前后的差集删，不碰集里原有的用例。
6. **外部用例与批量改**（`src/casefile.mjs` 解析与校验，`src/caseedit.mjs` 改动脚本）：写秒懂之前先在本地校验全部，外部用例先写 1 条读回来核对。断言只生成实测过的形状（同一份 spec §2.3 的核对 8：发文本、发事件、转人工），别的用 raw：断言写错时秒懂不报错，只是永远不生效。批量改走计划码，先备份再写。
7. **main 就是同事拿到的版本**：同事 `git pull` 之后，说明来自 main 上的 `skill/`（软链，立即生效），命令来自 main 上的 `dist/md.mjs`。所以改 `src/`、`vendor/` 的活在分支上做：把 `package.json` 的 `version` 改大（新功能加中间那位，只修问题加最后一位；没改大发版检查会拦），和改动一起提交后跑 `npm run release`，再提交它重新构建的 `dist/md.mjs`，然后合进 main（构建号就是改动所在的那个提交），推送后给它打 tag `v<版本号>` 并推送；只改说明文字、不涉及新命令的，可以直接进 main，不改版本号。`md --version` 显示 `md <版本号>（<构建号>）`，版本号只写在 `package.json` 一处。
8. **`dist/md.mjs` 只有 `npm run release` 写**：`npm run build` 和 `npm run install:local` 都把开发构建放进被忽略的 `build/md.mjs`，不碰 dist。
9. **本仓库必须保持私有**：`vendor/laodong/packages/shared/src/miaodong-regions.ts` 里有独立部署客户的名单。token 类的东西一律不进仓库：发版扫描查全部会进仓库的文件，测试和文档里要用假 token 就在运行时拼出来（照 `test/release.test.mjs` 的 `FAKE`）。
10. **`install.sh` 里的变量一律写成 `${VAR}`**：UTF-8 locale 下，macOS 自带的 bash 3.2 会把紧跟在变量后面的中文标点字节读进变量名，`set -u` 时直接报 unbound variable。C locale 下没事，所以 `test/install-sh.test.mjs` 固定在 `zh_CN.UTF-8` 下跑，别改回去。
11. **知识库**（`src/kb*.mjs`，spec 3a）：只读。FAQ 列表的 `filterType` 只传数字（传字符串服务端只回未审核的，还不报错）。`md kb why` 的重放，依赖「控制台语义搜索的分数 = 大模型知识库工具的分数」这个 09-25 的实测（spec §2.3）；秒懂升级后结论不对劲，先重新核对这一条。语义搜索只返回 0.8 以上的（`SEMANTIC_FLOOR`，同一次实测）：重放里没有某一条，只说明它低于 0.8，判定和「知识库改过」的比对都按这个前提写的，这个下限变了要一起改。语义索引里一条 FAQ 可能占好几行，工具取前 10 行再按 FAQ 去重（spec §2.5，09-25 真机验收）：名次按行算，「召回不满 10 条」推不出什么；「知识库改过」的比对照这个做法、并留 `SCORE_EPS` 的容差。
12. **知识库写入**（`src/kb-write.mjs`、`src/kb-import-*.mjs`、`src/kb-revoke.mjs`，spec 3b）：写知识库只有 `md kb import`（导入包）和 `md kb revoke` 两个入口；查 case 的命令（kb list/pull/find/why、exec、trial）顺着 import 一个都不能碰到 `kb-write.mjs`（`test/kb-readonly-guard.test.mjs` 守着）——这是用户定的规矩：查 case 时只读，只有处理客户资料才写库。写接口的路径也只许出现在 `kb-write.mjs`（同一个测试守着）。写接口的参数是 09-25 从控制台前端 1.18.4 核对的；两个「新建」都不返回 id：每个建、删都走 `src/kb-ops.mjs`——发之前记意图，发完再列（没认全再列几次），**只自动认「请求刚发完那几次列表里、唯一一条内容完全对得上的」**（FAQ 问题 + 答案；文件同名 + 手工 + 还是空的），本机别的导入记录认下的排除；之后才出现的一模一样的：FAQ 要用户确认、文件永远不认；一模一样的不止一条：不认不删（没有「自动删副本」）；窗口里没认上的只是「可疑的」，不删、不往里写；窗口里的判断只在请求刚发完时做一次、记进意图，续跑撤回按记下的来、不按现在的库重判；同一条可疑两次就不再重发（整支审查和四轮复审：按快照对账、按同问题 / 同名认、按「内容一模一样」事后认，都会把别人的条目认成自己的再删掉）。别放宽这些规矩。自己建的只有能证明还是自己的内容才删；撤回删之前先备份到本机，重建连续失败两次给「跳过」。写的时候给库上锁（接管死锁要先抢 `.lock.takeover`，这个标记不自动清）。先备份后写、试写一条、审核后才生效、先加后删、删之前和备份比对并再查能不能恢复，这些顺序由测试钉住，别调。还没在真实秒懂上实测过（spec §10），发版给同事前要先在测试库上做。
13. **改秒懂上的数据要用户同意**（用户 2026-09-27 定，spec `2026-09-27-miaodong-cli-write-confirm-design.md`）：改画布（`md push`、`md restore`）、写知识库（`md kb import`、`md kb revoke`）、改已有用例和删测试集（`md test edit`、`md test drop`）的命令，以及继续被暂停的回归任务（`md test resume`，09-29 加：继续就是多花钱），一律默认只读预演，带 `--confirm <计划码>` 才写。不走这条确认的：`md test import`（建集、导用例）、`md test run` / `status` / `stop`（建回归任务、暂停）、`md trial`（试跑）——花钱的仍按第 4 条的门槛确认。`test/write-confirm-guard.test.mjs` 守着：代码里的每个秒懂接口都要标读还是写，写接口只许出现在封装它的文件里、封装函数进 `WRITE_FNS`；会写秒懂的命令文件必须正好是它的两份清单。新命令碰到写接口：要确认的照 `md test drop` 加预演和计划码，补一个「预演一个写请求都不发」的测试，再进 `NEEDS_CONFIRM`；要进 `NO_CONFIRM` 的，先问用户。守卫只认名字和路径字面量（spec §3.4），别用拼接出来的路径绕开它。
14. **整条试跑**（`src/flow-trial.mjs` 判定，`src/commands/trial-flow.mjs` 命令，spec 2026-09-29）：从入口出发（沿连线、事件跳转、循环体子节点）能走到插件（插件计算、插件动作、挂了知识库以外工具的大模型）就不跑，不给开关——试跑没法 mock 插件，用户 09-29 定过规矩：插件一律 mock、不许真调，要 mock 走测试中心。md 不认识的节点类型也不跑，`FLOW_ACTIONS` 和 `TRIAL_ALLOWED` 只收核对过语义的类型。发消息、打标签、转人工这些动作照跑，依据是 09-29 实测：试跑会话的联系人、接收人都是空的，发文本只留动作记录、不进投递（spec §2.1）；秒懂升级后这一条要重新核对。`--session` 只认 md 自己开过的试跑会话（本机 `sessions.jsonl`），别放开成任意会话 id：同一个 id 会把试跑写进那个会话的历史。启动结果不明绝不重发（同单节点）。每次发请求前按最新草稿重新判闸门，能走到的部分变了就停（旧标签页自动保存会把插件接回来）；可达范围还包括打标签 → 标签变化、改自定义属性 → 属性变化这两种连锁（保守，没实测）。花费：能走到的全都按类型证明不花钱才是 ¥0（共用 `spendDecision` / `nextRunCheck` 里显式的 `free`，别改回按预估数值判 0——账本里的 0 可能是陈旧的）；否则只认同一个付费指纹、大于 0 的历史单价，花费不知道按 ¥0.7 × 付费节点数记（整支审查 C1）。按第 13 条，`md trial --text / --event` 和单节点一样属于试跑，不走改数据的确认（`write-confirm-guard` 里 `trial-flow.mjs` 在 `NO_CONFIRM`）；它自己拼的启动请求封装在 `src/trial-run.mjs` 的 `runFlowOnce`，守卫里 `/api/canvas/exec` 因此有两个封装处。
15. **命令行参数**（`src/args.mjs`）：开关（从不带值的参数）要登记进 `BOOLEAN_FLAGS`，解析时开关不吃后面的位置参数（`md exec --vs-draft <id>` 以前把 id 吞成开关的值）；别的参数的值原样是字符串，`--keyword 0`、`--per-command 0` 不能被当成「关」。命令里读参数一律走 `boolArg` / `strArg` / `intArg` / `listArg`（`--confirm` 走 `givenCode`），直接读 `args.x` 只许判「给没给」。`test/args.test.mjs` 扫源码对账：按开关读的没登记、登记的被当带值读、绕开取值函数直接按真假读，都会红。数字参数超上限报错，不悄悄截断。
