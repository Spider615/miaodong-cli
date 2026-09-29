// 3b 导入、续跑、撤回的命令行测试共用：带身份的临时 HOME、起能写的假秒懂、预演拿计划码、按计划码确认
import assert from 'node:assert/strict';
import { runCli, tempHome } from './run-cli.mjs';
import { seedIdentity } from './seed.mjs';
import { startKbServer } from './kb-server.mjs';
import { importServerOptions } from './kb-import-data.mjs';

export function homeFor(server) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}

export async function withServer(options, fn) {
  const server = await startKbServer(importServerOptions(options));
  try {
    await fn(server, homeFor(server));
  } finally {
    await server.close();
  }
}

// 建的请求先回 reply（504、或回了成功但没有 id），东西先不落库；测试调 flush() 才落，模拟「过一会儿才落库 / 列表延迟」。
// 不用毫秒定时器：机器忙时 md 发完之后那几次重列会变慢，按毫秒设的延迟会落进窗口里，测试就测不到「窗口外才出现」
// （09-29 全量跑时偶发失败，把文件列表调慢 40ms 能稳定复现）。命令跑完再 flush，必定在窗口之外
export function holdCreates(server, route, reply, { calls = Infinity } = {}) {
  const orig = server.routes[route];
  const held = [];
  let n = 0;
  server.routes[route] = async (rec) => {
    n += 1;
    if (n > calls) return orig(rec);
    held.push(rec);
    return reply;
  };
  return {
    async flush() {
      while (held.length) await orig(held.shift());
    },
  };
}

export const codeOf = (r) => r.stdout.match(/计划码：([0-9a-f]{8})/)?.[1];
export const recordOf = (r) => r.stdout.match(/导入记录：(\S+)（(\S+)）/);

// 预演（要求闸门全过），返回计划码
export async function previewCode(dir, h, env) {
  const r = await runCli(['kb', 'import', dir], { home: h, env });
  assert.equal(r.code, 0, r.stderr);
  return codeOf(r);
}

// 预演 + 按计划码确认，返回确认那一次的结果
export async function confirmImport(dir, h, env) {
  const code = await previewCode(dir, h, env);
  return runCli(['kb', 'import', dir, '--confirm', code], { home: h, env });
}

// 续跑：预演拿计划码，再确认
export async function resume(importId, h, env) {
  const p = await runCli(['kb', 'import', '--resume', importId], { home: h, env });
  assert.equal(p.code, 0, p.stderr);
  return { preview: p, done: await runCli(['kb', 'import', '--resume', importId, '--confirm', codeOf(p)], { home: h, env }) };
}

// 撤回：预演拿计划码，再确认（extra：比如 --skip-rebuild）
export async function revoke(importId, h, env, extra = []) {
  const p = await runCli(['kb', 'revoke', importId, ...extra], { home: h, env });
  assert.equal(p.code, 0, p.stderr);
  return { preview: p, done: await runCli(['kb', 'revoke', importId, ...extra, '--confirm', codeOf(p)], { home: h, env }) };
}
