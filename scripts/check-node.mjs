// 测试要 --experimental-strip-types（Node 22.6 起才有）。在 Node 18 下跑只会看到一句 bad option，
// 所以 release、sync 这些要跑测试的脚本先查、先说清楚（审查 M3）
export function testNodeProblem(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 6)) return null;
  return `测试要 Node 22.6 或更高（当前 ${version}）：先 nvm use（.nvmrc 写着 22），或者把 Node 22 的 bin 放到 PATH 前面`;
}
