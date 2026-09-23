import { intArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { describeNode } from '../../lib/summarize.mjs';
import { buildIndex, nodeName, refsTo, resolveNode, traceLines } from '../graph.mjs';
import { loadWorkspace, wsLine } from '../workspace.mjs';
import { out, shortId } from '../output.mjs';

function envelopeOf(ws, args) {
  return args.base ? ws.base : ws.current;
}

function scopeNote(ws, args) {
  if (args.base) return '（看的是拉取时的基线）';
  return ws.after ? '（看的是改后的状态，加 --base 看基线）' : '';
}

export const node = {
  summary: '看一个节点的完整配置（含 prompt 全文）',
  usage: 'md node <节点 id / id 前缀 / 唯一名字> [--ws <工作副本>] [--base]',
  async run(args) {
    const ws = loadWorkspace(args);
    const envelope = envelopeOf(ws, args);
    const target = resolveNode(envelope.canvas, args._[0]);
    const index = buildIndex(envelope.canvas, envelope.events);
    const info = index.nodes.find((n) => n.id === target.id);
    out(`${wsLine(ws)}${scopeNote(ws, args)}`);
    out(describeNode(envelope.canvas, target.id));
    out('');
    out(`上游 ${info.in} 条 · 下游 ${info.out} 条 · 被 ${refsTo(index, target.id).length} 处引用（md refs ${shortId(target.id)}）`);
    return EXIT.OK;
  },
};

export const trace = {
  summary: '沿连线和事件跳转看上下游',
  usage: 'md trace <节点> [--up] [--depth 6] [--ws <工作副本>] [--base]',
  async run(args) {
    const ws = loadWorkspace(args);
    const envelope = envelopeOf(ws, args);
    const start = resolveNode(envelope.canvas, args._[0]);
    out(`${wsLine(ws)}${scopeNote(ws, args)}`);
    const lines = traceLines(buildIndex(envelope.canvas, envelope.events), start.id, {
      direction: args.up ? 'up' : 'down',
      depth: intArg(args, 'depth', 6),
    });
    for (const line of lines) out(line);
    return EXIT.OK;
  },
};

export const refs = {
  summary: '谁引用了这个节点（全图扫描，给出字段路径）',
  usage: 'md refs <节点> [--ws <工作副本>] [--base]',
  async run(args) {
    const ws = loadWorkspace(args);
    const envelope = envelopeOf(ws, args);
    const target = resolveNode(envelope.canvas, args._[0]);
    const index = buildIndex(envelope.canvas, envelope.events);
    const names = new Map(index.nodes.map((n) => [n.id, n.name]));
    const hits = refsTo(index, target.id);
    out(`${wsLine(ws)}${scopeNote(ws, args)}`);
    out(`${nodeName(target)} [${shortId(target.id)}] 被引用 ${hits.length} 处：`);
    for (const r of hits) out(`  - ${names.get(r.from) ?? '(未知)'} [${shortId(r.from)}] ${r.path}${r.dataPath ? ` ← ${r.dataPath}` : ''}`);
    return EXIT.OK;
  },
};
