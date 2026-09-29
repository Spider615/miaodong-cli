// 批量改用例（spec §6.4）：跑改动脚本、给脚本的 h、比较改前改后。
// 脚本约定同 md apply：export default ({ cases, h }) => void，直接改 cases 里的对象（是副本，改坏了不影响秒懂）。
// h 找不到东西就报错，不猜。

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MdError, usage } from './errors.mjs';
import { stableStringify } from './canvas.mjs';
import { WRITABLE_FIELDS } from './testcenter.mjs';
import { HISTORY_VAR, TRIGGER_TYPES, buildExpect, byName, historyProblem, historyValue, isObject } from './casefile.mjs';

const scriptError = (message) => new MdError('edit_script', message);

export function createEditHelpers(cases, { events, vars }, log) {
  const find = (list, name, kind) => {
    if (!list) throw scriptError(`取不到${kind}列表`);
    const { hit, error } = byName(list, String(name), kind);
    if (error) throw scriptError(error);
    return hit;
  };
  return {
    pick(query) {
      if (typeof query === 'function') return cases.filter(query);
      if (query instanceof RegExp) {
        // 去掉 g、y：带这两个标志的正则 test 会记住上次的位置，挑出来隔一条漏一条（审查 M9）
        const re = new RegExp(query.source, query.flags.replace(/[gy]/g, ''));
        return cases.filter((c) => re.test(String(c?.name ?? '')));
      }
      return (Array.isArray(query) ? query : [query]).map((name) => {
        const hits = cases.filter((c) => c?.name === name);
        if (hits.length !== 1) throw scriptError(hits.length ? `用例「${name}」有 ${hits.length} 条同名` : `没有用例「${name}」`);
        return hits[0];
      });
    },
    eventId: (name) => find(events, name, '事件').eventId,
    varId: (name) => find(vars, name, '会话变量').id,
    historyVarId: () => find(vars, HISTORY_VAR, '会话变量').id,
    expect(form) {
      const { assertions, errors } = buildExpect(form, { events });
      if (errors.length) throw scriptError(errors.join('；'));
      return assertions;
    },
    history(items) {
      const { value, error } = historyValue(items);
      if (error) throw scriptError(error);
      return value;
    },
    log(message) {
      log.push(String(message));
    },
  };
}

export async function runEditScript(file, cases, ctx) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw usage(`找不到脚本：${abs}`);
  // 带时间戳参数绕开 ESM 模块缓存（同 md apply）
  const mod = await import(`${pathToFileURL(abs).href}?t=${Date.now()}`);
  if (typeof mod.default !== 'function') throw usage(`${abs} 需要 export default ({ cases, h }) => { ... }`);
  const copy = structuredClone(cases);
  const log = [];
  try {
    await mod.default({ cases: copy, h: createEditHelpers(copy, ctx, log) });
  } catch (error) {
    if (error instanceof MdError) throw error;
    throw scriptError(`脚本出错：${error?.message ?? String(error)}`);
  }
  return { cases: copy, log };
}

// 秒懂保存用例时，把断言的 actionContent.payload.params 同步成 verifyPayload.params（09-29 实测：脚本只删了 verifyPayload
// 里的参数，存完两处都没了；库里两处始终是整份相同的拷贝）。写之前照样同步一遍，计划、写入、回读比对都按秒懂会存的样子——
// 不然回读必定「不一致」（09-29：删 62 条空的 urls 参数，报了 62 处误报）。
// 脚本改了 actionContent 那份、又和 verifyPayload 对不上（也不是原来就有的那份）：秒懂会按 verifyPayload 覆盖，改动不会生效，算错
export function syncAssertionParams(after, before) {
  const list = Array.isArray(after?.canvasActionOutputAssertions) ? after.canvasActionOutputAssertions : null;
  if (!list) return { testCase: after, errors: [] };
  const original = new Set((Array.isArray(before?.canvasActionOutputAssertions) ? before.canvasActionOutputAssertions : [])
    .map((x) => stableStringify(x?.actionContent?.payload?.params)));
  const errors = [];
  const synced = list.map((x, i) => {
    const verify = x?.verifyPayload?.params;
    const payload = x?.actionContent?.payload;
    if (!isObject(verify) || !isObject(payload) || stableStringify(payload.params) === stableStringify(verify)) return x;
    if (!original.has(stableStringify(payload.params))) {
      errors.push(`用例「${after.name}」第 ${i + 1} 条断言改了 actionContent.payload.params，和 verifyPayload.params 对不上：秒懂保存时会按 verifyPayload.params 覆盖，这个改动不会生效（要改断言参数就改 verifyPayload.params，两份会自动同步）`);
    }
    return { ...x, actionContent: { ...x.actionContent, payload: { ...payload, params: structuredClone(verify) } } };
  });
  return { testCase: { ...after, canvasActionOutputAssertions: synced }, errors };
}

const SHAPES = [['triggerInputs', isObject, '对象'], ['sessionMemoryCustomData', isObject, '对象'], ['testNodeOutputAssertions', Array.isArray, '数组'], ['canvasActionOutputAssertions', Array.isArray, '数组']];

// 改前改后逐条比：只看 update 会写的字段。别的字段变了、条数或 id 变了、name 改空或改出重名、形状不对都算错（spec §6.4）。
// historyVarId 是这个智能体「消息历史」的 id：改过的历史要核对格式
export function editChanges(before, after, { historyVarId = null } = {}) {
  const errors = [];
  if (after.length !== before.length) errors.push(`用例从 ${before.length} 条变成了 ${after.length} 条：edit 不能增删用例（加用 md test import，删用 md test drop）`);
  const byId = new Map(after.map((c) => [c?.testCaseId, c]));
  const changed = [];
  for (const b of before) {
    const found = byId.get(b.testCaseId);
    if (!found) {
      errors.push(`用例「${b.name}」不见了（testCaseId 被改或被删）`);
      continue;
    }
    const { testCase: a, errors: paramErrors } = syncAssertionParams(found, b);
    errors.push(...paramErrors);
    const locked = Object.keys({ ...b, ...a }).filter((k) => !WRITABLE_FIELDS.includes(k) && stableStringify(a[k]) !== stableStringify(b[k]));
    if (locked.length) errors.push(`用例「${b.name}」改了不能改的字段：${locked.join('、')}（只能改 ${WRITABLE_FIELDS.join('、')}）`);
    const fields = WRITABLE_FIELDS.filter((k) => stableStringify(a[k]) !== stableStringify(b[k]));
    if (fields.length) changed.push({ before: b, after: a, fields });
  }
  // name 不能改成空的、不能改出重名：秒懂按 name 找用例，结果报告也靠它。
  // 集里原来就有的重名不算（从执行记录重复导同一条执行就会这样），只看这次改了 name 的（审查 I2）
  const renamed = new Set(changed.filter((c) => c.fields.includes('name')).map((c) => c.after.testCaseId));
  const trimmed = (c) => (typeof c?.name === 'string' ? c.name.trim() : '');
  const sameName = new Map();
  for (const c of after) sameName.set(trimmed(c), [...(sameName.get(trimmed(c)) ?? []), c]);
  for (const c of after) if (renamed.has(c?.testCaseId) && !trimmed(c)) errors.push(`用例 ${String(c?.testCaseId ?? '?').slice(0, 8)} 的 name 被改成空的`);
  for (const [name, list] of sameName) if (name && list.length > 1 && list.some((c) => renamed.has(c?.testCaseId))) errors.push(`name「${name}」有 ${list.length} 条重名`);
  for (const { before: b, after: a } of changed) {
    if (!TRIGGER_TYPES.includes(a.triggerType)) errors.push(`用例「${a.name}」的触发类型「${a.triggerType}」不是秒懂的触发类型`);
    for (const [key, check, word] of SHAPES) if (!check(a[key])) errors.push(`用例「${a.name}」的 ${key} 要是${word}`);
    const assertions = Array.isArray(a.canvasActionOutputAssertions) ? a.canvasActionOutputAssertions : [];
    if (assertions.some((x) => typeof x?.verifyPayload?.type !== 'string' || x?.actionContent?.type !== x.verifyPayload.type)) {
      errors.push(`用例「${a.name}」有断言的 verifyPayload 和 actionContent 类型不一致`);
    }
    const history = historyVarId ? a.sessionMemoryCustomData?.[historyVarId] : undefined;
    if (history !== undefined && stableStringify(history) !== stableStringify(b.sessionMemoryCustomData?.[historyVarId])) {
      const problem = historyProblem(history);
      if (problem) errors.push(`用例「${a.name}」的「${HISTORY_VAR}」${problem}`);
    }
  }
  return { changed, errors };
}
