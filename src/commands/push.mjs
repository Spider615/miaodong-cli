// 推送 = 预演（默认）+ 带计划码确认。只调 canvas/save，写的是编辑器草稿，不会上线。
// 为什么合并而不是覆盖：秒懂编辑页会自动保存、打开时还会就地改画布，拉取后草稿被改过是常态；
// 按节点三方合并只在碰到同一个节点时才停。
// 为什么要计划码：确认时草稿如果又变了，写上去的就不是预演时看到的内容；计划码把两者绑死。

import { createHash } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { boolArg, intArg } from '../args.mjs';
import { EXIT, MdError } from '../errors.mjs';
import { givenCode } from '../confirm.mjs';
import { ensureDir, writeJson } from '../home.mjs';
import { getCanvas, saveCanvas } from '../api.mjs';
import { compareNodes, contentKey, edgeMap, hashOf, nodeMap, stableStringify } from '../canvas.mjs';
import { graphProblems, runCheck } from '../check.mjs';
import { diffEnvelopes, nameMapOf, renderDiff } from '../diff.mjs';
import { businessNodes } from '../graph.mjs';
import { appendLedger } from '../ledger.mjs';
import { mergeCanvas } from '../merge.mjs';
import { loadWorkspace, saveMeta, stamp, targetFromMeta, writeIndex } from '../workspace.mjs';
import { out, shortId, targetLine } from '../output.mjs';

export const blocked = (message, hint = '') => new MdError('push_blocked', message, { exitCode: EXIT.BLOCKED, hint });

export function planCode({ botId, canvasId, live, save }) {
  return createHash('sha256').update(stableStringify({ botId, canvasId, live: hashOf(live), save: hashOf(save) })).digest('hex').slice(0, 8);
}

// 按 fieldChanges 产出的路径（a.b[0].c）取值；取不到就是 undefined
function valueAt(obj, path) {
  let current = obj;
  for (const token of path.split(/\.|\[(\d+)\]/).filter((t) => t !== undefined && t !== '')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[token];
  }
  return current;
}

// ours = diffEnvelopes(base, after)：只要求「你改过的那些字段」回读一致。
// 服务端会归一化个别字段（实测换模型时删掉 data.modelDeprecated），整节点比对会把正常推送误报成失败。
export function verifyReadback(expected, readback, canvasId, ours = null) {
  const problems = [];
  const notes = [];
  if (readback.canvasId !== canvasId) problems.push(`回读到的画布 id 变了（${shortId(readback.canvasId)}）`);
  const e = nodeMap(expected);
  const r = nodeMap(readback.rawCanvas);
  const changedFields = new Map((ours?.changed ?? []).map((c) => [c.id, c.fields]));
  const sameAt = (a, b, path) => stableStringify(valueAt(a, path) ?? null) === stableStringify(valueAt(b, path) ?? null);
  let missing = 0;
  let extra = 0;
  let oursDiffer = 0;
  let othersDiffer = 0;
  for (const [id, cell] of e) {
    const got = r.get(id);
    if (!got) missing++;
    else if (contentKey(cell) !== contentKey(got)) {
      const fields = changedFields.get(id);
      if (fields && fields.some((f) => !sameAt(cell, got, f.path))) oursDiffer++;
      else othersDiffer++;
    }
  }
  for (const id of r.keys()) if (!e.has(id)) extra++;
  const ee = edgeMap(expected);
  const re = edgeMap(readback.rawCanvas);
  let edgesDiffer = 0;
  for (const key of ee.keys()) if (!re.has(key)) edgesDiffer++;
  for (const key of re.keys()) if (!ee.has(key)) edgesDiffer++;
  if (missing) problems.push(`${missing} 个节点没写进去`);
  if (extra) problems.push(`多出 ${extra} 个节点`);
  if (oursDiffer) problems.push(`${oursDiffer} 个你改的节点内容和推送的不一样`);
  if (edgesDiffer) problems.push(`${edgesDiffer} 条连线不一致`);
  // 服务端会归一化个别字段（实测删过 data.modelDeprecated），未改动节点的差异只提示
  if (othersDiffer) notes.push(`${othersDiffer} 个节点里你没改的字段被服务端调整了（正常：服务端会归一化个别字段）`);
  return { problems, notes };
}

// 预演打印的确认命令要带上预演时用的开关，否则照抄去确认会走另一条路径
function flagsOf({ replaceDraft, ontoDraft, allowCheckErrors }) {
  const flags = [];
  if (replaceDraft) flags.push('--replace-draft');
  else if (ontoDraft) flags.push('--onto-draft');
  if (allowCheckErrors) flags.push('--allow-check-errors');
  return flags.map((flag) => ` ${flag}`).join('');
}

export const push = {
  summary: '把工作副本的改动推到草稿（默认预演；--confirm <计划码> 才写；不会上线）',
  usage: [
    'md push [--ws <工作副本>]                预演：合并方式、改动清单、计划码',
    'md push [--ws …] --confirm <计划码>      用户同意后真正写入草稿',
    '以版本为底且草稿与该版不同时，需加 --onto-draft（合进当前草稿）或 --replace-draft（草稿 = 该版 + 改动）',
    '自检有新增问题会被拦；确认可以忽略时加 --allow-check-errors',
  ].join('\n'),
  async run(args) {
    // 开关一开头就读：给错（比如给了两次）要在联网之前报出来
    const opts = { replaceDraft: boolArg(args, 'replace-draft'), ontoDraft: boolArg(args, 'onto-draft'), allowCheckErrors: boolArg(args, 'allow-check-errors') };
    const ws = loadWorkspace(args);
    const target = targetFromMeta(ws.meta);
    const { identity, orgId, botId } = target;
    if (!ws.after) throw blocked('这个工作副本还没有改动', '先 md apply <改动脚本>');
    const live = await getCanvas(identity, orgId, botId);
    if (live.canvasId !== ws.meta.mainCanvasId) {
      throw blocked(`草稿画布换了（拉取时 ${shortId(ws.meta.mainCanvasId)}，现在 ${shortId(live.canvasId)}）`, '重新 md pull，再把改动做一遍');
    }

    const check = runCheck(ws.base, ws.after);
    if (check.errors.length && !opts.allowCheckErrors) {
      throw blocked(`自检有 ${check.errors.length} 个问题，先修：\n${check.errors.map((e) => `  ❌ ${e}`).join('\n')}`, 'md check 看详情；确认可以忽略时加 --allow-check-errors');
    }

    let mode = 'merge';
    if (ws.meta.source.kind === 'version') {
      const drift = compareNodes(ws.base.canvas, live.rawCanvas);
      if (!drift.same && !opts.ontoDraft && !opts.replaceDraft) {
        throw blocked(
          `你是基于 ${ws.meta.source.version} 改的，但当前草稿和它不同（草稿多 ${drift.onlyB} 个节点、少 ${drift.onlyA} 个、${drift.changed} 个内容不同、连线差 ${drift.edgesDiffer} 条）`,
          '请用户二选一：--onto-draft（把改动合进当前草稿，保留草稿里别的修改）或 --replace-draft（草稿变成「该版本 + 你的改动」，草稿里别的修改会丢）',
        );
      }
      if (opts.replaceDraft) mode = 'replace';
    }

    let toSave;
    let theirs = null;
    if (mode === 'replace') {
      toSave = ws.after.canvas;
    } else {
      const merged = mergeCanvas(ws.base.canvas, ws.after.canvas, live.rawCanvas);
      if (merged.conflicts.length) {
        const lines = merged.conflicts.slice(0, 20).map((c) => `  - ${c.name} [${shortId(c.id)}]：${c.reason}`).join('\n');
        throw blocked(`有 ${merged.conflicts.length} 处冲突，不能自动合并：\n${lines}`, 'md rebase 在最新草稿上重跑改动脚本，再预演');
      }
      if (merged.noop) {
        out(targetLine({ ...target, versionLabel: '草稿' }));
        out('草稿里已经是这些内容了，没有需要推送的。');
        return EXIT.OK;
      }
      toSave = merged.canvas;
      theirs = merged.theirs;
    }
    if (businessNodes(toSave).length === 0) throw blocked('要推送的画布里没有任何节点，已阻止');
    // 自检比的是「基线 → 改后」；合并结果还可能因别人的并发修改出现新的断头（我引用的节点被别人删了等）
    const liveProblems = new Set(graphProblems({ canvas: live.rawCanvas, events: ws.base.events }));
    const introduced = graphProblems({ canvas: toSave, events: ws.base.events }).filter((p) => !liveProblems.has(p));
    if (introduced.length) {
      throw blocked(`推送后草稿里会新出现 ${introduced.length} 处悬空引用或连线：\n${introduced.slice(0, 20).map((p) => `  - ${p}`).join('\n')}`, 'md rebase 在最新草稿上重跑改动脚本，再预演');
    }

    const ours = diffEnvelopes(ws.base, ws.after);
    const code = planCode({ botId, canvasId: live.canvasId, live: live.rawCanvas, save: toSave });
    out(targetLine({ ...target, versionLabel: '草稿' }));
    out(`推送方式：${mode === 'replace' ? `用「${ws.meta.source.version} + 你的改动」整体替换草稿` : '把你的改动合进当前草稿（保留别人对其他节点的修改）'}`);
    if (theirs && theirs.changed + theirs.added + theirs.removed > 0) {
      out(`草稿在你拉取后被改过：改 ${theirs.changed} / 增 ${theirs.added} / 删 ${theirs.removed} 个节点，这些都会保留`);
    }
    out('你的改动：');
    for (const line of renderDiff(ours, { names: nameMapOf(ws.base.canvas, ws.after.canvas), limit: intArg(args, 'limit', 120) })) out(`  ${line}`);
    for (const error of check.errors) out(`  ❌ ${error}（已用 --allow-check-errors 放行）`);
    for (const warning of check.warnings) out(`  ⚠️ ${warning}`);

    const given = givenCode(args);
    if (given === null) {
      out('');
      out(`这是预演，什么都没写。计划码：${code}`);
      out(`用户同意后执行：md push --ws ${ws.dir}${flagsOf(opts)} --confirm ${code}`);
      return EXIT.OK;
    }
    if (given !== code) {
      throw blocked(`计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：草稿在预演之后又变了，或计划码抄错了`, '重新预演一次，把新的改动清单给用户看');
    }

    const at = stamp();
    const pushedAt = new Date().toISOString();
    const backup = join(ensureDir(join(ws.dir, 'backups')), `${at}-draft.json`);
    writeJson(backup, { canvasId: live.canvasId, updatedAt: live.updatedAt, rawCanvas: live.rawCanvas });
    await saveCanvas(identity, orgId, live.canvasId, toSave);

    // 保存成功就先留推送快照、准备账本，再回读：回读失败（网络）时这次推送也要记进账本，md log、md status --remote、md restore 才知道推了什么
    const historyDir = ensureDir(join(ws.dir, 'history', at));
    const pushed = join(historyDir, 'pushed.json');
    writeJson(pushed, { canvas: toSave });
    if (existsSync(join(ws.dir, 'transforms'))) renameSync(join(ws.dir, 'transforms'), join(historyDir, 'transforms'));
    const pick = (item) => ({ id: item.id, name: item.name ?? item.data?.name ?? '' });
    const entry = {
      at: pushedAt, kind: 'push',
      identityKey: target.identityKey, regionLabel: target.regionLabel, origin: identity.origin,
      orgId, orgName: target.orgName, botId, botName: target.botName,
      ws: ws.dir, mode, source: ws.meta.source,
      changed: ours.changed.map(pick), added: ours.added.map(pick), removed: ours.removed.map(pick),
      edgesAdded: ours.edgesAdded.length, edgesRemoved: ours.edgesRemoved.length,
      backup, pushed,
    };
    let readback;
    try {
      readback = await getCanvas(identity, orgId, botId);
    } catch (error) {
      appendLedger({ ...entry, readbackUpdatedAt: null, readbackFailed: true, problems: [`保存成功，回读失败：${error?.message ?? error}`] });
      saveMeta(ws.dir, { ...ws.meta, lastPush: { at: pushedAt, backup, pushed } });
      throw blocked(`已经保存到草稿，但回读失败：${error?.message ?? error}`, `这次推送已记进 md log。先 md status --remote 复查草稿是不是这次推的，不要直接重推；要撤回：md restore --ws ${ws.dir}`);
    }
    const { problems, notes } = verifyReadback(toSave, readback, live.canvasId, ours);
    appendLedger({ ...entry, readbackUpdatedAt: readback.updatedAt, problems });
    // 推送后工作副本跟着草稿走：以回读结果为新基线，已推的改动脚本移进 history
    const newBase = { canvas: readback.rawCanvas, sessions: ws.base.sessions, events: ws.base.events };
    writeJson(join(ws.dir, 'base.json'), newBase);
    rmSync(join(ws.dir, 'after.json'), { force: true });
    writeIndex(ws.dir, newBase);
    saveMeta(ws.dir, {
      ...ws.meta,
      source: { kind: 'draft' },
      handEdited: false,
      draft: { updatedAt: readback.updatedAt, version: readback.version, hash: hashOf(readback.rawCanvas) },
      lastPush: { at: pushedAt, backup, pushed },
    });

    if (problems.length) {
      out(`⚠️ 已保存，但回读核对有 ${problems.length} 处不一致：`);
      for (const p of problems) out(`  - ${p}`);
      out('  可能有人同时在编辑页保存。先 md status --remote 复查，必要时 md restore 回滚。');
      return EXIT.BLOCKED;
    }
    out('✅ 已推送到草稿（未发布）');
    for (const n of notes) out(`  · ${n}`);
    const touched = [...ours.changed.map(pick), ...ours.added.map(pick)];
    out(`改了 ${ours.changed.length} 个节点、新增 ${ours.added.length} 个、删除 ${ours.removed.length} 个${touched.length ? '：' : ''}`);
    for (const t of touched.slice(0, 30)) out(`  - ${t.name} [${shortId(t.id)}]`);
    if (touched.length > 30) out(`  …另有 ${touched.length - 30} 个（md log 看全部）`);
    out('在秒懂里看：刷新画布编辑页。没刷新的旧标签页会自动保存，可能把这次推送覆盖掉。');
    out(`回滚：md restore --ws ${ws.dir}`);
    out('上线需要你在秒懂里点「发布」。');
    return EXIT.OK;
  },
};
