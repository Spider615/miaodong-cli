// npm run install:local（开发者）：构建、跑 install.sh、放一份桌面副本（spec §6）。只在临时目录里装。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLocal } from '../install.mjs';
import { tempHome } from './helpers/run-cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 给 install.sh 的环境只带这几样：开发者 shell 里的 CLAUDE_CONFIG_DIR / CODEX_HOME / AGENTS_SKILLS_DIR 不能漏进去（审查 I3）
const testEnv = (home) => ({ PATH: process.env.PATH ?? '', HOME: home, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' });

// 一份仓库副本：构建产物写进副本，不碰真仓库的 dist/
function repoCopy() {
  const dir = join(tempHome(), 'miaodong-cli');
  mkdirSync(dir, { recursive: true });
  for (const name of ['install.sh', 'README.md', 'THIRD_PARTY_NOTICES.md']) cpSync(join(ROOT, name), join(dir, name));
  cpSync(join(ROOT, 'skill'), join(dir, 'skill'), { recursive: true });
  return realpathSync(dir);
}

test('install:local：构建开发版到 build/、用 install.sh 装（md 链到开发构建）、放一份桌面副本（布局同仓库，拿到的人跑 ./install.sh 就能装）；重复安装不出错', async () => {
  const root = repoCopy();
  const home = tempHome();
  const exportDir = join(home, 'Desktop', 'miaodong');
  const { logs } = await installLocal({ root, home, exportDir, env: testEnv(home) });
  assert.equal(readlinkSync(join(home, '.claude', 'skills', 'miaodong')), join(root, 'skill'));
  assert.equal(readlinkSync(join(home, '.local', 'bin', 'md')), join(root, 'build', 'md.mjs'));
  for (const file of ['install.sh', 'README.md', 'skill/SKILL.md', 'dist/md.mjs']) assert.ok(existsSync(join(exportDir, file)), `桌面副本缺 ${file}`);
  assert.match(logs.join('\n'), /已放一份到/);
  await installLocal({ root, home, exportDir, env: testEnv(home) });
});

test('install:local：桌面那个位置已有别人的东西时不覆盖', async () => {
  const home = tempHome();
  const exportDir = join(home, 'Desktop', 'miaodong');
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, '别人的.txt'), '别动');
  await assert.rejects(installLocal({ root: repoCopy(), home, exportDir, env: testEnv(home) }), /不是 md 放的/);
  assert.equal(readFileSync(join(exportDir, '别人的.txt'), 'utf-8'), '别动');
});

test('SKILL.md 头部合规：name 为 miaodong，description 不超过 1024 字', () => {
  const text = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf-8');
  const match = text.match(/^---\nname: miaodong\ndescription: (.+)\n---\n/);
  assert.ok(match, 'frontmatter 格式不对');
  assert.ok(match[1].length <= 1024);
});

test('install:local 不碰开发者真实的 skill 链接：shell 里设了 CODEX_HOME 也一样（审查 I3）', async () => {
  const real = tempHome();
  mkdirSync(join(real, 'skills'), { recursive: true });
  symlinkSync('/nowhere/real-skill', join(real, 'skills', 'miaodong'));
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = real;
  try {
    const home = tempHome();
    await installLocal({ root: repoCopy(), home, exportDir: '', env: testEnv(home) });
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
  assert.equal(readlinkSync(join(real, 'skills', 'miaodong')), '/nowhere/real-skill');
});

test('install:local 不写 dist/（那是已发布的版本）：构建进被忽略的 build/，md 链到 build/md.mjs（审查 I4）', async () => {
  const root = repoCopy();
  const home = tempHome();
  await installLocal({ root, home, exportDir: '', env: testEnv(home) });
  assert.equal(existsSync(join(root, 'dist', 'md.mjs')), false);
  assert.equal(readlinkSync(join(home, '.local', 'bin', 'md')), join(root, 'build', 'md.mjs'));
});
