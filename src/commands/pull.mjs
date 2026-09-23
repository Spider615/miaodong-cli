import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { getCanvas, listEvents, listSessions, listVersions } from '../api.mjs';
import { compareNodes, hashOf } from '../canvas.mjs';
import { buildIndex } from '../graph.mjs';
import { resolveBot, resolveVersion, targetArgs } from '../target.mjs';
import { createWorkspace, versionLabelOf, writeWorkspace } from '../workspace.mjs';
import { out, targetLine } from '../output.mjs';

export const pull = {
  summary: '把草稿或指定版本拉到新的工作副本（连同会话变量和事件）',
  usage: 'md pull --bot <智能体> [--org <企业>] [--region <区>] [--version <版本号或名称>]',
  async run(args) {
    const target = await resolveBot(targetArgs(args));
    const { identity, orgId, botId } = target;
    const draft = await getCanvas(identity, orgId, botId);
    let canvas = draft.rawCanvas;
    let source = { kind: 'draft' };
    const versionQuery = strArg(args, 'version');
    if (versionQuery) {
      const version = resolveVersion(await listVersions(identity, orgId, draft.canvasId), versionQuery);
      canvas = (await getCanvas(identity, orgId, botId, version.canvasId)).rawCanvas;
      source = { kind: 'version', version: version.version, name: version.name, canvasId: version.canvasId };
    }
    const [sessions, events] = await Promise.all([listSessions(identity, orgId, botId), listEvents(identity, orgId, botId)]);
    const notes = [];
    if (sessions === null) notes.push('读不到会话变量列表（这个区的接口不支持），自检会少会话类检查');
    if (events === null) notes.push('读不到事件列表（这个区的接口不支持），事件名显示不出来');
    const base = { canvas, sessions: sessions ?? [], events: events ?? [] };
    const meta = {
      schema: 1,
      identityKey: target.identityKey, regionLabel: target.regionLabel, origin: identity.origin,
      orgId, orgName: target.orgName, botId, botName: target.botName,
      mainCanvasId: draft.canvasId,
      source,
      draft: { updatedAt: draft.updatedAt, version: draft.version, hash: hashOf(draft.rawCanvas) },
      pulledAt: new Date().toISOString(),
      notes,
    };
    const dir = createWorkspace(target, source.kind === 'version' ? source.version : 'draft');
    writeWorkspace(dir, { meta, base, draft: source.kind === 'version' ? { canvas: draft.rawCanvas } : null });

    const index = buildIndex(base.canvas, base.events);
    const wires = index.edges.filter((e) => e.kind === 'wire').length;
    const types = new Map();
    for (const n of index.nodes) types.set(n.type, (types.get(n.type) ?? 0) + 1);
    out(targetLine({ ...target, versionLabel: versionLabelOf(meta) }));
    out(`工作副本：${dir}`);
    out(`节点 ${index.nodes.length} · 连线 ${wires} · 事件跳转 ${index.edges.length - wires} · 节点引用 ${index.refs.length} · 会话变量 ${base.sessions.length} · 事件 ${base.events.length}`);
    out(`节点类型：${[...types].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([type, n]) => `${type} ${n}`).join('、')}`);
    if (source.kind === 'version') {
      const d = compareNodes(canvas, draft.rawCanvas);
      out(d.same
        ? `草稿与 ${source.version} 内容一致。`
        : `⚠️ 草稿与 ${source.version} 不同：草稿多 ${d.onlyB} 个节点、少 ${d.onlyA} 个节点、${d.changed} 个节点内容不同、连线差 ${d.edgesDiffer} 条。推送时要选 --onto-draft 或 --replace-draft。`);
    }
    for (const n of notes) out(`（${n}）`);
    out(`查询：jq 查 ${dir}/index/{nodes,edges,refs}.jsonl；看细节用 md node / md trace / md refs`);
    return EXIT.OK;
  },
};
