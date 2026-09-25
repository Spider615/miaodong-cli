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
// 跑在 UTF-8 locale 下：同事的终端都是（这台机器是 zh_CN.UTF-8）。bash 3.2 在 UTF-8 下会把紧跟在变量后面的中文标点
// 读进变量名，C locale 下却没事——只在 C 下测会漏掉「一装就报 unbound variable」
function runInstall(repo, home) {
  const r = spawnSync('bash', [join(repo, 'install.sh')], { env: { PATH: process.env.PATH ?? '', HOME: home, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' }, encoding: 'utf-8' });
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
