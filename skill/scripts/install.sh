#!/usr/bin/env bash
# 把这个 skill 装给 Claude Code / Codex / ~/.agents，并把 md 命令放上 PATH（~/.local/bin/md）。
# 用软链：git pull 之后自动生效；可重复执行。已有的、不是本 skill 的东西一律不动，只提示。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NAME="miaodong"

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$major" -lt 18 ]; then
  echo "需要 Node.js 18 或更高（当前：$(node -v 2>/dev/null || echo 未安装)）"
  exit 1
fi

link() {
  local target="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ]; then
    if [ "$(readlink "$dest")" = "$target" ]; then echo "  已存在 $dest"; return; fi
    echo "  ⚠️ 跳过 $dest：它指向 $(readlink "$dest")，不是本 skill，没动它"
    return
  fi
  if [ -e "$dest" ]; then
    # 仓库本身就 clone 在这个位置（例如直接 clone 进 ~/.claude/skills/）
    if [ -d "$dest" ] && [ "$(cd "$dest" && pwd -P)" = "$target" ]; then echo "  已是本仓库目录 $dest"; return; fi
    echo "  ⚠️ 跳过 $dest：那里已有别的文件，没动它"
    return
  fi
  ln -s "$target" "$dest"
  echo "  链接 $dest -> $target"
}

chmod +x "$SKILL_DIR/scripts/md.mjs"
echo "安装 skill「$NAME」：$SKILL_DIR"
link "$SKILL_DIR" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/$NAME"
link "$SKILL_DIR" "${CODEX_HOME:-$HOME/.codex}/skills/$NAME"
link "$SKILL_DIR" "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}/$NAME"
link "$SKILL_DIR/scripts/md.mjs" "$HOME/.local/bin/md"

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
node "$SKILL_DIR/scripts/md.mjs" --version
echo "完成。Claude Code 里描述秒懂任务会自动触发（或输入 /$NAME）；Codex 用 \$$NAME。"
