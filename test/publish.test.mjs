// 发布到独立的 skill 仓库（github.com/magic-skills/miaodong）：生成的内容要能被同事 clone 下来直接装、直接跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publish } from '../publish.mjs';
import { tempHome } from './helpers/run-cli.mjs';

async function published() {
  const repoDir = join(tempHome(), 'miaodong');
  mkdirSync(repoDir);
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'old.txt'), '上一版留下的文件');
  await publish({ repoDir });
  return repoDir;
}

// 以「新同事」身份跑 install.sh：HOME 指向临时目录，环境里只有 PATH
function runInstall(repoDir, home) {
  return execFileSync('bash', [join(repoDir, 'scripts', 'install.sh')], {
    env: { PATH: process.env.PATH ?? '', HOME: home },
    encoding: 'utf-8',
  });
}

test('publish：保留 .git、清掉旧文件、带上 skill 全部文件和可执行的 md', async () => {
  const repoDir = await published();
  assert.ok(existsSync(join(repoDir, '.git')));
  assert.equal(existsSync(join(repoDir, 'old.txt')), false);
  for (const file of ['SKILL.md', 'README.md', '.gitignore', 'agents/openai.yaml', 'references/transforms.md', 'references/push.md']) {
    assert.ok(existsSync(join(repoDir, file)), `缺 ${file}`);
  }
  assert.ok(statSync(join(repoDir, 'scripts', 'md.mjs')).mode & 0o100);
  assert.ok(statSync(join(repoDir, 'scripts', 'install.sh')).mode & 0o100);
  assert.match(execFileSync(process.execPath, [join(repoDir, 'scripts', 'md.mjs'), '--version'], { encoding: 'utf-8' }), /^md /);
});

test('publish：目标不是 git 仓库时拒绝', async () => {
  await assert.rejects(publish({ repoDir: tempHome() }), /不是 git 仓库/);
});

test('install.sh：给新同事装到三个 skills 目录和 ~/.local/bin/md，装完能跑；重复执行不出错', async () => {
  const repoDir = await published();
  const home = tempHome();
  const out1 = runInstall(repoDir, home);
  // install.sh 用物理路径建软链（macOS 的 /var 其实是 /private/var）
  const real = realpathSync(repoDir);
  for (const root of ['.claude/skills', '.codex/skills', '.agents/skills']) {
    assert.equal(readlinkSync(join(home, root, 'miaodong')), real);
  }
  assert.equal(readlinkSync(join(home, '.local', 'bin', 'md')), join(real, 'scripts', 'md.mjs'));
  assert.match(execFileSync(join(home, '.local', 'bin', 'md'), ['--version'], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '' } }), /^md /);
  assert.match(out1, /完成/);
  assert.match(runInstall(repoDir, home), /已存在/);
});

test('install.sh：已有的别人的东西不动；zsh 里 md 是别名时提醒', async () => {
  const repoDir = await published();
  const home = tempHome();
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'md'), '别人的 md');
  writeFileSync(join(home, '.zshrc'), "alias md='mkdir -p'\n");
  const out = runInstall(repoDir, home);
  assert.equal(readFileSync(join(home, '.local', 'bin', 'md'), 'utf-8'), '别人的 md');
  assert.match(out, /跳过 .*\.local\/bin\/md/);
  assert.match(out, /md 是个别名/);
});
