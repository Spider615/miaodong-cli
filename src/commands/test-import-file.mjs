// md test import <集> --from-file <cases.jsonl> [--into]（spec §6.3）：外部用例。
// 本地先校验全部用例，有错就一条都不写 → 先写 1 条读回来核对，关键字段被丢就撤回 → 其余每批 50 条 →
// 按 name 回读拿 id → 按场景挂 → 逐字段审计、场景计数对账。

import { existsSync, readFileSync } from 'node:fs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { note, out, shortId, targetLine } from '../output.mjs';
import { listEvents, listSessions } from '../api.mjs';
import { attachCases, createCases, createTestSet, deleteCases, deleteTestSet, listCases, listTestSets, scenarioTree } from '../testcenter.mjs';
import { buildCases, flattenTree, parseCaseLines } from '../casefile.mjs';
import { caseDiffs, fieldLabel } from '../testcases.mjs';
import { resolveTestSet } from '../test-common.mjs';

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

// 写到一半出错：说清留下了什么、怎么查、怎么接着导（同 --from-execs；审查 M1）。pending 表示有用例还没挂场景
function partial(t, set, created, error, pending = false) {
  const bot = shortId(t.botId);
  const tips = [`md test cases ${set.testSetId} --bot ${bot} 看写进去了哪些`, '用 --into 重导时已经写进去的 name 会被拦下，只导缺的那几行'];
  if (created) tips.push(`也可以 md test drop ${set.testSetId} --bot ${bot} 删掉整个集再重导`);
  if (pending) tips.push('写进去的用例还没挂场景');
  return new MdError(error?.code ?? 'upstream', `${error?.message ?? error}（测试集「${set.name}」(${shortId(set.testSetId)}) ${created ? '已经建了' : '是已有的'}，可能已经写进去一部分）`, {
    exitCode: error?.exitCode,
    hint: tips.join('；'),
  });
}

// 先写第 1 条读回来：关键字段被服务端丢了，就撤回这 1 条（新建的集整个删掉）再报错；非关键字段丢了提醒后继续。
// 返回这个区不保存的非关键字段，后面的审计就不再重复提醒
async function canary(t, set, created, first, pending) {
  let rows;
  try {
    await createCases(t, set.testSetId, [first.testCase]);
    rows = await listCases(t, set.testSetId);
  } catch (error) {
    throw partial(t, set, created, error, pending);
  }
  const got = rows.find((c) => c.name === first.testCase.name);
  const diffs = got ? caseDiffs(first.testCase, got) : [];
  const soft = diffs.filter((d) => !d.critical).map((d) => d.field);
  if (got && soft.length === diffs.length) {
    if (soft.length) out(`⚠️ 这个区不保存 ${soft.map(fieldLabel).join('、')}（先写的 1 条读回来不一样）：分类、溯源信息请写进 name。其余照写`);
    return new Set(soft);
  }
  // 撤回：新建的集里只有这 1 条，全删；导进已有的集时，只删按 name 找到的那条（找不到就一条都不删）
  const doomed = created ? rows.map((c) => c.testCaseId) : got ? [got.testCaseId] : [];
  let left = 0;
  try {
    if (doomed.length) await deleteCases(t, doomed);
    left = (await listCases(t, set.testSetId)).filter((c) => doomed.includes(c.testCaseId)).length;
    if (created && !left) await deleteTestSet(t, set.testSetId);
  } catch (error) {
    throw partial(t, set, created, error, pending);
  }
  const bot = shortId(t.botId);
  const what = got ? `这些字段读回来不一样：${diffs.filter((d) => d.critical).map((d) => fieldLabel(d.field)).join('、')}` : '按 name 找不到';
  const action = !doomed.length
    ? `没法撤回：集里可能多了一条，用 md test cases ${set.testSetId} --bot ${bot} 看`
    : left ? `撤回时还剩 ${left} 条没删掉，用 md test drop ${set.testSetId} --bot ${bot} 清理` : `已撤回${created ? '，也删了新建的测试集' : ''}`;
  throw new MdError('canary_failed', `先写的第 1 条（第 ${first.line} 行「${first.testCase.name}」）${what}：秒懂没存下 md 写的内容，${action}`, {
    hint: '可能是这个区的版本字段不一样：把这一行改用 input / raw 原样写法再试；还不行就告诉 md 的维护者',
  });
}

// 按场景分组挂上去；挂之前（导入开始时读的树）和挂之后各看一次场景树，每个节点的用例数变化要等于这次挂的条数（spec §6.3 第 5 步）
async function attachAll(t, built, back, tree) {
  const groups = new Map();
  for (const b of built) {
    const got = back.get(b.testCase.name);
    if (b.scenarioNodeId && got) groups.set(b.scenarioNodeId, [...(groups.get(b.scenarioNodeId) ?? []), got.testCaseId]);
  }
  if (!groups.size) return { attached: 0, notes: [] };
  const before = new Map(flattenTree(tree.tree).map((n) => [n.id, n.ownCaseCount]));
  let attached = 0;
  const notes = [];
  try {
    for (const [nodeId, ids] of groups) {
      const n = await attachCases(t, nodeId, ids);
      attached += n;
      if (n !== ids.length) notes.push(`挂到场景 ${shortId(nodeId)} 的 ${ids.length} 条，秒懂说挂上了 ${n} 条`);
    }
  } catch (error) {
    throw new MdError(error?.code ?? 'upstream', `用例都写进去了，挂场景时出错：${error?.message ?? error}（已挂 ${attached} 条）`, { exitCode: error?.exitCode, hint: '在秒懂页面上把剩下的挂上；或者 md test drop 删掉这个集后重导' });
  }
  let after;
  try {
    after = new Map(flattenTree((await scenarioTree(t))?.tree).map((n) => [n.id, n]));
  } catch (error) {
    notes.push(`挂完没能读场景树核对计数：${error?.message ?? error}`);
    return { attached, notes };
  }
  for (const [nodeId, ids] of groups) {
    const node = after.get(nodeId);
    const delta = (node?.ownCaseCount ?? 0) - (before.get(nodeId) ?? 0);
    if (delta !== ids.length) notes.push(`场景「${node?.path ?? nodeId}」用例数变了 ${delta}，这次挂的是 ${ids.length} 条：可能有旧批次重复挂在这里`);
  }
  return { attached, notes };
}

export async function importFile(t, { name, file, into }) {
  if (!existsSync(file)) throw usage(`找不到文件：${file}`);
  const parsed = parseCaseLines(readFileSync(file, 'utf-8'));
  if (!parsed.rows.length && !parsed.errors.length) throw usage(`${file} 里没有用例`);
  const [events, vars, tree, sets] = await Promise.all([listEvents(t.identity, t.orgId, t.botId), listSessions(t.identity, t.orgId, t.botId), scenarioTree(t), listTestSets(t)]);
  let set = null;
  if (into) set = await resolveTestSet(t, name, sets);
  else if (sets.some((s) => s.name === name)) {
    throw new MdError('testset_exists', `${t.botName} 下已经有测试集「${name}」`, { exitCode: EXIT.BLOCKED, hint: '导进这个已有的集加 --into；否则换个名字' });
  }
  const existingNames = set ? (await listCases(t, set.testSetId)).map((c) => c.name) : [];
  const { built, errors } = buildCases(parsed.rows, { events, vars, scenarios: tree === null ? null : flattenTree(tree.tree) }, { existingNames });
  const problems = [...parsed.errors.map((e) => ({ ...e, name: '' })), ...errors].sort((a, b) => a.line - b.line);
  out(targetLine(t));
  if (problems.length) {
    out(`❌ ${file}：${problems.length} 处错误，一条都没写：`);
    for (const p of problems.slice(0, 50)) out(`  第 ${p.line} 行${p.name ? `「${p.name}」` : ''}：${p.reason}`);
    if (problems.length > 50) out(`  …另有 ${problems.length - 50} 处`);
    throw new MdError('invalid_cases', `${file} 有 ${problems.length} 处错误，什么都没写`, { hint: '改好文件再导；格式见 skill 的 references/test-cases.md' });
  }
  const warnings = new Map();
  for (const b of built) for (const w of b.warnings) bump(warnings, w);
  for (const [w, n] of warnings) out(`⚠️ ${w}（${n} 条）`);

  let created = false;
  if (!set) {
    set = { testSetId: await createTestSet(t, name), name };
    created = true;
  }
  out(`${created ? '新建' : '导进已有的'}测试集「${set.name}」(${shortId(set.testSetId)})：${built.length} 条用例`);
  const pending = built.some((b) => b.scenarioNodeId);
  const known = await canary(t, set, created, built[0], pending);
  let back;
  try {
    await createCases(t, set.testSetId, built.slice(1).map((b) => b.testCase), { onBatch: (done) => note(`（已写 ${done + 1}/${built.length}）`) });
    back = new Map((await listCases(t, set.testSetId)).map((c) => [c.name, c]));
  } catch (error) {
    throw partial(t, set, created, error, pending);
  }

  // 审计：逐条逐字段比，按字段汇总
  const missing = built.filter((b) => !back.has(b.testCase.name));
  const soft = new Map();
  const hard = [];
  for (const b of built) {
    const got = back.get(b.testCase.name);
    if (!got) continue;
    const diffs = caseDiffs(b.testCase, got);
    for (const d of diffs) if (!d.critical && !known.has(d.field)) bump(soft, d.field);
    const critical = diffs.filter((d) => d.critical);
    if (critical.length) hard.push({ b, fields: critical.map((d) => fieldLabel(d.field)) });
  }
  // 审计结果先打：挂场景出错时也不能丢（审查 M1）
  const report = (attached) => {
    out(`提交 ${built.length} · 回读 ${built.length - missing.length}${attached === null ? '' : ` · 挂场景 ${attached}`}${missing.length ? ` · 缺失 ${missing.length}` : ''}`);
    if (missing.length) out(`⚠️ 回读找不到：${missing.slice(0, 10).map((b) => `第 ${b.line} 行「${b.testCase.name}」`).join('、')}${missing.length > 10 ? '…' : ''}`);
    for (const [field, n] of soft) out(`⚠️ ${fieldLabel(field)}：${n} 条读回来和写的不一样（这个区可能不保存这个字段）`);
    for (const h of hard.slice(0, 20)) out(`❌ 第 ${h.b.line} 行「${h.b.testCase.name}」：${h.fields.join('、')} 读回来和写的不一样`);
  };
  let result;
  try {
    result = await attachAll(t, built, back, tree);
  } catch (error) {
    report(null);
    throw error;
  }
  const { attached, notes } = result;
  report(attached);
  for (const n of notes) out(`⚠️ ${n}`);
  out(`下一步：md test run ${set.name} --bot ${shortId(t.botId)}`);
  return missing.length || hard.length ? EXIT.ERROR : EXIT.OK;
}
