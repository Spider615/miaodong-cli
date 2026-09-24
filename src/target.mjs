// 把用户说的名字换算成确定的「区 / 企业 / 智能体」。
// 规则写死：id 完全一致 > id 前缀（至少 6 位）> 名字完全一致 > 名字包含。
// 同一档命中多个就列候选停下，绝不自己挑：克隆出来的同名测试机器人很常见，挑错就是推错智能体。

import { join } from 'node:path';
import { boolArg, strArg } from './args.mjs';
import { EXIT, MdError, usage } from './errors.mjs';
import { mdHome, readJson, writeJson } from './home.mjs';
import { loadIdentities, requireIdentities } from './identity.mjs';
import { listBots } from './api.mjs';
import { note, shortId } from './output.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000;
const norm = (value) => String(value ?? '').trim().toLowerCase();

function cachePath() {
  return join(mdHome(), 'cache', 'bots.json');
}

export async function loadBotDirectory({ refresh = false } = {}) {
  const identities = requireIdentities();
  // 身份变了（重新取过、增删了区）缓存就作废
  const keys = identities.map((identity) => `${identity.key}@${identity.savedAt}`).sort().join('|');
  const cache = readJson(cachePath(), null);
  if (!refresh && cache && cache.keys === keys && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.entries;
  const entries = [];
  let skipped = 0;
  for (const identity of identities) {
    for (const org of identity.orgs) {
      let bots;
      try {
        bots = await listBots(identity, org.id);
      } catch (error) {
        if (error instanceof MdError && error.code === 'auth_expired') throw error;
        note(`（跳过 ${identity.label} / ${org.name}：${error.message}）`);
        skipped++;
        continue;
      }
      for (const bot of bots) {
        entries.push({
          identityKey: identity.key, regionLabel: identity.label, orgId: org.id, orgName: org.name,
          botId: bot.id, botName: bot.name, enabled: bot.enabled,
        });
      }
    }
  }
  // 有企业没读到时目录不完整，缓存下来会让之后的同名歧义判断漏掉候选
  if (skipped === 0) writeJson(cachePath(), { keys, fetchedAt: Date.now(), entries });
  else note('（这次的智能体目录不完整，不写缓存）');
  return entries;
}

export function pickOne(entries, query, idOf, nameOf) {
  const q = norm(query);
  const tiers = [
    (e) => norm(idOf(e)) === q,
    (e) => q.length >= 6 && norm(idOf(e)).startsWith(q),
    (e) => norm(nameOf(e)) === q,
    (e) => norm(nameOf(e)).includes(q),
  ];
  for (const matches of tiers) {
    const hits = entries.filter(matches);
    if (hits.length) return hits;
  }
  return [];
}

export function filterEntries(entries, { region, org } = {}) {
  let list = entries;
  if (region) {
    const q = norm(region);
    list = list.filter((e) => norm(e.identityKey) === q || norm(e.regionLabel).includes(q));
  }
  if (org) {
    const orgs = [...new Map(list.map((e) => [e.orgId, { orgId: e.orgId, orgName: e.orgName }])).values()];
    const ids = new Set(pickOne(orgs, org, (o) => o.orgId, (o) => o.orgName).map((o) => o.orgId));
    list = list.filter((e) => ids.has(e.orgId));
  }
  return list;
}

export function describeEntry(entry) {
  return `${entry.regionLabel} / ${entry.orgName} / ${entry.botName} (${shortId(entry.botId)})`;
}

export function targetArgs(args) {
  return { bot: strArg(args, 'bot'), org: strArg(args, 'org'), region: strArg(args, 'region'), refresh: boolArg(args, 'refresh') };
}

export async function resolveBot({ bot, org, region, refresh = false }) {
  if (!bot) throw usage('缺 --bot <智能体名字或 id>', '不确定名字时先 md bots <关键词>');
  const attempt = async (fresh) =>
    pickOne(filterEntries(await loadBotDirectory({ refresh: fresh }), { region, org }), bot, (e) => e.botId, (e) => e.botName);
  let hits = await attempt(refresh);
  // 缓存里没有时强制刷新一次：可能是刚新建的智能体
  if (hits.length === 0 && !refresh) hits = await attempt(true);
  if (hits.length === 1) return { ...hits[0], identity: loadIdentities()[hits[0].identityKey] };
  if (hits.length === 0) {
    throw new MdError('target_not_found', `找不到智能体「${bot}」`, {
      exitCode: EXIT.TARGET,
      hint: '用 md bots <关键词> 看看有哪些；不同区要先分别取身份',
    });
  }
  const lines = hits.slice(0, 20).map((e) => `  - ${describeEntry(e)}`).join('\n');
  throw new MdError('target_ambiguous', `「${bot}」匹配到 ${hits.length} 个智能体，请用更精确的名字或 id：\n${lines}`, {
    exitCode: EXIT.TARGET,
    hint: '也可以加 --org <企业> 或 --region <区> 缩小范围',
  });
}

export function resolveVersion(versions, query) {
  const q = norm(query).replace(/^v/, '');
  const byVersion = versions.filter((v) => norm(v.version).replace(/^v/, '') === q);
  const hits = byVersion.length ? byVersion : versions.filter((v) => norm(v.name) === norm(query));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    throw new MdError('version_not_found', `没有版本「${query}」`, { exitCode: EXIT.TARGET, hint: '用 md versions --bot <智能体> 看版本列表' });
  }
  throw new MdError('version_ambiguous', `「${query}」匹配到 ${hits.length} 个版本：${hits.map((v) => `${v.version}（${v.name}）`).join('、')}`, {
    exitCode: EXIT.TARGET,
  });
}
