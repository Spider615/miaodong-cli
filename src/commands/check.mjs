import { EXIT } from '../errors.mjs';
import { runCheck } from '../check.mjs';
import { loadWorkspace, wsLine } from '../workspace.mjs';
import { out } from '../output.mjs';

export const check = {
  summary: '自检改动：只报这次新引入的问题（类型突变、悬空、结构校验、新增风险）',
  usage: 'md check [--ws <工作副本>]',
  async run(args) {
    const ws = loadWorkspace(args);
    out(wsLine(ws));
    if (!ws.after) {
      out('还没有改动（先 md apply）。');
      return EXIT.OK;
    }
    const result = runCheck(ws.base, ws.after);
    if (!result.errors.length && !result.warnings.length) out('✅ 没发现新问题');
    for (const e of result.errors) out(`❌ ${e}`);
    for (const w of result.warnings) out(`⚠️ ${w}`);
    for (const n of result.notes) out(`· ${n}`);
    return result.errors.length ? EXIT.ERROR : EXIT.OK;
  },
};
