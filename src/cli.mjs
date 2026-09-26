// md 的入口：解析参数 → 分发到命令 → 统一处理错误与退出码。
// 构建时 esbuild 把 __MD_BUILD__ 替换成「提交号@日期」；开发模式下它不存在，显示 dev。

import { parseArgs } from './args.mjs';
import { EXIT, MdError } from './errors.mjs';
import { finish, note, out } from './output.mjs';
import { COMMANDS } from './commands/index.mjs';

// eslint-disable-next-line no-undef
const BUILD = typeof __MD_BUILD__ === 'string' ? __MD_BUILD__ : 'dev';
// 版本号来自 package.json，构建时写进来；开发模式下没有，只显示 dev
const VERSION = typeof __MD_VERSION__ === 'string' ? __MD_VERSION__ : null;

function renderHelp() {
  const lines = ['用法：md <命令> [参数]    （md <命令> --help 看该命令的详细用法）', '', '命令：'];
  for (const [name, command] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(9)} ${command.summary}`);
  lines.push('', '退出码：0 成功 · 1 错误或自检有问题 · 2 用法错误 · 3 需要取身份 · 4 目标找不到或有歧义 · 5 被拦下（推送冲突 / 计划码不符，或要用户确认）');
  return lines.join('\n');
}

export async function main(argv) {
  const args = parseArgs(argv);
  const [name, ...rest] = args._;
  // 只有不带子命令时 --version 才是「看 md 版本」：md pull --version v1.0.400 里它是秒懂版本号
  if (name === 'version' || (!name && args.version)) {
    out(VERSION ? `md ${VERSION}（${BUILD}）` : `md ${BUILD}`);
    return EXIT.OK;
  }
  if (!name || name === 'help') {
    out(renderHelp());
    return EXIT.OK;
  }
  const command = COMMANDS[name];
  if (!command) {
    note(`未知命令：${name}`);
    note('运行 md help 查看全部命令');
    return EXIT.USAGE;
  }
  if (args.help) {
    out(command.usage);
    return EXIT.OK;
  }
  args._ = rest;
  return (await command.run(args)) ?? EXIT.OK;
}

async function entry() {
  let code;
  try {
    code = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof MdError) {
      note(`❌ ${error.message}`);
      if (error.hint) note(`   → ${error.hint}`);
      code = error.exitCode;
    } else {
      note(`❌ ${error?.message ?? String(error)}`);
      note(process.env.MD_DEBUG ? String(error?.stack ?? '') : '   （加 MD_DEBUG=1 看完整堆栈）');
      code = EXIT.ERROR;
    }
  }
  await finish(code);
}

await entry();
