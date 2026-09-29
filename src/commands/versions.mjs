import { intArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { basicInfo, getCanvas, listVersions } from '../api.mjs';
import { resolveBot, targetArgs } from '../target.mjs';
import { formatTime, out, shortId, targetLine } from '../output.mjs';

const TYPE_LABEL = { online: '正式', test: '测试' };

// 版本列表的创建人只给用户 id，秒懂也没有列企业成员的接口：是自己就写「我（名字）」，别人的写 id 前 8 位；本来就是名字的照原样
function creator(createdBy, identity) {
  if (!createdBy) return '';
  if (identity?.user?.id && createdBy === identity.user.id) return `我（${identity.user.name || '当前身份'}）`;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(createdBy) ? `其他成员 ${shortId(createdBy)}` : createdBy;
}

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
      out(`${v.version} | ${v.name || '-'} | ${TYPE_LABEL[v.versionType] ?? (v.versionType || '-')} | ${flags} | ${testText} | ${formatTime(v.createdAt)} ${creator(v.createdBy, identity)}`.trimEnd());
    }
    return EXIT.OK;
  },
};
