// 测试里建临时 git 仓库用。
// 提交一律显式关掉签名：开发者本机开了 commit.gpgsign 的话，临时仓库的提交会失败，整个测试跟着红（审查 M7）。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './run-cli.mjs';

const AS_TESTER = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

export const gitInit = (dir) => execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir });

export function gitCommitAll(dir, message = 'c') {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', [...AS_TESTER, 'commit', '-qm', message], { cwd: dir });
}

// 模拟开了提交签名的开发者机器：之后这个进程起的 git 都读这份全局配置，签名程序是 false，一签就失败。
// 在测试文件开头调一次：谁建临时仓库时忘了关签名，在任何机器上都当场红
export function useSigningGitConfig() {
  const file = join(tempHome(), 'gitconfig');
  writeFileSync(file, '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n');
  process.env.GIT_CONFIG_GLOBAL = file;
}
