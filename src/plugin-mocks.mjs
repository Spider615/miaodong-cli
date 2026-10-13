// 测试只使用用例里的插件数据。已核对的形状：{nodeId, pluginId, outputs: {...}}。
// 逐条、逐节点核对完整 id；原执行没走到的分支也不能退回真实调用。

import { asArray } from './api.mjs';
import { hashOf } from './canvas.mjs';
import { EXIT, MdError } from './errors.mjs';
import { businessNodes, nodeName, nodeType } from './graph.mjs';
import { shortId } from './output.mjs';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v) => typeof v === 'string' && v.trim() !== '';

export function pluginMockRequirements(canvas) {
  const nodes = [];
  const unsupported = [];
  if (!Array.isArray(canvas) || !canvas.length) {
    return { nodes, unsupported: ['取不到完整画布，无法确认插件 mock 是否齐全'] };
  }
  for (const cell of businessNodes(canvas)) {
    const type = nodeType(cell);
    const payload = cell.data?.nodePayload ?? {};
    const label = `${nodeName(cell)} [${shortId(cell.id)}]`;
    const tools = payload.tools;
    if ((tools != null && !Array.isArray(tools)) || asArray(tools).some((t) => String(t?.type ?? t?.toolType ?? '') !== 'query_kb')) {
      unsupported.push(`${label} 挂了外部工具，无法确认用例的插件 mock 会拦截这些工具`);
    } else if (type === 'plugin-calculation') {
      if (!id(cell.id) || !id(payload.pluginId)) unsupported.push(`${label} 缺 nodeId 或 pluginId，无法确认插件 mock 能匹配`);
      else nodes.push({ nodeId: cell.id, pluginId: payload.pluginId, name: nodeName(cell) });
    } else if (type.startsWith('plugin-')) {
      unsupported.push(`${label} 是 ${type}，无法确认用例的插件 mock 会拦截这个节点`);
    }
  }
  return { nodes, unsupported };
}

// 同一节点出现两份 mock 时，不能猜秒懂会取哪一份（包括一份旧 pluginId、一份新 pluginId）。
function mockFor(testCase, node) {
  const rows = (Array.isArray(testCase?.pluginMockOutputs) ? testCase.pluginMockOutputs : []).filter((m) => m?.nodeId === node.nodeId);
  if (rows.length !== 1 || rows[0].pluginId !== node.pluginId || !object(rows[0].outputs)) return null;
  return rows[0];
}

export function pluginMockPreflight(cases, canvas) {
  const { nodes, unsupported } = pluginMockRequirements(canvas);
  const errors = unsupported.map((reason) => ({ name: '（全部用例）', reason }));
  for (const c of cases) {
    for (const n of nodes) {
      if (!mockFor(c, n)) errors.push({
        name: String(c?.name ?? c?.testCaseId ?? '?'),
        reason: `${n.name} [${shortId(n.nodeId)}] 的插件 mock 缺失或无效（需要完整 nodeId + pluginId，outputs 是对象，同一节点只留一份）`,
      });
    }
  }
  return { nodes, errors };
}

// 独立于可跳过的事件 / 断言检查，也独立于花费确认；任何参数都不能放行真实插件调用。
export function assertPluginMocks(report) {
  if (!report.errors.length) return;
  const lines = report.errors.slice(0, 20).map((e) => `  - ${e.name}：${e.reason}`);
  if (report.errors.length > 20) lines.push(`  …另有 ${report.errors.length - 20} 处`);
  throw new MdError('plugin_mock_required', `插件 mock 检查不通过（${report.errors.length} 处），没有启动或继续测试：\n${lines.join('\n')}`, {
    exitCode: EXIT.BLOCKED,
    hint: '已有调优中心 case 的 pluginMockOutputs 直接使用；缺数据用 md test mocks <集> --bot <智能体> 生成脚本，填好后 md test edit 预演并确认。插件动作 / 外部工具须先核对平台的 mock 能力',
  });
}

// 暂停的任务可能使用建任务时的快照：只能继续 md 记录过、且画布和 mock 都没变的任务。
export function mockSafetyOf(cases, canvas) {
  return {
    canvas: hashOf(canvas),
    cases: Object.fromEntries(cases.map((c) => [c.testCaseId, hashOf(c.pluginMockOutputs ?? [])])),
  };
}

export function mockEditScript(cases, nodes) {
  const rows = cases.map((c) => {
    const missing = nodes.filter((n) => !mockFor(c, n));
    const replaced = new Set(missing.map((n) => n.nodeId));
    const kept = (Array.isArray(c.pluginMockOutputs) ? c.pluginMockOutputs : []).filter((m) => !replaced.has(m?.nodeId));
    return {
      testCaseId: c.testCaseId,
      name: c.name,
      pluginMockOutputs: [...structuredClone(kept), ...missing.map((n) => ({ nodeId: n.nodeId, pluginId: n.pluginId, outputs: null }))],
    };
  });
  return `// 填写每条用例缺失的 outputs（null）；已有调优中心插件数据原样保留。
// outputs 是插件的字段名 -> 值，例如 {output: {...}}；不要伪造业务结果。
// 本文件只改插件 mock，使用 md test edit 预演并经用户确认后才写入。
const mockCases = ${JSON.stringify(rows, null, 2)};

export default ({ cases }) => {
  for (const row of mockCases) {
    if (row.pluginMockOutputs.some((m) => m.outputs === null || typeof m.outputs !== 'object' || Array.isArray(m.outputs))) {
      throw new Error('用例「' + row.name + '」的插件 mock 未填完：请填写 outputs');
    }
    const c = cases.find((c) => c.testCaseId === row.testCaseId);
    if (!c) throw new Error('mock 脚本里的用例已不在测试集：' + row.testCaseId);
    c.pluginMockOutputs = structuredClone(row.pluginMockOutputs);
  }
};
`;
}
