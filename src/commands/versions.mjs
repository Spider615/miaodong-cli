import { intArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { basicInfo, getCanvas, listVersions } from '../api.mjs';
import { resolveBot, targetArgs } from '../target.mjs';
import { formatTime, out, targetLine } from '../output.mjs';

const TYPE_LABEL = { online: '正式', test: '测试' };

export const versions = {
  summary: '看智能体的版本：哪个在线上、哪个是灰度、草稿最后保存时间',
  usage: 'md versions --bot <智能体> [--org <企业>] [--region <区>] [--limit 30]',
  async run(args) {
    const target = await resolveBot(targetArgs(args));
    const { identity, orgId, botId } = target;
    const draft = await getCanvas(identity, orgId, botId);
    const [list, info] = await Promise.all([listVersions(identity, orgId, draft.canvasId), basicInfo(identity, orgId, botId)]);
    const limit = intArg(args, 'limit', 30);
    out(targetLine(target));
    out(`草稿：最后保存 ${formatTime(draft.updatedAt)}`);
    out(info?.canvasVersion ? `线上启用：${info.canvasVersion}` : '线上启用：取不到（这个区的接口不支持），以秒懂页面为准');
    out(`共 ${list.length} 个版本${list.length > limit ? `，显示最近 ${limit} 个（--limit 调整）` : ''}`);
    out('版本 | 名称 | 类型 | 线上 | 测试 | 创建');
    for (const v of list.slice(0, limit)) {
      const flags = [v.version === info?.canvasVersion ? '启用' : '', v.isCanary ? '灰度' : ''].filter(Boolean).join('+') || '-';
      const testText = `${v.testStatus || '-'}${v.passedRate !== null ? ` ${v.passedRate}` : ''}`;
      out(`${v.version} | ${v.name || '-'} | ${TYPE_LABEL[v.versionType] ?? (v.versionType || '-')} | ${flags} | ${testText} | ${formatTime(v.createdAt)} ${v.createdBy}`.trimEnd());
    }
    return EXIT.OK;
  },
};
