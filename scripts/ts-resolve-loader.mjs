// 测试用：Node 22 用 --experimental-strip-types 跑源码时，让不带扩展名的相对引用能找到 .ts 文件
// （vendor/laodong 里老懂的 TS 文件是这样写的）。打包不走这里，esbuild 自己会解析。
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function resolveExistingTsUrl(baseUrl) {
  for (const candidate of [baseUrl, new URL(`${baseUrl.href}.ts`), new URL(`${baseUrl.href}.tsx`)]) {
    try {
      await access(fileURLToPath(candidate));
      return { url: candidate.href, shortCircuit: true };
    } catch {
      // 试下一个扩展名
    }
  }
  return null;
}

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
    if (!isRelative || specifier.endsWith('.ts')) throw error;
    const resolved = await resolveExistingTsUrl(new URL(specifier, context.parentURL));
    if (resolved) return resolved;
    throw error;
  }
}
