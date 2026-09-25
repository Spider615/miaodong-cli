// 批量改用例（spec §6.4）：跑改动脚本、给脚本的 h、比较改前改后。
// 脚本约定同 md apply：export default ({ cases, h }) => void，直接改 cases 里的对象（是副本，改坏了不影响秒懂）。
// h 找不到东西就报错，不猜。

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MdError, usage } from './errors.mjs';
import { stableStringify } from './canvas.mjs';
import { WRITABLE_FIELDS } from './testcenter.mjs';
import { HISTORY_VAR, TRIGGER_TYPES, buildExpect, byName, historyValue, isObject } from './casefile.mjs';

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
      if (query instanceof RegExp) return cases.filter((c) => query.test(String(c?.name ?? '')));
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

const SHAPES = [['triggerInputs', isObject, '对象'], ['sessionMemoryCustomData', isObject, '对象'], ['testNodeOutputAssertions', Array.isArray, '数组'], ['canvasActionOutputAssertions', Array.isArray, '数组']];

// 改前改后逐条比：只看 update 会写的字段。别的字段变了、条数或 id 变了、name 空或重名、形状不对都算错（spec §6.4）
export function editChanges(before, after) {
  const errors = [];
  if (after.length !== before.length) errors.push(`用例从 ${before.length} 条变成了 ${after.length} 条：edit 不能增删用例（加用 md test import，删用 md test drop）`);
  const byId = new Map(after.map((c) => [c?.testCaseId, c]));
  const changed = [];
  for (const b of before) {
    const a = byId.get(b.testCaseId);
    if (!a) {
      errors.push(`用例「${b.name}」不见了（testCaseId 被改或被删）`);
      continue;
    }
    const locked = Object.keys({ ...b, ...a }).filter((k) => !WRITABLE_FIELDS.includes(k) && stableStringify(a[k]) !== stableStringify(b[k]));
    if (locked.length) errors.push(`用例「${b.name}」改了不能改的字段：${locked.join('、')}（只能改 ${WRITABLE_FIELDS.join('、')}）`);
    const fields = WRITABLE_FIELDS.filter((k) => stableStringify(a[k]) !== stableStringify(b[k]));
    if (fields.length) changed.push({ before: b, after: a, fields });
  }
  // name 不能空、不能重名：秒懂按 name 找用例，结果报告也靠它
  const names = new Map();
  for (const c of after) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name) errors.push(`用例 ${String(c?.testCaseId ?? '?').slice(0, 8)} 的 name 被改成空的`);
    else names.set(name, (names.get(name) ?? 0) + 1);
  }
  for (const [name, count] of names) if (count > 1) errors.push(`name「${name}」有 ${count} 条重名`);
  for (const { after: a } of changed) {
    if (!TRIGGER_TYPES.includes(a.triggerType)) errors.push(`用例「${a.name}」的触发类型「${a.triggerType}」不是秒懂的触发类型`);
    for (const [key, check, word] of SHAPES) if (!check(a[key])) errors.push(`用例「${a.name}」的 ${key} 要是${word}`);
    const assertions = Array.isArray(a.canvasActionOutputAssertions) ? a.canvasActionOutputAssertions : [];
    if (assertions.some((x) => typeof x?.verifyPayload?.type !== 'string' || x?.actionContent?.type !== x.verifyPayload.type)) {
      errors.push(`用例「${a.name}」有断言的 verifyPayload 和 actionContent 类型不一致`);
    }
  }
  return { changed, errors };
}
