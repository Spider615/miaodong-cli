# miaodong（秒懂 md）

一个 **Agent Skill**。装上以后，Claude Code 或 Codex 会用 `md` 命令直接读写**秒懂智能体画布**，
完成修 bot 的整个流程：

- 按名字找智能体和版本
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

需要 **Node.js 18 或更高版本**（用 `node -v` 查看）。取身份时要读剪贴板，默认按 macOS 做的。

```bash
git clone https://github.com/magic-skills/miaodong.git ~/.claude/skills/miaodong
bash ~/.claude/skills/miaodong/scripts/install.sh
```

`install.sh` 会用软链把这个 skill 装到三个地方：`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`。
同时把 `md` 放到 `~/.local/bin`。这个脚本可以反复运行；如果那些位置已经有不属于本 skill 的东西，它不会动，只会提示。

**更新**：`git -C ~/.claude/skills/miaodong pull`。因为是软链，拉完就生效，不用重装。

## 第一次用

在 Claude Code 或 Codex 里直接说要干什么，比如「智能体：XXX，帮我看下这个 badcase……」。

第一次碰某个区时，AI 会让你取一次身份：

1. AI 给你一行代码。
2. 你打开那个区的秒懂控制台，在浏览器控制台里执行这行代码。
3. 看到「✅ 已复制身份」后，**只回复「好了」**。

⚠️ **不要把复制的内容粘贴进对话。** 那是你的登录凭证，AI 会自己从剪贴板读。每个人用自己的身份，不要共用。

## 它怎么保证不出事

- **目标看得清楚**：每条输出的第一行都是 `区 / 企业 / 智能体 (id) / 版本`。名字对应多个智能体时，会列出候选并停下，不会自己挑一个。
- **推送先预演**：默认只预演，不写入。你确认改动清单后，AI 要带上「计划码」才能真正写入。预演之后如果草稿又被人改过，计划码会对不上，这次推送会被拦下。
- **不覆盖别人的修改**：按节点合并，别人在编辑器里对其他节点的修改都会保留；只有改到同一个节点时才会停下来。
- **推送后自动核对**：写完会立刻读回来比对。每次推送前都会备份，`md restore` 可以一键回滚。
- **数据留在本机**：本地数据都在 `~/.miaodong/md`，身份文件的权限是 0600。

## 常见问题

- **`md` 没反应，或者当前目录下多出 `auth`、`import` 这样的文件夹**
  这是 oh-my-zsh 自带 `alias md='mkdir -p'`，把 `md` 占用了。解决办法：在 `~/.zshrc` 里 oh-my-zsh 那一行之后加一行 `unalias md`，然后重开终端。`install.sh` 检测到这种情况会提醒你。
- **提示找不到 `md`**
  确认 `~/.local/bin` 在 PATH 里。
- **提示身份失效（退出码 3）**
  重新取一次身份即可。

## 维护

`scripts/md.mjs` 是构建产物，**不要直接改**。源码在句子老懂仓库的 `miaodong-kit/` 目录，在那边改好、测完后，这样重新生成：

```bash
npm run md:publish -- <本仓库的本地目录>
```

生成后提交到这里。
