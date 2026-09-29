// 这个文件是不是被 node 直接运行的入口。node 按真实路径算入口脚本的 import.meta.url，argv[1] 却是敲进去的路径：
// 仓库放在软链目录下（macOS 的 /tmp、/var 都是软链）时两者字面上不一样，直接比会以为「不是入口」，脚本静默什么都不做、退出码 0。
// 所以两边都取真实路径再比
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
