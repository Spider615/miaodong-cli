// 从源码里取出引用的模块名（vendor.test 用）。认得跨行写的 import（import {\n  a,\n} from './x'）、只为副作用的 import './x'、
// 动态 import('./x')；整行注释里的不算，模板字符串里的也不算。
// 审查 M1：原来按单行匹配，跨行写的 import 看不见——漏掉的依赖要到别的测试才红，还丢了「加进 SOURCE.json」的提示。
export function importSpecifiers(text) {
  const code = text.replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, '');
  const specs = [];
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}
