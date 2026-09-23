import { intArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { diffEnvelopes, diffToJson, nameMapOf, renderDiff } from '../diff.mjs';
import { loadWorkspace, wsLine } from '../workspace.mjs';
import { out } from '../output.mjs';

export const diff = {
  summary: '看工作副本相对拉取时改了什么（字段级，prompt 按行）',
  usage: 'md diff [--ws <工作副本>] [--limit 400] [--json]',
  async run(args) {
    const ws = loadWorkspace(args);
    const d = diffEnvelopes(ws.base, ws.current);
    if (args.json) {
      out(JSON.stringify(diffToJson(d), null, 2));
      return EXIT.OK;
    }
    out(wsLine(ws));
    for (const line of renderDiff(d, { names: nameMapOf(ws.base.canvas, ws.current.canvas), limit: intArg(args, 'limit', 400) })) out(line);
    return EXIT.OK;
  },
};
