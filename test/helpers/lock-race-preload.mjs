// 测试用：让这个进程在上锁的某一步停一会儿，模拟被系统调度挂起（复审 Important 5：接管死锁的竞态）。
// MD_TEST_STALL_AT=takeover：第一次抢接管标记（.lock.takeover）之前停；=remove：第一次删 .lock 之前停。MD_TEST_STALL_MS 停多久
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const at = process.env.MD_TEST_STALL_AT;
const ms = Number(process.env.MD_TEST_STALL_MS ?? 0);
const stall = () => {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* 挂起 */ }
};
if (at === 'takeover') {
  const orig = fs.linkSync;
  let first = true;
  fs.linkSync = function patched(src, dest) {
    if (first && String(dest).endsWith('.lock.takeover')) {
      first = false;
      stall();
    }
    return orig.call(this, src, dest);
  };
}
if (at === 'remove') {
  const orig = fs.rmSync;
  let first = true;
  fs.rmSync = function patched(p, opts) {
    if (first && String(p).endsWith('/.lock')) {
      first = false;
      stall();
    }
    return orig.call(this, p, opts);
  };
}
syncBuiltinESMExports();
