// md test results <任务> [<任务2> …] [--out <文件.xlsx|.csv|.jsonl>] [--deep] [--limit 10]（spec §6.6）
// stdout 只出汇总和前几条没通过的；逐条明细总是存一份 JSONL 到本机（给 jq）；--out 按扩展名出报告。

import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { boolArg, intArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { DATA_NOTE, note, out, shortId, targetLine } from '../output.mjs';
import { actionTexts, clip, formatCost, getExecDetail } from '../execs.mjs';
import { stamp } from '../workspace.mjs';
import { taskDetail, taskItems } from '../testcenter.mjs';
import { ROW_HEAD, alignTasks, alignedTable, itemRow, rowCells, taskSummary, toCsv } from '../testresults.mjs';
import { writeXlsx } from '../xlsx.mjs';
import { readSources, testTarget, testsDir } from '../test-common.mjs';
import { resolveTask } from './test-run.mjs';

const FORMATS = new Set(['.xlsx', '.csv', '.jsonl']);

// --deep：测试项里拿不到回复（回复在下游事件链里）时，按测试执行 id 取详情，从发出的动作里取回复
// 某一条取不到（网络抖动、详情过期）就标出来接着取别的，不让前面花的时间白费（审查 M7）；身份失效照常报
async function deepen(t, rows) {
  const need = rows.filter((r) => !r.reply && r.testExecId);
  if (!need.length) return;
  note(`（--deep：${need.length} 条要取执行详情，每条约 2 秒）`);
  let failed = 0;
  for (const r of need) {
    try {
      const detail = await getExecDetail(t.identity, t.orgId, r.testExecId, t.botId);
      const texts = actionTexts(detail?.canvasExec?.outputActions);
      const pick = (kinds) => texts.filter((a) => kinds.includes(a.kind)).map((a) => a.text).join('；');
      r.reply = pick(['reply', 'handover']) || pick(['event']);
    } catch (error) {
      if (error instanceof MdError && error.code === 'auth_expired') throw error;
      failed++;
      r.reply = `（取详情失败：${clip(error?.message ?? error, 80)}）`;
    }
  }
  if (failed) note(`（--deep：${failed} 条取详情失败，已在「实际回复」里标出）`);
}

const jsonlOf = (tasks) => `${tasks.flatMap(({ summary, rows }) => rows.map((r) => JSON.stringify({ task: summary.id, taskName: summary.name, ...r }))).join('\n')}\n`;

function writeReport(file, tasks) {
  const ext = extname(file).toLowerCase();
  if (ext === '.jsonl') {
    writeFileSync(file, jsonlOf(tasks));
    return;
  }
  const single = tasks.length === 1 ? tasks[0].rows : null;
  const table = single ? { head: ROW_HEAD, rows: single.map(rowCells) } : alignedTable(tasks, alignTasks(tasks));
  if (ext === '.csv') {
    writeFileSync(file, toCsv(table.head, table.rows));
    return;
  }
  const summaryRows = tasks.map(({ summary: s }) => [s.name, s.id, s.status, s.version, s.runs, s.passed, s.rate === null ? '' : Math.round(s.rate * 1000) / 10, s.noop, Math.round(s.cost * 10000) / 10000, s.durationMs ? Math.round(s.durationMs / 1000) : '']);
  writeXlsx(file, [
    { name: '汇总', head: ['任务', '任务ID', '状态', '版本', '次数', '通过', '通过率%', '空跑', '花费', '耗时秒'], rows: summaryRows },
    { name: '逐条', head: table.head, rows: table.rows, rowStyle: (i) => (!single || single[i].notRun ? 'plain' : single[i].passed ? 'pass' : 'fail') },
  ]);
}

export async function results(args) {
  const outFile = strArg(args, 'out');
  if (outFile && !FORMATS.has(extname(outFile).toLowerCase())) throw usage(`--out 只支持 .xlsx / .csv / .jsonl，收到「${outFile}」`);
  if (!args._.length) throw usage('缺任务：md test results <任务> [<任务2> …] --bot <智能体>');
  const t = await testTarget(args);
  const deep = boolArg(args, 'deep');
  const limit = intArg(args, 'limit', 10, 200);
  const tasks = [];
  for (const query of args._) {
    const task = await resolveTask(t, query);
    const detail = await taskDetail(t, task.testTaskId);
    const sources = readSources(t, detail?.testSetId ?? task.testSetId);
    const rows = (await taskItems(t, task.testTaskId)).map((item) => itemRow(item, sources));
    if (deep) await deepen(t, rows);
    tasks.push({ summary: taskSummary(detail ?? task, rows), rows });
  }
  out(targetLine(t));
  out(DATA_NOTE);
  for (const { summary: s } of tasks) {
    out(`任务 ${s.name}（${shortId(s.id)}）${s.status} · ${s.version || '-'} · ${s.runs} 次 · 通过 ${s.passed}${s.rate === null ? '' : `（${Math.round(s.rate * 100)}%）`}${s.noop ? ` · 空跑 ${s.noop}` : ''} · ${formatCost(s.cost)}${s.durationMs ? ` · ${Math.round(s.durationMs / 1000)}s` : ''}${s.notRun ? ` · 还有 ${s.notRun} 条没跑` : ''}`);
  }
  for (const { summary, rows } of tasks) {
    const bad = rows.filter((r) => !r.passed && !r.notRun);
    if (!bad.length) continue;
    out(`${summary.name} 没通过的（前 ${Math.min(limit, bad.length)} / ${bad.length} 条）：`);
    for (const r of bad.slice(0, limit)) out(`  - ${r.name}：${clip(r.verdict, 160) || '-'} ｜ 回复：${clip(r.reply, 120) || '（测试项里没有，加 --deep 取）'}`);
  }
  const saved = join(testsDir(t, 'results'), `${tasks.map((x) => shortId(x.summary.id)).join('+')}-${stamp()}.jsonl`);
  writeFileSync(saved, jsonlOf(tasks));
  out(`逐条明细：${saved}`);
  if (outFile) {
    writeReport(outFile, tasks);
    out(`报告：${outFile}`);
  }
  return EXIT.OK;
}
