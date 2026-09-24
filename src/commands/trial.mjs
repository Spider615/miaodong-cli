// md trial：单节点试跑。跑的是秒懂上的草稿（推送后立即生效）；超门槛、估不出花费、调插件时要用户确认（确认码，spec §7）。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { intArg, listArg, strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { getCanvas } from '../api.mjs';
import { resolveBot, targetArgs } from '../target.mjs';
import { latestWorkspaceFor, loadWorkspace, stamp, targetFromMeta } from '../workspace.mjs';
import { resolveNode } from '../graph.mjs';
import { ensureDir, mdHome } from '../home.mjs';
import { formatTime, note, out, shortId, targetLine } from '../output.mjs';
import { clip, formatCost } from '../execs.mjs';
import { locateExec } from '../exec-locate.mjs';
import { normalizeDetail, promptText } from '../exec-detail.mjs';
import { buildTrialInputs, classifyTrialNode, costSummary, draftVsLocal, inputDefs, parseInputPairs } from '../trial.mjs';
import { runNodeOnce } from '../trial-run.mjs';
import { dayKey, loadLimits, readSpends, recordSpend, spendDecision, spentOn, updateSpend } from '../spend.mjs';
import { codeFor, givenCode } from '../confirm.mjs';
import { buildBranchNameIndex } from '../../../apps/api/lib/miaodong/badcase-normalize.ts';

const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');

async function trialTarget(args) {
  if (strArg(args, 'ws')) {
    const ws = loadWorkspace(args);
    return { target: targetFromMeta(ws.meta), ws };
  }
  const target = await resolveBot(targetArgs(args));
  return { target, ws: latestWorkspaceFor(target.botId) };
}

function lastPerRun(botId, nodeId) {
  const hit = readSpends().filter((r) => r.kind === 'trial' && r.botId === botId && r.nodeId === nodeId && typeof r.actualPerRun === 'number').at(-1);
  return hit ? hit.actualPerRun : null;
}

function readInputsFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw usage(`--inputs 读不了：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw usage('--inputs 的文件要是一个 JSON 对象：{"键": 值}');
  return parsed;
}

const roundCost = (value) => (value === null ? null : Math.round(value * 10000) / 10000);

// 需要用户确认：把原因和确认码打出来，什么都不跑（退出码 5）。remaining 有值时是「跑到一半停下，其余几次要确认」
function stopForConfirm({ code, previous, given, reasons, remaining = null }) {
  const what = remaining ? `其余 ${remaining} 次` : '';
  out(`⛔ 要用户确认才能跑${what}：${reasons.join('；')}`);
  out(`确认码：${code}（只对这一笔有效：次数、输入、预估任何一样变了就作废，用过一次也作废）`);
  const hint = remaining
    ? `把已跑的实际花费和其余 ${remaining} 次的预估单独告诉用户（不要夹在别的问题里）；用户明确同意后，同一条命令把 --times 改成 ${remaining}，再加 --confirm ${code}`
    : `把上面的预估和原因单独告诉用户（不要夹在别的问题里）；用户明确同意这一笔后，同一条命令加 --confirm ${code}`;
  if (given !== null && given === previous) throw new MdError('confirm_used', `确认码 ${given} 已经用过了：每个码只能用一次`, { exitCode: EXIT.BLOCKED, hint });
  if (given !== null) throw new MdError('confirm_mismatch', `确认码对不上（给的是 ${given || '空'}，当前是 ${code}）：次数、输入或预估和上次不一样了`, { exitCode: EXIT.BLOCKED, hint });
  throw new MdError('confirm_needed', `需要用户确认${what}：${reasons.join('；')}`, { exitCode: EXIT.BLOCKED, hint });
}

export const trial = {
  summary: '单节点试跑：用执行记录里的原始输入复现、推草稿后复验（跑的是草稿；超门槛和调插件要用户确认）',
  usage: [
    'md trial <节点> (--bot <智能体> | --ws <工作副本>) [--from-exec <执行id>] [--input 键=值 …] [--inputs <文件.json>]',
    '        [--times 1] [--keep-platform-params] [--allow-plugin] [--confirm <确认码>]',
    '跑的是秒懂上的草稿：本地改动要先 md push 才会生效。只跑计算类节点；发消息、打标签、转人工、事件这类动作节点一律不跑。',
    '预估超单次门槛、今天累计超每日上限、会真的调用插件时，md 不跑，只给预估和确认码（退出码 5）：单独问用户，同意后同一条命令加 --confirm <码>。',
    '估不出花费时先跑 1 次，按实际推算其余几次，超门槛就停下给其余几次的确认码。md spend 看门槛和花费。',
  ].join('\n'),
  async run(args) {
    const query = args._[0];
    if (!query) throw usage('缺节点：md trial <节点 id / id 前缀 / 名字> --bot <智能体>');
    const times = intArg(args, 'times', 1, 10);
    const { target, ws } = await trialTarget(args);
    const draft = await getCanvas(target.identity, target.orgId, target.botId);
    const cell = resolveNode(draft.rawCanvas, query);
    const node = { id: cell.id, name: String(cell.data?.name ?? cell.id), type: String(cell.data?.type ?? cell.shape ?? ''), category: String(cell.data?.category ?? '') };
    const cls = classifyTrialNode(cell);
    if (cls.kind === 'denied') {
      throw new MdError('trial_denied', `「${node.name}」是 ${cls.type || '未知类型'}，这类节点不做单节点试跑（只跑大模型、代码、规则、知识库查询这类计算节点；秒懂页面也不给别的节点试跑按钮）`, { exitCode: EXIT.BLOCKED });
    }
    if (cls.kind === 'plugin' && args['allow-plugin'] !== true) {
      throw new MdError('trial_plugin', `「${node.name}」会真的调用外部系统（${cls.plugins.join('、')}）`, { exitCode: EXIT.BLOCKED, hint: '确认要跑：加 --allow-plugin；md 会先给出预估和确认码，要用户确认' });
    }

    // 输入与单次花费
    let fromExec = null;
    let perRun = null;
    let basis = '';
    const execId = strArg(args, 'from-exec');
    if (execId) {
      const located = await locateExec({}, execId);
      const executed = normalizeDetail(located.detail).nodes.find((n) => n.id === node.id);
      if (!executed) {
        throw new MdError('node_not_in_exec', `执行 ${shortId(execId)} 没有跑到「${node.name}」[${shortId(node.id)}]`, { exitCode: EXIT.TARGET, hint: 'md exec <执行id> 看那次跑了哪些节点' });
      }
      fromExec = executed.inputs && typeof executed.inputs === 'object' ? executed.inputs : {};
      if (typeof executed.cost === 'number') {
        perRun = executed.cost;
        basis = `执行 ${shortId(execId)} 里这个节点花了 ${formatCost(executed.cost)}/次`;
      }
      if (located.target.botId !== target.botId) note(`（输入取自另一个智能体「${located.target.botName}」的执行）`);
    }
    if (perRun === null) {
      const last = lastPerRun(target.botId, node.id);
      if (last !== null) {
        perRun = last;
        basis = `上次试跑这个节点花了 ${formatCost(last)}/次`;
      }
    }
    const file = strArg(args, 'inputs');
    const built = buildTrialInputs(inputDefs(cell), {
      fromExec,
      fromFile: file ? readInputsFile(file) : null,
      overrides: parseInputPairs(listArg(args, 'input')),
      keepPlatform: args['keep-platform-params'] === true,
    });

    // 预演信息先打出来：要确认时，这就是给用户看的预演
    const limits = loadLimits();
    const today = spentOn(readSpends());
    const estimate = perRun === null ? null : perRun * times;
    const fresh = draftVsLocal(node.id, draft.rawCanvas, ws);
    out(targetLine({ ...target, versionLabel: '草稿' }));
    out(`试跑「${node.name}」[${shortId(node.id)}] ${node.type} × ${times} · 草稿最后保存 ${formatTime(draft.updatedAt)}`);
    if (fresh.status === 'unpushed') out(`⚠️ 本地改动还没推：这次跑的是草稿上的旧版本（工作副本 ${fresh.dir}）；要试新改的先 md push`);
    if (fresh.status === 'draft-changed') out('（草稿里这个节点在你拉取之后被改过；跑的是草稿现在的内容）');
    out(`输入：${Object.keys(built.inputs).join('、') || '（无）'}${execId ? `（取自执行 ${shortId(execId)}）` : ''}`);
    if (built.dropped.length) out(`去掉平台参数：${built.dropped.join('、')}（让秒懂填最新值；要保留加 --keep-platform-params）`);
    if (built.missing.length) out(`⚠️ 缺输入：${built.missing.join('、')}（会按空值跑，结果可能失真）`);
    if (built.extra.length) out(`（多出来的键：${built.extra.join('、')}）`);
    out(`花费：预计 ${estimate === null ? '估不出，先跑 1 次看实际' : `${formatCost(estimate)}${basis ? `（${basis}）` : ''}`} · 今天已花 ${formatCost(today)} / 上限 ${formatCost(limits.perDay)}`);

    // 确认：估不出花费、不调插件、今天没到上限时，先跑 1 次拿到真实花费再决定其余几次；用户已经确认过这一笔就照确认的跑
    const external = cls.kind === 'plugin' ? cls.plugins : [];
    const probeFirst = estimate === null && !external.length && today < limits.perDay;
    const given = givenCode(args);
    const operation = (n, est) => ({ kind: 'trial', botId: target.botId, nodeId: node.id, times: n, inputs: built.inputs, estimate: roundCost(est), external, day: dayKey() });
    const decision = spendDecision({ estimate, externalCalls: external }, { limits, today });
    const confirm = codeFor(operation(times, estimate), readSpends());
    const confirmed = decision.needApproval && given === confirm.code;
    if (decision.needApproval && !confirmed && (given !== null || !probeFirst)) stopForConfirm({ ...confirm, given, reasons: decision.reasons });
    const approved = confirmed ? 'confirm' : 'auto';
    if (confirmed) out('（用户已确认这一笔）');

    const dir = ensureDir(join(mdHome(), 'trials', safe(target.identityKey), safe(target.botId.slice(0, 8)), `${stamp()}-${safe(shortId(node.id))}`));
    const spendId = recordSpend({
      kind: 'trial', regionLabel: target.regionLabel, botId: target.botId, botName: target.botName,
      what: node.name, nodeId: node.id, count: times, estimate, basis: basis || (estimate === null ? '估不出' : ''), approved,
      ...(confirmed ? { opKey: confirm.opKey, code: confirm.code } : {}),
    });
    const branches = buildBranchNameIndex(draft.rawCanvas);
    const outputs = new Set();
    const runs = [];
    try {
      for (let i = 1; i <= times; i++) {
        if (i === 2 && probeFirst && !confirmed) {
          // 第 1 次超时没跑完时 perRun 是 null：还是估不出，照样要确认
          const probe = costSummary(runs);
          const rest = probe.perRun === null ? null : probe.perRun * (times - 1);
          const next = spendDecision({ estimate: rest }, { limits, today: today + probe.actual });
          if (next.needApproval) {
            out(`第 1 次实际 ${formatCost(probe.actual)}；其余 ${times - 1} 次${rest === null ? '还是估不出' : `按它推算预计 ${formatCost(rest)}`}`);
            stopForConfirm({ ...codeFor(operation(times - 1, rest), readSpends()), given: null, reasons: next.reasons, remaining: times - 1 });
          }
        }
        const { execId: nodeExecId, run, timedOut } = await runNodeOnce({ identity: target.identity, orgId: target.orgId, canvasId: draft.canvasId, node, inputs: built.inputs });
        const result = run.nodeResults[0] ?? {};
        const cost = typeof run.cost.cny === 'number' ? run.cost.cny : null;
        runs.push({ cost, timedOut });
        writeFileSync(join(dir, `run-${i}.json`), JSON.stringify({ nodeExecId, inputs: built.inputs, run }, null, 2));
        const prompt = promptText({ prompt: result.metadata?.prompt });
        if (prompt) writeFileSync(join(dir, `prompt-${i}.txt`), prompt);
        const icon = timedOut ? '⏳' : run.status === 'success' ? '✅' : '❌';
        const branch = result.outputBranchId ? ` → 分支「${branches.get(result.outputBranchId) ?? shortId(result.outputBranchId)}」` : '';
        out(`#${i} ${icon} ${timedOut ? `5 分钟没跑完（${nodeExecId}）` : run.status} ${(run.duration / 1000).toFixed(1)}s ${formatCost(cost)}${branch}`);
        if (result.error) out(`   报错：${clip(typeof result.error === 'string' ? result.error : JSON.stringify(result.error), 300)}`);
        const text = typeof result.output?.message === 'string' ? result.output.message : JSON.stringify(result.output ?? null);
        out(`   输出：${clip(text, 1500)}`);
        const reasoning = result.metadata?.reasoning;
        if (typeof reasoning === 'string' && reasoning.trim()) out(`   推理：${clip(reasoning, 300)}`);
        outputs.add(JSON.stringify(result.output ?? null));
      }
    } finally {
      const sum = costSummary(runs);
      updateSpend(spendId, { actual: sum.actual, actualPerRun: sum.perRun, runs: runs.length, unknownRuns: sum.unknownRuns });
    }
    const sum = costSummary(runs);
    out(`${runs.length} 次里 ${outputs.size} 种不同输出 · 共 ${formatCost(sum.actual)}${sum.unknownRuns ? `（另有 ${sum.unknownRuns} 次没跑完，花费未知）` : ''} · 结果和 prompt 在 ${dir}`);
    return EXIT.OK;
  },
};
