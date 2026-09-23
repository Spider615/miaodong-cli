// 构建并安装：~/.claude/skills/miaodong（真身）、~/.codex/skills/miaodong（软链）、~/.local/bin/md（软链），
// 另在桌面放一份完整副本 ~/Desktop/miaodong（用户要求：方便查看、直接转给同事；每次安装刷新，改它不会生效）。
// 复制而不是软链到仓库：切到没有 miaodong-kit 的分支时，md 不能跟着消失。
// 不用 npm link：它会把 md 装进当前 nvm 版本目录，切 Node 版本就找不到了。
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle } from './build.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));
const MARKER = '.md-cli-skill';

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkTo(linkPath, targetPath, logs) {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (isSymlink(linkPath)) {
    if (readlinkSync(linkPath) === targetPath) {
      logs.push(`已存在：${linkPath}`);
      return;
    }
    rmSync(linkPath);
  } else if (existsSync(linkPath)) {
    logs.push(`⚠️ 跳过 ${linkPath}：那里已有别的文件，没动它`);
    return;
  }
  symlinkSync(targetPath, linkPath);
  logs.push(`已链接：${linkPath} → ${targetPath}`);
}

export async function install({
  skillDir = process.env.MD_SKILL_DIR ?? join(homedir(), '.claude', 'skills', 'miaodong'),
  codexSkillsDir = process.env.MD_CODEX_SKILLS_DIR ?? join(homedir(), '.codex', 'skills'),
  binDir = process.env.MD_BIN_DIR ?? join(homedir(), '.local', 'bin'),
  exportDir = process.env.MD_EXPORT_DIR ?? join(homedir(), 'Desktop', 'miaodong'),
} = {}) {
  const logs = [];
  for (const dir of [skillDir, exportDir].filter(Boolean)) {
    if (existsSync(dir) && !existsSync(join(dir, MARKER))) throw new Error(`${dir} 已存在且不是 md 装的，没敢覆盖`);
  }
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  cpSync(join(KIT, 'skill'), skillDir, { recursive: true });
  const { tag } = await buildBundle({ outfile: join(skillDir, 'scripts', 'md.mjs') });
  writeFileSync(join(skillDir, MARKER), `${tag}\n`);
  logs.push(`已安装 skill：${skillDir}（${tag}）`);
  if (existsSync(dirname(codexSkillsDir))) linkTo(join(codexSkillsDir, 'miaodong'), skillDir, logs);
  else logs.push(`（没有 ${dirname(codexSkillsDir)}，跳过 Codex）`);
  linkTo(join(binDir, 'md'), join(skillDir, 'scripts', 'md.mjs'), logs);
  // MD_EXPORT_DIR='' 时不放桌面副本
  if (exportDir) {
    rmSync(exportDir, { recursive: true, force: true });
    cpSync(skillDir, exportDir, { recursive: true });
    logs.push(`已放一份到 ${exportDir}（给你看、转给同事用；真正生效的是 ${skillDir}，改桌面这份不会生效）`);
  }
  return { tag, logs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { logs } = await install();
  for (const line of logs) console.log(line);
  console.log('验证：新开一个终端运行 md --version');
}
