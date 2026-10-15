// 事件定义管理。所有写入默认预演、确认后单次请求、备份并回读；不提供事件删除。
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listArg, strArg } from '../args.mjs';
import { getCanvas } from '../api.mjs';
import { createEvent, eventIsUsed, importEvents, listEventDefinitions, setEventVisibility, updateEvent } from '../event-api.mjs';
import { codeFor, givenCode } from '../confirm.mjs';
import { UUID, assertEditable, eventConfig, inputVariables, object, resolveEvent, same, validateEvent, validatePatch } from '../events.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { ensureDir, ensureNewDir, mdHome, readJson, writeJson } from '../home.mjs';
import { appendLedger, readLedger } from '../ledger.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { varUsage } from '../session-vars.mjs';
import { resolveBot, targetArgs } from '../target.mjs';
import { stamp } from '../workspace.mjs';

const VERBS = { add: '新增', edit: '修改', hide: '隐藏', show: '显示', import: '导入' };
const SUBS = ['list', 'get', 'used', ...Object.keys(VERBS)];
const blocked = (message) => new MdError('event_plan_blocked', message, { exitCode: EXIT.BLOCKED, hint: '重新预演，把新的清单和计划码交给用户确认' });
const safe = (s) => String(s).replace(/[^\w.@-]+/g, '_');
const ordered = (rows) => [...rows].sort((a, b) => a.eventId.localeCompare(b.eventId));
const rawFile = (path) => {
  const value = readJson(resolve(path), undefined);
  if (value === undefined) throw usage(`文件不存在：${path}`);
  return value;
};

function patchOf(args) {
  const path = strArg(args, 'config');
  const patch = path ? validatePatch(rawFile(path)) : {};
  const name = strArg(args, 'name');
  if (name !== undefined) patch.name = name;
  const inputs = listArg(args, 'input');
  if (inputs.length) {
    if (patch.variables !== undefined) throw usage('--input 和配置文件中的 variables 只能给一边');
    patch.variables = inputVariables(inputs);
  }
  return patch;
}

async function usageOf(t, item) {
  const serverUsed = await eventIsUsed(t.identity, t.orgId, t.botId, item.eventId);
  const draft = await getCanvas(t.identity, t.orgId, t.botId, undefined, { strictRawCanvas: true });
  const nodes = (varUsage(draft.rawCanvas).get(item.eventId) ?? []).sort((a, b) => a.id.localeCompare(b.id));
  return { serverUsed, nodes };
}

function printUsage(refs) {
  out(`服务端：${refs.serverUsed ? '已被引用' : '未被引用'}；草稿引用 ${refs.nodes.length} 个节点`);
  for (const node of refs.nodes) out(`  ${node.name} [${node.id}]`);
}

function planOf(t, op, items, list, refs) {
  return { kind: 'events', origin: t.identity.origin, identityKey: t.identityKey, orgId: t.orgId, botId: t.botId, op, items, list: ordered(list), refs };
}

function verify(items, before, after, op, response) {
  const oldIds = new Set(before.map((e) => e.eventId));
  if (op === 'import') {
    const map = response?.data?.eventIdMap;
    if (!object(map) || Object.keys(map).length !== items.length || new Set(Object.values(map)).size !== items.length) throw new MdError('events_readback', '导入返回的 eventIdMap 不完整或重复，不能确认导入完成');
    for (const item of items) {
      const id = map[item.eventId];
      const got = after.find((e) => e.eventId === id);
      if (!UUID.test(id) || oldIds.has(id) || !got || !same(eventConfig(item), eventConfig(got)) || !!item.isHidden !== !!got.isHidden) throw new MdError('events_readback', `导入后事件「${item.name}」的 ID 映射或定义读回来对不上`);
    }
    return map;
  }
  for (const item of items) {
    const found = op === 'add' ? after.filter((e) => !oldIds.has(e.eventId) && e.name === item.name) : after.filter((e) => e.eventId === item.eventId);
    if (found.length !== 1 || (['hide', 'show'].includes(op) ? found[0].isHidden !== item.isHidden : !same(eventConfig(found[0]), eventConfig(item)))) throw new MdError('events_readback', `事件「${item.name}」写后读回来对不上`);
  }
  return null;
}

async function write(t, args, op, items, before, refs, operation, expectedCode) {
  const base = ensureDir(join(mdHome(), 'events', safe(t.identityKey), safe(t.orgId), safe(t.botId)));
  const lock = join(base, '.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw blocked(`本机已有事件写入或上次写入未结束：${lock}。先核对远端和操作记录；确认没有进程在写后再移除本机锁`);
    throw error;
  }
  try {
    const dir = ensureNewDir(join(base, `${stamp()}-${op}`));
    const backup = join(dir, 'before.json');
    const resultFile = join(dir, 'result.json');
    const record = { op, botId: t.botId, items, status: 'prepared', backup };
    writeJson(backup, { botId: t.botId, orgId: t.orgId, events: before });
    writeJson(join(dir, 'plan.json'), operation);
    out(`备份：${backup}`);
    // 锁内重读：不能用刚确认过但已陈旧的事件列表或引用状态写入。
    const current = await listEventDefinitions(t.identity, t.orgId, t.botId);
    const currentRefs = refs ? await usageOf(t, items[0]) : null;
    const latest = planOf(t, op, items, current, currentRefs);
    const auth = codeFor(latest, readLedger());
    if (!same(operation, latest) || auth.code !== expectedCode) throw blocked('计划码对不上：写入前事件列表、引用状态或本机操作记录发生变化');
    record.status = 'sending';
    writeJson(resultFile, record);
    // 请求前消耗确认码并记意图。超时、业务失败、回读失败都不自动重发，更不删事件来补偿。
    appendLedger({ at: new Date().toISOString(), kind: 'events', op, opKey: auth.opKey, identityKey: t.identityKey, origin: t.identity.origin, regionLabel: t.regionLabel, orgId: t.orgId, orgName: t.orgName, botId: t.botId, botName: t.botName, items: items.map((e) => ({ eventId: e.eventId, name: e.name })), resultFile, backup });
    try {
      if (op === 'add') record.response = await createEvent(t.identity, t.orgId, t.botId, items[0]);
      else if (op === 'edit') record.response = await updateEvent(t.identity, t.orgId, t.botId, items[0]);
      else if (op === 'import') record.response = await importEvents(t.identity, t.orgId, t.botId, items);
      else record.response = await setEventVisibility(t.identity, t.orgId, items[0].eventId, items[0].isHidden);
      record.status = 'readback_pending';
      writeJson(resultFile, record);
      if (op === 'import') writeJson(join(dir, 'event-id-map.json'), { eventIdMap: record.response?.data?.eventIdMap ?? null });
      const after = await listEventDefinitions(t.identity, t.orgId, t.botId);
      const eventIdMap = verify(items, before, after, op, record.response);
      record.status = 'verified';
      record.after = after;
      writeJson(resultFile, record);
      if (eventIdMap) {
        const mapping = join(dir, 'event-id-map.json');
        const output = strArg(args, 'out');
        if (output) writeJson(resolve(output), { eventIdMap });
        out(`ID 映射：${mapping}`);
        for (const [from, to] of Object.entries(eventIdMap)) out(`  ${from} → ${to}`);
        out('画布中的旧事件 ID 要按映射替换后另行预演推送；本命令只导入事件定义。');
      }
      out(`✅ 已${VERBS[op]} ${items.length} 个事件，读回核对过`);
      return EXIT.OK;
    } catch (error) {
      record.status = record.status === 'sending' ? 'request_failed_or_unknown' : 'readback_failed';
      record.error = error.message;
      writeJson(resultFile, record);
      throw new MdError(error.code ?? 'events_write_failed', error.message, { exitCode: error.exitCode ?? EXIT.ERROR, hint: `操作记录：${resultFile}；先只读核对远端，不能盲目重发或删除重建` });
    }
  } finally { rmSync(lock, { recursive: true }); }
}

export const events = {
  summary: '流程事件：列表、详情、引用检查、新增、修改、隐藏／显示、导入；禁止删除，写前预演确认',
  usage: [
    'md events [list] --bot <智能体> [--out <events.json>]          全部事件（包含隐藏的）；可导出完整定义',
    'md events get <名字或id> --bot <智能体> [--out <event.json>]   查看完整定义',
    'md events used <名字或id> --bot <智能体>                     检查服务端和草稿引用',
    'md events add <名字> --input text=string [--input score=number] [--config <配置.json>] --bot <智能体>',
    'md events edit <名字或id> [--name 新名字] [--input …] [--config <配置.json>] --bot <智能体>',
    'md events hide|show <名字或id> --bot <智能体>                 隐藏／显示',
    'md events import <events.json> --bot <智能体> [--out <映射.json>]   导入并保存 eventIdMap，不写画布',
    '写操作默认只预演；用户明确同意后同一条命令加 --confirm <计划码>。禁止删除事件，包括回滚和失败补偿。',
    '配置文件接受 name、variables、触发次数、生效日期／时间和触发间隔；--input 是完整输入列表，已引用事件只能在原列表后追加。',
  ].join('\n'),
  async run(args) {
    const [first, ...rest] = args._;
    if (['rm', 'delete', 'drop', 'remove', 'del'].includes(first)) throw new MdError('event_delete_forbidden', '禁止删除事件；没有删除入口，确认码也不能放行', { exitCode: EXIT.BLOCKED });
    const op = first ?? 'list';
    if (!SUBS.includes(op)) throw usage(`不认识「md events ${op}」`, events.usage);
    const allowed = new Set(['bot', 'org', 'region', 'refresh', 'help', ...(op in VERBS ? ['confirm'] : []), ...(['list', 'get', 'import'].includes(op) ? ['out'] : []), ...(['add', 'edit'].includes(op) ? ['input', 'config'] : []), ...(op === 'edit' ? ['name'] : [])]);
    for (const key of Object.keys(args)) if (key !== '_' && !allowed.has(key)) throw usage(`md events ${op} 不支持参数 --${key}`);
    const given = givenCode(args);
    const output = strArg(args, 'out');
    const params = first === undefined ? [] : rest;
    if (op === 'list' ? params.length : params.length !== 1) throw usage(events.usage);
    // 文件和配置先整体校验，再找智能体、再预演。导入后才发现包尾有错会留下部分资源。
    const patch = ['add', 'edit'].includes(op) ? patchOf(args) : null;
    let imported;
    if (op === 'import') {
      const content = rawFile(params[0]);
      imported = Array.isArray(content) ? content : content?.events;
      if (!Array.isArray(imported) || !imported.length) throw usage('导入文件需要非空事件数组，或包含 events 数组的对象');
      const ids = new Set();
      const names = new Set();
      imported = imported.map((e) => {
        if (!object(e) || !UUID.test(e.eventId) || ids.has(e.eventId) || names.has(e.name)) throw usage('导入事件需要唯一的完整 UUID 和不重复的名称');
        if (e.isDefault === true || e.isSystem === true || e.isBuiltin === true) throw usage('不能导入系统事件');
        if (e.isHidden !== undefined && typeof e.isHidden !== 'boolean') throw usage('isHidden 必须是布尔值');
        ids.add(e.eventId); names.add(e.name);
        // 与前端导入一致保留源事件附加字段；归属在明确目标之后统一改成目标智能体。
        return { ...e, ...validateEvent(eventConfig(e)), eventId: e.eventId, isHidden: e.isHidden ?? false };
      });
    }
    const t = await resolveBot(targetArgs(args));
    const list = await listEventDefinitions(t.identity, t.orgId, t.botId);
    out(targetLine(t));
    if (op === 'list') {
      out(`事件 ${list.length} 个（包含隐藏事件）：`);
      for (const e of list) out(`  ${e.name} · ${e.isHidden ? '隐藏' : '显示'} · 输入 ${e.variables.map((v) => v.name).join('、') || '-'} · ${e.eventId}`);
      if (output) { writeJson(resolve(output), { botId: t.botId, events: list }); out(`已存：${resolve(output)}`); }
      return EXIT.OK;
    }
    const current = !['add', 'import'].includes(op) ? resolveEvent(list, params[0]) : null;
    if (op === 'get') {
      out(JSON.stringify(current, null, 2));
      if (output) { writeJson(resolve(output), current); out(`已存：${resolve(output)}`); }
      return EXIT.OK;
    }
    const refs = ['used', 'edit'].includes(op) ? await usageOf(t, current) : null;
    if (op === 'used') { printUsage(refs); return EXIT.OK; }
    let items;
    if (op === 'add') {
      if (patch.name !== undefined && patch.name !== params[0]) throw usage('配置中的 name 与命令行事件名称不一致');
      items = [validateEvent(eventConfig({ ...patch, name: params[0], variables: patch.variables ?? [] }))];
    } else if (op === 'edit') {
      if (!Object.keys(patch).length) throw usage('用 --name、--input 或 --config 指定要改的内容');
      const next = { ...current, ...patch };
      validateEvent(eventConfig(next));
      assertEditable(current, next, refs.serverUsed || refs.nodes.length > 0);
      items = [next];
      printUsage(refs);
    } else if (op === 'import') items = imported.map((e) => ({ ...e, botId: t.botId, orgId: t.orgId }));
    else items = [{ ...current, isHidden: op === 'hide' }];
    if (['add', 'edit', 'import'].includes(op)) for (const e of items) if (list.some((x) => x.name.trim() === e.name.trim() && (op !== 'edit' || x.eventId !== e.eventId))) throw blocked(`已经有同名事件「${e.name}」，不创建副本或覆盖`);
    const operation = planOf(t, op, items, list, refs);
    const auth = codeFor(operation, readLedger());
    if (given !== null && given !== auth.code) throw blocked('计划码对不上：目标、输入、事件列表、引用状态已变化，或该码已经用过');
    if (current && same(current, items[0])) { out('当前定义已经是目标状态，不用写入'); return EXIT.OK; }
    out(`要${VERBS[op]} ${items.length} 个事件：`);
    for (const e of items) out(JSON.stringify(op === 'import' ? e : ['hide', 'show'].includes(op) ? { eventId: e.eventId, name: e.name, isHidden: e.isHidden } : { ...eventConfig(e), ...(e.eventId ? { eventId: e.eventId } : {}) }, null, 2));
    if (op === 'import') out('导入会创建新事件 ID；本命令不自动修改画布。');
    if (given === null) {
      out(`这是预演，什么都没写。计划码：${auth.code}`);
      out(`用户明确同意后，在同一条命令加 --confirm ${auth.code}`);
      return EXIT.OK;
    }
    return write(t, args, op, items, list, refs, operation, given);
  },
};
