// 用户 09-27 定的规矩：改秒懂上的数据（画布、知识库、已有用例和测试集）要用户同意——默认预演，带 --confirm <计划码> 才写；
// 导入用例、跑回归、试跑不用确认（spec 2026-09-27-miaodong-cli-write-confirm-design.md）。
// 靠结构保证，写法同 kb-readonly-guard：每个秒懂接口都标了读写；写接口只在封装它的文件里；会写秒懂的命令正好是下面两份清单。
// 新命令、新接口没归类就不过。预演真的一个写请求都不发，由各命令自己的测试断言（spec §2 的表）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { REPO } from './helpers/run-cli.mjs';

const at = (p) => resolve(REPO, p);
const CMD = at('src/commands');
const TC = '/api/test-center';
const TRIAL_CORE = 'vendor/laodong/apps/api/lib/miaodong/trial-core.ts';

// 会写秒懂的命令文件必须正好是这些。要用户同意的：照 test drop 加预演和计划码，并补「预演不写」的测试；归到不用确认的，先问用户
// test-resume.mjs（md test resume，继续被暂停的任务，09-29 加）：继续就是多花钱，每次都先预演、带计划码才继续
// vars.mjs（md vars，会话属性定义的增删改，09-30 加）：写进去立刻对整个智能体生效，先预演、带计划码才写
const NEEDS_CONFIRM = ['push.mjs', 'restore.mjs', 'test-edit.mjs', 'test-drop.mjs', 'kb-import.mjs', 'kb-revoke.mjs', 'test-resume.mjs', 'vars.mjs'];
// trial-flow.mjs 是 md trial --text / --event（整条试跑）的实现，和 trial.mjs 同属 md trial（试跑），09-29 加
const NO_CONFIRM = ['test-import.mjs', 'test-import-file.mjs', 'test-run.mjs', 'trial.mjs', 'trial-flow.mjs'];
// 只分发子命令的路由：不参与分类，但自己不许写
const ROUTERS = ['index.mjs', 'test.mjs', 'kb.mjs'];

const READ = [
  '/api/bot/list', '/api/bot/basic-info', '/api/canvas/get', '/api/canvas/list-version', '/api/canvas/event/list', '/api/session-memory/list',
  '/api/canvas/history/list', '/api/canvas/history/details', '/api/canvas/history/list-by-session',
  '/api/knowledge-base/list', '/api/knowledge-base/details', '/api/knowledge-base/file/list', '/api/knowledge-base/file/details',
  '/api/knowledge-base/file/paragraphs', '/api/knowledge-base/web/list', '/api/qa/list', '/api/qa/metrics', '/api/qa/check-similarity',
  ...['/test-set/list', '/test-case/list', '/test-task/list', '/test-task/detail', '/test-task-item/list', '/scenario/tree', '/scenario/cases'].map((p) => TC + p),
];
// 写接口 → 允许出现它的文件（封装它的地方）。试跑的两个路径 GET 是查结果、POST 是启动，按写算。
// /api/canvas/exec 有两个封装处：vendor 的 startTrialRun 只能发文本；整条试跑要带事件触发和预置会话变量，md 自己在 src/trial-run.mjs 的 runFlowOnce 里封装
const WRITE = {
  '/api/canvas/save': 'src/api.mjs',
  ...Object.fromEntries(['/api/session-memory/create', '/api/session-memory/update', '/api/session-memory/delete'].map((p) => [p, 'src/api.mjs'])),
  ...Object.fromEntries(['/test-set/create', '/test-set/delete', '/test-case/import', '/test-case/create', '/test-case/update',
    '/test-case/batch-delete', '/scenario/attach-cases', '/test-task/create', '/test-task/pause', '/test-task/resume'].map((p) => [TC + p, 'src/testcenter.mjs'])),
  ...Object.fromEntries(['/api/qa/batch-create', '/api/qa/batch-review', '/api/qa/batch-delete', '/api/knowledge-base/file/manual-create',
    '/api/knowledge-base/file/manual-create-paragraph', '/api/knowledge-base/file/delete', '/api/knowledge-base/file/update-abstract'].map((p) => [p, 'src/kb-write.mjs'])),
  '/api/canvas/node/exec': TRIAL_CORE,
  '/api/canvas/exec': [TRIAL_CORE, 'src/trial-run.mjs'],
};
// 封装写接口的函数，按名字认（换个别名 import 也躲不开）；定义它们的文件自己不算。kb-write.mjs 整个是写模块，碰到就算会写
const WRITE_FNS = ['saveCanvas', 'createSessionVar', 'updateSessionVar', 'deleteSessionVar', 'createTestSet', 'deleteTestSet', 'importExecs', 'updateCase', 'createCases', 'attachCases', 'deleteCases',
  'createTask', 'pauseTask', 'resumeTask', 'startNodeTrialRun', 'startTrialRun', 'runFlowOnce'];
const DEFINERS = ['src/api.mjs', 'src/testcenter.mjs', 'src/kb-write.mjs', TRIAL_CORE].map(at);
const KB_WRITE = at('src/kb-write.mjs');
// 用着写接口的路径、但只 GET 查结果的函数（试跑）：不算写函数
const GET_ONLY = ['getTrialRun', 'getNodeTrialRun'];
// 会写的命令文件里只读的工具：从那里 import 它们不算写
const READ_HELPERS = { 'test-run.mjs': ['resolveTask', 'progressOf', 'judgeFee'] };

// 静态 import / export ... from、import '...'、动态 import('...')
const IMPORTS = /(?:(?:import|export)[^'"]*from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const MENTION = new RegExp(`\\b(?:${WRITE_FNS.join('|')})\\b`, 'g');
const read = (file) => readFileSync(file, 'utf-8');
const homes = (path) => [WRITE[path]].flat();
const writeHomes = () => Object.keys(WRITE).flatMap((path) => homes(path).map((home) => [path, home]));
const rel = (file) => relative(REPO, file);
const isCommand = (file) => dirname(file) === CMD;
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(mjs|ts)$/.test(e.name) ? [join(dir, e.name)] : []));
const scanned = () => [...sources(at('src')), ...sources(at('vendor'))];

// 顺着 import 往下找（包括 vendor），不进别的命令文件：命令之间的 import 在 writers() 里单独看
function reach(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const m of read(file).matchAll(IMPORTS)) {
    const next = resolve(dirname(file), m[1]);
    if (existsSync(next) && !isCommand(next)) reach(next, seen);
  }
  return seen;
}

function ownWrites(file) {
  const hits = new Set();
  for (const f of reach(file)) {
    if (f === KB_WRITE) hits.add(rel(KB_WRITE));
    else if (!DEFINERS.includes(f)) for (const m of read(f).matchAll(MENTION)) hits.add(`${m[0]}（${rel(f)}）`);
  }
  return [...hits];
}

// 自己会写的，加上从会写的命令文件 import 了只读工具以外东西的（包括 import * 和动态 import），算到不再变
function writers(commands) {
  const found = new Map(commands.map((c) => [c, ownWrites(join(CMD, c))]).filter(([, hits]) => hits.length));
  for (let changed = true; changed;) {
    changed = false;
    for (const c of commands.filter((x) => !found.has(x))) {
      for (const m of read(join(CMD, c)).matchAll(IMPORTS)) {
        const from = basename(m[1]);
        if (!isCommand(resolve(CMD, m[1])) || !found.has(from)) continue;
        const names = m[0].match(/\{([^}]*)\}/)?.[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) ?? [];
        if (!names.length || names.some((n) => !(READ_HELPERS[from] ?? []).includes(n))) {
          found.set(c, [`从 ${from} import 了 ${names.join('、') || m[0]}`]);
          changed = true;
          break;
        }
      }
    }
  }
  return found;
}

// 代码里的接口路径：引号或反引号开头（前面可以拼一段 ${…}），到路径字符为止——注释里不带引号的提法不算（vendor 的 canvas-derive.ts 注释里就有）。
// 测试中心的相对路径（'/test-…'、'/scenario/…'、`${TC}/…`）补成全路径
function pathsIn(file) {
  const text = read(file);
  const full = [...text.matchAll(/['"`](?:\$\{[^}]*\})?(\/api\/[\w/-]+)(?![\w/-])/g)].map((m) => m[1]).filter((p) => p !== TC);
  const tc = [...text.matchAll(/['"`](?:\$\{[^}]*\})?(\/(?:test-[\w-]+|scenario)\/[\w-]+)(?![\w/-])/g)].map((m) => TC + m[1]);
  return [...new Set([...full, ...tc])];
}

test('每个秒懂接口都标了读还是写：新接口没归类不过，代码里不再用的也要从清单删掉', () => {
  const used = new Set(scanned().flatMap(pathsIn));
  const listed = new Set([...READ, ...Object.keys(WRITE)]);
  const unlisted = [...used].filter((p) => !listed.has(p));
  assert.deepEqual(unlisted, [], `没归类的接口：${unlisted.join('、')}——读的加进 READ；写的加进 WRITE，封装它的函数加进 WRITE_FNS`);
  const stale = [...listed].filter((p) => !used.has(p));
  assert.deepEqual(stale, [], `清单里有、代码里已经不用的接口：${stale.join('、')}`);
  assert.deepEqual(READ.filter((p) => p in WRITE), [], '同一个接口不能既算读又算写');
});

test('写接口只许出现在封装它的文件里：别处不能绕开封装函数直接调', () => {
  for (const file of scanned()) {
    for (const path of pathsIn(file).filter((p) => p in WRITE)) {
      assert.ok(homes(path).includes(rel(file)), `${rel(file)} 里出现了写接口 ${path}（只许在 ${homes(path).join('、')}）`);
    }
  }
  for (const [path, home] of writeHomes()) assert.ok(pathsIn(at(home)).includes(path), `${home} 里找不到 ${path}`);
});

test('封装写接口的函数都在写函数清单里：命令调到它们才认得出（kb-write.mjs 整个算写，不用列）', () => {
  for (const [path, home] of writeHomes().filter(([, h]) => at(h) !== KB_WRITE)) {
    const text = read(at(home));
    const lit = path.startsWith(`${TC}/`) && home === 'src/testcenter.mjs' ? path.slice(TC.length) : path;
    for (const m of text.matchAll(new RegExp(`['"\`](?:\\$\\{[^}]*\\})?${lit.replace(/[/-]/g, '\\$&')}(?![\\w/-])`, 'g'))) {
      const fn = [...text.slice(0, m.index).matchAll(/export (?:async )?function (\w+)|export const (\w+) =/g)].at(-1);
      const name = fn?.[1] ?? fn?.[2];
      assert.ok(WRITE_FNS.includes(name) || GET_ONLY.includes(name), `${home} 里用到 ${path} 的函数 ${name ?? '?'} 不在 WRITE_FNS（只 GET 查结果的放 GET_ONLY）`);
    }
  }
});

test('会写秒懂的命令正好是两份清单：要用户同意的 8 个、不用确认的 5 个（用户 09-27 定；09-29 加了 md trial 的整条试跑、md test resume，09-30 加了 md vars）', () => {
  const commands = readdirSync(CMD).filter((f) => f.endsWith('.mjs') && !ROUTERS.includes(f));
  const found = writers(commands);
  const expected = [...NEEDS_CONFIRM, ...NO_CONFIRM];
  const extra = [...found.keys()].filter((c) => !expected.includes(c));
  assert.deepEqual(extra, [], `${extra.map((c) => `src/commands/${c} 会写秒懂但没归类：${found.get(c).join('；')}`).join('\n')}
要用户同意的：照 test drop 加预演和计划码、补「预演不写」的测试，再加进 NEEDS_CONFIRM；归到不用确认的（NO_CONFIRM），先问用户`);
  const missing = expected.filter((c) => !found.has(c));
  assert.deepEqual(missing, [], `清单里的命令不再写秒懂了：${missing.join('、')}——从清单里删掉`);
});

test('路由只分发子命令，自己不写秒懂', () => {
  for (const r of ROUTERS) assert.deepEqual(ownWrites(join(CMD, r)), [], `src/commands/${r} 自己写了秒懂`);
});

test('要用户同意的命令都有预演和计划码核对（兜底；预演真的不写由各命令的测试断言）', () => {
  for (const c of NEEDS_CONFIRM) {
    const text = read(join(CMD, c));
    assert.match(text, /这是预演/, `src/commands/${c} 没有预演`);
    assert.match(text, /givenCode\(|args\.confirm/, `src/commands/${c} 没有核对计划码`);
  }
});
