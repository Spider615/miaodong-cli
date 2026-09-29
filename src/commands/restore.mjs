import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { givenCode } from '../confirm.mjs';
import { ensureDir, readJson, writeJson } from '../home.mjs';
import { getCanvas, saveCanvas } from '../api.mjs';
import { compareNodes, hashOf } from '../canvas.mjs';
import { businessNodes } from '../graph.mjs';
import { appendLedger } from '../ledger.mjs';
import { loadWorkspace, saveMeta, stamp, targetFromMeta, writeIndex } from '../workspace.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { blocked, planCode, verifyReadback } from './push.mjs';

function latestBackup(dir) {
  const backupsDir = join(dir, 'backups');
  const files = existsSync(backupsDir) ? readdirSync(backupsDir).filter((name) => name.endsWith('-draft.json')).sort() : [];
  if (files.length === 0) throw blocked('这个工作副本还没有推送过，没有备份', '用 --backup <文件> 指定');
  return join(backupsDir, files.at(-1));
}

export const restore = {
  summary: '用推送前的备份回滚草稿（默认预演，--confirm <计划码> 才写）',
  usage: 'md restore [--ws <工作副本>] [--backup <备份文件>] [--confirm <计划码>]',
  async run(args) {
    const ws = loadWorkspace(args);
    const target = targetFromMeta(ws.meta);
    const { identity, orgId, botId } = target;
    const backupArg = strArg(args, 'backup');
    const backupFile = backupArg ? resolve(backupArg) : latestBackup(ws.dir);
    const backup = readJson(backupFile, null);
    if (!backup || !Array.isArray(backup.rawCanvas) || businessNodes(backup.rawCanvas).length === 0) throw blocked(`备份不可用：${backupFile}`);
    const live = await getCanvas(identity, orgId, botId);
    if (backup.canvasId && backup.canvasId !== live.canvasId) {
      throw blocked(`备份属于另一张画布（${shortId(backup.canvasId)}），当前草稿是 ${shortId(live.canvasId)}`);
    }
    out(targetLine({ ...target, versionLabel: '草稿' }));
    out(`回滚到：${backupFile}`);
    const d = compareNodes(live.rawCanvas, backup.rawCanvas);
    if (d.same) {
      out('当前草稿和备份一样，不需要回滚。');
      return EXIT.OK;
    }
    out(`回滚会让草稿：恢复 ${d.onlyB} 个节点、去掉 ${d.onlyA} 个、改回 ${d.changed} 个、连线变化 ${d.edgesDiffer} 条（备份之后别人做的修改也会一起丢掉）`);
    const code = planCode({ botId, canvasId: live.canvasId, live: live.rawCanvas, save: backup.rawCanvas });
    const given = givenCode(args);
    if (given === null) {
      out('');
      out(`这是预演，什么都没写。计划码：${code}`);
      out(`用户同意后执行：md restore --ws ${ws.dir} --backup ${backupFile} --confirm ${code}`);
      return EXIT.OK;
    }
    if (given !== code) throw blocked(`计划码对不上（当前是 ${code}）：草稿在预演之后又变了`, '重新预演一次');

    const safety = join(ensureDir(join(ws.dir, 'backups')), `${stamp()}-before-restore.json`);
    writeJson(safety, { canvasId: live.canvasId, updatedAt: live.updatedAt, rawCanvas: live.rawCanvas });
    await saveCanvas(identity, orgId, live.canvasId, backup.rawCanvas);
    const readback = await getCanvas(identity, orgId, botId);
    const { problems } = verifyReadback(backup.rawCanvas, readback, live.canvasId);
    appendLedger({
      at: new Date().toISOString(), kind: 'restore',
      identityKey: target.identityKey, regionLabel: target.regionLabel, origin: identity.origin,
      orgId, orgName: target.orgName, botId, botName: target.botName,
      ws: ws.dir, backup: backupFile, safety, problems,
    });
    const newBase = { canvas: readback.rawCanvas, sessions: ws.base.sessions, events: ws.base.events };
    writeJson(join(ws.dir, 'base.json'), newBase);
    writeIndex(ws.dir, ws.after ?? newBase);
    saveMeta(ws.dir, { ...ws.meta, source: { kind: 'draft' }, draft: { updatedAt: readback.updatedAt, version: readback.version, hash: hashOf(readback.rawCanvas) } });
    if (problems.length) {
      out(`⚠️ 已保存，但回读核对有 ${problems.length} 处不一致：`);
      for (const p of problems) out(`  - ${p}`);
      return EXIT.BLOCKED;
    }
    out('✅ 已回滚草稿（未发布）。刷新画布编辑页查看；回滚前的草稿另存在：');
    out(`  ${safety}`);
    if (ws.after) out('注意：工作副本里还有未推送的改动，它们是基于旧基线做的，建议 md apply --reset 或 md rebase。');
    return EXIT.OK;
  },
};
