// 外部用例 JSONL（spec §6.3）：解析、本地校验、生成请求体。纯逻辑，不发请求。
// 断言只生成 spec §2.3 核对 8 实测过的形状：发文本、发事件、转人工；别的形状用 raw 原样写
// （断言写错时秒懂不报错，这条断言永远不生效）。

import { asArray } from './api.mjs';

// 服务端的触发类型枚举：核对 8 里 create 的 400 校验列出来的，共 20 个
export const TRIGGER_TYPES = ['input', 'receive-text-message', 'receive-image-message', 'receive-audio-message', 'receive-video-message', 'receive-file-message', 'receive-other-message', 'receive-intent-comment', 'receive-note-message', 'receive-share-note-comment-message', 'receive-email-message', 'custom-attr-event', 'tag-event', 'join-room', 'new-friend', 'canvas-event-trigger', 'bot-receive-text-message', 'write-message', 'contact-lead-filled', 'wecom-contact-bind'];

export const HISTORY_VAR = '消息历史';
const DEFAULT_THRESHOLD = 0.75; // 秒懂自动生成的相似度断言用的就是 0.75

export const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// 每行一个 JSON 对象；空行跳过；去掉 BOM 和行尾 \r（Excel、Windows 转出来的文件常带）
export function parseCaseLines(text) {
  const rows = [];
  const errors = [];
  String(text).replace(/^﻿/, '').split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      errors.push({ line: i + 1, reason: `不是 JSON：${error.message}` });
      return;
    }
    if (isObject(value)) rows.push({ line: i + 1, value });
    else errors.push({ line: i + 1, reason: '不是 JSON 对象（一行要是一个 {…}）' });
  });
  return { rows, errors };
}

// 按名字找唯一的一项：没有、重名都算错
export function byName(list, name, kind) {
  const hits = asArray(list).filter((x) => String(x?.name ?? '') === name);
  if (hits.length === 1) return { hit: hits[0] };
  return { error: hits.length ? `${kind}「${name}」在这个智能体里有 ${hits.length} 个同名` : `${kind}「${name}」在这个智能体里没有` };
}

// 「消息历史」的值：字符串记成 user 说的（图片写裸 URL）；对象要 {role: user 或 assistant, content}（真实历史里只见过这两种 role）
export function historyValue(items) {
  if (!Array.isArray(items)) return { error: 'history 要写成数组' };
  const value = [];
  for (const [i, item] of items.entries()) {
    if (typeof item === 'string') value.push({ role: 'user', content: item });
    else if (isObject(item) && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string') value.push({ role: item.role, content: item.content });
    else return { error: `history 第 ${i + 1} 项要么是字符串，要么是 {role: user 或 assistant, content: 字符串}` };
  }
  return { value };
}

// 判定写法（reply 和事件变量共用）：字符串 = LLM 判定；或者 {llm} / {similar, threshold} / {equal} 三选一。
// 事件变量的 LLM 判定带 value: ''，和真实用例里的一样（核对 8）
function verifyOf(spec, { param = false } = {}) {
  const llm = (description) => (param ? { verifyType: 'llm', description, value: '' } : { verifyType: 'llm', description });
  if (typeof spec === 'string') return spec.trim() ? { verify: llm(spec) } : { error: '判定不能是空字符串' };
  const keys = isObject(spec) ? ['llm', 'similar', 'equal'].filter((k) => spec[k] !== undefined) : [];
  const extra = isObject(spec) ? Object.keys(spec).filter((k) => !['llm', 'similar', 'equal', 'threshold'].includes(k)) : [];
  if (keys.length !== 1 || extra.length) return { error: '判定要写成字符串（LLM 判定），或者 {llm}、{similar, threshold}、{equal} 三选一' };
  const [kind] = keys;
  const text = spec[kind];
  if (typeof text !== 'string' || !text.trim()) return { error: `${kind} 要写成非空字符串` };
  if (spec.threshold !== undefined && kind !== 'similar') return { error: 'threshold 只用于 similar' };
  if (kind === 'llm') return { verify: llm(text) };
  if (kind === 'equal') return { verify: { verifyType: 'equal', value: text } };
  const threshold = spec.threshold ?? DEFAULT_THRESHOLD;
  if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) return { error: 'threshold 要是 0 到 1 之间的数' };
  return { verify: { verifyType: 'similarity', value: text, threshold } };
}

const failed = (message) => ({ assertions: [], errors: [message] });

// 一种写法 → 断言
function formAssertions(form, events) {
  const keys = isObject(form) ? Object.keys(form) : [];
  if (typeof form === 'string' || keys.includes('reply')) {
    if (keys.length > 1) return failed('reply 要单独写一项');
    const { verify, error } = verifyOf(typeof form === 'string' ? form : form.reply);
    if (error) return failed(error);
    return { assertions: [{ verifyPayload: { type: 'send-text-message', text: verify }, actionContent: { type: 'send-text-message', payload: { text: verify } } }], errors: [] };
  }
  if (keys.includes('handover')) {
    if (form.handover !== true || keys.length > 1) return failed('转人工写成 {handover: true}');
    return { assertions: [{ verifyPayload: { type: 'handover' }, actionContent: { type: 'handover' } }], errors: [] };
  }
  if (keys.includes('event')) {
    const extra = keys.filter((k) => !['event', 'params'].includes(k));
    if (extra.length) return failed(`发事件只认 event、params，多了 ${extra.join('、')}`);
    if (!events) return failed(`取不到事件列表，没法把「${form.event}」换成 id`);
    const { hit, error } = byName(events, String(form.event ?? ''), '事件');
    if (error) return failed(error);
    if (form.params !== undefined && !isObject(form.params)) return failed('params 要写成 {事件变量名: 判定}');
    const known = new Set(asArray(hit.variables).map((v) => String(v?.name ?? '')));
    const params = {};
    const errors = [];
    for (const [name, spec] of Object.entries(form.params ?? {})) {
      if (!known.has(name)) {
        errors.push(`事件「${hit.name}」没有变量「${name}」`);
        continue;
      }
      const { verify, error: problem } = verifyOf(spec, { param: true });
      if (problem) errors.push(`params.${name}：${problem}`);
      else params[name] = verify;
    }
    if (errors.length) return { assertions: [], errors };
    return { assertions: [{ verifyPayload: { type: 'canvas-event-action', eventId: hit.eventId, params }, actionContent: { type: 'canvas-event-action', payload: { eventId: hit.eventId, eventName: hit.name, params } } }], errors: [] };
  }
  if (keys.includes('raw')) {
    if (keys.length > 1) return failed('raw 要单独写一项');
    const list = Array.isArray(form.raw) ? form.raw : [form.raw];
    const bad = list.some((a) => !isObject(a) || typeof a?.verifyPayload?.type !== 'string' || a?.actionContent?.type !== a.verifyPayload.type);
    return bad ? failed('raw 断言要有 verifyPayload 和 actionContent，两份的 type 一样') : { assertions: list, errors: [] };
  }
  return failed('认不出来。可以写字符串、{reply}、{handover: true}、{event, params}、{raw}');
}

// expect → canvasActionOutputAssertions，顺序照写的顺序。events 取不到时是 null
export function buildExpect(expect, { events }) {
  const forms = expect === undefined ? [] : Array.isArray(expect) ? expect : [expect];
  const assertions = [];
  const errors = [];
  forms.forEach((form, i) => {
    const at = forms.length > 1 ? `expect 第 ${i + 1} 项` : 'expect';
    const one = formAssertions(form, events);
    assertions.push(...one.assertions);
    errors.push(...one.errors.map((e) => `${at}：${e}`));
  });
  return { assertions, errors };
}

const FIELDS = new Set(['name', 'trigger', 'text', 'image', 'event', 'data', 'input', 'history', 'vars', 'expect', 'scenario', 'dimension', 'strict', 'mocks']);
const TYPE_WORD = { string: '字符串', number: '数字', boolean: '布尔值', array: '数组' };

// 值和变量类型对不上时说要什么；tag、datetime 等类型不核对
function typeProblem(value, type) {
  const want = typeof type === 'string' ? type : type?.type;
  if (!TYPE_WORD[want]) return null;
  const ok = want === 'array' ? Array.isArray(value) : typeof value === want;
  return ok ? null : `要${TYPE_WORD[want]}`;
}

// 场景树拍平：每个节点带路径（父/子）
export function flattenTree(tree) {
  const out = [];
  const walk = (nodes, parent) => {
    for (const n of asArray(nodes)) {
      const name = String(n?.name ?? '');
      const path = String(n?.path || (parent ? `${parent}/${name}` : name));
      out.push({ id: n?.id, name, path, ownCaseCount: Number(n?.ownCaseCount) || 0 });
      walk(n?.children, path);
    }
  };
  walk(tree, '');
  return out;
}

// 带「/」按路径找，否则按名字找；同名的要求写路径
export function resolveScenario(nodes, query) {
  const hits = nodes.filter((n) => (query.includes('/') ? n.path === query : n.name === query));
  if (hits.length === 1) return { hit: hits[0] };
  if (hits.length > 1) return { error: `场景「${query}」有 ${hits.length} 个同名，写完整路径（父/子）：${hits.map((n) => n.path).join('、')}` };
  return { error: `没有场景「${query}」` };
}

// 触发：简写或 input → [triggerType, triggerInputs]。不写 trigger 时按简写推（spec §6.3）
function triggerOf(v, events, errors) {
  const shorthand = ['text', 'image', 'event', 'data'].filter((k) => v[k] !== undefined);
  if (v.trigger !== undefined && !TRIGGER_TYPES.includes(v.trigger)) {
    errors.push(`trigger「${v.trigger}」不是秒懂的触发类型`);
    return [v.trigger, {}];
  }
  if (v.input !== undefined) {
    if (shorthand.length) errors.push(`input 不能和 ${shorthand.join('、')} 一起写`);
    if (v.trigger === undefined) errors.push('写了 input 就要写 trigger');
    if (!isObject(v.input)) {
      errors.push('input 要写成对象（完整的 triggerInputs）');
      return [v.trigger, {}];
    }
    if (v.trigger === 'canvas-event-trigger' && events && !events.some((e) => e.eventId === v.input.eventId)) errors.push(`input.eventId「${v.input.eventId}」在这个智能体里没有`);
    return [v.trigger, v.input];
  }
  const trigger = v.trigger ?? (v.event !== undefined ? 'canvas-event-trigger' : v.image !== undefined ? 'receive-image-message' : v.text !== undefined ? 'receive-text-message' : undefined);
  const only = (allowed) => {
    const extra = shorthand.filter((k) => !allowed.includes(k));
    if (extra.length) errors.push(`${trigger} 用例不写 ${extra.join('、')}`);
  };
  if (trigger === 'receive-text-message') {
    only(['text']);
    if (typeof v.text !== 'string' || !v.text.trim()) errors.push('文本用例要写 text');
    return [trigger, { text: v.text }];
  }
  if (trigger === 'receive-image-message') {
    // 用户另发的文字属于聊天历史（IM 里文字和图片是两条消息）；triggerInputs.text 在秒懂里是图片自带的说明文字
    if (v.text !== undefined) errors.push('图片用例不写 text：用户另发的文字写进 history（text 在秒懂里是图片自带的说明文字）');
    only(['image', 'text']);
    if (typeof v.image !== 'string' || !v.image.trim()) errors.push('图片用例要写 image（最后一张图的 URL）');
    return [trigger, { imageUrl: v.image }];
  }
  if (trigger === 'canvas-event-trigger') {
    only(['event', 'data']);
    if (v.data !== undefined && !isObject(v.data)) errors.push('data 要写成 {事件变量名: 值}');
    if (!events) {
      errors.push(`取不到事件列表，没法把「${v.event}」换成 id`);
      return [trigger, {}];
    }
    const { hit, error } = byName(events, String(v.event ?? ''), '事件');
    if (error) {
      errors.push(error);
      return [trigger, {}];
    }
    const variables = new Map(asArray(hit.variables).map((x) => [String(x?.name ?? ''), x]));
    const data = isObject(v.data) ? v.data : {};
    for (const [key, value] of Object.entries(data)) {
      if (!variables.has(key)) errors.push(`事件「${hit.name}」没有变量「${key}」`);
      else {
        const problem = typeProblem(value, variables.get(key).type);
        if (problem) errors.push(`事件变量「${key}」${problem}`);
      }
    }
    return [trigger, { eventId: hit.eventId, data }];
  }
  if (trigger === undefined) errors.push('缺触发：写 text、image、event 之一，或者 trigger + input');
  else errors.push(`「${trigger}」没有简写，要写 input（完整的 triggerInputs）`);
  return [trigger, {}];
}

// 会话数据：history 写进「消息历史」，vars 按名字换成 id
function sessionOf(v, vars, errors) {
  const session = {};
  if (v.history !== undefined) {
    const history = historyValue(v.history);
    if (history.error) errors.push(history.error);
    else if (!vars) errors.push('取不到会话变量列表，history 写不进去');
    else {
      const { hit, error } = byName(vars, HISTORY_VAR, '会话变量');
      if (error) errors.push(`${error}，history 写不进去（可以用 vars 写进别的变量）`);
      else session[hit.id] = history.value;
    }
  }
  if (v.vars !== undefined) {
    if (!isObject(v.vars)) errors.push('vars 要写成 {会话变量名: 值}');
    else if (!vars) errors.push('取不到会话变量列表，没法把 vars 的名字换成 id');
    else {
      for (const [varName, value] of Object.entries(v.vars)) {
        const { hit, error } = byName(vars, varName, '会话变量');
        if (error) {
          errors.push(error);
          continue;
        }
        if (hit.id in session) {
          errors.push(`「${varName}」写了两遍（history 就是写进「${HISTORY_VAR}」的）`);
          continue;
        }
        const problem = typeProblem(value, hit.type);
        if (problem) errors.push(`会话变量「${varName}」${problem}`);
        else session[hit.id] = value;
      }
    }
  }
  return session;
}

// 一行 → 一条用例（create 的请求体）。ctx.scenarios 是 null 表示这个区没有场景树
export function buildCase(row, { events, vars, scenarios }) {
  const v = row.value;
  const errors = [];
  const warnings = [];
  const unknown = Object.keys(v).filter((k) => !k.startsWith('_') && !FIELDS.has(k));
  if (unknown.length) errors.push(`不认识的字段：${unknown.join('、')}（自己的备注写在 _ 开头的字段里）`);
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) errors.push('缺 name');
  const [triggerType, triggerInputs] = triggerOf(v, events, errors);
  const sessionMemoryCustomData = sessionOf(v, vars, errors);
  const expect = buildExpect(v.expect, { events });
  errors.push(...expect.errors);
  if (v.expect === undefined) warnings.push('没写 expect：没有断言，跑了只能看实际回复');
  let scenarioNodeId = null;
  if (v.scenario !== undefined) {
    if (typeof v.scenario !== 'string' || !v.scenario.trim()) errors.push('scenario 要写场景名或路径');
    else if (scenarios === null) warnings.push('这个区没有场景树，scenario 不挂');
    else {
      const { hit, error } = resolveScenario(scenarios, v.scenario.trim());
      if (error) errors.push(error);
      else scenarioNodeId = hit.id;
    }
  }
  if (v.dimension !== undefined && typeof v.dimension !== 'string') errors.push('dimension 要写成字符串');
  if (v.strict !== undefined && typeof v.strict !== 'boolean') errors.push('strict 要写成 true 或 false');
  const mocks = v.mocks ?? {};
  const mocksOk = isObject(mocks) && Object.keys(mocks).every((k) => ['plugin', 'sql'].includes(k)) && [mocks.plugin, mocks.sql].every((m) => m === undefined || Array.isArray(m));
  if (!mocksOk) errors.push('mocks 要写成 {plugin: [...], sql: [...]}');
  const testCase = {
    name, triggerType, triggerInputs, sessionMemoryCustomData,
    pluginMockOutputs: mocksOk && mocks.plugin ? mocks.plugin : [],
    sqlDbMockOutputs: mocksOk && mocks.sql ? mocks.sql : [],
    testNodeOutputAssertions: [],
    canvasActionOutputAssertions: expect.assertions,
    isStrictVerify: v.strict === true,
    ...(typeof v.dimension === 'string' ? { dimension: v.dimension } : {}),
  };
  return { testCase, scenarioNodeId, errors, warnings };
}

// 全部行：逐行生成，再查 name 重复（文件里、和集里已有的）。有错误就一条都不写（spec §6.3 第 1 步）
export function buildCases(rows, ctx, { existingNames = [] } = {}) {
  const built = rows.map((row) => ({ line: row.line, ...buildCase(row, ctx) }));
  const lines = new Map();
  for (const b of built) if (b.testCase.name) lines.set(b.testCase.name, [...(lines.get(b.testCase.name) ?? []), b.line]);
  const existing = new Set(existingNames);
  for (const b of built) {
    const at = lines.get(b.testCase.name) ?? [];
    if (at.length > 1) b.errors.push(`name「${b.testCase.name}」在第 ${at.join('、')} 行重复`);
    if (existing.has(b.testCase.name)) b.errors.push(`name「${b.testCase.name}」集里已经有了`);
  }
  const errors = built.flatMap((b) => b.errors.map((reason) => ({ line: b.line, name: b.testCase.name, reason })));
  return { built, errors };
}
