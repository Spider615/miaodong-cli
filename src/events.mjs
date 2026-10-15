// 事件定义的校验和选择；请求字段核对自控制台 1.19.17 的事件编辑表单。
import { EXIT, MdError, usage } from './errors.mjs';
import { hashOf } from './canvas.mjs';

export const EVENT_DEFAULTS = {
  triggerTimesType: 'unlimited', maxTriggerTimes: 0,
  effectiveDateType: 'always', effectiveDateConfig: [],
  effectiveTimeType: 'always', effectiveTimeConfig: [],
  triggerIntervalType: 'no_interval', triggerIntervalSeconds: 0,
};
export const EVENT_FIELDS = ['name', 'variables', ...Object.keys(EVENT_DEFAULTS)];
export const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const same = (a, b) => hashOf(a) === hashOf(b);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ['string', 'number', 'boolean', 'datetime', 'image', 'audio', 'video', 'object', 'array'];

export function resolveEvent(events, query) {
  const exact = events.filter((e) => e.eventId === query);
  const prefix = exact.length ? exact : /^[0-9a-f-]{4,}$/i.test(query) ? events.filter((e) => e.eventId.startsWith(query)) : [];
  const found = prefix.length ? prefix : events.filter((e) => e.name === query);
  if (found.length === 1) return found[0];
  throw new MdError(found.length ? 'event_ambiguous' : 'event_not_found', found.length ? `「${query}」匹配到 ${found.length} 个事件，请用完整 id` : `没有事件「${query}」`, { exitCode: EXIT.TARGET, hint: 'md events --bot <智能体> 看有哪些' });
}

export function eventConfig(event) {
  return { ...structuredClone(EVENT_DEFAULTS), ...Object.fromEntries(EVENT_FIELDS.filter((k) => event[k] !== undefined).map((k) => [k, event[k]])) };
}

function schema(type, depth = 0) {
  if (depth > 20 || !object(type) || !TYPES.includes(type.type)) throw usage('事件输入的 type 必须是有效类型对象');
  if (type.type === 'array') schema(type.items, depth + 1);
  if (type.type === 'object') {
    if (!object(type.properties)) throw usage('object 输入需要 properties 对象');
    for (const value of Object.values(type.properties)) schema(value, depth + 1);
  }
}

export function inputVariables(inputs) {
  return inputs.map((input) => {
    const at = input.indexOf('=');
    if (at < 1) throw usage('--input 要写成 变量名=类型，如 text=string 或 values=array<string>');
    const name = input.slice(0, at).trim();
    const value = input.slice(at + 1).trim();
    const array = value.match(/^array<(string|number|boolean|object)>$/);
    const leaf = (t) => t === 'object' ? { type: t, properties: {} } : { type: t };
    return { name, type: array ? { type: 'array', items: leaf(array[1]) } : leaf(value) };
  });
}

export function validatePatch(patch) {
  if (!object(patch)) throw usage('事件配置必须是 JSON 对象');
  for (const key of Object.keys(patch)) if (!EVENT_FIELDS.includes(key)) throw usage(`事件配置不支持字段「${key}」`, '只接受事件定义字段；id、归属和隐藏状态不能通过配置修改');
  return patch;
}

export function validateEvent(event) {
  if (typeof event.name !== 'string' || !event.name.trim()) throw usage('事件名称不能为空');
  if (!Array.isArray(event.variables) || !event.variables.length) throw usage('事件至少需要一个输入变量（与当前控制台一致）');
  const names = new Set();
  for (const v of event.variables) {
    if (!object(v) || typeof v.name !== 'string' || !v.name.trim()) throw usage('事件输入变量名不能为空');
    if (names.has(v.name.trim())) throw usage(`事件输入变量名重复：${v.name}`);
    names.add(v.name.trim());
    schema(v.type);
  }
  const choice = (key, values) => { if (!values.includes(event[key])) throw usage(`${key} 只能是 ${values.join('、')}`); };
  choice('triggerTimesType', ['unlimited', 'limited']);
  choice('triggerIntervalType', ['no_interval', 'interval']);
  choice('effectiveDateType', ['always', 'specific']);
  choice('effectiveTimeType', ['always', 'specific']);
  for (const key of ['maxTriggerTimes', 'triggerIntervalSeconds']) if (!Number.isSafeInteger(event[key]) || event[key] < 0) throw usage(`${key} 必须是非负整数`);
  if (event.triggerIntervalType === 'interval' && event.triggerIntervalSeconds === 0) throw usage('启用触发间隔时 triggerIntervalSeconds 必须大于 0');
  for (const key of ['effectiveDateConfig', 'effectiveTimeConfig']) if (!Array.isArray(event[key])) throw usage(`${key} 必须是数组`);
  if (event.effectiveDateType === 'specific' && !event.effectiveDateConfig.length) throw usage('指定生效日期时至少需要一个日期范围');
  if (event.effectiveTimeType === 'specific' && !event.effectiveTimeConfig.length) throw usage('指定生效时间时至少需要一个时间范围');
  for (const range of event.effectiveDateConfig) {
    if (!object(range) || !Number.isFinite(range.startTimestamp) || !Number.isFinite(range.endTimestamp) || range.startTimestamp > range.endTimestamp) throw usage('生效日期需要有效且起止有序的 startTimestamp、endTimestamp（毫秒）');
  }
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  for (const range of event.effectiveTimeConfig) {
    if (!object(range) || !time.test(range.startTime) || !time.test(range.endTime) || range.startTime > range.endTime) throw usage('生效时间需要起止有序的 startTime、endTime（HH:mm）；跨天请拆成两个范围');
  }
  return event;
}

export function assertEditable(before, after, isUsed) {
  if (before.isDefault === true || before.isSystem === true || before.isBuiltin === true) throw new MdError('event_builtin', '系统事件不能修改', { exitCode: EXIT.BLOCKED });
  if (!isUsed) return;
  const a = eventConfig(before);
  const b = eventConfig(after);
  const unchanged = EVENT_FIELDS.filter((k) => k !== 'variables').every((k) => same(a[k], b[k]));
  if (!unchanged || b.variables.length < a.variables.length || !same(a.variables, b.variables.slice(0, a.variables.length))) {
    throw new MdError('event_in_use', '事件已被引用：只能保留原定义并追加输入变量，不能改名、改已有输入或触发配置', { exitCode: EXIT.BLOCKED });
  }
}
