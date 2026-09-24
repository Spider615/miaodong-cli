// 找到一条执行属于哪个区 / 企业 / 智能体，并取详情（带缓存）。md exec 和 md trial --from-exec 共用。

import { strArg } from './args.mjs';
import { EXIT, MdError } from './errors.mjs';
import { loadIdentities, requireIdentities } from './identity.mjs';
import { loadBotDirectory, resolveBot, targetArgs } from './target.mjs';
import { note, shortId } from './output.mjs';
import { getExecDetail } from './execs.mjs';
import { execDir, findCachedExec, loadCachedDetail, saveDetail } from './exec-store.mjs';

export const EXEC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 找到这条执行属于哪个区 / 企业 / 智能体。查详情不需要 botId（09-24 核对），所以没给 --bot 时逐个企业试
export async function locateExec(args, execId) {
  if (strArg(args, 'bot')) {
    const target = await resolveBot(targetArgs(args));
    const dir = execDir(target, execId);
    const cached = loadCachedDetail(dir);
    if (cached) return { target, dir, detail: cached };
    const detail = await getExecDetail(target.identity, target.orgId, execId, target.botId);
    if (!detail) {
      throw new MdError('exec_not_found', `${target.botName} 下找不到执行 ${execId}`, { exitCode: EXIT.TARGET, hint: '去掉 --bot，md 会在所有已取身份的企业里找' });
    }
    const owner = String(detail.canvasExec.botId ?? '');
    if (owner && owner !== target.botId) {
      throw new MdError('exec_other_bot', `执行 ${execId} 属于另一个智能体（${shortId(owner)}）`, { exitCode: EXIT.TARGET, hint: '去掉 --bot，md 会自己找到它属于哪个智能体' });
    }
    return { target, dir, detail: saveDetail(dir, target, detail), fresh: true };
  }
  const cached = findCachedExec(execId);
  if (cached) {
    const identity = loadIdentities()[cached.target.identityKey];
    if (!identity) {
      throw new MdError('no_identity', `这条执行属于「${cached.target.regionLabel}」，本机没有这个区的身份`, { exitCode: EXIT.AUTH, hint: '先取这个区的身份：md auth snippet <域名>' });
    }
    return { target: { ...cached.target, identity }, dir: cached.dir, detail: cached.detail };
  }
  for (const identity of requireIdentities()) {
    for (const org of identity.orgs) {
      let detail;
      try {
        detail = await getExecDetail(identity, org.id, execId);
      } catch (error) {
        if (error instanceof MdError && error.code === 'auth_expired') throw error;
        note(`（跳过 ${identity.label} / ${org.name}：${error.message}）`);
        continue;
      }
      if (!detail) continue;
      const botId = String(detail.canvasExec.botId ?? '');
      const entry = (await loadBotDirectory()).find((e) => e.botId === botId);
      const target = entry
        ? { ...entry, identity: loadIdentities()[entry.identityKey] ?? identity }
        : { identityKey: identity.key, regionLabel: identity.label, orgId: org.id, orgName: org.name, botId, botName: `智能体 ${shortId(botId)}`, identity };
      const dir = execDir(target, execId);
      return { target, dir, detail: saveDetail(dir, target, detail), fresh: true };
    }
  }
  throw new MdError('exec_not_found', `在已取身份的企业里都找不到执行 ${execId}`, { exitCode: EXIT.TARGET, hint: '执行 id 抄全了吗？如果是别的区的执行，先取那个区的身份' });
}
