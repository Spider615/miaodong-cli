// md kb why（spec 3a §3.5）：重放当时的检索，说清为什么没召回那一条
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { U } from './helpers/fixtures.mjs';
import { X, chainRows, detailOf } from './helpers/exec-fixtures.mjs';
import { KB_FAQ, KB_GONE, KB_OTHER, faqs, kbCanvas, kbExec, toolCall } from './helpers/kb-fixtures.mjs';

const run = (n, extra = {}) => ({ nodeId: U(n), status: 'success', inputs: { inputData: {} }, output: {}, processDuration: 5, actions: [], ...extra });
// 库里既有 FAQ 也有文件时，工具的召回里会混着段落（spec §2.5 实测只见过 FAQ，这里按同样的结构造一条）
const withParagraph = (c) => ({
  ...c,
  toolResult: { ...c.toolResult, result: [...c.toolResult.result, { knowledgeBaseId: KB_FAQ, score: 0.85, content: '课程退款规则：开课七天内全额退款。', sourceType: 'doc', reference: { type: 'doc', source: { id: 9001 } } }] },
});
// 画布还引用着、企业里已经删掉的库：执行时召回过一条
const gone = {
  name: `q_kb_${KB_GONE}`, toolType: 'query_kb', toolCallArguments: { query: '课程怎么退款', threshold: 0.6, topK: 3 },
  toolResult: { success: true, result: [{ knowledgeBaseId: KB_GONE, score: 0.9, content: '旧的', sourceType: 'qa', reference: { type: 'qa', source: { id: 9901, question: '旧问题', reviewed: true } } }] },
};
// 没记录门槛的调用
const noThreshold = (() => {
  const c = toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 });
  const { threshold, ...args } = c.toolCallArguments;
  return { ...c, toolCallArguments: args };
})();
// 模型按标签过滤过的调用
const tagged = (() => {
  const c = toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 });
  return { ...c, toolCallArguments: { ...c.toolCallArguments, tags: ['售后'] } };
})();
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
      [X(61)]: kbExec(61, '课程怎么退款', [gone]),
      [X(62)]: kbExec(62, '', [], { event: true, canvas: kbCanvas({ nodeKbs: [KB_FAQ] }), extraResults: [run(4)] }),
      [X(63)]: kbExec(63, '怎么修改收货地址', [{ ...toolCall(KB_FAQ, '怎么修改收货地址', { threshold: 0.6 }), toolResult: { error: 'timeout' } }]),
      [X(64)]: kbExec(64, '课程怎么退', [tagged]),
      [X(65)]: kbExec(65, '课程怎么退', [toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 })], { extraResults: [run(3, { metadata: {} })] }),
      [X(66)]: kbExec(66, '发票', [toolCall(KB_FAQ, '发票', { threshold: 0.6 })], { extraResults: [run(4, { inputs: { inputData: { query: '发票' } } })] }),
      [X(68)]: kbExec(68, '课程怎么退', [toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 })]),
      [X(69)]: kbExec(69, '课程怎么退', [toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 })]),
      [X(70)]: kbExec(70, '课程怎么退', [], { canvas: kbCanvas({ nodeKbs: [KB_FAQ, KB_GONE] }), extraResults: [run(4, { inputs: { inputData: { query: '课程怎么退' } } })] }),
      [X(71)]: kbExec(71, '课程怎么退', [noThreshold]),
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

test('md kb why：候选里列出过了门槛、但排在前 10 名之后的（spec §3.5 第 4 步）', async () => {
  const rows = [...faqs(), ...Array.from({ length: 12 }, (_, i) => ({ id: 8001 + i, kb: KB_FAQ, question: `课程怎么退款${i + 1}`, answer: '同上。', isReviewed: true }))];
  const call = toolCall(KB_FAQ, '课程怎么退款', { threshold: 0.6, rows });
  // 前 10 条里有一段 0.95 的段落时，FAQ 只占 9 个名额（第 10 名的 #8009 被挤掉了）
  const [top, ...rest] = call.toolResult.result;
  const para = { knowledgeBaseId: KB_FAQ, score: 0.95, content: '课程退款规则', sourceType: 'doc', reference: { type: 'doc', source: { id: 9001 } } };
  const mixed = { ...call, toolResult: { success: true, result: [top, para, ...rest].slice(0, 10) } };
  const s = await startKbServer({
    faqRows: rows,
    details: {
      [X(33)]: kbExec(33, '课程怎么退款', [call]),
      [X(34)]: kbExec(34, '课程怎么退款', [mixed]),
      [X(72)]: kbExec(72, '课程怎么退款', [toolCall(KB_FAQ, '课程怎么退款', { threshold: 0.8, rows })]),
    },
  });
  try {
    const r = await runCli(['kb', 'why', X(33)], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /召回 10 条/);
    assert.doesNotMatch(r.stdout, /知识库在这次执行之后改过/);
    assert.match(r.stdout, /过了门槛、但排在前 10 名之后的（前 3 条）：\n    #8010 课程怎么退款10 0\.833（第 11 名）\n    #8011 课程怎么退款11 0\.833（第 12 名）\n    #8012 课程怎么退款12 0\.833（第 13 名）\n/);
    const m = await runCli(['kb', 'why', X(34)], { home: home(s.origin) });
    assert.equal(m.code, 0, m.stderr);
    assert.match(m.stdout, /记录的召回：#7001 1\.000、#9001（doc）0\.950、#8001/);
    assert.doesNotMatch(m.stdout, /知识库在这次执行之后改过/);
    // 门槛 0.8：0.8 以上的已经有 13 行，#7002 被挤出；它又不在 0.8 以上的结果里，分数也低于门槛（整支审查小问题 2）
    const both = await runCli(['kb', 'why', X(72), '--expect', '7002'], { home: home(s.origin) });
    assert.match(both.stdout, /结论：被挤出前 10 名 —— 重放结果里没有这一条（语义搜索只返回 0\.8 以上的）；过了门槛、分数比它高的已经占了 13 个名次/);
    assert.match(both.stdout, /补充：分数不够门槛 —— 重放结果里没有这一条（语义搜索只返回 0\.8 以上的），它的分数低于门槛 0\.800/);
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb why：查询被改写；补充里推断分数不够门槛（重放看不到 0.8 以下的分数，这次一条都没召回）', async () => {
  const r = await md(['kb', 'why', X(22), '--expect', '7001']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /结论：查询被改写 —— 拿去查的是「退款流程」，不是用户原话；用原话查，这一条排第 1（1\.000）/);
  assert.match(r.stdout, /补充：分数不够门槛 —— 重放结果里没有这一条（语义搜索只返回 0\.8 以上的），它的分数低于 0\.8；这次一条都没召回，说明没有过门槛 0\.600 的，它也没过/);
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

test('md kb why：一处检索都没有时，挂了知识库工具却没调的节点逐个报「模型没调知识库工具」（spec §3.5 第 2 步）', async () => {
  const r = await md(['kb', 'why', X(25)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /检索：#2 回答生成 挂了知识库工具（「售后 FAQ」、「财务 FAQ」），这次一次都没调\n结论：模型没调知识库工具/);
  assert.match(r.stdout, /检索：#3 闲聊 挂了知识库工具（「已不存在的库 dddd0004」），这次一次都没调\n结论：模型没调知识库工具/);
  assert.match(r.stdout, /下一步：md trial 00000002-0000-4000-8000-000000000000 [^\n]*\n下一步：md trial 00000003-0000-4000-8000-000000000000 /);
  const one = await md(['kb', 'why', X(25), '--node', '闲聊']);
  assert.equal(one.code, 0, one.stderr);
  assert.doesNotMatch(one.stdout, /#2 回答生成/);
  assert.match(one.stdout, /检索：#3 闲聊 挂了知识库工具（「已不存在的库 dddd0004」），这次一次都没调/);
});

test('md kb why：只有一处真的检索时直接看它，挂了工具没调的节点只附一句（整支审查小问题 1）', async () => {
  const r = await md(['kb', 'why', X(65)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /另有 1 个挂了知识库工具的大模型节点这次没调：#3 闲聊（要看它加 --node）/);
  assert.match(r.stdout, /检索：#2 回答生成 第 1 次调用知识库工具/);
  assert.doesNotMatch(r.stdout, /检索：#3 闲聊/);
});

test('md kb why：有多处真的检索时列出来，要求 --node', async () => {
  const r = await md(['kb', 'why', X(66)]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /这次执行有 2 处知识库检索，用 --node 指定：\n  - #2 回答生成：调了 1 次知识库工具\n  - #3 查手册：知识库查询节点/);
});

test('md kb why：一个节点调了两个库，逐次分析（Review Focus 2）', async () => {
  const r = await md(['kb', 'why', X(26), '--expect', '发票']);
  assert.equal(r.code, 0, r.stderr);
  const [, first, second] = r.stdout.split('检索：');
  assert.match(first, /第 1 次调用知识库工具 · 库「售后 FAQ」/);
  assert.match(first, /结论：不在查询的库里 —— 这一条在「财务 FAQ」里/);
  assert.match(second, /第 2 次调用知识库工具 · 库「财务 FAQ」/);
  assert.match(second, /结论：这次召回到了这一条（排第 1，0\.400）/);
  // 几次调用放在一起的总结论（整支审查小问题 9）
  assert.match(r.stdout, /总结：2 次调用里，第 2 次召回到了这一条/);
});

test('md kb why：几次调用都没召回时总结各次的原因；同一个库的 FAQ 只整库拉一次（整支审查小问题 9）', async () => {
  const before = server.requests.length;
  const r = await md(['kb', 'why', X(26), '--expect', '7003']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /总结：2 次调用都没召回这一条（第 1 次：分数偏低；第 2 次：不在查询的库里）/);
  const scans = server.requests.slice(before).filter((q) => q.path === '/api/qa/list' && q.body?.sortType === 'DEFAULT' && q.body?.knowledgeBaseId === KB_FAQ);
  assert.equal(scans.length, 1);
});

test('md kb why：重放里没有、又推不出原因时报「分数偏低」（整支审查小问题 10）', async () => {
  const r = await md(['kb', 'why', X(68), '--expect', '7002']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /结论：分数偏低 —— 重放结果里没有这一条（语义搜索只返回 0\.8 以上的），它的分数低于 0\.8/);
});

test('md kb why：重放显示它该召回、记录里却没有——知识库改过，查不出（整支审查小问题 10）', async () => {
  server.state.faqs = faqs().map((f) => (f.id === 7002 ? { ...f, question: '课程怎么退呀' } : f));
  try {
    const r = await md(['kb', 'why', X(69), '--expect', '7002']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /⚠️ 知识库在这次执行之后改过/);
    assert.match(r.stdout, /结论：查不出 —— 以上原因都不成立，用 md trial 复验/);
  } finally {
    server.state.faqs = faqs();
  }
});

test('md kb why：查询节点挂的库里有一个被删了——候选只查还在的库，不抛接口的原始报错（整支审查小问题 7）', async () => {
  const r = await md(['kb', 'why', X(70)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /检索：#\d+ 查手册（知识库查询节点）· 库「售后 FAQ」、「已不存在的库 dddd0004」/);
  assert.match(r.stdout, /看某一条为什么没召回/);
});

test('md kb why：工具调用没记录门槛——标题照实写，不拿「门槛 ?」去比（整支审查小问题 5）', async () => {
  const r = await md(['kb', 'why', X(71), '--expect', '7002']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /第 1 次调用知识库工具 · 库「售后 FAQ」\(aaaa0001\) · 查询「课程怎么退」 · 门槛没记录 · 召回 1 条/);
  assert.match(r.stdout, /结论：查不出 —— 这次调用没记录门槛，推不出为什么没召回；用 md trial 看/);
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
  // spec §3.5 第 2 步：照实说这类节点的运行记录认不得
  assert.match(r.stdout, /这类节点的运行记录 md 还不认得/);
  assert.deepEqual(server.unexpected(), []);
});

test('md kb why：同一条 FAQ 在索引里占好几行（09-25 真机验收）——按行排名次、按 FAQ 去重，不误报改过', async () => {
  const more = Array.from({ length: 12 }, (_, i) => ({ id: 8001 + i, kb: KB_FAQ, question: `课程怎么退款${i + 1}`, answer: '同上。', isReviewed: true }));
  // #7001 多一行 0.909，#8001 多一行 0.833：按行排，第 2 名是 #7001 的第二行，#8009 排到第 11 名
  const rows = [...faqs().map((f) => (f.id === 7001 ? { ...f, vectors: ['课程怎么退款呢'] } : f)), ...more.map((f) => (f.id === 8001 ? { ...f, vectors: ['课程怎么退款1吧'] } : f))];
  const s = await startKbServer({
    faqRows: rows,
    details: {
      [X(36)]: kbExec(36, '课程怎么退款', [toolCall(KB_FAQ, '课程怎么退款', { threshold: 0.6, rows })]),
      [X(37)]: kbExec(37, '课程怎么退款', [toolCall(KB_FAQ, '课程怎么退款', { threshold: 0.95, rows })]),
      [X(38)]: kbExec(38, '课程怎么退款', []),
    },
  });
  const run = (args) => runCli(args, { home: home(s.origin) });
  try {
    // 前 10 行里 #7001 占两行，去重后召回 9 条；重放照样取前 10 行再去重，对得上
    const r = await run(['kb', 'why', X(36)]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /召回 9 条/);
    assert.doesNotMatch(r.stdout, /知识库在这次执行之后改过/);
    // #8001 的第二行排第 12 名，但 #8001 已经召回了，不算被挤出
    assert.match(r.stdout, /过了门槛、但排在前 10 名之后的（前 4 条）：\n    #8009 课程怎么退款9 0\.909（第 11 名）\n    #8010 课程怎么退款10 0\.833（第 13 名）\n/);
    // #8009 按 FAQ 数是第 10 条，按行是第 11 名：被挤出
    const e = await run(['kb', 'why', X(36), '--expect', '8009']);
    assert.match(e.stdout, /结论：被挤出前 10 名 —— 分数 0\.909 过了门槛，但排第 11 名/);
    // 门槛 0.95：#7001 召回了，它 0.909 的第二行不算「差一点的」
    const high = await run(['kb', 'why', X(37)]);
    assert.equal(high.code, 0, high.stderr);
    assert.match(high.stdout, /差一点的（重放时没过门槛 0\.950，前 5 条）：\n    #8001 课程怎么退款1 0\.909\n/);
    assert.doesNotMatch(high.stdout.split('差一点的')[1], /#7001/);
    // 挂了工具没调：用原话查的前 3 条也按 FAQ 去重
    const silent = await run(['kb', 'why', X(38)]);
    assert.match(silent.stdout, /前 3 条）：#7001 课程怎么退款 1\.000；#8001 课程怎么退款1 0\.909；#8002 课程怎么退款2 0\.909/);
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb why：重放时秒懂报错，照实报错退出，不当成「没有结果」去编原因（整支审查第 1 条）', async () => {
  const s = await startKbServer({ semanticFail: true, details: { [X(60)]: kbExec(60, '课程怎么退', [toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 })]) } });
  try {
    const r = await runCli(['kb', 'why', X(60), '--expect', '7002'], { home: home(s.origin) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 502/);
    assert.doesNotMatch(r.stdout, /结论：|知识库在这次执行之后改过/);
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb why：查的库已经被删了——说重放不了，不误报「改过」', async () => {
  const r = await md(['kb', 'why', X(61)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /查的库已经不在企业里了（执行之后被删了？）：候选和分数要用 md trial 看/);
  assert.doesNotMatch(r.stdout, /知识库在这次执行之后改过/);
});

test('md kb why：知识库查询节点取不到查询（事件触发、没有 query）——不编查询、不下结论（整支审查第 2 条）', async () => {
  const r = await md(['kb', 'why', X(62), '--node', '查手册', '--expect', '7001']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /检索：#\d+ 查手册（知识库查询节点）· 库「售后 FAQ」 · 查询取不到 · 门槛 0\.800 · 召回最多 5 条/);
  assert.match(r.stdout, /这类节点的运行记录 md 还不认得/);
  assert.match(r.stdout, /结论：查不出 —— 这次检索的查询取不到，只能用 md trial 看/);
  const c = await md(['kb', 'why', X(62), '--node', '查手册']);
  assert.match(c.stdout, /这次检索的查询取不到：候选和分数要用 md trial 看/);
  assert.doesNotMatch(c.stdout, /重放和相似度检查都没有别的候选/);
});

test('md kb why：工具的返回认不出——不写「召回 0 条」，也不推原因（整支审查第 3 条）', async () => {
  const r = await md(['kb', 'why', X(63), '--expect', '7003']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /召回 0 条|一条都没有/);
  assert.match(r.stdout, /第 1 次调用知识库工具 · .* · 返回认不出/);
  assert.match(r.stdout, /结论：工具的返回认不出 —— 这次调用的返回认不出（没有 success=true 和召回列表）/);
});

test('md kb why：给的 FAQ id 不在查的库里，就到企业的其他库里找；哪儿都没有就报找不到（整支审查第 5 条）', async () => {
  const other = await md(['kb', 'why', X(21), '--expect', '7101']);
  assert.equal(other.code, 0, other.stderr);
  assert.match(other.stdout, /目标：FAQ #7101「发票怎么开」 \[已审核\]（在「财务 FAQ」里）/);
  assert.match(other.stdout, /结论：不在查询的库里 —— 这一条在「财务 FAQ」里，这次查的不是这个库/);
  const none = await md(['kb', 'why', X(21), '--expect', '99999']);
  assert.equal(none.code, 4);
  assert.match(none.stderr, /企业的知识库里都没有 FAQ #99999/);
});

test('md kb why：模型按标签过滤过——重放不带标签、不可比，不误报「改过」、不推原因（整支审查第 6 条）', async () => {
  const r = await md(['kb', 'why', X(64), '--expect', '7002']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /模型这次按标签（售后）过滤了，重放不带标签，结果不可比/);
  assert.match(r.stdout, /结论：查不出 —— 模型这次按标签（售后）过滤了/);
  assert.doesNotMatch(r.stdout, /知识库在这次执行之后改过/);
});

test('md kb why：认不出审没审核时不说成「未审核」，先照实说再推分数（整支审查小问题 4）', async () => {
  const s = await startKbServer({ omitFaqFields: ['isReviewed'], details: { [X(74)]: kbExec(74, '课程怎么退', [toolCall(KB_FAQ, '课程怎么退', { threshold: 0.6 })]) } });
  try {
    const r = await runCli(['kb', 'why', X(74), '--expect', '7002'], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /目标：FAQ #7002「退款多久到账」 \[审核状态认不出\]/);
    assert.match(r.stdout, /结论：审核状态认不出 —— 接口里认不出这一条审没审核/);
    assert.match(r.stdout, /补充：分数偏低/);
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb why：关键词匹配到的超过 20 条时照实报条数（整支审查小问题 6）', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: 7200 + i, kb: KB_FAQ, question: `退款问题${i + 1}`, answer: '看订单页。', isReviewed: true }));
  const rows = [...faqs(), ...many];
  const s = await startKbServer({ faqRows: rows, details: { [X(73)]: kbExec(73, '退款', [toolCall(KB_FAQ, '退款', { threshold: 0.6, rows })]) } });
  try {
    const r = await runCli(['kb', 'why', X(73), '--expect', '退款问题'], { home: home(s.origin) });
    assert.equal(r.code, 4);
    assert.match(r.stderr, /「退款问题」在「售后 FAQ」里匹配到 25 条/);
    assert.deepEqual(s.unexpected(), []);
  } finally {
    await s.close();
  }
});

test('md kb why：目标 FAQ 是执行之后才上传的——结论就是「执行的时候库里还没有它」，按现在的库推的原因降成补充；「改过」的提醒点出是哪几条', async () => {
  const late = { id: 7005, kb: KB_FAQ, question: '课程退款要多久', answer: '三个工作日。', isReviewed: true, createdTime: new Date().toISOString() };
  const early = faqs().map((f) => ({ ...f, createdTime: '2026-01-01T00:00:00.000Z' }));
  const srv = await startKbServer({ details: { [X(72)]: kbExec(72, '课程退款要多久', [toolCall(KB_FAQ, '课程退款要多久', { threshold: 0.6 })]) }, faqRows: [...early, late] });
  try {
    const r = await runCli(['kb', 'why', X(72), '--expect', '7005'], { home: home(srv.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /⚠️ 知识库在这次执行之后改过[^\n]*\n\s+其中 #7005 是执行之后才上传的/);
    assert.match(r.stdout, /结论：执行之后才上传的 —— 这一条上传于 \S+ \S+，执行在 \S+ \S+：执行的时候库里还没有它/);
    assert.doesNotMatch(r.stdout, /结论：(?!执行之后才上传的)/);
    const old = await runCli(['kb', 'why', X(72), '--expect', '7001'], { home: home(srv.origin) });
    assert.doesNotMatch(old.stdout, /结论：执行之后才上传的/);
  } finally {
    srv.close();
  }
});

test('md exec 看一条执行：用到了知识库就单独一行说检索了几处、在哪，给出 md kb why；挂了工具没调的也说；没用到的不说（查 case 时结合知识库）', async () => {
  const used = await md(['exec', X(21)]);
  assert.equal(used.code, 0, used.stderr);
  assert.match(used.stdout, /知识库：这次检索了 1 次（#2 回答生成），召回了什么、该召回的为什么没召回：md kb why e0000021-0000-4000-8000-000000000000/);
  const silent = await md(['exec', X(25)]);
  assert.equal(silent.code, 0, silent.stderr);
  assert.match(silent.stdout, /知识库：#2 回答生成、#3 闲聊 挂了知识库工具，这次没调；用户原话在库里能搜到什么：md kb why e0000025-0000-4000-8000-000000000000/);
  const none = await md(['exec', X(30)]);
  assert.equal(none.code, 0, none.stderr);
  assert.doesNotMatch(none.stdout, /知识库：/);
});

