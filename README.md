# miaodong-cli（秒懂 md）

一个命令行工具 `md`，外加一份给 AI 看的使用说明。装上以后，Claude Code 或 Codex 会用 `md` 直接读写**秒懂智能体画布**，
完成修 bot 的整个流程：

- 按名字找智能体和版本
- 查执行记录：按条件搜 badcase，看节点轨迹和事件链，找出某句话是哪个节点产生的
- 试跑：单节点试跑用执行记录的原始输入复现、推草稿后复验；整条试跑给链路上没有插件的草稿，一句话看完走过的节点和回复，能接着聊；花钱超门槛时先问你。试跑不真实调用插件，插件链路走测试中心 mock
- 测试中心：从执行记录导入用例（跨智能体自动换 id），直接使用 case 里的插件数据；缺 mock 时阻止启动，`md test mocks` 生成补数据的脚本。也支持从 Excel / 飞书批量建用例、批量改用例、跑回归、盯进度、出 xlsx 报告、删测试集
- 知识库：看智能体用了哪些库、哪些 FAQ 没审核，查一句话能不能被搜到、分数多少，查一条执行为什么没召回（只读）
- 知识库导入：把处理好的客户资料导进秒懂知识库（加 FAQ、文件和段落，删旧的重建）；默认预演、要你确认，先备份，中途断了能续跑，能整批撤回
- 流程事件：列出、查看定义和引用、新增、修改、隐藏／显示、导入。写前预演、确认、备份，写后回读；禁止删除事件
- 拉草稿或历史版本
- 看节点的上下游和引用
- 用脚本批量改 prompt 或模型
- 自检
- 安全地推到草稿
- 回滚
- 查推送记录

同一份文件，Claude Code 和 Codex 两边都能用。

> 它不会替你上线。画布改动只写**编辑器草稿**，上线要你自己在秒懂里点「发布」。事件、会话属性和知识库是独立资源，写入要单独预演确认。

## 安装

前提：
- **Node.js 18 或更高版本**（用 `node -v` 查看）。
- 能访问这个仓库：它是私有仓库，找 Spider615 把你的 GitHub 账号加成协作者。加上以后 GitHub 会发一封邀请，**要先点接受**：在邀请邮件里点，或者打开 https://github.com/Spider615/miaodong-cli/invitations。然后在本机登录 GitHub（`gh auth login`，或者配好 SSH 后把下面的地址换成 `git@github.com:Spider615/miaodong-cli.git`）。没接受邀请、没登录时，GitHub 只会报 `Repository not found`。
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

装好的是指向这个仓库的链接，所以仓库要一直留着。挪了位置的话，在新位置再跑一次 `install.sh`。

如果它提示 `~/.local/bin 不在 PATH 里`（macOS 默认就不在），在 `~/.zshrc` 里加一行 `export PATH="$HOME/.local/bin:$PATH"`。**装完重开终端，并重启 Claude Code / Codex**，它们才能找到 `md`。

**更新**：`git -C ~/tools/miaodong-cli pull`，然后再跑一次 `install.sh`。

## 第一次用

在 Claude Code 或 Codex 里直接说要干什么，比如「秒懂智能体：XXX，把所有「回答生成」节点的提示词加一条规则……」。有 badcase 时，把执行 id 发给 AI（在秒懂调优中心复制），它会自己查。

第一次碰某个区时，AI 会让你取一次身份：

1. AI 给你一行代码。
2. 你打开那个区的秒懂控制台，在浏览器控制台里执行这行代码。
3. 看到「✅ 已复制身份」后，**只回复「好了」**。

⚠️ **不要把复制的内容粘贴进对话。** 那是你的登录凭证，AI 会自己从剪贴板读。每个人用自己的身份，不要共用。

## 流程事件

```bash
md events --bot <智能体>                             # 全部事件（含隐藏）
md events get <事件名或id> --bot <智能体>              # 完整定义
md events used <事件名或id> --bot <智能体>             # 引用检查
md events add 跟进 --input text=string --bot <智能体>  # 新增预演
md events edit 跟进 --name 课程跟进 --bot <智能体>     # 修改预演
md events hide 跟进 --bot <智能体>                    # 隐藏预演；show 显示
md events list --bot <源智能体> --out events.json
md events import events.json --bot <目标智能体> --out event-id-map.json
```

写入须在确认具体清单后，加 `--confirm <计划码>`。没有删除事件命令。复杂输入和触发设置可用 `--config`，完整格式及导入失败处理见 [事件说明](skill/references/events.md)。

## 它怎么保证不出事

- **目标看得清楚**：针对某个智能体的命令，输出第一行都是 `区 / 企业 / 智能体 (id) / 版本`。名字对应多个智能体时，会列出候选并停下，不会自己挑一个。
- **推送先预演**：默认只预演，不写入。你确认改动清单后，AI 要带上「计划码」才能真正写入。预演之后如果草稿又被人改过，计划码会对不上，这次推送会被拦下。
- **默认最小改动**：局部需求优先在原节点、分支和连线上完成，保留其余业务行为；不主动拆事件、加续接节点或重写整套业务脚本。
- **保存前拦截编辑器格式错误**：事件动作的 shape／type 和事件入口的内嵌定义会在自检、推送、回滚和保存接口检查，不能用忽略自检开关跳过。这只覆盖已知格式约束，不代替浏览器加载验收或业务回归。
- **不覆盖别人的修改**：按节点合并，别人在编辑器里对其他节点的修改都会保留；只有改到同一个节点时才会停下来。
- **推送后自动核对**：写完会立刻读回来比对。每次推送前都会备份，`md restore` 可以一键回滚。
- **测试由你决定**：确认推送后不会自动试跑或跑回归。AI 会先说明测试范围、次数和预估花费，你明确同意后才开始；已经明确要求的测试按授权范围执行。推送时的结构自检和回读核对照常进行。
- **数据留在本机**：本地数据都在 `~/.miaodong/md`，身份文件的权限是 0600。
- **事件禁止删除**：`md events` 只支持查询、创建、修改、隐藏／显示和导入；确认码不能放行删除，失败补偿也不能删。导入生成新 ID，映射保存在本机，画布引用要另外调整并预演推送。
- **花钱要你点头**：试跑或跑回归之前，超过单次门槛（默认 ¥2）、当天累计超过上限（默认 ¥10）、估不出花费、或者会调用插件，md 都会先停下，报出预估金额和一个确认码；AI 要单独问你，你同意后它才能带着确认码去跑。
  - 跑的过程中也按实际花费重算。试跑每跑完一次算一次，超了就停，剩下的几次要你重新确认；回归在秒懂那边跑，md 每次看进度时算，超了就把任务暂停。
  - 这是给 AI 定的规矩，不是锁（确认码只有 AI 看得到），所以 `md spend` 里每一笔都标着是自动放行还是经你确认的，随时可以查。

## 常见问题

- **`md` 没反应，或者当前目录下多出 `auth`、`import` 这样的文件夹**
  这是 oh-my-zsh 自带 `alias md='mkdir -p'`，把 `md` 占用了。解决办法：在 `~/.zshrc` 里 oh-my-zsh 那一行之后加一行 `unalias md`，然后重开终端。`install.sh` 检测到这种情况会提醒你。
- **提示找不到 `md`**
  确认 `~/.local/bin` 在 PATH 里，并且改完 PATH 之后重开过终端、重启过 Claude Code / Codex。
- **以前从 magic-skills/miaodong 装过**：直接按上面的步骤装新版，install.sh 会把旧版挪去备份。
- **提示身份失效（退出码 3）**
  重新取一次身份即可。

## 开发

源码在 `src/`，测试在 `test/`，开发说明见 `CLAUDE.md`。
- 测试：Node 22 下 `npm test`（`.nvmrc` 写着 22）。
- 本机试新构建：`npm run install:local`（md 链到开发构建 `build/md.mjs`）；换回发过版的：再跑一次 `./install.sh`。
- 版本号：只写在 `package.json` 的 `version` 一处，`md --version` 显示成 `md 1.0.0（提交号@构建日期）`。每次发版前先把它改大：新功能加中间那位（1.0.0 → 1.1.0），只修问题加最后一位（1.0.0 → 1.0.1），不兼容的大改加第一位。没改大，发版检查会拦下。
- 发版：先把改动（包括改大的版本号）提交（工作区要干净），再跑 `MD_E2E_NODE=<Node 18 的 node 路径> npm run release`：它跑全部测试、构建 `dist/md.mjs`、扫描有没有本机路径和 token。看过 diff 后提交 `dist/md.mjs`、合进 main 并推送，再给这个提交打标签 `v<版本号>` 并推送（`git tag -a v1.1.0 -m "md 1.1.0"`，`git push origin v1.1.0`）。同事 `git pull` 拿到的就是这一版。
- `vendor/laodong/` 是句子老懂仓库的代码，原样拷贝，不在这里改：`npm run sync:laodong -- <老懂仓库路径>` 同步。

第三方软件声明见 `THIRD_PARTY_NOTICES.md`。
