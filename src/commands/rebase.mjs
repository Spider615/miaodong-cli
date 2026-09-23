import { basename, join } from 'node:path';
import { EXIT, MdError } from '../errors.mjs';
import { writeJson } from '../home.mjs';
import { getCanvas, listEvents, listSessions } from '../api.mjs';
import { compareNodes, hashOf } from '../canvas.mjs';
import { runTransform } from '../transform.mjs';
import { listTransforms, loadWorkspace, saveAfter, saveMeta, targetFromMeta } from '../workspace.mjs';
import { out, targetLine } from '../output.mjs';

export const rebase = {
  summary: '在最新草稿上按顺序重跑改动脚本（草稿被改过、推送有冲突时用）',
  usage: 'md rebase [--ws <工作副本>]',
  async run(args) {
    const ws = loadWorkspace(args);
    const target = targetFromMeta(ws.meta);
    if (ws.meta.handEdited) {
      throw new MdError('cannot_rebase', '这个工作副本有整份手改（md apply --json），没法自动重放', { exitCode: EXIT.BLOCKED, hint: '重新 md pull，再把改动做一遍' });
    }
    const transforms = listTransforms(ws.dir);
    if (transforms.length === 0) {
      throw new MdError('cannot_rebase', '没有可重放的改动脚本', { exitCode: EXIT.BLOCKED, hint: '先 md apply <改动脚本>' });
    }
    const { identity, orgId, botId } = target;
    const live = await getCanvas(identity, orgId, botId);
    const [sessions, events] = await Promise.all([listSessions(identity, orgId, botId), listEvents(identity, orgId, botId)]);
    const base = { canvas: live.rawCanvas, sessions: sessions ?? ws.base.sessions, events: events ?? ws.base.events };
    let envelope = base;
    const log = [];
    for (const file of transforms) {
      try {
        const result = await runTransform(file, envelope);
        envelope = result.envelope;
        log.push(...result.log);
      } catch (error) {
        throw new MdError('rebase_failed', `在最新草稿上重跑 ${basename(file)} 失败：${error.message}`, {
          exitCode: EXIT.BLOCKED,
          hint: '锚点或节点在新草稿里变了：改好脚本后 md apply --reset，再逐个 md apply',
        });
      }
    }
    writeJson(join(ws.dir, 'base.json'), base);
    saveAfter(ws.dir, envelope);
    saveMeta(ws.dir, {
      ...ws.meta,
      mainCanvasId: live.canvasId,
      source: { kind: 'draft' },
      draft: { updatedAt: live.updatedAt, version: live.version, hash: hashOf(live.rawCanvas) },
    });
    const d = compareNodes(base.canvas, envelope.canvas);
    out(targetLine({ ...target, versionLabel: '草稿' }));
    if (ws.meta.source.kind === 'version') out(`（原来基于 ${ws.meta.source.version}，现在改为基于当前草稿）`);
    out(`已在最新草稿上重跑 ${transforms.length} 个改动脚本：`);
    for (const line of log) out(`  · ${line}`);
    out(`相对最新草稿：新增 ${d.onlyB} 个节点、删除 ${d.onlyA} 个、改了 ${d.changed} 个、连线变化 ${d.edgesDiffer} 条`);
    out('下一步：md diff / md check / md push');
    return EXIT.OK;
  },
};
