// 测试中心接口（/api/test-center/*）。只管发请求和翻页，不做判断；字段形状见 spec §2.3（09-25 实测）。
// query 一律带 orgId、botId：测试中心按智能体隔离。t 是 resolveBot 得到的目标：{ identity, orgId, botId, … }

import { request } from './http.mjs';
import { asArray } from './api.mjs';
import { MdError } from './errors.mjs';

const TC = '/api/test-center';
const MAX_PAGES = 200;
const q = (t, extra = {}) => ({ orgId: t.orgId, botId: t.botId, ...extra });
const post = (t, path, body) => request(t.identity, `${TC}${path}`, { method: 'POST', query: q(t), body, timeoutMs: 90_000 });

// 翻到底。有 page.total 以它为准：服务端可能把每页封顶在比 pageSize 小的数，「这一页没满」不代表读完了（审查 I5）；
// 没有 total 才看这一页满没满。翻到页数上限还没读完就报错：跑前检查、预估、删测试集都假设列表是全的，不能悄悄截断
async function paged(t, path, extra, pageSize) {
  const rows = [];
  let total = null;
  for (let current = 1; current <= MAX_PAGES; current++) {
    const payload = await request(t.identity, `${TC}${path}`, { query: q(t, { ...extra, current, pageSize }), timeoutMs: 90_000 });
    const page = asArray(payload?.data);
    rows.push(...page);
    const n = Number(payload?.page?.total);
    if (Number.isFinite(n)) total = n;
    if (!page.length || (total !== null ? rows.length >= total : page.length < pageSize)) return rows;
  }
  throw new MdError('upstream', `${path} 翻了 ${MAX_PAGES} 页还没读完（已读 ${rows.length} 条，共 ${total ?? '?'} 条）`, { hint: '数据太多，md 只读到了一部分；这条命令没有继续往下做' });
}

export const listTestSets = (t) => paged(t, '/test-set/list', {}, 100);
export const listCases = (t, testSetId) => paged(t, '/test-case/list', { testSetId }, 200);
export const taskItems = (t, testTaskId) => paged(t, '/test-task-item/list', { testTaskId }, 200);

// 最近的任务，新的在前。给了 testSetId 只看这个集的（服务端筛选生效，spec §2.3）
export async function recentTasks(t, { testSetId, limit = 50 } = {}) {
  const payload = await request(t.identity, `${TC}/test-task/list`, { query: q(t, { ...(testSetId ? { testSetId } : {}), current: 1, pageSize: limit }), timeoutMs: 90_000 });
  return asArray(payload?.data).sort((a, b) => String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')));
}

export async function taskDetail(t, testTaskId) {
  const payload = await request(t.identity, `${TC}/test-task/detail`, { query: q(t, { testTaskId }), timeoutMs: 60_000 });
  return payload?.data ?? null;
}

// 老一代的区没有场景树：404 返回 null，别的错误照常抛
export async function scenarioTree(t) {
  try {
    const payload = await request(t.identity, `${TC}/scenario/tree`, { query: q(t), timeoutMs: 60_000 });
    return { tree: asArray(payload?.data?.tree), unclassified: Number(payload?.data?.unclassifiedCount) || 0 };
  } catch (error) {
    if (error instanceof MdError && error.status === 404) return null;
    throw error;
  }
}

export async function createTestSet(t, name) {
  const payload = await post(t, '/test-set/create', { botId: t.botId, name });
  const id = payload?.data?.testSetId;
  if (!id) throw new MdError('upstream', `建测试集「${name}」没有返回 testSetId`);
  return id;
}

export const deleteTestSet = (t, testSetId) => post(t, '/test-set/delete', { testSetId });

// 从执行记录导入：每批 20 条；计数在 data 外面（spec §2.3）
export async function importExecs(t, testSetId, execIds, { batch = 20 } = {}) {
  const sum = { imported: 0, failed: 0, skippedNodeTypes: [] };
  for (let i = 0; i < execIds.length; i += batch) {
    const payload = await post(t, '/test-case/import', { testSetId, canvasExecIds: execIds.slice(i, i + batch), includeSessionMemory: true });
    sum.imported += Number(payload?.imported) || 0;
    sum.failed += Number(payload?.failed) || 0;
    for (const type of asArray(payload?.skippedNodeTypes)) if (!sum.skippedNodeTypes.includes(type)) sum.skippedNodeTypes.push(type);
  }
  return sum;
}

// update 是全量覆盖：漏传的可写字段会被清空，所以可写字段要传全；只读字段不传。值是 null 的也不传（空着就是空着）
export const WRITABLE_FIELDS = ['name', 'dimension', 'triggerType', 'triggerInputs', 'sessionMemoryCustomData', 'pluginMockOutputs', 'sqlDbMockOutputs', 'testNodeOutputAssertions', 'canvasActionOutputAssertions', 'isStrictVerify'];

export function updateCase(t, testCase) {
  const body = { testCaseId: testCase.testCaseId };
  for (const key of WRITABLE_FIELDS) {
    if (testCase[key] !== undefined && testCase[key] !== null) body[key] = testCase[key];
  }
  return post(t, '/test-case/update', body);
}

export async function deleteCases(t, testCaseIds, { batch = 100 } = {}) {
  for (let i = 0; i < testCaseIds.length; i += batch) await post(t, '/test-case/batch-delete', { testCaseIds: testCaseIds.slice(i, i + batch) });
}

// 建任务：必填 testSetId、canvasId、name、testRound（spec §2.3，由空 body 的 400 校验列出）
export async function createTask(t, { testSetId, canvasId, name, rounds, concurrency }) {
  const payload = await post(t, '/test-task/create', { testSetId, canvasId, name, testRound: rounds, concurrency, botId: t.botId });
  const id = payload?.data?.testTaskId;
  if (!id) throw new MdError('upstream', '建任务没有返回 testTaskId');
  return id;
}

export const pauseTask = (t, testTaskId) => post(t, '/test-task/pause', { testTaskId });
