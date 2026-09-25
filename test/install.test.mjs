// npm run install:local（开发者）：构建、跑 install.sh、放一份桌面副本（spec §6）。只在临时目录里装。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLocal } from '../install.mjs';
import { tempHome } from './helpers/run-cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 一份仓库副本：构建产物写进副本，不碰真仓库的 dist/
function repoCopy() {
  const dir = join(tempHome(), 'miaodong-cli');
  mkdirSync(dir, { recursive: true });
  for (const name of ['install.sh', 'README.md', 'THIRD_PARTY_NOTICES.md']) cpSync(join(ROOT, name), join(dir, name));
  cpSync(join(ROOT, 'skill'), join(dir, 'skill'), { recursive: true });
  return realpathSync(dir);
}

test('install:local：构建进仓库的 dist/、用 install.sh 装、放一份桌面副本（布局同仓库，拿到的人跑 ./install.sh 就能装）；重复安装不出错', async () => {
  const root = repoCopy();
  const home = tempHome();
  const exportDir = join(home, 'Desktop', 'miaodong');
  const { logs } = await installLocal({ root, home, exportDir });
  assert.equal(readlinkSync(join(home, '.claude', 'skills', 'miaodong')), join(root, 'skill'));
  assert.equal(readlinkSync(join(home, '.local', 'bin', 'md')), join(root, 'dist', 'md.mjs'));
  for (const file of ['install.sh', 'README.md', 'skill/SKILL.md', 'dist/md.mjs']) assert.ok(existsSync(join(exportDir, file)), `桌面副本缺 ${file}`);
  assert.match(logs.join('\n'), /已放一份到/);
  await installLocal({ root, home, exportDir });
});

test('install:local：桌面那个位置已有别人的东西时不覆盖', async () => {
  const home = tempHome();
  const exportDir = join(home, 'Desktop', 'miaodong');
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, '别人的.txt'), '别动');
  await assert.rejects(installLocal({ root: repoCopy(), home, exportDir }), /不是 md 放的/);
  assert.equal(readFileSync(join(exportDir, '别人的.txt'), 'utf-8'), '别动');
});

test('SKILL.md 头部合规：name 为 miaodong，description 不超过 1024 字', () => {
  const text = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf-8');
  const match = text.match(/^---\nname: miaodong\ndescription: (.+)\n---\n/);
  assert.ok(match, 'frontmatter 格式不对');
  assert.ok(match[1].length <= 1024);
});
