// 只读检查插件 mock，生成可交给 md test edit 的本地脚本；不调用插件、不写秒懂。

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listArg, strArg } from '../args.mjs';
import { getCanvas, listVersions } from '../api.mjs';
import { EXIT, MdError } from '../errors.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { mockEditScript, pluginMockPreflight, pluginMockRequirements } from '../plugin-mocks.mjs';
import { resolveVersion } from '../target.mjs';
import { listCases } from '../testcenter.mjs';
import { pickCases, resolveTestSet, testTarget, testsDir } from '../test-common.mjs';
import { stamp } from '../workspace.mjs';

export async function mocks(args) {
  const t = await testTarget(args);
  const set = await resolveTestSet(t, args._[0]);
  const all = await listCases(t, set.testSetId);
  const picks = listArg(args, 'case');
  const cases = picks.length ? pickCases(all, picks, { set, botId: t.botId }) : all;
  if (!cases.length) throw new MdError('empty_set', `测试集「${set.name}」里没有用例`, { exitCode: EXIT.BLOCKED });
  let draft = await getCanvas(t.identity, t.orgId, t.botId);
  let label = '草稿';
  const version = strArg(args, 'version');
  if (version) {
    const v = resolveVersion(await listVersions(t.identity, t.orgId, draft.canvasId), version);
    draft = await getCanvas(t.identity, t.orgId, t.botId, v.canvasId);
    label = v.version;
  }
  const { nodes, unsupported } = pluginMockRequirements(draft.rawCanvas);
  out(targetLine({ ...t, versionLabel: label }));
  if (unsupported.length) throw new MdError('plugin_mock_unsupported', unsupported.join('\n'), { exitCode: EXIT.BLOCKED, hint: '先核对这些节点的 mock 能力，不能靠填一个同名 mock 放行真实调用' });
  if (!nodes.length) {
    out('这张画布没有插件节点，不需要插件 mock。');
    return EXIT.OK;
  }
  const report = pluginMockPreflight(cases, draft.rawCanvas);
  out(`测试集「${set.name}」：${cases.length} 条用例 × ${nodes.length} 个插件；${report.errors.length} 处需要补 mock，已有数据直接保留。`);
  for (const e of report.errors.slice(0, 20)) out(`  - ${e.name}：${e.reason}`);
  const file = resolve(strArg(args, 'out') ?? join(testsDir(t, 'exports'), `${shortId(set.testSetId)}-mocks-${stamp()}.mjs`));
  try {
    writeFileSync(file, mockEditScript(cases, nodes), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new MdError('file_exists', `文件已存在，没有覆盖：${file}`, { hint: '--out 指定一个新文件，保留已填写的 mock 数据' });
    throw error;
  }
  out(`只生成本地脚本，没有写秒懂：${file}`);
  out(`填完 outputs 后预演：md test edit ${set.testSetId} "${file}" --bot ${shortId(t.botId)}；用户同意后带计划码写入，再 md test run。`);
  return EXIT.OK;
}
