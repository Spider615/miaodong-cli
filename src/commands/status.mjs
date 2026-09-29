import { join } from 'node:path';
import { boolArg, intArg, strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { readJson } from '../home.mjs';
import { getCanvas } from '../api.mjs';
import { compareNodes, contentKey, nodeMap } from '../canvas.mjs';
import { readLedger } from '../ledger.mjs';
import { listWorkspaces, targetFromMeta, wsLine } from '../workspace.mjs';
import { formatTime, out, shortId } from '../output.mjs';

const matchesBot = (item, query) => !query || item.botName.toLowerCase().includes(query.toLowerCase()) || item.botId.startsWith(query);

// 最近一次是回滚：回滚改回的节点（回滚前的草稿和回滚到的那份不一样的）还是回滚到的样子、回滚去掉的节点没再出现，就是正常
function restoreCheck(entry, live) {
  const restored = readJson(entry.backup, null)?.rawCanvas;
  const before = readJson(entry.safety, null)?.rawCanvas;
  if (!restored || !before) return `  ${entry.regionLabel} / ${entry.botName}：回滚的快照不见了（${!restored ? entry.backup : entry.safety}）`;
  const expected = nodeMap(restored);
  const prev = nodeMap(before);
  const current = nodeMap(live.rawCanvas);
  const touched = [...expected.keys()].filter((id) => !prev.has(id) || contentKey(prev.get(id)) !== contentKey(expected.get(id)));
  const lost = touched.filter((id) => !current.has(id) || contentKey(current.get(id)) !== contentKey(expected.get(id)));
  const revived = [...prev.keys()].filter((id) => !expected.has(id) && current.has(id));
  if (lost.length || revived.length) {
    return `  ⚠️ ${entry.regionLabel} / ${entry.botName}：${formatTime(entry.at)} 的回滚有 ${lost.length} 个节点又被改了、${revived.length} 个去掉的节点又回来了（多半是没刷新的编辑页自动保存）：${[...lost, ...revived].slice(0, 10).map(shortId).join('、')}`;
  }
  return `  ✅ ${entry.regionLabel} / ${entry.botName}：${formatTime(entry.at)} 回滚改回的 ${touched.length} 个节点都还在`;
}

async function remoteCheck(query) {
  // 每个智能体看最近一次推送或回滚：回滚之后还拿之前的推送去比，会把回滚当成「推送被覆盖」
  const latest = new Map();
  for (const entry of readLedger()) if ((entry.kind === 'push' || entry.kind === 'restore') && matchesBot(entry, query)) latest.set(entry.botId, entry);
  out('');
  if (latest.size === 0) {
    out('（账本里没有推送记录，无从核对）');
    return;
  }
  out('核对最近一次推送（或回滚）是否还在草稿里：');
  for (const entry of latest.values()) {
    const target = targetFromMeta(entry);
    const live = await getCanvas(target.identity, entry.orgId, entry.botId);
    if (entry.kind === 'restore') {
      out(restoreCheck(entry, live));
      continue;
    }
    const pushed = readJson(entry.pushed, null);
    if (!pushed) {
      out(`  ${entry.regionLabel} / ${entry.botName}：推送快照不见了（${entry.pushed}）`);
      continue;
    }
    const expected = nodeMap(pushed.canvas);
    const current = nodeMap(live.rawCanvas);
    const ids = [...entry.changed, ...entry.added].map((c) => c.id);
    const lost = ids.filter((id) => !current.has(id) || contentKey(current.get(id)) !== contentKey(expected.get(id)));
    const revived = entry.removed.map((c) => c.id).filter((id) => current.has(id));
    if (lost.length || revived.length) {
      out(`  ⚠️ ${entry.regionLabel} / ${entry.botName}：${formatTime(entry.at)} 的推送有 ${lost.length} 个节点被覆盖、${revived.length} 个删掉的节点又回来了（多半是没刷新的编辑页自动保存）：${lost.slice(0, 10).map(shortId).join('、')}`);
    } else {
      out(`  ✅ ${entry.regionLabel} / ${entry.botName}：${formatTime(entry.at)} 推送的 ${ids.length} 个节点都还在`);
    }
  }
}

export const status = {
  summary: '本机工作副本：哪个智能体、有没有未推送改动、最后推送；--remote 核对推送是否还在',
  usage: 'md status [--bot <名字或 id 前缀>] [--limit 10] [--remote]',
  async run(args) {
    const query = strArg(args, 'bot');
    const list = listWorkspaces().filter((w) => matchesBot(w.meta, query)).slice(0, intArg(args, 'limit', 10));
    if (list.length === 0) out('没有工作副本。');
    for (const w of list) {
      let pending = '无未推送改动';
      if (w.hasAfter) {
        const d = compareNodes(readJson(join(w.dir, 'base.json')).canvas, readJson(join(w.dir, 'after.json')).canvas);
        pending = `未推送改动：改 ${d.changed} / 增 ${d.onlyB} / 删 ${d.onlyA} 个节点`;
      }
      out(wsLine({ meta: w.meta, after: w.hasAfter }));
      out(`  ${w.dir}`);
      out(`  拉取 ${formatTime(w.meta.pulledAt)} · ${pending} · 最后推送 ${w.meta.lastPush ? formatTime(w.meta.lastPush.at) : '无'}`);
    }
    if (boolArg(args, 'remote')) await remoteCheck(query);
    return EXIT.OK;
  },
};

export const log = {
  summary: '推送 / 回滚记录（改了哪些节点）',
  usage: 'md log [--bot <名字或 id 前缀>] [--limit 20]',
  async run(args) {
    const query = strArg(args, 'bot');
    const entries = readLedger().filter((e) => matchesBot(e, query)).reverse().slice(0, intArg(args, 'limit', 20));
    if (entries.length === 0) {
      out('还没有推送记录。');
      return EXIT.OK;
    }
    for (const e of entries) {
      const counts = e.kind === 'push' ? ` · 改 ${e.changed.length} 增 ${e.added.length} 删 ${e.removed.length} · 连线 +${e.edgesAdded} -${e.edgesRemoved}` : '';
      out(`${formatTime(e.at)} ${e.kind === 'restore' ? '回滚' : '推送'} ${e.regionLabel} / ${e.botName} (${shortId(e.botId)})${counts}${e.readbackFailed ? ' · ⚠️ 回读失败' : e.problems?.length ? ' · ⚠️ 回读不一致' : ''}`);
      if (e.kind !== 'push') continue;
      const rows = [...e.changed.map((c) => ['~', c]), ...e.added.map((c) => ['+', c]), ...e.removed.map((c) => ['-', c])];
      for (const [mark, c] of rows.slice(0, 30)) out(`    ${mark} ${c.name} [${shortId(c.id)}]`);
      if (rows.length > 30) out(`    …另有 ${rows.length - 30} 个`);
    }
    return EXIT.OK;
  },
};
