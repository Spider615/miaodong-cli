// md kb why（spec 3a §3.5）：重放当时的检索，说清为什么没召回那一条
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { U } from './helpers/fixtures.mjs';
import { X, chainRows, detailOf } from './helpers/exec-fixtures.mjs';
import { KB_FAQ, KB_OTHER, faqs, kbExec, toolCall } from './helpers/kb-fixtures.mjs';

const run = (n, extra = {}) => ({ nodeId: U(n), status: 'success', inputs: { inputData: {} }, output: {}, processDuration: 5, actions: [], ...extra });
// 库里既有 FAQ 也有文件时，工具的召回里会混着段落（spec §2.5 实测只见过 FAQ，这里按同样的结构造一条）
const withParagraph = (c) => ({
  ...c,
  toolResult: { ...c.toolResult, result: [...c.toolResult.result, { knowledgeBaseId: KB_FAQ, score: 0.85, content: '课程退款规则：开课七天内全额退款。', sourceType: 'doc', reference: { type: 'doc', source: { id: 9001 } } }] },
});
let server;
before(async () => {
  server = await startKbServer({
    details: {
      [X(21)]: kbExec(21, '课程可以退吗', [toolCall(KB_FAQ, '课程可以退吗', { threshold: 0.6 })]),
      [X(22)]: kbExec(22, '课程怎么退款', [toolCall(KB_FAQ, '退款流程', { threshold: 0.6 })]),
      [X(23)]: kbExec(23, '课程怎么退', [toolCall(KB_FAQ, '课程怎么退', { threshold: 0.9 })]),
      [X(24)]: kbExec(24, '发票怎么开', [toolCall(KB_FAQ, '发票怎么开', { threshold: 0.6 })]),
      [X(25)]: kbExec(25, '随便聊聊', [], { extraResults: [run(3, { metadata: {} })] }),
      [X(26)]: kbExec(26, '发票', [toolCall(KB_FAQ, '怎么退款', { threshold: 0.6 }), toolCall(KB_OTHER, '发票', { threshold: 0.3 })]),
      [X(27)]: kbExec(27, '课程怎么退', [toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 })]),
      [X(28)]: kbExec(28, '怎么退款', [toolCall(KB_FAQ, '怎么退款', { success: false })]),
      [X(29)]: kbExec(29, '', [toolCall(KB_FAQ, '退款流程', { threshold: 0.6 })], { event: true }),
      [X(30)]: detailOf({ ...chainRows()[0], execId: X(30) }, { nodeResults: [] }),
      [X(31)]: kbExec(31, '发票', [], { extraResults: [run(4, { inputs: { inputData: { query: '发票' } } })] }),
      [X(32)]: kbExec(32, '课程怎么退', [withParagraph(toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 }))]),
      [X(35)]: kbExec(35, '怎么退款', [toolCall(KB_FAQ, '怎么退款', { threshold: 0.6 })]),
    },
  });
});
after(() => server.close());
function home(origin = server.origin) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args) => runCli(args, { home: home() });

test('md kb why：未审核——第一行是智能体和执行；带诊断材料提示、用户原话、检索、目标、结论和下一步', async () => {
  const r = await md(['kb', 'why', X(21), '--expect', '7004']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0 质检革新版 \(147bd600\) \/ v1\.0\.402 · 执行 e0000021\n/);
  assert.match(r.stdout, /只作诊断材料/);
  assert.match(r.stdout, /用户原话：课程可以退吗/);
  assert.match(r.stdout, /检索：#2 回答生成 第 1 次调用知识库工具 · 库「售后 FAQ」\(aaaa0001\) · 查询「课程可以退吗」 · 门槛 0\.600 · 召回 0 条/);
  assert.match(r.stdout, /目标：FAQ #7004「课程可以退吗」 \[未审核\]/);
  assert.match(r.stdout, /结论：未审核 —— 未审核的 FAQ 不进语义索引，检索不到/);
  assert.match(r.stdout, /下一步：md trial 00000002-0000-4000-8000-000000000000 --bot 147bd600-0000-4000-8000-000000000000 --from-exec e0000021-/);
});

test('md kb why：不给 --expect 时列候选——门槛低于 0.8 时说明没过门槛的看不到；问题很像但没审核的', async () => {
  const r = await md(['kb', 'why', X(21)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /记录的召回：一条都没有（没有 FAQ 过门槛 0\.600）/);
  assert.doesNotMatch(r.stdout, /差一点的/);
  assert.match(r.stdout, /没过门槛 0\.600 的看不到：语义搜索只返回 0\.8 以上的/);
  assert.match(r.stdout, /问题很像、但没审核的（检索不到）：\n    #7004 课程可以退吗 1\.000/);
  assert.match(r.stdout, /加 --expect <FAQ id>/);
});

test('md kb why：门槛是模型定的 0.9 时，候选里列出差一点过门槛的', async () => {
  const r = await md(['kb', 'why', X(23)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /差一点的（重放时没过门槛 0\.900，前 1 条）：\n    #7001 课程怎么退款 0\.889/);
  assert.doesNotMatch(r.stdout, /看不到/);
});

test('md kb why：候选里列出过了门槛、但排在 10 条之后的（spec §3.5 第 4 步）', async () => {
  const rows = [...faqs(), ...Array.from({ length: 12 }, (_, i) => ({ id: 8001 + i, kb: KB_FAQ, question: `课程怎么退款${i + 1}`, answer: '同上。', isReviewed: true }))];
  const call = toolCall(KB_FAQ, '课程怎么退款', { threshold: 0.6, rows });
  // 前 10 条里有一段 0.95 的段落时，FAQ 只占 9 个名额（第 10 名的 #8009 被挤掉了）
  const [top, ...rest] = call.toolResult.result;
  const para = { knowledgeBaseId: KB_FAQ, score: 0.95, content: '课程退款规则', sourceType: 'doc', reference: { type: 'doc', source: { id: 9001 } } };
  const mixed = { ...call, toolResult: { success: true, result: [top, para, ...rest].slice(0, 10) } };
  const s = await startKbServer({ faqRows: rows, details: { [X(33)]: kbExec(33, '课程怎么退款', [call]), [X(34)]: kbExec(34, '课程怎么退款', [mixed]) } });
  try {
    const r = await runCli(['kb', 'why', X(33)], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /召回 10 条/);
    assert.doesNotMatch(r.stdout, /知识库在这次执行之后改过/);
    assert.match(r.stdout, /过了门槛、但排在 10 条之后的（前 3 条）：\n    #8010 课程怎么退款10 0\.833（第 11）\n    #8011 课程怎么退款11 0\.833（第 12）\n    #8012 课程怎么退款12 0\.833（第 13）\n/);
    const m = await runCli(['kb', 'why', X(34)], { home: home(s.origin) });
    assert.equal(m.code, 0, m.stderr);
    assert.match(m.stdout, /记录的召回：#7001 1\.000、#9001（doc）0\.950、#8001/);
    assert.doesNotMatch(m.stdout, /知识库在这次执行之后改过/);
  } finally {
    await s.close();
  }
});

test('md kb why：查询被改写；补充里按召回条数推断分数不够门槛（重放看不到 0.8 以下的分数）', async () => {
  const r = await md(['kb', 'why', X(22), '--expect', '7001']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /结论：查询被改写 —— 拿去查的是「退款流程」，不是用户原话；用原话查，这一条排第 1（1\.000）/);
  assert.match(r.stdout, /补充：分数不够门槛 —— 重放结果里没有这一条（语义搜索只返回 0\.8 以上的），它的分数低于 0\.8；这次只召回了 0 条（不满 10 条），过了门槛的都召回了，所以它没过门槛 0\.600/);
});

test('md kb why：门槛是模型自己定的 0.9，说出用 0.6 就能过', async () => {
  const r = await md(['kb', 'why', X(23), '--expect', '7001']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /结论：分数不够门槛 —— 分数 0\.889 低于门槛 0\.900；门槛是模型这次自己定的，用 0\.6 就能过/);
});

test('md kb why：按关键词找目标，在别的库里——不在查询的库里', async () => {
  const r = await md(['kb', 'why', X(24), '--expect', '发票']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /目标：FAQ #7101「发票怎么开」 \[已审核\]（在「财务 FAQ」里）/);
  assert.match(r.stdout, /结论：不在查询的库里 —— 这一条在「财务 FAQ」里，这次查的不是这个库/);
});

test('md kb why：有多处检索时要求 --node；挂了工具没调', async () => {
  const many = await md(['kb', 'why', X(25)]);
  assert.equal(many.code, 4);
  assert.match(many.stderr, /这次执行有 2 处知识库检索，用 --node 指定/);
  assert.match(many.stderr, /#3 闲聊：挂了知识库工具但没调/);
  const r = await md(['kb', 'why', X(25), '--node', '闲聊']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /检索：#3 闲聊 挂了知识库工具（「已不存在的库 dddd0004」），这次一次都没调/);
  assert.match(r.stdout, /结论：模型没调知识库工具/);
});

test('md kb why：一个节点调了两个库，逐次分析（Review Focus 2）', async () => {
  const r = await md(['kb', 'why', X(26), '--expect', '发票']);
  assert.equal(r.code, 0, r.stderr);
  const [, first, second] = r.stdout.split('检索：');
  assert.match(first, /第 1 次调用知识库工具 · 库「售后 FAQ」/);
  assert.match(first, /结论：不在查询的库里 —— 这一条在「财务 FAQ」里/);
  assert.match(second, /第 2 次调用知识库工具 · 库「财务 FAQ」/);
  assert.match(second, /结论：这次召回到了这一条（排第 1，0\.400）/);
});

test('md kb why：知识库在执行之后改过——重放和记录（0.8 以上的部分）对不上时提示', async () => {
  const clean = await md(['kb', 'why', X(27)]);
  assert.doesNotMatch(clean.stdout, /知识库在这次执行之后改过/);
  // 召回的 #7001 是 0.75：在门槛 0.6 和 0.8 之间，重放看不到它，不能因此说改过
  const low = await md(['kb', 'why', X(35)]);
  assert.match(low.stdout, /记录的召回：#7001 0\.750/);
  assert.doesNotMatch(low.stdout, /知识库在这次执行之后改过/);
  server.state.faqs = faqs().map((f) => (f.id === 7001 ? { ...f, question: '课程如何退费' } : f));
  try {
    const r = await md(['kb', 'why', X(27)]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /⚠️ 知识库在这次执行之后改过/);
  } finally {
    server.state.faqs = faqs();
  }
});

test('md kb why：召回里混着文件段落时，只拿 FAQ 和重放比，不误报「知识库改过」', async () => {
  const r = await md(['kb', 'why', X(32)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /记录的召回：#7001 0\.889、#9001（doc）0\.850/);
  assert.doesNotMatch(r.stdout, /知识库在这次执行之后改过/);
});

test('md kb why：工具调用失败（Review Focus 3）', async () => {
  const r = await md(['kb', 'why', X(28)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /结论：知识库工具调用失败 —— 知识库服务超时/);
});

test('md kb why：事件触发、取不到用户原话时不判「查询被改写」（Review Focus 4）', async () => {
  const r = await md(['kb', 'why', X(29), '--expect', '7001']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /用户原话：（取不到：这次不是文本消息触发的）/);
  assert.match(r.stdout, /结论：分数不够门槛/);
  assert.doesNotMatch(r.stdout, /查询被改写/);
});

test('md kb why：这次执行没用到知识库（退出码 4）', async () => {
  const r = await md(['kb', 'why', X(30)]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /这次执行没有用到知识库/);
});

test('md kb why：知识库查询节点 + 文件库：按关键词找到段落，没处理完就是还在处理', async () => {
  const r = await md(['kb', 'why', X(31), '--node', '查手册', '--expect', '发票']);
  assert.equal(r.code, 0, r.stderr);
  // #序号是这次执行里的执行顺序：收到文本、回答生成、查手册（闲聊没跑）
  assert.match(r.stdout, /检索：#3 查手册（知识库查询节点）· 库「产品手册」 · 查询「发票」 · 门槛 0\.800 · 召回最多 5 条/);
  assert.match(r.stdout, /目标：段落 #9002「发票在订单完成后可以申请。」 \[processing\]/);
  assert.match(r.stdout, /结论：还在处理 —— 状态是 processing，处理完之前检索不到/);
  assert.deepEqual(server.unexpected(), []);
});
