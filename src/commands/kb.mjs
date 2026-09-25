// md kb：知识库。list / pull / find / why 只读（spec 3a）：看有哪些库、拉到本机、查一句话、查一条执行为什么没召回——查 case 只用这几个。
// import / revoke 写库（spec 3b）：只在处理客户资料时用，默认预演、要用户确认计划码。子命令分在 kb-*.mjs 里，这里只分发
import { usage } from '../errors.mjs';
import { find } from './kb-find.mjs';
import { importCmd, importsCmd } from './kb-import.mjs';
import { list } from './kb-list.mjs';
import { pull } from './kb-pull.mjs';
import { revoke } from './kb-revoke.mjs';
import { why } from './kb-why.mjs';

const SUBS = { list, pull, find, why, import: importCmd, imports: importsCmd, revoke };

const USAGE = [
  'md kb list [--bot <智能体> [--version vX]] [--region <区>] [--org <企业>]   知识库列表；--bot 只列这个智能体引用的库、各节点怎么挂的、FAQ 未审核数',
  'md kb pull <知识库> [--region <区>] [--org <企业>]           把全部 FAQ、文件、段落拉到本机；条数和平台对不上就报错',
  'md kb find <知识库> "<一句话>" [--local] [--region <区>] [--org <企业>]   文字命中 + 语义最像 + 问题相似（含未审核），带分数和状态',
  'md kb why <执行id> [--node <节点|#序号>] [--expect <FAQ id|"关键词">]   这次为什么没召回：重放当时的检索，给出原因和证据',
  '以上只读、不花钱，查 case 只用它们；知识库全文只存本机 ~/.miaodong/md/kb/，终端里答案和段落只显示前 60 个字',
  'md kb import <导入包目录> [--confirm <计划码>]   写库：把处理好的客户资料导进知识库（只在处理客户资料时用）；默认预演，闸门全过才给计划码，用户本人确认后才写',
  'md kb import --resume <导入id> [--confirm <计划码>]   导入中途停了，从停下的那一步接着做',
  'md kb revoke <导入id> [--confirm <计划码>]   撤回一次导入：从备份重建这次删掉的，再删这次建的',
  'md kb imports   本机的导入记录（导入 id、状态）',
];

export const kb = {
  summary: '知识库：列知识库和智能体的引用、拉到本机、查一句话的命中和分数、查一条执行为什么没召回（只读）；把处理好的客户资料导入知识库、撤回导入（写库，要用户确认）',
  usage: USAGE.join('\n'),
  async run(args) {
    const sub = args._[0];
    const handler = SUBS[sub];
    if (!handler) throw usage(sub ? `不认识「md kb ${sub}」` : '缺子命令', `可用：${Object.keys(SUBS).join('、')}`);
    return handler({ ...args, _: args._.slice(1) });
  },
};
