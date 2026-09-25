// 知识库命令的「区 / 企业 / 知识库」换算（spec 3a §3.1）。
// 知识库按 id 完全一致 > id 前缀（至少 4 位）> 名字完全一致 > 名字包含 的顺序找；同一档命中多个，由调用方列出候选停下。
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
