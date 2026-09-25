// G 组：JS 节点运行期隐患（对 nodePayload.code 字符串做启发式）。
// 只做低误报的判据；G1/G7 那类「扫所有裸标识符」的高误报检查刻意收窄或不做。
//   G1 return main 传入了未在 inputs 声明的参数（运行时 undefined）
//   G2 function main 形参 与 return main 实参 不一致
//   G3 使用沙箱不支持的全局（require/import/fetch/…）
//   G4 时区不安全（本地时区取值 / 未 +8h）
//   G5 有 function main 但不以 return main(...) 收尾
//   G6 outputTypes 声明了某输出，但代码从不产出该 key

import type { RiskFinding, RiskSeverity } from '../types';
import { asArray, asObject, asString, type AnalysisContext, type RiskNode } from '../context';

type Add = (f: RiskFinding) => void;

/** 沙箱不支持的全局 / 语法（token → 检测正则）。 */
const UNAVAILABLE: { token: string; re: RegExp }[] = [
  { token: 'require', re: /\brequire\s*\(/ },
  { token: 'import', re: /\bimport\s*[\s(]/ },
  { token: 'fetch', re: /\bfetch\s*\(/ },
  { token: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { token: 'process', re: /\bprocess\s*\./ },
  { token: 'window', re: /\bwindow\s*\./ },
  { token: 'document', re: /\bdocument\s*\./ },
  { token: 'Buffer', re: /\bBuffer\b/ },
  { token: 'setTimeout', re: /\bsetTimeout\s*\(/ },
  { token: 'setInterval', re: /\bsetInterval\s*\(/ },
  { token: 'Promise', re: /\bPromise\b/ },
  { token: 'async', re: /\basync\b/ },
  { token: 'await', re: /\bawait\b/ },
];

const IDENT = /^[A-Za-z_$][\w$]*$/;

function parseArgList(code: string, re: RegExp): string[] | null {
  const m = re.exec(code);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function checkJsRuntime(ctx: AnalysisContext, add: Add): void {
  for (const node of ctx.nodes) {
    if (node.shape !== 'javascript-code' && node.type !== 'javascript-code') continue;
    const code = asString(node.payload.code) ?? '';
    if (!code.trim()) continue;

    const inputNames = new Set<string>();
    asArray(node.payload.inputs).forEach((inp) => {
      const nm = asString(asObject(inp)?.name);
      if (nm && nm.trim()) inputNames.add(nm);
    });

    const push = (code2: string, rule: string, severity: RiskSeverity, message: string, summary: string, path = 'data.nodePayload.code') =>
      add({ code: code2, rule, category: 'js-runtime', severity, nodeId: node.id, path, message, fix: { summary } });

    // G3：不支持的全局
    const hits = UNAVAILABLE.filter((u) => u.re.test(code)).map((u) => u.token);
    if (hits.length) {
      push(
        'G3',
        'js-unavailable-global',
        'warn',
        `JS 节点「${node.name}」用到了沙箱不支持的 ${hits.join(' / ')}，运行时会报错（平台 JS 沙箱只支持纯同步 JS）。`,
        '去掉这些用法；需要外部调用/异步请改用 plugin-calculation 节点',
      );
    }

    // G5：有 function main 但不以 return main() 收尾
    const hasMain = /function\s+main\s*\(/.test(code);
    const hasReturnMain = /return\s+main\s*\(/.test(code);
    if (hasMain && !hasReturnMain) {
      push(
        'G5',
        'js-no-return-main',
        'warn',
        `JS 节点「${node.name}」定义了 function main 但没有以 return main(...) 收尾，节点不会有输出。`,
        '在末尾补 return main(<入参>);，且 main 返回 { key: value }',
      );
    }

    // G1 / G2：main 形参 / return main 实参 / inputs 三方对齐
    const mainParams = parseArgList(code, /function\s+main\s*\(([^)]*)\)/);
    const callArgs = parseArgList(code, /return\s+main\s*\(([^)]*)\)/);
    if (callArgs) {
      for (const arg of callArgs) {
        if (IDENT.test(arg) && !inputNames.has(arg)) {
          push(
            'G1',
            'js-undefined-arg-reference',
            'warn',
            `JS 节点「${node.name}」的 return main(${callArgs.join(', ')}) 传入了未在 inputs 声明的「${arg}」，运行时它是 undefined。`,
            `把「${arg}」加进 inputs[]（platform 按 input name 注入实参）`,
          );
        }
      }
    }
    if (mainParams && callArgs && mainParams.join(',') !== callArgs.filter((a) => IDENT.test(a)).join(',') && callArgs.every((a) => IDENT.test(a))) {
      push(
        'G2',
        'js-return-main-arg-mismatch',
        'warn',
        `JS 节点「${node.name}」的 function main(${mainParams.join(', ')}) 形参与 return main(${callArgs.join(', ')}) 实参不一致（顺序错会张冠李戴、漏传会 undefined）。`,
        'function main 形参、return main 实参、inputs 名称三处对齐一致',
      );
    }

    // G4：时区不安全
    const usesDate = /new\s+Date\b/.test(code) || /Date\s*\.\s*now\b/.test(code);
    if (usesDate) {
      const localGetters = /\.(getFullYear|getMonth|getDate|getHours|getMinutes)\s*\(/.test(code);
      const nowNoOffset = /Date\s*\.\s*now\s*\(\s*\)/.test(code) && !/8\s*\*\s*3600\s*\*\s*1000|28800000|8\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(code);
      if (localGetters || nowNoOffset) {
        push(
          'G4',
          'js-timezone-unsafe',
          'info',
          `JS 节点「${node.name}」的时间处理可能有时区问题（平台 JS 跑在 UTC）：${localGetters ? '用了本地时区的 getHours/getMonth 等' : 'Date.now() 未加 8 小时偏移'}。`,
          '用 new Date(Date.now()+8*3600*1000) 并全程改用 getUTC* 系列',
        );
      }
    }

    // G6：outputTypes 声明了某输出，但代码从不产出该 key
    const outputNames = ctx.outputNamesById.get(node.id) ?? new Set<string>();
    for (const name of outputNames) {
      if (!IDENT.test(name)) continue;
      const producedRe = new RegExp(`['"\`]?\\b${name}\\b['"\`]?\\s*:`);
      if (!producedRe.test(code)) {
        push(
          'G6',
          'js-return-keys-mismatch-outputtypes',
          'warn',
          `JS 节点「${node.name}」的 outputTypes 声明了输出「${name}」，但代码里从没有 ${name}: ... 产出它，下游引用会取空。`,
          `让 main 返回的对象包含 ${name} 字段，或删除该 outputTypes 声明`,
          'data.outputTypes',
        );
      }
    }
  }
}
