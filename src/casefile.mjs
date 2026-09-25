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
