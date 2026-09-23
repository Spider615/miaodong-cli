import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildSnippet, decodeAuthBlob, jwtExpiry, normalizeOrigin, regionOf } from '../src/identity.mjs';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { ok, startFakeMiaodong } from './helpers/fake-miaodong.mjs';
import { encodeAuthBlob, seedIdentity } from './helpers/seed.mjs';

// 在 Node 里模拟浏览器控制台执行那行代码
function runSnippet(origin, { pageOrigin = origin, storage = {} } = {}) {
  let copied = null;
  const context = vm.createContext({
    location: { origin: pageOrigin },
    localStorage: { getItem: (key) => storage[key] ?? null },
    copy: (text) => { copied = text; },
    btoa, unescape, encodeURIComponent, JSON, Array, String,
  });
  const result = vm.runInContext(buildSnippet(origin), context);
  return { result, copied };
}

let server;
before(async () => { server = await startFakeMiaodong({ 'GET /api/bot/list': () => ok([]) }); });
after(() => server.close());

test('域名规范化与区识别', () => {
  assert.equal(normalizeOrigin('xlink-insight.juzibot.com/main/agents'), 'https://xlink-insight.juzibot.com');
  assert.deepEqual(regionOf('https://xlink-insight.juzibot.com'), { key: 'xingqudao', label: '兴趣岛（独立部署）' });
  assert.deepEqual(regionOf('https://demo.example.com'), { key: 'demo.example.com', label: 'demo.example.com' });
  assert.throws(() => normalizeOrigin('  '), (e) => e.exitCode === 2);
});

test('控制台代码：读 localStorage.user，复制 md-auth 串，能解回来', () => {
  const user = {
    id: 'u1', name: '胡同学', token: 'jwt.abc.def',
    currentOrg: { id: 'org-1', name: '兴趣岛平台' },
    orgs: [{ id: 'org-1', name: '兴趣岛平台' }, { id: 'org-2', name: '测试企业' }],
  };
  const { result, copied } = runSnippet('https://xlink-insight.juzibot.com', { storage: { user: JSON.stringify(user) } });
  assert.match(result, /✅ 已复制身份/);
  const blob = decodeAuthBlob(copied);
  assert.equal(blob.origin, 'https://xlink-insight.juzibot.com');
  assert.equal(blob.token, 'jwt.abc.def');
  assert.equal(blob.currentOrgId, 'org-1');
  assert.deepEqual(blob.orgs.map((o) => o.name), ['兴趣岛平台', '测试企业']);
  assert.equal(blob.user.name, '胡同学');
});

test('控制台代码：域名不对或没登录时只给提示、不复制', () => {
  const wrong = runSnippet('https://xlink-insight.juzibot.com', { pageOrigin: 'https://xlink-hi.juzibot.com' });
  assert.match(wrong.result, /❌ 当前页面是 https:\/\/xlink-hi\.juzibot\.com/);
  assert.equal(wrong.copied, null);
  const noLogin = runSnippet('https://xlink-insight.juzibot.com');
  assert.match(noLogin.result, /没读到登录态/);
  assert.equal(noLogin.copied, null);
});

test('控制台代码：嵌入模式下的 user-ai-pc 也能读', () => {
  const { copied } = runSnippet('https://a.example.com', {
    storage: { 'user-ai-pc': JSON.stringify({ token: 't', currentOrg: { id: 'o', name: 'O' } }) },
  });
  assert.equal(decodeAuthBlob(copied).token, 't');
});

test('decode：剪贴板里是别的东西时报错，退出码 3，且不回显内容', () => {
  assert.throws(() => decodeAuthBlob("(()=>{try{const want='x'"), (e) =>
    e.code === 'auth_blob_invalid' && e.exitCode === 3 && !e.message.includes('want'));
  assert.throws(() => decodeAuthBlob('md-auth:!!!'), (e) => e.code === 'auth_blob_invalid');
  assert.throws(() => decodeAuthBlob(encodeAuthBlob({ origin: 'https://a.com', token: '', orgs: [{ id: 'o' }] })), /没有登录凭证/);
  assert.throws(() => decodeAuthBlob(encodeAuthBlob({ origin: 'https://a.com', token: 't', orgs: [] })), /没有任何企业/);
});

test('jwtExpiry：有 exp 返回毫秒，没有返回 null', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(jwtExpiry(`h.${b64({ exp: 2000000000 })}.s`), 2000000000 * 1000);
  assert.equal(jwtExpiry(`h.${b64({ id: 'u' })}.s`), null);
  assert.equal(jwtExpiry('opaque-token'), null);
});

test('md auth import --stdin：验证后保存（0600），输出不含 token', async () => {
  const home = tempHome();
  const blob = encodeAuthBlob({
    origin: server.origin, token: 'tok-SECRET-9', user: { id: 'u1', name: '胡同学' },
    currentOrg: { id: 'org-1', name: '企业一' }, orgs: [{ id: 'org-1', name: '企业一' }],
  });
  const r = await runCli(['auth', 'import', '--stdin'], { home, input: blob });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /✅ 已保存：127\.0\.0\.1:\d+ · 企业一 · 胡同学/);
  assert.ok(!`${r.stdout}${r.stderr}`.includes('SECRET'));
  const file = join(home, 'md', 'identities.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const entry = Object.values(JSON.parse(readFileSync(file, 'utf-8')))[0];
  assert.equal(entry.token, 'tok-SECRET-9');
  assert.equal(server.requests.at(-1).query.orgId, 'org-1');
});

test('md auth import：秒懂拒绝时不保存，退出码 3', async () => {
  const home = tempHome();
  server.routes['GET /api/bot/list'] = () => ({ status: 401, body: { statusCode: 401, message: 'Authentication failed' } });
  const blob = encodeAuthBlob({ origin: server.origin, token: 'bad', currentOrg: { id: 'o', name: 'O' }, orgs: [] });
  const r = await runCli(['auth', 'import', '--stdin'], { home, input: blob });
  assert.equal(r.code, 3);
  assert.equal(existsSync(join(home, 'md', 'identities.json')), false);
  server.routes['GET /api/bot/list'] = () => ok([]);
});

test('md auth snippet / list / remove', async () => {
  const home = tempHome();
  const s = await runCli(['auth', 'snippet', 'xlink-insight.juzibot.com'], { home });
  assert.equal(s.code, 0);
  assert.match(s.stdout, /兴趣岛/);
  assert.match(s.stdout, /localStorage\.getItem\('user'\)/);
  seedIdentity(home, { key: 'k1', label: '测试区', origin: 'https://a.example.com', token: 'tok-SECRET', orgs: [{ id: 'o1', name: '企业一' }], currentOrgId: 'o1' });
  const l = await runCli(['auth', 'list'], { home });
  assert.match(l.stdout, /测试区/);
  assert.ok(!l.stdout.includes('SECRET'));
  assert.equal((await runCli(['auth', 'remove', 'k1'], { home })).code, 0);
  assert.match((await runCli(['auth', 'list'], { home })).stdout, /还没有任何区的身份/);
});

test('控制台代码和步骤都提醒：只回复「好了」，不要把身份串粘贴进对话', async () => {
  const { result } = runSnippet('https://a.example.com', { storage: { user: JSON.stringify({ token: 't', currentOrg: { id: 'o', name: 'O' } }) } });
  assert.match(result, /不要粘贴/);
  const s = await runCli(['auth', 'snippet', 'a.example.com'], { home: tempHome() });
  assert.match(s.stdout, /不要把复制的内容粘贴进对话/);
});

// 用 PATH 里的假 pbpaste / pbcopy 模拟剪贴板（读写一个临时文件），不在产品代码里留测试钩子
function fakeClipboard(content) {
  const dir = tempHome();
  const clip = join(dir, 'clip.txt');
  writeFileSync(clip, content);
  writeFileSync(join(dir, 'pbpaste'), '#!/bin/sh\ncat "$MD_TEST_CLIP"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'pbcopy'), '#!/bin/sh\ncat > "$MD_TEST_CLIP"\n', { mode: 0o755 });
  return { clip, env: { PATH: `${dir}:${process.env.PATH}`, MD_TEST_CLIP: clip } };
}

test('从剪贴板导入：验证失败也清空剪贴板；剪贴板里不是身份串时不动它', async () => {
  server.routes['GET /api/bot/list'] = () => ({ status: 401, body: { statusCode: 401, message: 'Authentication failed' } });
  const bad = fakeClipboard(encodeAuthBlob({ origin: server.origin, token: 'tok-SECRET', currentOrg: { id: 'o', name: 'O' }, orgs: [] }));
  const r = await runCli(['auth', 'import'], { home: tempHome(), env: bad.env });
  server.routes['GET /api/bot/list'] = () => ok([]);
  assert.equal(r.code, 3);
  assert.equal(readFileSync(bad.clip, 'utf-8'), '');
  const other = fakeClipboard('随便一段文字');
  const r2 = await runCli(['auth', 'import'], { home: tempHome(), env: other.env });
  assert.equal(r2.code, 3);
  assert.equal(readFileSync(other.clip, 'utf-8'), '随便一段文字');
});

test('snippet：不认识的域名要提醒确认', async () => {
  const unknown = await runCli(['auth', 'snippet', 'willow-hi.juzibot.com'], { home: tempHome() });
  assert.match(unknown.stdout, /不是已知的秒懂控制台域名/);
  const known = await runCli(['auth', 'snippet', 'insight.juzibot.com'], { home: tempHome() });
  assert.doesNotMatch(known.stdout, /不是已知的秒懂控制台域名/);
});

test('没有 pbpaste 的机器：提示让用户在自己的终端用 --stdin，而不是把内容贴进对话', async () => {
  const r = await runCli(['auth', 'import'], { home: tempHome(), env: { PATH: dirname(process.execPath) } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /在自己的终端运行 md auth import --stdin/);
  assert.match(r.stderr, /不要把内容贴进对话/);
});
