// md test：测试中心（spec §6）。子命令分在 test-*.mjs 里，这里只分发

import { usage } from '../errors.mjs';
import { drop } from './test-drop.mjs';
import { edit } from './test-edit.mjs';
import { importCmd } from './test-import.mjs';
import { results } from './test-results.mjs';
import { run, status, stop } from './test-run.mjs';
import { resume } from './test-resume.mjs';
import { audit } from './test-audit.mjs';
import { cases, sets, tree } from './test-view.mjs';

const SUBS = { sets, cases, tree, import: importCmd, audit, edit, run, status, stop, resume, results, drop };

const USAGE = [
  'md test sets --bot <智能体>                             测试集列表；这个区有没有场景树',
  'md test cases <集> --bot <智能体> [--out <文件.jsonl>]    用例汇总；完整用例存本机',
  'md test cases [<集>] --scenario <场景名或路径> --bot <智能体>   挂在这个场景上的用例（跨测试集；给了集只看这个集的）',
  'md test tree --bot <智能体>                             场景树和各节点的用例数',
  'md test import <集> --bot <智能体> --from-execs <.jsonl | 执行id,…> [--from-bot <源智能体>] [--into] [--allow-preflight-errors]   从执行记录导入；跨智能体按名字换 id；取不到事件 / 会话变量列表时默认不写',
  'md test import <集> --bot <智能体> --from-file <cases.jsonl> [--into]   外部用例：本地先校验全部，有错一条都不写；先写 1 条读回来核对，再批量写、挂场景、审计',
  'md test audit <集> --from-file <cases.jsonl> --bot <智能体>   只读对账：文件里的用例和秒懂存的逐条逐字段比，缺的、多的、不一样的、没挂对场景的都列出来',
  'md test edit <集> <脚本.mjs> --bot <智能体> [--confirm <计划码>]   按脚本批量改用例：默认预演给计划码；确认后先备份、逐条全量更新、回读核对',
  'md test run <集> --bot <智能体> [--case <用例名或 id> …] [--version vX] [--rounds 1] [--concurrency 10] [--name <任务名>] [--allow-preflight-errors] [--confirm <码>]   跑回归：先跑前检查和预估，超门槛或估不出要用户确认；--case 只跑挑出来的几条',
  'md test status [<任务>] --bot <智能体> [--set <集>] [--wait] [--timeout 540]   进度；--wait 盯着跑，超出额度自动暂停，跑完记账',
  'md test stop <任务> --bot <智能体>                 暂停（秒懂没有取消）',
  'md test resume <任务> --bot <智能体> [--confirm <计划码>]   继续暂停的任务：默认预演剩几条、其余花费，给计划码；用户同意后带码才继续',
  'md test results <任务> [<任务2> …] --bot <智能体> [--out <文件.xlsx|.csv|.jsonl>] [--deep] [--limit 10]   报告；两个任务按用例对齐比改前改后',
  'md test drop <集> --bot <智能体> [--confirm <计划码>]   删测试集：默认预演；确认后先备份、先删用例后删集',
];

export const test = {
  summary: '测试中心：看测试集 / 用例 / 场景树，从执行记录或外部文件导入，对账，批量改用例，跑回归（超门槛要用户确认），看进度和结果，暂停、继续，删测试集',
  usage: USAGE.join('\n'),
  async run(args) {
    const sub = args._[0];
    const handler = SUBS[sub];
    if (!handler) throw usage(sub ? `不认识「md test ${sub}」` : '缺子命令', `可用：${Object.keys(SUBS).join('、')}`);
    return handler({ ...args, _: args._.slice(1) });
  },
};
