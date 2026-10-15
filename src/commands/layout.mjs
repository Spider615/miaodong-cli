import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { strArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { layoutChanges } from '../layout-only.mjs';
import { optimizeLayout } from '../layout.mjs';
import { renderLayoutPreview } from '../layout-preview.mjs';
import { loadWorkspace, saveAfter, saveMeta, wsLine } from '../workspace.mjs';
import { out } from '../output.mjs';

export const layout = {
  summary: '按连线、分支和事件 ID 优化布局，生成本地 SVG/HTML 预览（不写秒懂）',
  usage: [
    'md layout [--ws <工作副本>] [--out <新目录>]',
    '先 md pull --bot <智能体>；layout 在本地暂存坐标，生成候选快照、SVG 图片、HTML 预览和检查报告。',
    '默认输出到工作副本中的新 layout-* 目录；--out 也必须是尚不存在的新目录。',
    '确认预览后 md check，再 md push --layout-only 预演；用户同意计划码后才保存草稿。',
    '不调用模型或插件。共用事件入口兼顾多个上游；反馈允许回跳，面积不保证缩小。',
  ].join('\n'),
  async run(args) {
    if (args.bot !== undefined || args._.length)
      throw usage(
        'md layout 使用已拉取的工作副本：先 md pull --bot <智能体>，再 md layout --ws <工作副本>',
      );
    const given = strArg(args, 'out'),
      destination = given ? resolve(given) : null;
    if (destination && existsSync(destination))
      throw usage(`布局输出目录已存在，不能覆盖：${destination}`);
    const ws = loadWorkspace(args);
    if (ws.meta.source.kind !== 'draft')
      throw usage('布局必须基于当前草稿，请先 md pull --bot <智能体>');
    layoutChanges(ws.base.canvas, ws.current.canvas);
    out(wsLine(ws));
    out('正在按连线、分支及事件 ID 计算本地布局…');
    const result = await optimizeLayout(ws.current),
      preview = renderLayoutPreview(
        ws.current,
        result.envelope,
        result.report,
        `${ws.meta.botName} · 事件关联布局`,
      );
    const dir = destination ?? mkdtempSync(join(ws.dir, 'layout-'));
    if (destination) {
      mkdirSync(dirname(dir), { recursive: true });
      try {
        mkdirSync(dir);
      } catch (error) {
        if (error.code === 'EEXIST')
          throw usage(`布局输出目录已存在，不能覆盖：${dir}`);
        throw error;
      }
    }
    for (const [file, value] of [
      ['candidate.json', JSON.stringify(result.envelope)],
      ['report.json', JSON.stringify(result.report, null, 2)],
      ['before.svg', preview.beforeSvg],
      ['optimized.svg', preview.svg],
      ['preview.html', preview.html],
    ])
      writeFileSync(join(dir, file), value);
    saveAfter(ws.dir, result.envelope);
    saveMeta(ws.dir, {
      ...ws.meta,
      handEdited: true,
      layout: {
        report: join(dir, 'report.json'),
        inputHash: result.report.inputHash,
        outputHash: result.report.outputHash,
      },
    });
    const r = result.report;
    out(
      `本地布局已暂存：移动 ${r.changes.nodes.length} 个元素，清理 ${r.changes.edges.length} 条旧拐点；业务配置变化 0`,
    );
    out(
      `节点重叠 ${r.before.overlapPairs} → ${r.after.overlapPairs}；实线穿过节点（近似）${r.before.edgeNodeIntersections} → ${r.after.edgeNodeIntersections}`,
    );
    out(
      `跨链路事件 ${r.eventDistances.after.links} 条，平均距离 ${r.eventDistances.before.mean} → ${r.eventDistances.after.mean}；画布面积 ${r.before.area} → ${r.after.area}`,
    );
    if (r.unmatchedEventActions.length)
      out(
        `提示：${r.unmatchedEventActions.length} 个事件动作在当前画布没有匹配入口，未补节点。`,
      );
    if (r.containerUnits)
      out(`容器整体移动 ${r.containerUnits} 组，内部相对位置保留。`);
    out(`预览：${join(dir, 'preview.html')}`);
    out(`图片：${join(dir, 'optimized.svg')}`);
    out(`报告：${join(dir, 'report.json')}`);
    out(
      `尚未写入秒懂。检查预览后：md check --ws ${ws.dir}；md push --layout-only --ws ${ws.dir}（默认预演，用户同意后带计划码保存）`,
    );
    return EXIT.OK;
  },
};
