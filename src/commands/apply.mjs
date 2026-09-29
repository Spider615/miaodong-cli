import { resolve } from 'node:path';
import { boolArg, strArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { readJson } from '../home.mjs';
import { compareNodes } from '../canvas.mjs';
import { runTransform } from '../transform.mjs';
import { clearAfter, loadWorkspace, recordTransform, saveAfter, saveMeta, wsLine } from '../workspace.mjs';
import { out } from '../output.mjs';

export const apply = {
  summary: '在工作副本上执行改动脚本（可叠加），产出改后快照',
  usage: [
    'md apply <改动脚本.mjs> [--ws <工作副本>]   脚本写法见 skill 的 references/transforms.md',
    'md apply --json <画布.json>                 整份替换（手改，不能 rebase 重放）',
    'md apply --reset                            丢弃全部本地改动，回到拉取时的状态',
  ].join('\n'),
  async run(args) {
    const ws = loadWorkspace(args);
    if (boolArg(args, 'reset')) {
      clearAfter(ws.dir, ws.base);
      saveMeta(ws.dir, { ...ws.meta, handEdited: false });
      out(wsLine({ ...ws, after: null }));
      out('已丢弃本地改动，回到拉取时的状态。');
      return EXIT.OK;
    }
    let next;
    let log = [];
    const jsonFile = strArg(args, 'json');
    if (jsonFile) {
      const data = readJson(resolve(jsonFile));
      const canvas = Array.isArray(data) ? data : data?.canvas ?? data?.rawCanvas;
      if (!Array.isArray(canvas)) throw usage(`${jsonFile} 里没有画布数组（要么是数组本身，要么带 canvas / rawCanvas 字段）`);
      next = { ...ws.current, canvas };
      saveMeta(ws.dir, { ...ws.meta, handEdited: true });
      log = [`整份替换为 ${jsonFile}（手改，不能 rebase 重放）`];
    } else {
      const file = args._[0];
      if (!file) throw usage('用法：md apply <改动脚本.mjs> | --json <画布.json> | --reset');
      ({ envelope: next, log } = await runTransform(file, ws.current));
      recordTransform(ws.dir, resolve(file));
    }
    saveAfter(ws.dir, next);
    const d = compareNodes(ws.base.canvas, next.canvas);
    out(wsLine({ ...ws, after: next }));
    for (const line of log) out(`  · ${line}`);
    out(`相对拉取时：新增 ${d.onlyB} 个节点、删除 ${d.onlyA} 个、改了 ${d.changed} 个、连线变化 ${d.edgesDiffer} 条`);
    out('下一步：md diff 看具体改了什么，md check 自检');
    return EXIT.OK;
  },
};
