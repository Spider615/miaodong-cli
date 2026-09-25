// md kb list（spec 3a §3.2）：企业的全部知识库；--bot 时列出这个智能体怎么用知识库：
// 大模型节点挂了哪些库（门槛和条数由模型每次调用时自己定，不列）、知识库查询节点的配置、各库 FAQ 未审核数、已经被删的库。
import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { getCanvas, listVersions } from '../api.mjs';
import { faqMetrics, listKbs } from '../kb.mjs';
import { kbRefs } from '../kb-refs.mjs';
import { resolveOrg } from '../kb-target.mjs';
import { resolveVersion } from '../target.mjs';
import { out, shortId, targetLine } from '../output.mjs';

const counts = (k) => `FAQ ${k.faqCount} · 文件 ${k.fileCount} · 网页 ${k.webCount} · 视频 ${k.videoCount}`;

export async function list(args) {
  const org = await resolveOrg(args);
  const kbs = await listKbs(org.identity, org.orgId);
  if (!org.bot) {
    out(`${org.regionLabel} / ${org.orgName}`);
    out(`共 ${kbs.length} 个知识库`);
    for (const k of kbs) out(`  ${k.name} (${shortId(k.id)})  ${counts(k)}${k.model ? ` · ${k.model}` : ''}`);
    return EXIT.OK;
  }
  const { bot } = org;
  let canvas = await getCanvas(bot.identity, bot.orgId, bot.botId);
  let versionLabel = '草稿';
  const versionQuery = strArg(args, 'version');
  if (versionQuery) {
    const version = resolveVersion(await listVersions(bot.identity, bot.orgId, canvas.canvasId), versionQuery);
    canvas = await getCanvas(bot.identity, bot.orgId, bot.botId, version.canvasId);
    versionLabel = version.version;
  }
  const byId = new Map(kbs.map((k) => [k.id, k]));
  const nameOf = (id) => byId.get(id)?.name ?? `❌ 已不存在（${shortId(id)}）`;
  const refs = kbRefs(canvas.rawCanvas);
  const tools = refs.filter((r) => r.kind === 'tool');
  const nodes = refs.filter((r) => r.kind === 'node');
  out(targetLine({ ...bot, versionLabel }));
  out(`大模型节点挂的知识库工具（${tools.length} 个节点；门槛和条数由模型每次调用时定）：`);
  for (const r of tools) out(`  ${r.nodeName} [${shortId(r.nodeId)}]：${r.kbIds.map(nameOf).join('、')}`);
  out(`知识库查询节点（${nodes.length} 个）：`);
  for (const r of nodes) out(`  ${r.nodeName} [${shortId(r.nodeId)}]：${r.kbIds.map(nameOf).join('、')} · 召回 ${r.resultCount ?? '?'} 条 · 门槛 ${r.threshold ?? '?'} · 重排 ${r.rerank}`);
  const used = [...new Set(refs.flatMap((r) => r.kbIds))];
  out(`引用的知识库（${used.length} 个）：`);
  for (const id of used) {
    const k = byId.get(id);
    if (!k) {
      out(`  ❌ ${shortId(id)}：企业里没有这个库（被删了？），引用它的节点永远召回不到`);
      continue;
    }
    const m = k.faqCount ? await faqMetrics(org.identity, org.orgId, id) : null;
    out(`  ${k.name} (${shortId(k.id)})  ${counts(k)}${m?.unreviewed ? ` · ⚠️ 未审核 ${m.unreviewed} 条：这些 FAQ 检索不到` : ''}`);
  }
  return EXIT.OK;
}
