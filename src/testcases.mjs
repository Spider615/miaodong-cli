// 测试用例的纯逻辑：汇总、跨智能体换 id、跑前检查。字段形状见 spec §2.3（09-25 实测）。

import { asArray } from './api.mjs';
import { classifyTrialNode } from './trial.mjs';
import { stableStringify } from './canvas.mjs';
import { WRITABLE_FIELDS } from './testcenter.mjs';

// 估不出花费时，每条每轮按这个价预留（spec §7：测试的参考单价 ¥0–0.3），宁可多算
export const UNKNOWN_CASE_COST = 0.3;

// 秒懂给「从执行记录导入」的用例起的名字，括号里是源执行 id
export const IMPORT_NAME = /^调优中心导入\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/i;
export const execIdOfCase = (name) => IMPORT_NAME.exec(String(name ?? ''))?.[1] ?? null;

// 这条用例里用户说了什么：文本触发取 text；事件触发取事件变量里的 text（延时回复这类事件把用户消息放在这里）
export function caseText(testCase) {
  const input = testCase?.triggerInputs ?? {};
  return String(input.text ?? input.data?.text ?? input.data?.userOriginalText ?? '');
}

export function summarizeCases(cases) {
  const byTrigger = {};
  for (const c of cases) {
    const type = c?.triggerType ?? '?';
    byTrigger[type] = (byTrigger[type] ?? 0) + 1;
  }
  return {
    total: cases.length,
    byTrigger,
    unreviewed: cases.filter((c) => c?.isReviewed === false).length,
    attached: cases.filter((c) => c?.scenarioNodeId).length,
  };
}

// 源 bot 的事件 id、会话变量 id → 目标 bot 的（spec §6.2）。目标里本来就有同一个 id（克隆出来的智能体）就原样用；
// 别的按名字对。名字在目标里没有、有重名，或者源里就有重名（几个源 id 会并成同一个目标 id，会话数据的键被合掉），都记下原因
export function buildIdMap({ sourceEvents, targetEvents, sourceVars, targetVars }) {
  const map = new Map();
  const unresolved = new Map();
  const pair = (source, target, idKey, kind) => {
    const byName = new Map();
    const targetIds = new Set();
    for (const row of asArray(target)) {
      const name = String(row?.name ?? '');
      const id = String(row?.[idKey] ?? '');
      targetIds.add(id);
      byName.set(name, [...(byName.get(name) ?? []), id]);
    }
    const sourceNames = new Map();
    for (const row of asArray(source)) {
      const name = String(row?.name ?? '');
      sourceNames.set(name, (sourceNames.get(name) ?? 0) + 1);
    }
    for (const row of asArray(source)) {
      const id = String(row?.[idKey] ?? '');
      if (!id) continue;
      const name = String(row?.name ?? '');
      const hits = byName.get(name) ?? [];
      if (targetIds.has(id)) map.set(id, id);
      else if (sourceNames.get(name) > 1) unresolved.set(id, `${kind}「${name}」在源里有 ${sourceNames.get(name)} 个同名，不知道对哪个`);
      else if (hits.length === 1) map.set(id, hits[0]);
      else unresolved.set(id, `${kind}「${name}」${hits.length ? `在目标里有 ${hits.length} 个同名` : '在目标里没有'}`);
    }
  };
  pair(sourceEvents, targetEvents, 'eventId', '事件');
  pair(sourceVars, targetVars, 'id', '会话变量');
  return { map, unresolved };
}

// 整条用例（值和键）里，凡是等于源 bot 某个 id 的字符串都换成目标的。不挑字段：
// 事件 id 在 triggerInputs.eventId 和发事件断言的 eventId 里；会话变量 id 是 sessionMemoryCustomData 的键、也是写字段断言的 fieldId。
// 断言的 verifyPayload 和 actionContent 两份自然都换到；秒懂以后在别处也用这些 id，照样换得到。
export function remapCase(testCase, { map, unresolved }) {
  const problems = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (unresolved.has(value)) problems.add(unresolved.get(value));
      return map.get(value) ?? value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        if (unresolved.has(key)) problems.add(unresolved.get(key));
        out[map.get(key) ?? key] = walk(inner);
      }
      return out;
    }
    return value;
  };
  return { testCase: walk(testCase), problems: [...problems] };
}

// 回读核对：用例（值和键）里还剩哪些给定的 id
export function leftoverIds(testCase, ids) {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (ids.has(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (ids.has(key)) found.add(key);
        walk(inner);
      }
    }
  };
  walk(testCase);
  return [...found];
}

// 断言里引用的 id：发事件断言的事件 id、写字段断言的会话变量 id（fieldId）。verifyPayload 和 actionContent 两份都看（spec §2.3）
function assertionIds(assertion) {
  const verify = assertion?.verifyPayload ?? {};
  const payload = assertion?.actionContent?.payload ?? {};
  const type = verify.type ?? assertion?.actionContent?.type;
  const ids = (list) => [...new Set(list.map((x) => String(x ?? '')).filter(Boolean))];
  if (type === 'canvas-event-action') return { events: ids([verify.eventId, payload.eventId]), vars: [] };
  if (type === 'update-data') return { events: [], vars: ids([...asArray(verify.operations), ...asArray(payload.operations)].map((op) => op?.fieldId)) };
  return { events: [], vars: [] };
}

// 事件、会话变量在这个智能体里存不存在。events / vars 取不到（null）时不查那一项。
// kind：trigger（触发的事件）、vars（会话数据的键）会让用例空跑；assertion（断言里引用的）会让这条断言永远不过。
// ids 是对不上的那几个 id：比较改前改后只能按 kind + id 比，原因文字里带着个数（两个里修好一个，文字就变了）
export function idProblems(cases, { events, vars }) {
  const eventIds = events ? new Set(events.map((e) => String(e?.eventId ?? ''))) : null;
  const varIds = vars ? new Set(vars.map((v) => String(v?.id ?? ''))) : null;
  const rows = [];
  for (const c of cases) {
    const name = String(c?.name ?? c?.testCaseId ?? '?');
    const eventId = String(c?.triggerInputs?.eventId ?? '');
    if (eventIds && c?.triggerType === 'canvas-event-trigger' && !eventIds.has(eventId)) rows.push({ name, kind: 'trigger', ids: [eventId], reason: `事件 ${eventId.slice(0, 8)} 在这个智能体里不存在` });
    if (varIds) {
      const missing = Object.keys(c?.sessionMemoryCustomData ?? {}).filter((key) => !varIds.has(key));
      if (missing.length) rows.push({ name, kind: 'vars', ids: missing, reason: `${missing.length} 个会话变量在这个智能体里不存在（${missing.slice(0, 3).map((k) => k.slice(0, 8)).join('、')}）` });
    }
    for (const assertion of asArray(c?.canvasActionOutputAssertions)) {
      const ids = assertionIds(assertion);
      for (const id of eventIds ? ids.events.filter((x) => !eventIds.has(x)) : []) rows.push({ name, kind: 'assertion', ids: [id], reason: `发事件断言里的事件 ${id.slice(0, 8)} 在这个智能体里不存在` });
      const gone = varIds ? ids.vars.filter((x) => !varIds.has(x)) : [];
      if (gone.length) rows.push({ name, kind: 'assertion', ids: gone, reason: `写字段断言里的 ${gone.length} 个会话变量在这个智能体里不存在（${gone.slice(0, 3).map((k) => k.slice(0, 8)).join('、')}）` });
    }
  }
  return rows;
}

// 跑前检查（spec §6.5）。秒懂对触发器、事件、会话变量对不上的用例不报错：照样「成功」，但什么都没执行
// （spec §2.3 核对 6），只能在这里拦。canvas 是要跑的那张画布（草稿或某个版本）
export function preflight(cases, { canvas, events, vars }) {
  const cells = asArray(canvas).filter((c) => c && typeof c === 'object' && c.data);
  const entries = new Set(cells.filter((c) => c.data.type === 'canvas-event-trigger').flatMap((c) => [String(c.shape ?? ''), String(c.data.nodePayload?.eventId ?? '')]).filter(Boolean));
  const types = new Set(cells.map((c) => String(c.data.type ?? '')));
  const errors = idProblems(cases, { events, vars });
  // 取不到列表就没法核对：不能当作没问题放过去（审查 I4；api.mjs 里写着个别区版本不齐）
  if (!events || !vars) errors.unshift({ name: '（全部用例）', reason: '取不到这个智能体的事件或会话变量列表，没法核对会不会空跑' });
  const eventIds = events ? new Set(events.map((e) => String(e?.eventId ?? ''))) : null;
  for (const c of cases) {
    const name = String(c?.name ?? c?.testCaseId ?? '?');
    if (c?.triggerType === 'canvas-event-trigger') {
      const eventId = String(c?.triggerInputs?.eventId ?? '');
      // 事件本身不存在的已经记过了；存在但这张画布上没有入口的，单独记
      if ((!eventIds || eventIds.has(eventId)) && !entries.has(eventId)) errors.push({ name, reason: `要跑的画布上没有事件 ${eventId.slice(0, 8)} 的入口` });
    } else if (c?.triggerType && !types.has(c.triggerType)) {
      errors.push({ name, reason: `要跑的画布上没有「${c.triggerType}」触发器` });
    }
  }
  // 会真调外部系统的：插件计算节点、挂了外部工具的大模型（同 md trial 的认法），以及插件动作节点
  const plugins = [];
  for (const cell of cells) {
    const cls = classifyTrialNode(cell);
    if (cls.kind === 'plugin') plugins.push(...cls.plugins);
    else if (cell.data.type === 'plugin-action') plugins.push(String(cell.data.name ?? cell.data.type));
  }
  return { errors, plugins: [...new Set(plugins)], unreviewed: cases.filter((c) => c?.isReviewed === false).length };
}

// 回读核对（spec §6.3 第 3、5 步，§6.4）：只比 update 会写的字段。关键字段不对，这条就不是写进去的那条用例；
// 非关键字段有的区不保存（核对 8：兴趣岛丢 dimension），只提醒
export const CRITICAL_FIELDS = ['name', 'triggerType', 'triggerInputs', 'sessionMemoryCustomData', 'testNodeOutputAssertions', 'canvasActionOutputAssertions'];
const LABELS = { name: 'name', dimension: 'dimension', triggerType: '触发类型', triggerInputs: '触发输入', sessionMemoryCustomData: '会话数据', pluginMockOutputs: '插件 mock', sqlDbMockOutputs: '数据库 mock', testNodeOutputAssertions: '节点断言', canvasActionOutputAssertions: '断言', isStrictVerify: '严格校验' };
export const fieldLabel = (field) => LABELS[field] ?? field;

// 非关键字段里 null、空串、空数组、空对象都算「没有」：服务端常把没传的存成其中一种，逐字比会满屏误报
const blank = (value) => value === null || value === undefined || value === '' || (typeof value === 'object' && !Object.keys(value).length);

export function caseDiffs(sent, got, fields = Object.keys(sent ?? {})) {
  return fields
    .filter((field) => WRITABLE_FIELDS.includes(field))
    .filter((field) => {
      const [a, b] = [sent?.[field], got?.[field]];
      if (!CRITICAL_FIELDS.includes(field) && blank(a) && blank(b)) return false;
      return stableStringify(a) !== stableStringify(b);
    })
    .map((field) => ({ field, critical: CRITICAL_FIELDS.includes(field) }));
}
