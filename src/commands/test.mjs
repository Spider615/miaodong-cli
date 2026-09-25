// md test：测试中心（spec §6）。子命令分在 test-*.mjs 里，这里只分发

import { usage } from '../errors.mjs';
import { importCmd } from './test-import.mjs';
import { results } from './test-results.mjs';
import { run, status, stop } from './test-run.mjs';
import { cases, sets, tree } from './test-view.mjs';

const SUBS = { sets, cases, tree, import: importCmd, run, status, stop, results };

const USAGE = [
  'md test sets --bot <智能体>                             测试集列表；这个区有没有场景树',
  'md test cases <集> --bot <智能体> [--out <文件.jsonl>]    用例汇总；完整用例存本机',
  'md test tree --bot <智能体>                             场景树和各节点的用例数',
  'md test import <集> --bot <智能体> --from-execs <.jsonl | 执行id,…> [--from-bot <源智能体>] [--into]   从执行记录导入；跨智能体按名字换 id',
  'md test run <集> --bot <智能体> [--version vX] [--rounds 1] [--concurrency 5] [--name <任务名>] [--allow-preflight-errors] [--confirm <码>]   跑回归：先跑前检查和预估，超门槛或估不出要用户确认',
  'md test status [<任务>] --bot <智能体> [--set <集>] [--wait] [--timeout 540]   进度；--wait 盯着跑，超出额度自动暂停，跑完记账',
  'md test stop <任务> --bot <智能体>                 暂停（秒懂没有取消）',
  'md test results <任务> [<任务2> …] --bot <智能体> [--out <文件.xlsx|.csv|.jsonl>] [--deep] [--limit 10]   报告；两个任务按用例对齐比改前改后',
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
