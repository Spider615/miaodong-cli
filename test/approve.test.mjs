import test from 'node:test';
import assert from 'node:assert/strict';
import { osascriptArgs, requestApproval } from '../src/approve.mjs';

const REQ = { title: 'md 花费确认', lines: ['智能体：太极2.0 质检革新版', '预计 ¥3.00'] };

test('macOS：弹系统对话框，只有点「同意」才算批准', async () => {
  const seen = [];
  const yes = await requestApproval(REQ, { platform: 'darwin', env: {}, runOsascript: async (text, title) => { seen.push({ text, title }); return { ok: true }; } });
  assert.deepEqual(yes, { ok: true, via: 'dialog' });
  assert.equal(seen[0].text, '智能体：太极2.0 质检革新版\n预计 ¥3.00');
  assert.equal(seen[0].title, 'md 花费确认');
  const no = await requestApproval(REQ, { platform: 'darwin', env: {}, runOsascript: async () => ({ ok: false, reason: '用户点了拒绝' }) });
  assert.deepEqual(no, { ok: false, reason: '用户点了拒绝', via: 'dialog' });
});

test('MD_NO_DIALOG=1 只会让它直接拒绝，不弹窗', async () => {
  let called = 0;
  const r = await requestApproval(REQ, { platform: 'darwin', env: { MD_NO_DIALOG: '1' }, runOsascript: async () => { called++; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(called, 0);
});

test('不是 macOS：有终端才问（要输入「同意」）；AI 调用（没有终端）一律拒绝', async () => {
  const noTty = await requestApproval(REQ, { platform: 'linux', env: {}, isTTY: false });
  assert.equal(noTty.ok, false);
  assert.match(noTty.reason, /自己的终端/);
  const tty = await requestApproval(REQ, { platform: 'linux', env: {}, isTTY: true, promptTty: async (text) => { assert.match(text, /预计 ¥3\.00/); return { ok: true }; } });
  assert.deepEqual(tty, { ok: true, via: 'tty' });
});

test('弹窗文字走 argv，不拼进 AppleScript 源码（防引号出错和注入）', () => {
  const text = '他说"你好" & do shell script "rm -rf ~"';
  const args = osascriptArgs(text, '标题');
  assert.deepEqual(args.slice(-2), [text, '标题']);
  const script = args.slice(0, -2);
  assert.ok(script.every((a) => !a.includes('rm -rf')));
  assert.equal(script.filter((a) => a === '-e').length, script.length / 2);
});
