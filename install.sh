#!/usr/bin/env bash
# 安装 md：给 Claude Code / Codex / ~/.agents 接上使用说明（skill/），把 md 命令放上 PATH（~/.local/bin/md）。
# 全用软链：git pull 之后自动生效；可以重复执行。
# 认得旧装法（从 magic-skills/miaodong 装的、旧版 npm run md:install 装的）：旧目录挪去 ~/.miaodong/old-installs/<时间>/ 备份，
# 链接改指新位置。备份不放在 skills 目录里：那里的东西会被当成 skill 加载。别人的东西一律不动，只提示。
set -euo pipefail
# 变量一律写成 ${VAR}：UTF-8 下 bash 3.2 会把紧跟在变量后面的中文标点字节读进变量名（set -u 时直接报 unbound variable）

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NAME="miaodong"
SKILL_SRC="${ROOT}/skill"
# MD_BIN_SRC：开发者 npm run install:local 用它让 md 链到开发构建 build/md.mjs；同事不用设，默认链到已发布的 dist/md.mjs
BIN_SRC="${MD_BIN_SRC:-${ROOT}/dist/md.mjs}"
CLAUDE_SKILLS="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skills"
CODEX_SKILLS="${CODEX_HOME:-${HOME}/.codex}/skills"
AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-${HOME}/.agents/skills}"
BIN_LINK="${HOME}/.local/bin/md"
BACKUP_DIR="${HOME}/.miaodong/old-installs/$(date +%Y%m%d-%H%M%S)"

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${major}" -lt 18 ]; then
  echo "需要 Node.js 18 或更高（当前：$(node -v 2>/dev/null || echo 未安装)）"
  exit 1
fi
if [ ! -f "${BIN_SRC}" ]; then
  echo "缺 ${BIN_SRC#"${ROOT}"/}：仓库不完整。重新 git clone 一次；开发者可以先 npm run build"
  exit 1
fi
# 仓库本身不能放在任何一个 skills 位置：那里要放的是仓库里的 skill/ 目录
for dest in "${CLAUDE_SKILLS}/${NAME}" "${CODEX_SKILLS}/${NAME}" "${AGENTS_SKILLS}/${NAME}"; do
  if [ -d "${dest}" ] && [ "$(cd "${dest}" && pwd -P)" = "${ROOT}" ]; then
    echo "仓库不能放在 ${dest}：那里要放的是仓库里的 skill/ 目录，不是整个仓库。"
    echo "直接挪走就行，不用重新 clone：mv \"${dest}\" ~/tools/miaodong-cli && ~/tools/miaodong-cli/install.sh"
    exit 1
  fi
done

# 这个目录是不是 md 的旧装法：有 .md-cli-skill 标记（旧版 npm run md:install），或者 SKILL.md 写着 name: miaodong
is_old_md_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] && { [ -f "$1/.md-cli-skill" ] || grep -Eq '^name:[[:space:]]*miaodong[[:space:]]*$' "$1/SKILL.md" 2>/dev/null; }
}
# 这个目录是不是一份 md 仓库（新布局）：有 install.sh，skill/SKILL.md 写着 name: miaodong
is_md_repo() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/install.sh" ] && grep -Eq '^name:[[:space:]]*miaodong[[:space:]]*$' "$1/skill/SKILL.md" 2>/dev/null
}
# 这个软链是不是指向 md 的旧装法或另一份 md：旧 skill 目录（或其中的 scripts/md.mjs），
# 另一份仓库的 skill/、dist/md.mjs、build/md.mjs
points_to_old() {
  local target
  target="$(readlink "$1")"
  case "${target}" in
    */scripts/md.mjs) target="${target%/scripts/md.mjs}" ;;
    */dist/md.mjs) target="${target%/dist/md.mjs}" ;;
    */build/md.mjs) target="${target%/build/md.mjs}" ;;
  esac
  is_old_md_dir "${target}" || is_md_repo "${target}"
}
# 备份目录里用的名字：.claude/skills/miaodong → claude-skills-miaodong
label_of() {
  printf '%s' "${1#"${HOME}"/}" | sed -e 's#^\.##' -e 's#/\.#/#g' -e 's#/#-#g'
}

# 先认一遍（挪走旧目录之前）：哪些软链指向旧装法
old_links="|"
for dest in "${CLAUDE_SKILLS}/${NAME}" "${CODEX_SKILLS}/${NAME}" "${AGENTS_SKILLS}/${NAME}" "${BIN_LINK}"; do
  if [ -L "${dest}" ] && points_to_old "${dest}"; then old_links="${old_links}${dest}|"; fi
done
# 旧目录、放错位置的仓库挪去备份
for dest in "${CLAUDE_SKILLS}/${NAME}" "${CODEX_SKILLS}/${NAME}" "${AGENTS_SKILLS}/${NAME}"; do
  if is_old_md_dir "${dest}" || is_md_repo "${dest}"; then
    mkdir -p "${BACKUP_DIR}"
    mv "${dest}" "${BACKUP_DIR}/$(label_of "${dest}")"
    echo "  旧版（或放错位置的仓库）挪到 ${BACKUP_DIR}/$(label_of "${dest}")（备份；确认新版能用后可以删掉）"
  fi
done

link() {
  local target="$1" dest="$2" current
  mkdir -p "$(dirname "${dest}")"
  if [ -L "${dest}" ]; then
    current="$(readlink "${dest}")"
    if [ "${current}" = "${target}" ]; then echo "  已存在 ${dest}"; return; fi
    case "${old_links}" in
      *"|${dest}|"*) rm "${dest}"; ln -s "${target}" "${dest}"; echo "  改指 ${dest} -> ${target}（原来指向旧版或另一份 md：${current}）"; return ;;
    esac
    if [ ! -e "${dest}" ]; then
      rm "${dest}"; ln -s "${target}" "${dest}"; echo "  改指 ${dest} -> ${target}（原来指向的地方已经不在了）"; return
    fi
    echo "  ⚠️ 跳过 ${dest}：它指向 ${current}，不是 md，没动它"
    skipped="${skipped} ${dest}"
    return
  fi
  if [ -e "${dest}" ]; then
    echo "  ⚠️ 跳过 ${dest}：那里已有别的文件，没动它"
    skipped="${skipped} ${dest}"
    return
  fi
  ln -s "${target}" "${dest}"
  echo "  链接 ${dest} -> ${target}"
}

skipped=""
chmod +x "${BIN_SRC}"
echo "安装 md（${ROOT}）"
link "${SKILL_SRC}" "${CLAUDE_SKILLS}/${NAME}"
link "${SKILL_SRC}" "${CODEX_SKILLS}/${NAME}"
link "${SKILL_SRC}" "${AGENTS_SKILLS}/${NAME}"
link "${BIN_SRC}" "${BIN_LINK}"

case ":${PATH}:" in
  *":${HOME}/.local/bin:"*) ;;
  *) echo "⚠️ ${HOME}/.local/bin 不在 PATH 里：在 ~/.zshrc 加一行 export PATH=\"\$HOME/.local/bin:\$PATH\"，然后重开终端" ;;
esac
# oh-my-zsh 默认有 alias md='mkdir -p'：md auth import 会变成建两个目录，而且不报错
if command -v zsh >/dev/null 2>&1 && [ -n "$(zsh -ic 'alias md' 2>/dev/null)" ]; then
  echo "⚠️ 你的 zsh 里 md 是个别名（多半是 oh-my-zsh 的 alias md='mkdir -p'），会盖住这个命令。"
  echo "   在 ~/.zshrc 里 oh-my-zsh 那一行之后加一行 unalias md，然后重开终端。"
fi

# 有位置被别人的东西占着：没装全，不能说「完成」
if [ -n "${skipped}" ]; then
  echo "没装全：${skipped# } 这些位置上有别人的东西，没动它们。确认不是你要的，挪走后再跑一次 ./install.sh"
  exit 1
fi

echo
node "${BIN_SRC}" --version
echo "完成。Claude Code 里描述秒懂任务会自动触发（或输入 /${NAME}）；Codex 用 \$${NAME}。更新：git pull 之后再跑一次 ./install.sh"
