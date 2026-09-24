// 需要用户本人批准的操作（花费超门槛、估不出花费、会真的调插件、改门槛）都走这里。
// 为什么不用 --confirm：AI 能执行任意命令，计划码只能证明它做过预演。
// 为什么不用「在终端里输入确认」：md 分不清终端里的字是人敲的还是 AI 敲的。系统弹窗只有人能点。
// 没有任何参数或环境变量能「放行」；MD_NO_DIALOG=1 只会让它直接拒绝（测试用，只能更严）。

import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

const OSASCRIPT = '/usr/bin/osascript';
const TIMEOUT_S = 90;

// 文字经 argv 传进 AppleScript，不拼进脚本源码：避免引号转义出错，也避免内容被当成脚本执行
const SCRIPT = [
  'on run argv',
  `set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"拒绝", "同意"} default button "拒绝" cancel button "拒绝" with icon caution giving up after ${TIMEOUT_S}`,
  'if gave up of r then return "timeout"',
  'return button returned of r',
  'end run',
];

export function osascriptArgs(text, title) {
  return [...SCRIPT.flatMap((line) => ['-e', line]), text, title];
}

function runOsascript(text, title) {
  return new Promise((resolve) => {
    execFile(OSASCRIPT, osascriptArgs(text, title), { timeout: (TIMEOUT_S + 15) * 1000 }, (error, stdout) => {
      const answer = String(stdout ?? '').trim();
      if (error) resolve({ ok: false, reason: /-128/.test(String(error.message)) ? '用户点了拒绝' : `弹窗失败：${String(error.message).slice(0, 120)}` });
      else if (answer === '同意') resolve({ ok: true });
      else if (answer === 'timeout') resolve({ ok: false, reason: `${TIMEOUT_S} 秒内没有人点` });
      else resolve({ ok: false, reason: `用户选了「${answer}」` });
    });
  });
}

function promptTty(text) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${text}\n\n确认请输入「同意」：`, (answer) => {
      rl.close();
      resolve(answer.trim() === '同意' ? { ok: true } : { ok: false, reason: '没有输入「同意」' });
    });
  });
}

export async function requestApproval({ title, lines }, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const text = lines.join('\n');
  if (env.MD_NO_DIALOG === '1') return { ok: false, via: 'none', reason: '这台机器关掉了确认弹窗（MD_NO_DIALOG=1）' };
  if (platform === 'darwin') {
    const r = await (deps.runOsascript ?? runOsascript)(text, title);
    return { ...r, via: 'dialog' };
  }
  const tty = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (tty) {
    const r = await (deps.promptTty ?? promptTty)(`${title}\n${text}`);
    return { ...r, via: 'tty' };
  }
  return { ok: false, via: 'none', reason: '这台机器弹不出确认框：请用户在自己的终端里运行同一条命令' };
}
