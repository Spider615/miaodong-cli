// md kb：知识库（spec 3a）。全部只读：看有哪些库、拉到本机、查一句话、查一条执行为什么没召回。子命令分在 kb-*.mjs 里，这里只分发
import { usage } from '../errors.mjs';
import { find } from './kb-find.mjs';
import { importCmd } from './kb-import.mjs';
import { list } from './kb-list.mjs';
import { pull } from './kb-pull.mjs';
import { revoke } from './kb-revoke.mjs';
import { why } from './kb-why.mjs';

const SUBS = { list, pull, find, why, import: importCmd, revoke };

const USAGE = [
  'md kb list [--bot <智能体> [--version vX]] [--region <区>] [--org <企业>]   知识库列表；--bot 只列这个智能体引用的库、各节点怎么挂的、FAQ 未审核数',
  'md kb pull <知识库> [--region <区>] [--org <企业>]           把全部 FAQ、文件、段落拉到本机；条数和平台对不上就报错',
  'md kb find <知识库> "<一句话>" [--local] [--region <区>] [--org <企业>]   文字命中 + 语义最像 + 问题相似（含未审核），带分数和状态',
  'md kb why <执行id> [--node <节点|#序号>] [--expect <FAQ id|"关键词">]   这次为什么没召回：重放当时的检索，给出原因和证据',
  '全部只读、不花钱；知识库全文只存本机 ~/.miaodong/md/kb/，终端里答案和段落只显示前 60 个字',
];

export const kb = {
  summary: '知识库（只读）：列知识库和智能体的引用，拉到本机，查一句话的命中和分数，查一条执行为什么没召回',
  usage: USAGE.join('\n'),
  async run(args) {
    const sub = args._[0];
    const handler = SUBS[sub];
    if (!handler) throw usage(sub ? `不认识「md kb ${sub}」` : '缺子命令', `可用：${Object.keys(SUBS).join('、')}`);
    return handler({ ...args, _: args._.slice(1) });
  },
};
