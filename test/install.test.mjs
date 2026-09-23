import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { install } from '../install.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';

function dirs() {
  const root = tempHome();
  // exportDir 必须指向临时目录：测试绝不能碰真实桌面
  return { skillDir: join(root, 'claude', 'skills', 'miaodong'), codexSkillsDir: join(root, 'codex', 'skills'), binDir: join(root, 'bin'), exportDir: join(root, 'desktop', 'miaodong') };
}

test('安装：skill 真身 + codex 软链 + bin 软链 + 桌面副本，装完能跑；重复安装不出错', async () => {
  const d = dirs();
  mkdirSync(join(d.codexSkillsDir, '..'), { recursive: true });
  await install(d);
  assert.ok(existsSync(join(d.skillDir, 'SKILL.md')));
  assert.ok(existsSync(join(d.skillDir, 'references', 'transforms.md')));
  assert.ok(statSync(join(d.skillDir, 'scripts', 'md.mjs')).mode & 0o100);
  assert.equal(readlinkSync(join(d.codexSkillsDir, 'miaodong')), d.skillDir);
  assert.equal(readlinkSync(join(d.binDir, 'md')), join(d.skillDir, 'scripts', 'md.mjs'));
  assert.ok(existsSync(join(d.exportDir, 'SKILL.md')), '桌面副本要有 SKILL.md');
  assert.ok(existsSync(join(d.exportDir, 'scripts', 'md.mjs')), '桌面副本要带可执行的 md');
  const r = await runCli(['--version'], { home: tempHome(), bundle: join(d.binDir, 'md') });
  assert.equal(r.code, 0, r.stderr);
  await install(d);
});

test('目标目录已有别人的东西时拒绝覆盖', async () => {
  const d = dirs();
  mkdirSync(d.skillDir, { recursive: true });
  writeFileSync(join(d.skillDir, 'SKILL.md'), '别人的 skill');
  await assert.rejects(install(d), /不是 md 装的/);
});

test('SKILL.md 头部合规：name 为 miaodong，description 不超过 1024 字', () => {
  const text = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf-8');
  const match = text.match(/^---\nname: miaodong\ndescription: (.+)\n---\n/);
  assert.ok(match, 'frontmatter 格式不对');
  assert.ok(match[1].length <= 1024);
});
