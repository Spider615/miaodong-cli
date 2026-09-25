// 知识库命令的「区 / 企业 / 知识库」换算（spec 3a §3.1）。
// 知识库按 id 完全一致 > id 前缀（至少 4 位）> 名字完全一致 > 名字包含 的顺序找；同一档命中多个，由调用方列出候选停下。
import { EXIT, MdError } from './errors.mjs';
import { requireIdentities } from './identity.mjs';
import { listKbs } from './kb.mjs';
import { shortId } from './output.mjs';
import { filterEntries, resolveBot, targetArgs } from './target.mjs';

const norm = (v) => String(v ?? '').trim().toLowerCase();

export function matchKbs(kbs, query) {
  const q = norm(query);
  const tiers = [
    (k) => norm(k.id) === q,
    (k) => q.length >= 4 && norm(k.id).startsWith(q),
    (k) => norm(k.name) === q,
    (k) => norm(k.name).includes(q),
  ];
  for (const matches of tiers) {
    const hits = kbs.filter(matches);
    if (hits.length) return hits;
  }
  return [];
}

// 区和企业来自本机身份，不拉智能体目录；带 --bot 时跟着智能体走
export function orgEntries() {
  return requireIdentities().flatMap((identity) => identity.orgs.map((org) => ({
    identityKey: identity.key, regionLabel: identity.label, orgId: org.id, orgName: org.name, identity,
  })));
}

export async function resolveOrg(args) {
  const t = targetArgs(args);
  if (t.bot) {
    const bot = await resolveBot(t);
    return { identityKey: bot.identityKey, regionLabel: bot.regionLabel, orgId: bot.orgId, orgName: bot.orgName, identity: bot.identity, bot };
  }
  const hits = filterEntries(orgEntries(), { region: t.region, org: t.org });
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new MdError('org_not_found', '找不到这个区或企业', { exitCode: EXIT.TARGET, hint: 'md orgs 看本机身份能看到哪些企业' });
  const lines = hits.map((h) => `  - ${h.regionLabel} / ${h.orgName}`).join('\n');
  throw new MdError('org_ambiguous', `本机身份能看到 ${hits.length} 个企业，请用 --region 或 --org 指定：\n${lines}`, { exitCode: EXIT.TARGET });
}

export function pickKb(kbs, query) {
  const hits = matchKbs(kbs, query);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new MdError('kb_not_found', `找不到知识库「${query}」`, { exitCode: EXIT.TARGET, hint: 'md kb list 看这个企业有哪些知识库' });
  const lines = hits.slice(0, 20).map((k) => `  - ${k.name} (${shortId(k.id)})`).join('\n');
  throw new MdError('kb_ambiguous', `「${query}」匹配到 ${hits.length} 个知识库：\n${lines}`, { exitCode: EXIT.TARGET, hint: '用更完整的名字或 id 前缀' });
}

export async function resolveKb(org, query) {
  return pickKb(await listKbs(org.identity, org.orgId), query);
}

export function kbLine(org, kb) {
  return `${org.regionLabel} / ${org.orgName} / ${kb.name} (${shortId(kb.id)})`;
}
