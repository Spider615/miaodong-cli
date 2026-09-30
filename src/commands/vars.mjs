// md vars：智能体的会话属性定义（session memory）——列出、新增（可以按名字从别的智能体复制）、修改、删除。
// 调整 case、迁移功能时要增删改会话属性本身（用户 09-30 要的）。会话属性没有草稿这一层，写进去立刻对整个智能体生效，
// 所以写操作按 09-27 的规矩：默认只预演，带 --confirm <计划码> 才写；写完读回核对、记账；改、删之前把定义备份到本机。
// 删除和改类型：草稿、线上版本、灰度版本里有节点在用就拦下（秒懂自己只拦线上版本，草稿里的引用它不管，删了草稿就断了）

import { join } from 'node:path';
import { strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { basicInfo, createSessionVar, deleteSessionVar, getCanvas, listSessions, listVersions, updateSessionVar } from '../api.mjs';
import { resolveBot, targetArgs } from '../target.mjs';
import { ensureDir, mdHome, writeJson } from '../home.mjs';
import { appendLedger } from '../ledger.mjs';
import { hashOf } from '../canvas.mjs';
import { confirmCode, givenCode } from '../confirm.mjs';
import { stamp } from '../workspace.mjs';
import { out, shortId, targetLine } from '../output.mjs';
import { VAR_TYPES, normalizeVar, resolveVar, varUsage } from '../session-vars.mjs';

const safe = (value) => String(value).replace(/[^\w.@-]+/g, '_');
const blocked = (code, message, hint = '') => new MdError(code, message, { exitCode: EXIT.BLOCKED, hint });
const line = (v) => `${v.name} · ${v.type || '?'} · ${v.description || '-'}`;

async function varsOf(identity, orgId, botId, botName) {
  const rows = await listSessions(identity, orgId, botId);
  if (!rows) throw new MdError('vars_unavailable', `取不到「${botName}」的会话属性列表`, { hint: '过一会儿再试；这个区的版本可能不支持这个接口' });
  return rows.map(normalizeVar);
}

// 计划码绑定这次要做的事和预演时的整份列表：预演之后会话属性被人改过，码就对不上
const planOf = (t, op, items, list) => confirmCode({ kind: `vars-${op}`, botId: t.botId, items, list: hashOf(list) });

function confirmOrPreview(t, args, op, code, command) {
  const given = givenCode(args);
  if (given === null) {
    out(`这是预演，什么都没写。计划码：${code}`);
    out(`用户明确同意后执行：${command} --confirm ${code}`);
    return false;
  }
  if (given !== code) throw blocked('plan_mismatch', `计划码对不上（给的是 ${given || '空'}，当前是 ${code}）：预演之后会话属性被改过，或者计划码抄错了`, '重新预演一次，把新的清单给用户看');
  return true;
}

// 草稿、线上版本、灰度版本里在用这个会话属性的节点
async function usageOf(t) {
  const draft = await getCanvas(t.identity, t.orgId, t.botId);
  const places = [{ label: '草稿', canvas: draft.rawCanvas }];
  const info = await basicInfo(t.identity, t.orgId, t.botId);
  const versions = await listVersions(t.identity, t.orgId, draft.canvasId).catch(() => []);
  const online = info?.enabledCanvasId ? versions.find((v) => v.canvasId === info.enabledCanvasId) ?? { canvasId: info.enabledCanvasId, version: info.canvasVersion } : null;
  if (online) places.push({ label: `线上版本 ${online.version || shortId(online.canvasId)}`, canvasId: online.canvasId });
  for (const v of versions.filter((x) => x.isCanary && x.canvasId !== online?.canvasId)) places.push({ label: `灰度版本 ${v.version || shortId(v.canvasId)}`, canvasId: v.canvasId });
  for (const p of places) if (!p.canvas) p.canvas = (await getCanvas(t.identity, t.orgId, t.botId, p.canvasId)).rawCanvas;
  const notes = info ? [] : ['线上版本取不到（这个区的接口不支持），只查了草稿和灰度'];
  return { places: places.map((p) => ({ label: p.label, usage: varUsage(p.canvas) })), notes };
}

// 有节点在用就拦下：先把节点列出来，再报错
function refuseIfUsed(v, usageInfo, what) {
  const hits = usageInfo.places.map((p) => ({ label: p.label, nodes: p.usage.get(v.id) ?? [] })).filter((p) => p.nodes.length);
  if (!hits.length) return;
  for (const p of hits) out(`  ${p.label}：${p.nodes.slice(0, 10).map((n) => `${n.name} [${shortId(n.id)}]`).join('、')}${p.nodes.length > 10 ? ` 等 ${p.nodes.length} 个` : ''}`);
  throw blocked('var_in_use', `「${v.name}」有节点在用（${hits.map((p) => `${p.label} ${p.nodes.length} 个`).join('、')}），不能${what}`, '先在画布里把这些节点改掉、推到草稿、发布，再来');
}

function record(t, op, items, extra = {}) {
  appendLedger({
    at: new Date().toISOString(), kind: 'vars', op,
    identityKey: t.identityKey, regionLabel: t.regionLabel, origin: t.identity.origin,
    orgId: t.orgId, orgName: t.orgName, botId: t.botId, botName: t.botName, items, ...extra,
  });
}

function backup(t, op, items) {
  const file = join(ensureDir(join(mdHome(), 'vars', safe(t.identityKey), safe(t.botId.slice(0, 8)))), `${stamp()}-${op}.json`);
  writeJson(file, { botId: t.botId, botName: t.botName, items });
  return file;
}

async function list(t) {
  const vars = await varsOf(t.identity, t.orgId, t.botId, t.botName);
  const draft = await getCanvas(t.identity, t.orgId, t.botId);
  const usage = varUsage(draft.rawCanvas);
  out(targetLine(t));
  out(`会话属性 ${vars.length} 个（系统默认 ${vars.filter((v) => v.isDefault).length} 个）：`);
  for (const v of [...vars.filter((x) => !x.isDefault), ...vars.filter((x) => x.isDefault)]) {
    const used = usage.get(v.id)?.length ?? 0;
    out(`  ${line(v)} · ${v.isDefault ? '系统默认' : used ? `草稿里 ${used} 个节点在用` : '没有节点在用'} · ${shortId(v.id)}`);
  }
  return EXIT.OK;
}

async function add(t, args) {
  const names = args._;
  if (!names.length) throw usage('缺名字：md vars add <名字> … --type string|number|boolean --bot <智能体>');
  if (new Set(names).size !== names.length) throw usage('名字给重复了');
  const fromBot = strArg(args, 'from-bot');
  const type = strArg(args, 'type');
  const desc = strArg(args, 'desc');
  if (fromBot && (type !== undefined || desc !== undefined)) throw usage('--from-bot 和 --type / --desc 只能给一边', '--from-bot 照源智能体的类型和描述建；自己定就用 --type、--desc');
  if (!fromBot && type === undefined) throw usage('缺 --type string|number|boolean（或者用 --from-bot 照别的智能体建）');
  if (type !== undefined && !VAR_TYPES.includes(type)) throw usage(`--type 只能是 ${VAR_TYPES.join('、')}（控制台也只给这三种）`);

  let items;
  let source = null;
  if (fromBot) {
    source = await resolveBot({ bot: fromBot });
    const theirs = await varsOf(source.identity, source.orgId, source.botId, source.botName);
    items = names.map((name) => {
      const hits = theirs.filter((v) => v.name === name);
      if (!hits.length) throw new MdError('var_not_found', `「${source.botName}」里没有会话属性「${name}」`, { exitCode: EXIT.TARGET });
      if (hits.length > 1) throw new MdError('var_ambiguous', `「${source.botName}」里有 ${hits.length} 个会话属性叫「${name}」`, { exitCode: EXIT.TARGET, hint: '在秒懂上看一眼，只复制其中一个的话用 --type、--desc 自己建' });
      if (hits[0].isDefault) throw blocked('var_builtin', `「${name}」在「${source.botName}」里是系统默认的会话属性，每个智能体本来就有，不用建`);
      if (!VAR_TYPES.includes(hits[0].type)) throw blocked('var_type', `「${name}」在「${source.botName}」里的类型是 ${hits[0].type}，控制台只能建 ${VAR_TYPES.join('、')}`);
      return { name, type: hits[0].type, description: hits[0].description };
    });
  } else {
    items = names.map((name) => ({ name, type, description: desc ?? '' }));
  }

  const vars = await varsOf(t.identity, t.orgId, t.botId, t.botName);
  for (const it of items) {
    if (!it.name.trim()) throw usage('名字不能是空的');
    if (vars.some((v) => v.name === it.name)) throw blocked('var_exists', `已经有会话属性「${it.name}」`, '会话属性不许重名：--var、跨智能体导入换 id、用例文件里的 vars 都按名字找');
  }
  out(targetLine(t));
  out(`要新增 ${items.length} 个会话属性：`);
  for (const it of items) out(`  + ${line(it)}${source ? `（照「${source.botName}」）` : ''}`);
  out('写进去立刻对整个智能体生效（会话属性没有草稿这一层）；新建的要在画布里自己接上');
  const code = planOf(t, 'add', items, vars);
  const flags = source ? ` --from-bot ${shortId(source.botId)}` : ` --type ${type}${desc !== undefined ? ` --desc "${desc}"` : ''}`;
  if (!confirmOrPreview(t, args, 'add', code, `md vars add ${names.join(' ')}${flags} --bot ${shortId(t.botId)}`)) return EXIT.OK;

  const created = [];
  try {
    for (const it of items) {
      await createSessionVar(t.identity, t.orgId, t.botId, it);
      created.push(it.name);
    }
  } finally {
    // 建了几个就记几个：中途出错时，已经建进去的也要留下记录
    if (created.length) record(t, 'add', items.filter((it) => created.includes(it.name)));
  }
  // 读回核对：每个名字正好一个，类型和描述对得上（新建接口不回 id，按名字认）
  const after = await varsOf(t.identity, t.orgId, t.botId, t.botName);
  const got = items.map((it) => ({ it, hits: after.filter((v) => v.name === it.name && !vars.some((old) => old.id === v.id)) }));
  const wrong = got.filter(({ it, hits }) => hits.length !== 1 || hits[0].type !== it.type || hits[0].description !== it.description);
  if (wrong.length) throw new MdError('vars_readback', `新增后读回来对不上：${wrong.map(({ it, hits }) => `「${it.name}」${hits.length === 1 ? '类型或描述不一样' : `找到 ${hits.length} 个`}`).join('、')}`, { hint: 'md vars --bot … 看现在的样子' });
  out(`✅ 已新增 ${items.length} 个，读回核对过：${got.map(({ it, hits }) => `${it.name}（${it.type}）${shortId(hits[0].id)}`).join('、')}`);
  return EXIT.OK;
}

async function edit(t, args) {
  const [query, ...rest] = args._;
  if (!query || rest.length) throw usage('md vars edit <名字或id> [--name 新名字] [--type string|number|boolean] [--desc 描述] --bot <智能体>');
  const name = strArg(args, 'name');
  const type = strArg(args, 'type');
  const desc = strArg(args, 'desc');
  if (name === undefined && type === undefined && desc === undefined) throw usage('要改什么：--name、--type、--desc 至少给一个');
  if (type !== undefined && !VAR_TYPES.includes(type)) throw usage(`--type 只能是 ${VAR_TYPES.join('、')}（控制台也只给这三种）`);
  const vars = await varsOf(t.identity, t.orgId, t.botId, t.botName);
  const v = resolveVar(vars, query);
  if (v.isDefault) throw blocked('var_builtin', '系统默认的会话属性不能改（控制台也不让改）');
  const next = { ...v, name: name ?? v.name, type: type ?? v.type, description: desc ?? v.description };
  if (next.name !== v.name && vars.some((x) => x.name === next.name)) throw blocked('var_exists', `已经有会话属性「${next.name}」`, '会话属性不许重名');
  out(targetLine(t));
  if (next.type !== v.type) refuseIfUsed(v, await usageOf(t), '改类型');
  const changes = [['名字', v.name, next.name], ['类型', v.type, next.type], ['描述', v.description, next.description]].filter(([, a, b]) => a !== b);
  if (!changes.length) {
    out(`「${v.name}」本来就是这样，不用改`);
    return EXIT.OK;
  }
  out(`要修改会话属性「${v.name}」(${shortId(v.id)})：`);
  for (const [label, a, b] of changes) out(`  ${label}：${a || '（空）'} → ${b || '（空）'}`);
  if (next.name !== v.name) out('改名后，按名字用它的地方（--var、用例文件里的 vars、跨智能体导入换 id）要改用新名字；画布按 id 引用，不受影响');
  out('写进去立刻对整个智能体生效（会话属性没有草稿这一层）');
  const code = planOf(t, 'edit', [v, next], vars);
  const flags = [name !== undefined ? ` --name "${name}"` : '', type !== undefined ? ` --type ${type}` : '', desc !== undefined ? ` --desc "${desc}"` : ''].join('');
  if (!confirmOrPreview(t, args, 'edit', code, `md vars edit ${shortId(v.id)}${flags} --bot ${shortId(t.botId)}`)) return EXIT.OK;

  const file = backup(t, 'edit', [v]);
  out(`改之前的定义备份在 ${file}`);
  await updateSessionVar(t.identity, t.orgId, t.botId, next);
  record(t, 'edit', [next], { before: v });
  const got = (await varsOf(t.identity, t.orgId, t.botId, t.botName)).find((x) => x.id === v.id);
  if (!got || got.name !== next.name || got.type !== next.type || got.description !== next.description) {
    throw new MdError('vars_readback', `修改后读回来对不上：「${v.name}」${got ? '的字段和要写的不一样' : '不见了'}`, { hint: `改之前的定义备份在 ${file}` });
  }
  out(`✅ 已修改，读回核对过：${line(got)} · ${shortId(got.id)}`);
  return EXIT.OK;
}

async function rm(t, args) {
  if (!args._.length) throw usage('缺会话属性：md vars rm <名字或id> … --bot <智能体>');
  const vars = await varsOf(t.identity, t.orgId, t.botId, t.botName);
  const items = [...new Map(args._.map((q) => resolveVar(vars, q)).map((v) => [v.id, v])).values()];
  for (const v of items) if (v.isDefault) throw blocked('var_builtin', `系统默认的会话属性不能删：「${v.name}」`);
  out(targetLine(t));
  const usageInfo = await usageOf(t);
  for (const v of items) refuseIfUsed(v, usageInfo, '删');
  for (const note of usageInfo.notes) out(`（${note}）`);
  out(`要删除 ${items.length} 个会话属性：`);
  for (const v of items) out(`  - ${line(v)} · ${shortId(v.id)}`);
  out('删了就回不来：重建出来是新 id，原来引用它的地方接不回去；用例里用到它的（会话数据、写字段断言），跑前检查会拦下');
  const code = planOf(t, 'rm', items, vars);
  if (!confirmOrPreview(t, args, 'rm', code, `md vars rm ${items.map((v) => shortId(v.id)).join(' ')} --bot ${shortId(t.botId)}`)) return EXIT.OK;

  const file = backup(t, 'rm', items);
  out(`删之前的定义备份在 ${file}`);
  const done = [];
  try {
    for (const v of items) {
      await deleteSessionVar(t.identity, t.orgId, t.botId, v.id);
      done.push(v);
    }
  } finally {
    if (done.length) record(t, 'rm', done, { backup: file });
  }
  const left = (await varsOf(t.identity, t.orgId, t.botId, t.botName)).filter((x) => items.some((v) => v.id === x.id));
  if (left.length) throw new MdError('vars_readback', `删除后读回来还在：${left.map((x) => x.name).join('、')}`, { hint: `定义备份在 ${file}` });
  out(`✅ 已删除 ${items.length} 个，读回核对过：${items.map((v) => v.name).join('、')}`);
  return EXIT.OK;
}

const SUBS = { list, add, edit, rm };

export const vars = {
  summary: '智能体的会话属性（定义本身）：列出、新增（可按名字从别的智能体复制）、修改、删除；写之前预演，要用户确认计划码',
  usage: [
    'md vars --bot <智能体>                                          列出会话属性：类型、描述、系统默认、草稿里几个节点在用',
    'md vars add <名字> … --type string|number|boolean [--desc 描述] --bot <智能体> [--confirm <计划码>]   新增',
    'md vars add <名字> … --from-bot <源智能体> --bot <智能体> [--confirm <计划码>]   照源智能体的类型和描述新增（迁移功能时用）',
    'md vars edit <名字或id> [--name 新名字] [--type …] [--desc 描述] --bot <智能体> [--confirm <计划码>]   修改',
    'md vars rm <名字或id> … --bot <智能体> [--confirm <计划码>]      删除',
    '写进去立刻对整个智能体生效（会话属性没有草稿这一层）。系统默认的不能改、不能删；草稿、线上、灰度版本里有节点在用的，不能删、不能改类型。',
  ].join('\n'),
  async run(args) {
    const sub = args._[0] && SUBS[args._[0]] ? args._[0] : args._[0] ? null : 'list';
    if (!sub) throw usage(`不认识「md vars ${args._[0]}」`, `可用：${Object.keys(SUBS).join('、')}`);
    const t = await resolveBot(targetArgs(args));
    return SUBS[sub](t, { ...args, _: args._.slice(sub === 'list' && !args._.length ? 0 : 1) });
  },
};
