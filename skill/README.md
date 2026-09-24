# miaodong（秒懂 md）

一个 **Agent Skill**。装上以后，Claude Code 或 Codex 会用 `md` 命令直接读写**秒懂智能体画布**，
完成修 bot 的整个流程：

- 按名字找智能体和版本
- 查执行记录：按条件搜 badcase，看节点轨迹和事件链，找出某句话是哪个节点产生的
- 拉草稿或历史版本
- 看节点的上下游和引用
- 用脚本批量改 prompt 或模型
- 自检
- 安全地推到草稿
- 回滚
- 查推送记录

同一份文件，Claude Code 和 Codex 两边都能用。

> 它不会替你上线。md 只写**编辑器草稿**，上线要你自己在秒懂里点「发布」。

## 安装

前提：
- **Node.js 18 或更高版本**（用 `node -v` 查看）。
- 能访问这个仓库：它目前是私有仓库，要先找管理员把你的 GitHub 账号加进 magic-skills，并在本机登录 GitHub（`gh auth login`，或者配好 SSH 后把下面的地址换成 `git@github.com:magic-skills/miaodong.git`）。没有权限时 GitHub 只会报 `Repository not found`。
- **macOS**：取身份时读剪贴板。Linux 也能用，只是导入身份要在自己的终端运行 `md auth import --stdin` 再粘贴；Windows 请在 WSL 里用。

```bash
git clone https://github.com/magic-skills/miaodong.git ~/.claude/skills/miaodong
bash ~/.claude/skills/miaodong/scripts/install.sh
```

`install.sh` 做两件事：
- 把这个 skill 接到 Codex（`~/.codex/skills`）和通用位置（`~/.agents/skills`）；Claude Code 直接读 clone 下来的目录。
- 把 `md` 命令放到 `~/.local/bin`。

它可以反复运行；如果那些位置已经有不属于本 skill 的东西，它不会动，只会提示。

如果它提示 `~/.local/bin 不在 PATH 里`（macOS 默认就不在），在 `~/.zshrc` 里加一行 `export PATH="$HOME/.local/bin:$PATH"`。**装完重开终端，并重启 Claude Code / Codex**，它们才能找到 `md`。

**更新**：`git -C ~/.claude/skills/miaodong pull`。因为是软链，拉完就生效，不用重装。

## 第一次用

在 Claude Code 或 Codex 里直接说要干什么，比如「秒懂智能体：XXX，把所有「回答生成」节点的提示词加一条规则……」。有 badcase 时，把执行 id 发给 AI（在秒懂调优中心复制），它会自己查。

第一次碰某个区时，AI 会让你取一次身份：

1. AI 给你一行代码。
2. 你打开那个区的秒懂控制台，在浏览器控制台里执行这行代码。
3. 看到「✅ 已复制身份」后，**只回复「好了」**。

⚠️ **不要把复制的内容粘贴进对话。** 那是你的登录凭证，AI 会自己从剪贴板读。每个人用自己的身份，不要共用。

## 它怎么保证不出事

- **目标看得清楚**：针对某个智能体的命令，输出第一行都是 `区 / 企业 / 智能体 (id) / 版本`。名字对应多个智能体时，会列出候选并停下，不会自己挑一个。
- **推送先预演**：默认只预演，不写入。你确认改动清单后，AI 要带上「计划码」才能真正写入。预演之后如果草稿又被人改过，计划码会对不上，这次推送会被拦下。
- **不覆盖别人的修改**：按节点合并，别人在编辑器里对其他节点的修改都会保留；只有改到同一个节点时才会停下来。
- **推送后自动核对**：写完会立刻读回来比对。每次推送前都会备份，`md restore` 可以一键回滚。
- **数据留在本机**：本地数据都在 `~/.miaodong/md`，身份文件的权限是 0600。

## 常见问题

- **`md` 没反应，或者当前目录下多出 `auth`、`import` 这样的文件夹**
  这是 oh-my-zsh 自带 `alias md='mkdir -p'`，把 `md` 占用了。解决办法：在 `~/.zshrc` 里 oh-my-zsh 那一行之后加一行 `unalias md`，然后重开终端。`install.sh` 检测到这种情况会提醒你。
- **提示找不到 `md`**
  确认 `~/.local/bin` 在 PATH 里，并且改完 PATH 之后重开过终端、重启过 Claude Code / Codex。
- **clone 时报 `destination path already exists`，或 install.sh 提示「跳过……不是本 skill」**
  那个位置已经有旧版本（比如以前复制过去的目录或旧软链）。先把它删掉，再重新 clone、运行 install.sh。
- **提示身份失效（退出码 3）**
  重新取一次身份即可。

## 维护

`scripts/md.mjs` 是构建产物，**不要直接改**。源码在句子老懂仓库的 `miaodong-kit/` 目录（目前在 `feat/miaodong-cli` 分支），在那边改好、测完后，这样重新生成：

```bash
npm run md:publish -- <本仓库的本地目录>
```

生成后提交到这里。第三方软件声明见 `THIRD_PARTY_NOTICES.md`。
