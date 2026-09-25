// md test：测试中心（spec §6）。子命令分在 test-*.mjs 里，这里只分发

import { usage } from '../errors.mjs';
import { importCmd } from './test-import.mjs';
import { cases, sets, tree } from './test-view.mjs';

const SUBS = { sets, cases, tree, import: importCmd };

const USAGE = [
  'md test sets --bot <智能体>                             测试集列表；这个区有没有场景树',
  'md test cases <集> --bot <智能体> [--out <文件.jsonl>]    用例汇总；完整用例存本机',
  'md test tree --bot <智能体>                             场景树和各节点的用例数',
  'md test import <集> --bot <智能体> --from-execs <.jsonl | 执行id,…> [--from-bot <源智能体>] [--into]   从执行记录导入；跨智能体按名字换 id',
];

export const test = {
  summary: '测试中心：看测试集 / 用例 / 场景树，从执行记录导入，跑回归（超门槛要用户确认），看进度和结果，暂停，删测试集',
  usage: USAGE.join('\n'),
  async run(args) {
    const sub = args._[0];
    const handler = SUBS[sub];
    if (!handler) throw usage(sub ? `不认识「md test ${sub}」` : '缺子命令', `可用：${Object.keys(SUBS).join('、')}`);
    return handler({ ...args, _: args._.slice(1) });
  },
};
