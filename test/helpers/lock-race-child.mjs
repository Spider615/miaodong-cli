// 测试用：上锁、拿着锁待一会儿、放锁，把结果打出来（拿到锁 / 被拦：错误码）
import { lockKb } from '../../src/kb-import-store.mjs';

try {
  const release = lockKb('k1', process.env.MD_TEST_KB, `进程 ${process.env.NAME}`);
  console.log(`${process.env.NAME} 拿到锁`);
  await new Promise((r) => setTimeout(r, Number(process.env.HOLD ?? 800)));
  release();
} catch (error) {
  console.log(`${process.env.NAME} 被拦：${error.code}`);
}
