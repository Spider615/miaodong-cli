import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { describeEntry, filterEntries, loadBotDirectory } from '../target.mjs';
import { out } from '../output.mjs';

export const bots = {
  summary: '列出 / 搜索智能体（跨所有已取身份的区和企业）',
  usage: 'md bots [关键词] [--org <企业>] [--region <区>] [--refresh]',
  async run(args) {
    const keyword = String(args._[0] ?? '').trim().toLowerCase();
    const entries = filterEntries(await loadBotDirectory({ refresh: args.refresh === true }), {
      org: strArg(args, 'org'),
      region: strArg(args, 'region'),
    });
    const hits = keyword
      ? entries.filter((e) => e.botName.toLowerCase().includes(keyword) || e.botId.toLowerCase().startsWith(keyword))
      : entries;
    out(`共 ${hits.length} 个智能体${keyword ? `（含「${args._[0]}」）` : ''}：`);
    for (const e of hits) out(`  - ${describeEntry(e)}${e.enabled ? '' : '  [已停用]'}`);
    return EXIT.OK;
  },
};
