# 秒懂 CLI（md）3a 实施计划：知识库只读与「没召回」排查

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 md 加上 `md kb list / pull / find / why` 四个只读命令，让 AI 不开控制台就能查知识库，查出「库里有、但这次没召回」的原因。

**Architecture:** 新增 6 个模块：
- `src/kb.mjs`：知识库读接口，统一字段名，挡住 `filterType` 的坑；
- `src/kb-target.mjs`：区、企业、知识库的换算；
- `src/kb-refs.mjs`：画布里的知识库引用；
- `src/kb-retrieval.mjs`：执行记录里的检索；
- `src/kb-diagnose.mjs`：判定原因，纯函数；
- `src/kb-store.mjs`：本机副本。

命令放在 `src/commands/kb*.mjs`。`md kb why` 复用 `md exec` 的 `locateExec` 和 `normalizeDetail`，用控制台语义搜索按原样重放大模型的知识库工具调用：spec §2.3 实测，两边分数一致。

**Tech Stack:** Node。源码测试用 Node 22 + strip-types，产物是 Node 18 单文件；测试框架 node:test，打包用 esbuild；不加新依赖。

**Spec:** `docs/specs/2026-09-25-miaodong-cli-step3a-kb-read-design.md`（分支 `feat/kb-read` 上的 8df2d2f 版）

## Global Constraints

- **全部只读**：只调 spec §2.1 的读接口。测试用的假服务器用 `server.unexpected()` 列出不在读接口清单里的请求，每组测试最后断言它为空。
- **FAQ 列表的 `filterType` 只传数字**：0 是全部，1 是已审核，2 是未审核（spec §2.2 第 1 条）。
- **段落列表**同时带 `id`（以字符串传）和 `knowledgeBaseId`；相似度检查返回的 `qaId` 统一成 `id`（§2.2 第 2、4 条）。
- **输出第一行**：`区 / 企业 / 知识库名 (id 前 8 位)`；带 `--bot` 或是 `why` 时，用 `targetLine` 那一行。
- **知识库写法**：名字、完整 id，或 4 位以上的 id 前缀；有歧义时列出候选，退出码 4。
- **隐私**：完整内容只存在 `$MD_HOME/kb/` 下；终端里答案和段落只显示前 60 个字（`clip(…, 60)`）；`why` 的输出开头带 `DATA_NOTE`。
- **不花钱**：`why` 不自动试跑，只给出 `md trial` 的命令。
- **不加 npm 依赖**；产物要能在 Node 18 上跑（用 `MD_E2E_NODE` 验证）。
- **代码风格**：中文注释、英文标识符；每个新模块开头一段注释，说清它做什么、为什么这么做。
- **测试命令**：全部测试用 `PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH MD_E2E_NODE=$HOME/.nvm/versions/node/v18.20.8/bin/node npm test`；单个文件用 `PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs --test test/<文件>`，下文记作 `T test/<文件>`。

## Review Focus

1. **大库**（2725 条 FAQ），而且服务端把每页封顶在比 `pageSize` 小的条数：pull 必须按 `page.total` 读完，不能因为某页不满 50 条就停。→ Task 1 用 `pageCap: 1` 的假服务器，测 `listKbs` 和 `listFaqs` 能读全。
2. **同一个节点调了多个知识库工具**：`why` 要逐次分析，不能只看第一次。→ Task 8 测一个节点两次调用、两个库，`--expect` 落在第二个库。
3. **工具调用失败**（`toolResult.success=false`）：不能报成「没召回」。→ Task 7、Task 8 测「知识库工具调用失败」。
4. **事件触发的执行**，取不到用户原话：这时要跳过「查询被改写」的判定，不能拿空字符串去重放。→ Task 7 测 `userText` 为空时不报 `rewritten`；Task 8 用事件触发的执行跑一遍。
5. **本机有多个区或企业的身份**：`kb list/pull/find` 不带 `--region`/`--org` 时要列出候选停下（退出码 4），不能默默选第一个。→ Task 3 测。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/kb.mjs` | 知识库读接口的封装、字段统一、分页 |
| `src/kb-target.mjs` | 区和企业（来自本机身份）、知识库的换算，以及输出第一行 |
| `src/kb-refs.mjs` | 从画布里取知识库引用：大模型工具、知识库查询节点 |
| `src/kb-retrieval.mjs` | 从 `normalizeDetail` 的结果里取检索记录，以及挂了工具却没调的节点 |
| `src/kb-diagnose.mjs` | 判定原因，纯函数 |
| `src/kb-store.mjs` | pull 下来的本机副本 |
| `src/commands/kb.mjs` | 子命令分发和用法说明 |
| `src/commands/kb-list.mjs`、`kb-pull.mjs`、`kb-find.mjs`、`kb-why.mjs` | 四个子命令 |
| `src/commands/index.mjs` | 登记 `kb` 命令 |
| `test/helpers/kb-fixtures.mjs`、`test/helpers/kb-server.mjs` | 测试数据、假秒懂 |
| `test/kb-api.test.mjs`、`kb-refs.test.mjs`、`kb-cli-list.test.mjs`、`kb-cli-pull.test.mjs`、`kb-cli-find.test.mjs`、`kb-retrieval.test.mjs`、`kb-diagnose.test.mjs`、`kb-cli-why.test.mjs` | 测试 |
| `skill/SKILL.md`、`skill/references/kb.md`、`CLAUDE.md`、`AGENTS.md`、`README.md`、`test/bundle.test.mjs` | 文档和产物测试 |

---

### Task 0：开工前核对（只读，不花钱）

spec §7 的第 2～5 条，外加 `/qa/detail` 能不能用。结果写回 spec；影响后面任务的地方，在账本里记一条 Ruling。

**Files:**
- 临时脚本（不进仓库）：`$SCRATCH/kb-check/check.mjs`。`$SCRATCH` 是会话的临时目录。
- Modify：`docs/specs/2026-09-25-miaodong-cli-step3a-kb-read-design.md`（§2.1、§2.3、§2.5、§7）

- [ ] **Step 1：在线上找知识库查询节点的运行记录（最多 30 条执行）**

```bash
cd /Users/hukui/Desktop/workspace/miaodong-cli
S=$SCRATCH/kb-check; mkdir -p $S
~/.local/bin/md exec --bot 147bd600 --since 168h --limit 30 --save $S/execs.jsonl > /dev/null
for id in $(tail -n +2 $S/execs.jsonl | python3 -c "import json,sys; [print(json.loads(l)['execId']) for l in sys.stdin if l.strip()]"); do ~/.local/bin/md exec $id > /dev/null 2>&1; done
python3 - <<'EOF'
import json, glob, os
def shape(v, k='', d=0):
    if d > 5: return '…'
    if isinstance(v, dict): return {kk: shape(vv, kk, d + 1) for kk, vv in v.items()}
    if isinstance(v, list): return [f'×{len(v)}'] + ([shape(v[0], k, d + 1)] if v else [])
    if isinstance(v, str): return f'str({len(v)})'
    return v
n = 0
for f in glob.glob(os.path.expanduser('~/.miaodong/md/execs/*/*/*/detail.json')):
    d = json.load(open(f))
    kb = {c['id'] for c in (d.get('canvas') or {}).get('rawCanvas') or [] if isinstance(c, dict) and c.get('shape') == 'query-knowledge-base'}
    for r in d.get('nodeResults') or []:
        if r.get('nodeId') in kb:
            n += 1
            if n == 1:
                print('inputs:', json.dumps(shape(r.get('inputs')), ensure_ascii=False)[:800])
                print('output:', json.dumps(shape(r.get('output')), ensure_ascii=False)[:1500])
print('知识库查询节点的运行记录：', n, '条')
EOF
```

Expected：最后一行打出条数。有记录时，前两行分别是节点输入和输出的结构（只打印结构，不打印内容）。

- [ ] **Step 2：写并运行接口核对脚本**

`$SCRATCH/kb-check/check.mjs`：

```js
// 3a 开工前核对（只读、不进仓库）：/qa/list 的 pageSize 上限、语义搜索的 total 和分数下限、/qa/detail、段落 keyword
import { requireIdentities } from '/Users/hukui/Desktop/workspace/miaodong-cli/src/identity.mjs';
import { request } from '/Users/hukui/Desktop/workspace/miaodong-cli/src/http.mjs';

const identity = requireIdentities()[0];
const orgId = identity.currentOrgId;
const kbs = (await request(identity, '/api/knowledge-base/list', { query: { orgId, current: 1, pageSize: 50 } })).data;
const big = kbs.slice().sort((a, b) => b.qaCount - a.qaCount)[0];
const qa = (body) => request(identity, '/api/qa/list', { method: 'POST', query: { orgId }, body: { knowledgeBaseId: big.id, current: 1, filterType: 0, sortType: 'DEFAULT', ...body } });
for (const pageSize of [50, 100, 200, 500]) {
  const r = await qa({ pageSize });
  console.log(`pageSize=${pageSize}：返回 ${r.data.length} 条，page.pageSize=${r.page?.pageSize}，total=${r.page?.total}`);
}
const one = (await qa({ pageSize: 1, filterType: 1 })).data[0];
for (const keyword of [one.question, '完全无关的一句话xyz']) {
  const r = await qa({ pageSize: 50, sortType: 'SIMILARITY', keyword, searchMode: 'semantic' });
  const s = r.data.map((x) => x.similarity);
  console.log(`语义搜索（${keyword === one.question ? '原问题' : '无关的话'}）：返回 ${s.length} 条，total=${r.page?.total}，最低分 ${Math.min(...s).toFixed(3)}`);
}
try {
  const d = await request(identity, '/api/qa/detail', { query: { orgId, knowledgeBaseId: big.id, qaId: one.id } });
  console.log('/qa/detail 可用，字段：', Object.keys(d.data ?? {}).join(','));
} catch (error) {
  console.log('/qa/detail 不可用：', String(error.message).slice(0, 160));
}
const fileKb = kbs.find((k) => k.fileCount > 0);
if (fileKb) {
  const file = (await request(identity, '/api/knowledge-base/file/list', { query: { orgId, knowledgeBaseId: fileKb.id, current: 1, pageSize: 1 } })).data[0];
  const all = (await request(identity, '/api/knowledge-base/file/paragraphs', { query: { orgId, knowledgeBaseId: fileKb.id, id: String(file.id), current: 1, pageSize: 50 } })).data;
  const word = all[0].content.slice(0, 4);
  const hit = (await request(identity, '/api/knowledge-base/file/paragraphs', { query: { orgId, knowledgeBaseId: fileKb.id, id: String(file.id), current: 1, pageSize: 50, keyword: word } })).data;
  console.log(`段落 keyword：全部 ${all.length} 段，按「前 4 个字」过滤后 ${hit.length} 段（${hit.length < all.length ? '生效' : '可能没生效'}）`);
}
```

```bash
cd /Users/hukui/Desktop/workspace/miaodong-cli && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH node --no-warnings --experimental-strip-types --loader ./scripts/ts-resolve-loader.mjs $SCRATCH/kb-check/check.mjs
```

Expected：打出 4 行 pageSize 的结果、2 行语义搜索的结果、1 行 `/qa/detail` 的结论、1 行段落 keyword 的结论。只打印条数、分数和字段名，不打印内容。

- [ ] **Step 3：把结论写回 spec，并记下 Ruling**
  - §2.1：补上 `pageSize` 上限、`/qa/detail` 能不能用、段落 `keyword` 是否生效。
  - §2.3：补上语义搜索的 `total` 和分数下限的结论。
  - §2.5：如果找到了知识库查询节点的运行记录，写明它的输入和输出结构。
  - §7：把做过的条目划掉，写上结论。
  - 账本：
    - 如果 pageSize 上限大于 50：`Task 0: Ruling: PAGE_SIZE 仍用 50——翻页按 total 读全，上限只影响速度——代价：大库慢一点`。
    - 如果找到了知识库查询节点的运行记录：`Task 0: Ruling: Task 6 的 kbNodes 从 inputs/output 按 Step 1 的字段取查询和召回——…`；找不到：`Task 0: Ruling: 3a 的知识库查询节点只按配置和重放判断（spec §3.5 第 2 步）——…`。
    - `/qa/detail` 不在本计划里使用：`--expect` 给 FAQ id 时，本计划用 `listFaqs` 扫库，这样更稳。如果 `/qa/detail` 可用，就记一条 Ruling：「不用它，扫库更稳；大库慢一点」。

- [ ] **Step 4：提交**

```bash
git add docs/specs/2026-09-25-miaodong-cli-step3a-kb-read-design.md
git commit -q -F - <<'EOF'
docs(spec): 3a 开工前核对结论（pageSize 上限、语义搜索 total、/qa/detail、段落 keyword、知识库查询节点的运行记录）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 1：知识库读接口 `src/kb.mjs`，外加假秒懂

**Files:**
- Create：`test/helpers/kb-fixtures.mjs`、`test/helpers/kb-server.mjs`、`test/kb-api.test.mjs`、`src/kb.mjs`

**Interfaces:**
- Produces：`FAQ_FILTER`、`PAGE_SIZE`、`SEARCH_SIZE`、`normalizeKb(raw)`、`normalizeFaq(raw)`、`listKbs(identity, orgId)`、`kbDetails(identity, orgId, kbId)`、`faqMetrics(identity, orgId, kbId)`、`listFaqs(identity, orgId, kbId, { filter })`、`searchFaqs(identity, orgId, kbId, text, { mode, size })`、`checkSimilarity(identity, orgId, kbId, question)`、`listFiles(identity, orgId, kbId)`、`fileDetails(identity, orgId, kbId, fileId)`、`listParagraphs(identity, orgId, kbId, fileId)`、`listWebs(identity, orgId, kbId)`。
  - 知识库：`{ id, name, faqCount, fileCount, webCount, videoCount, model }`
  - FAQ：`{ id(数字), question, answer, reviewed, generated, duplicateStatus, similarity(数字或 null) }`
  - 文件：`{ id(数字), name, extension, status }`
  - 段落：`{ id(数字), index, content, wordCount, status }`
- Produces（测试）：`kb-fixtures` 导出 `KB_FAQ`、`KB_FILE`、`KB_OTHER`、`KB_GONE`、`sim(a, b)`、`faqs()`、`kbList()`、`files()`、`paragraphs()`、`kbCanvas()`、`toolCall(kb, query, { threshold, topK, success })`、`kbExec(n, ask, calls, { extraResults, event })`；`kb-server` 导出 `startKbServer({ details, pageCap, kbs, faqRows })`，返回的对象带 `origin`、`requests`、`state`、`unexpected()`、`close()`。

- [ ] **Step 1：写测试数据 `test/helpers/kb-fixtures.mjs`**

```js
// 知识库测试数据：三个知识库（售后 FAQ、产品手册、财务 FAQ），一张挂了知识库工具的画布，一个拼执行详情的函数。
// 结构照 09-25 的真实数据（spec 3a §2.1、§2.4、§2.5）。分数用一个确定的假相似度算：假服务器的语义搜索也用它，
// 所以用执行里记录的查询重放时，结果和记录一致（真实环境里两边分数也一致，spec §2.3）。
import { U, edge, node } from './fixtures.mjs';
import { X, chainRows, detailOf } from './exec-fixtures.mjs';

// 32 位、不带横杠，和真实的知识库 id 一样
export const KB_FAQ = `aaaa0001${'0'.repeat(24)}`;
export const KB_FILE = `bbbb0002${'0'.repeat(24)}`;
export const KB_OTHER = `cccc0003${'0'.repeat(24)}`;
export const KB_GONE = `dddd0004${'0'.repeat(24)}`; // 画布还引用着，企业里已经没有了

// 假相似度：两句话按两个字一组切开，算 Dice 系数，保留 4 位小数。两句一样时是 1
export function sim(a, b) {
  const grams = (s) => {
    const t = String(s).replace(/\s+/g, '');
    const out = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out.length ? out : [t];
  };
  const A = grams(a);
  const pool = grams(b);
  const total = A.length + pool.length;
  let hit = 0;
  for (const g of A) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return Math.round(((2 * hit) / total) * 10000) / 10000;
}

export const faqs = () => [
  { id: 7001, kb: KB_FAQ, question: '课程怎么退款', answer: '在订单详情页点申请退款，三个工作日内原路退回。', isReviewed: true },
  { id: 7002, kb: KB_FAQ, question: '退款多久到账', answer: '审核通过后三个工作日内原路退回。', isReviewed: true },
  { id: 7003, kb: KB_FAQ, question: '怎么修改收货地址', answer: '发货前可以在订单详情页修改。', isReviewed: true },
  { id: 7004, kb: KB_FAQ, question: '课程可以退吗', answer: '开课七天内可以全额退。', isReviewed: false }, // 未审核：语义搜索搜不到
  { id: 7101, kb: KB_OTHER, question: '发票怎么开', answer: '在我的订单里申请电子发票。', isReviewed: true },
];

export const kbList = () => [
  { id: KB_FAQ, name: '售后 FAQ', qaCount: 4, fileCount: 0, pageCount: 0, videoCount: 0, modelType: 'text-embedding-ada-002' },
  { id: KB_FILE, name: '产品手册', qaCount: 0, fileCount: 1, pageCount: 0, videoCount: 0, modelType: 'text-embedding-ada-002' },
  { id: KB_OTHER, name: '财务 FAQ', qaCount: 1, fileCount: 0, pageCount: 0, videoCount: 0, modelType: 'text-embedding-ada-002' },
];

export const files = () => [{ id: 501, kb: KB_FILE, name: '手册.pdf', extension: 'pdf', status: 'ready', paragraphCount: 2 }];
export const paragraphs = () => [
  { id: 9001, fileId: 501, index: 0, content: '课程退款规则：开课七天内全额退款。', wordCount: 16, status: 'ready' },
  { id: 9002, fileId: 501, index: 1, content: '发票在订单完成后可以申请。', wordCount: 13, status: 'processing' },
];

// 画布：1 收到文本 → 2 回答生成（挂售后 FAQ、财务 FAQ 两个知识库工具）、3 闲聊（挂了一个已被删的库）、4 查手册（知识库查询节点）
export function kbCanvas() {
  const tool = (kb) => ({ type: 'query_kb', configParams: { knowledgeBaseId: kb } });
  return [
    node(1, { name: '收到文本', type: 'receive-text-message', category: 'trigger' }),
    node(2, { name: '回答生成', payload: { modelType: 'doubao', tools: [tool(KB_FAQ), tool(KB_OTHER)] } }),
    node(3, { name: '闲聊', payload: { modelType: 'doubao', tools: [tool(KB_GONE)] } }),
    node(4, {
      name: '查手册', type: 'query-knowledge-base',
      payload: { knowledgeBaseIds: [KB_FILE], resultCount: 5, threshold: 80, rerankType: 'weighted', weightedRerankConfig: { vectorWeight: 0.5 }, query: { valueType: 'reference', dataPath: 'text' } },
    }),
    edge(101, 1, 2), edge(102, 1, 3), edge(103, 1, 4),
  ];
}

// 一次大模型调知识库工具的记录（spec §2.5 的真实结构）。召回按假相似度现算：只有已审核的、过了门槛的，最多 10 条
export function toolCall(kb, query, { threshold = 0.6, topK = 3, success = true } = {}) {
  const result = faqs()
    .filter((f) => f.kb === kb && f.isReviewed)
    .map((f) => ({ f, score: sim(query, f.question) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ f, score }) => ({
      knowledgeBaseId: kb, score, content: `${f.question} ${f.answer}`, sourceType: 'qa',
      reference: { type: 'qa', source: { id: f.id, question: f.question, answer: f.answer, reviewed: true, duplicateStatus: 'normal' } },
    }));
  return {
    name: `q_kb_${kb}`, toolType: 'query_kb', toolCallArguments: { query, threshold, topK },
    toolResult: success ? { success: true, result } : { success: false, error: '知识库服务超时' },
  };
}

// 一条执行：用户问 ask（event=true 时是事件触发、取不到用户原话），「回答生成」这次的知识库工具调用是 calls
export function kbExec(n, ask, calls, { extraResults = [], event = false } = {}) {
  const row = { ...chainRows()[0], execId: X(n) };
  if (event) {
    row.triggerContent = { triggerType: 'canvas-event-trigger', content: { eventId: 'ev-x', eventName: '回访', data: { contactId: 'c1' } } };
    row.rawTrigger = { triggerType: 'canvas-event-trigger', sessionId: row.sessionId, triggerSource: 'mh', canvasEvent: { eventId: 'ev-x', data: { contactId: 'c1' } } };
  } else {
    row.triggerContent = { triggerType: 'receive-text-message', content: { text: ask } };
    row.rawTrigger = { triggerType: 'receive-text-message', sessionId: row.sessionId, triggerSource: 'mh', receiveTextMessage: { text: ask, contactId: 'c1' } };
  }
  const nodeResults = [
    { nodeId: U(1), status: 'success', inputs: { inputData: {} }, output: { text: ask }, processDuration: 1, actions: [] },
    { nodeId: U(2), status: 'success', inputs: { inputData: { text: ask } }, output: { message: '好的' }, processDuration: 900, actions: [], metadata: { toolCallResults: calls } },
    ...extraResults,
  ];
  return detailOf(row, { snapshot: kbCanvas(), nodeResults });
}
```

- [ ] **Step 2：写假秒懂 `test/helpers/kb-server.mjs`**

```js
// 带知识库的假秒懂（spec 3a §2.1、§2.2）。读接口按真实行为返回，并复现 §2.2 的坑：
//   /qa/list 的 filterType 传字符串时只回未审核的（不报错）；段落列表缺 knowledgeBaseId 回 400；
//   相似度检查回 qaId；语义搜索不含未审核的。
// 读接口清单之外的请求都走 404，unexpected() 把它们列出来：测试断言它为空，保证 md kb 只读。
// state.faqs 可以在测试中途改（模拟「执行之后知识库改过」）。
import { ok, startFakeMiaodong } from './fake-miaodong.mjs';
import { EXEC_BOT } from './exec-fixtures.mjs';
import { faqs, files, kbCanvas, kbList, paragraphs, sim } from './kb-fixtures.mjs';

const bad = (message) => ({ status: 400, body: { statusCode: 400, message, error: 'Bad Request' } });

export async function startKbServer({ details = {}, pageCap = Infinity, kbs = kbList(), faqRows = faqs() } = {}) {
  const state = { faqs: faqRows };
  const page = (rows, current, pageSize) => {
    const size = Math.min(Number(pageSize) || 20, pageCap);
    const c = Number(current) || 1;
    return ok(rows.slice((c - 1) * size, c * size), { page: { current: c, pageSize: size, total: rows.length } });
  };
  const faqOut = (f, extra = {}) => ({
    id: f.id, question: f.question, answer: f.answer, isReviewed: f.isReviewed, isAutogenerated: false,
    duplicateStatus: f.duplicateStatus ?? 'normal', materials: [], mhMaterialIds: [], tags: [], ...extra,
  });
  const routes = {
    'GET /api/bot/list': ({ query }) => ok(query.orgId === 'org-1' ? [{ id: EXEC_BOT, name: '太极2.0 质检革新版' }] : []),
    'GET /api/canvas/get': () => ok({ canvasId: 'main-1', rawCanvas: kbCanvas(), version: 'v1.0.403', updatedAt: '2026-09-24T01:00:00.000Z' }),
    'GET /api/canvas/list-version': () => ok([{ canvasId: 'ver-402', version: 'v1.0.402', name: '402', versionType: 'online' }]),
    'GET /api/canvas/history/details': ({ query }) => (details[query.execId]
      ? ok(details[query.execId])
      : { status: 201, body: { code: -1, message: 'CANVAS_EXEC_NOT_FOUND' } }),
    'GET /api/knowledge-base/list': ({ query }) => page(kbs, query.current, query.pageSize),
    'GET /api/knowledge-base/details': ({ query }) => {
      const k = kbs.find((x) => x.id === query.knowledgeBaseId);
      return k
        ? ok({ knowledgeBaseId: k.id, name: k.name, qaCount: k.qaCount, docCount: k.fileCount, webCount: k.pageCount, videoCount: k.videoCount, embeddingModel: k.modelType })
        : bad('knowledge base not found');
    },
    'GET /api/qa/metrics': ({ query }) => {
      const rows = state.faqs.filter((f) => f.kb === query.knowledgeBaseId);
      return ok({ total: rows.length, reviewed: rows.filter((f) => f.isReviewed).length, unreviewed: rows.filter((f) => !f.isReviewed).length });
    },
    'POST /api/qa/list': ({ body }) => {
      if (body.filterType === undefined || body.sortType === undefined) {
        return bad('filterType must be one of the following values: ALL, REVIEWED, GENERATED, 0, 1, 2');
      }
      let rows = state.faqs.filter((f) => f.kb === body.knowledgeBaseId);
      if (typeof body.filterType === 'string') rows = rows.filter((f) => !f.isReviewed); // 真实服务端的坑：传字符串一律只回未审核的
      else if (body.filterType === 1) rows = rows.filter((f) => f.isReviewed);
      else if (body.filterType === 2) rows = rows.filter((f) => !f.isReviewed);
      let out = rows.map((f) => faqOut(f));
      if (body.sortType === 'SIMILARITY' && body.keyword) {
        out = body.searchMode === 'text'
          ? rows.filter((f) => f.question.includes(body.keyword) || f.answer.includes(body.keyword)).map((f) => faqOut(f))
          : rows.filter((f) => f.isReviewed)
            .map((f) => faqOut(f, { similarity: sim(body.keyword, f.question) }))
            .sort((a, b) => b.similarity - a.similarity);
      }
      return page(out, body.current, body.pageSize);
    },
    'POST /api/qa/check-similarity': ({ body }) => ok(state.faqs
      .filter((f) => f.kb === body.knowledgeBaseId)
      .map((f) => ({ qaId: f.id, question: f.question, answer: f.answer, similarity: sim(body.question, f.question), reviewed: f.isReviewed, materials: [], mhMaterialIds: [] }))
      .filter((f) => f.similarity >= 0.5)
      .sort((a, b) => b.similarity - a.similarity)),
    'GET /api/knowledge-base/file/list': ({ query }) => page(
      files().filter((f) => f.kb === query.knowledgeBaseId).map(({ kb, paragraphCount, ...f }) => ({ ...f, createAt: 0, createBy: 'u', tags: [] })),
      query.current, query.pageSize,
    ),
    'GET /api/knowledge-base/file/details': ({ query }) => {
      const f = files().find((x) => String(x.id) === String(query.docId) && x.kb === query.knowledgeBaseId);
      return f
        ? ok({ id: f.id, name: f.name, status: f.status, extension: f.extension, paragraphCount: f.paragraphCount, docUrl: 'https://example.com/a.pdf', abstract: '', tags: [] })
        : bad('doc not found');
    },
    'GET /api/knowledge-base/file/paragraphs': ({ query }) => {
      if (!query.knowledgeBaseId) return bad('knowledgeBaseId must be a string');
      if (!/^\d+$/.test(String(query.id ?? ''))) return bad('id must be a number string');
      const rows = paragraphs().filter((p) => String(p.fileId) === query.id).map(({ fileId, ...p }) => ({ ...p, createdAt: 0 }));
      return page(rows, query.current, query.pageSize);
    },
    'GET /api/knowledge-base/web/list': ({ query }) => page([], query.current, query.pageSize),
  };
  const server = await startFakeMiaodong(routes);
  const reads = new Set(Object.keys(routes));
  return Object.assign(server, { state, unexpected: () => server.requests.filter((r) => !reads.has(`${r.method} ${r.path}`)) });
}
```

- [ ] **Step 3：写会失败的测试 `test/kb-api.test.mjs`**

```js
// 知识库读接口（spec 3a §2.1、§2.2）：字段统一、按 total 分页读全、filterType 只传数字、段落带 knowledgeBaseId、qaId 统一成 id、只读
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { checkSimilarity, faqMetrics, fileDetails, kbDetails, listFaqs, listKbs, listParagraphs, searchFaqs } from '../src/kb.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ, KB_FILE } from './helpers/kb-fixtures.mjs';

let server;
let capped;
before(async () => {
  server = await startKbServer();
  capped = await startKbServer({ pageCap: 1 });
});
after(async () => {
  await server.close();
  await capped.close();
});
const who = (s) => ({ key: 'k1', label: '测试区', origin: s.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }] });

test('kb api：服务端每页只给 1 条时，也按 page.total 把知识库和 FAQ 读全（Review Focus 1）', async () => {
  const kbs = await listKbs(who(capped), 'org-1');
  assert.deepEqual(kbs.map((k) => k.name), ['售后 FAQ', '产品手册', '财务 FAQ']);
  assert.deepEqual(kbs[0], { id: KB_FAQ, name: '售后 FAQ', faqCount: 4, fileCount: 0, webCount: 0, videoCount: 0, model: 'text-embedding-ada-002' });
  assert.equal((await listFaqs(who(capped), 'org-1', KB_FAQ)).length, 4);
});

test('kb api：FAQ 列表的 filterType 只传数字——传字符串时服务端只回未审核的（spec §2.2 第 1 条）', async () => {
  const all = await listFaqs(who(server), 'org-1', KB_FAQ);
  assert.deepEqual(all.map((f) => [f.id, f.reviewed]), [[7001, true], [7002, true], [7003, true], [7004, false]]);
  const bodies = server.requests.filter((r) => r.path === '/api/qa/list').map((r) => r.body);
  assert.ok(bodies.length > 0 && bodies.every((b) => typeof b.filterType === 'number'));
});

test('kb api：详情的字段名统一成列表那一套（knowledgeBaseId → id，docCount → fileCount）；FAQ 统计', async () => {
  assert.deepEqual(await kbDetails(who(server), 'org-1', KB_FILE), { id: KB_FILE, name: '产品手册', faqCount: 0, fileCount: 1, webCount: 0, videoCount: 0, model: 'text-embedding-ada-002' });
  assert.deepEqual(await faqMetrics(who(server), 'org-1', KB_FAQ), { total: 4, reviewed: 3, unreviewed: 1 });
});

test('kb api：语义搜索不含未审核、分数从高到低；文字搜索含未审核；相似度检查的 qaId 统一成 id', async () => {
  const semantic = await searchFaqs(who(server), 'org-1', KB_FAQ, '课程怎么退款');
  assert.deepEqual(semantic.map((f) => f.id), [7001, 7002, 7003]);
  assert.equal(semantic[0].similarity, 1);
  assert.ok(semantic.every((f, i) => i === 0 || f.similarity <= semantic[i - 1].similarity));
  const text = await searchFaqs(who(server), 'org-1', KB_FAQ, '课程可以退吗', { mode: 'text' });
  assert.deepEqual(text.map((f) => f.id), [7004]);
  const similar = await checkSimilarity(who(server), 'org-1', KB_FAQ, '课程可以退吗');
  assert.deepEqual(similar[0], { id: 7004, question: '课程可以退吗', answer: '开课七天内可以全额退。', reviewed: false, generated: false, duplicateStatus: 'normal', similarity: 1 });
});

test('kb api：段落列表同时带数字 id 和 knowledgeBaseId（缺了服务端回 400，spec §2.2 第 2 条）；文件详情', async () => {
  const ps = await listParagraphs(who(server), 'org-1', KB_FILE, 501);
  assert.deepEqual(ps.map((p) => [p.id, p.status]), [[9001, 'ready'], [9002, 'processing']]);
  const q = server.requests.filter((r) => r.path === '/api/knowledge-base/file/paragraphs').at(-1).query;
  assert.deepEqual([q.knowledgeBaseId, q.id], [KB_FILE, '501']);
  assert.deepEqual(await fileDetails(who(server), 'org-1', KB_FILE, 501), { id: 501, name: '手册.pdf', status: 'ready', paragraphCount: 2 });
});

test('kb api：只调读接口', () => {
  assert.deepEqual([...server.unexpected(), ...capped.unexpected()], []);
});
```

- [ ] **Step 4：跑测试，确认失败**

Run：`T test/kb-api.test.mjs`
Expected：FAIL，报错是找不到 `../src/kb.mjs`（`ERR_MODULE_NOT_FOUND`）。

- [ ] **Step 5：写 `src/kb.mjs`**

```js
// 秒懂知识库的读接口（spec 3a §2.1）。只读：这里没有任何写接口的封装。
// §2.2 的两个坑在这一层挡住：
// - FAQ 列表的 filterType 只传数字：传字符串时服务端一律只回未审核的，还不报错；
// - 列表和详情的字段名不一样（id / knowledgeBaseId、fileCount / docCount、pageCount / webCount），
//   相似度检查的 id 叫 qaId：这里统一成一套。
import { request } from './http.mjs';
import { asArray } from './api.mjs';

export const FAQ_FILTER = Object.freeze({ ALL: 0, REVIEWED: 1, PENDING: 2 });
export const PAGE_SIZE = 50;
export const SEARCH_SIZE = 50;
const MAX_PAGES = 1000;

const str = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);

export function normalizeKb(raw) {
  return {
    id: str(raw?.id ?? raw?.knowledgeBaseId),
    name: str(raw?.name),
    faqCount: num(raw?.qaCount),
    fileCount: num(raw?.fileCount ?? raw?.docCount),
    webCount: num(raw?.pageCount ?? raw?.webCount),
    videoCount: num(raw?.videoCount),
    model: str(raw?.modelType ?? raw?.embeddingModel),
  };
}

export function normalizeFaq(raw) {
  return {
    id: num(raw?.id ?? raw?.qaId),
    question: str(raw?.question),
    answer: str(raw?.answer),
    reviewed: (raw?.isReviewed ?? raw?.reviewed) === true,
    generated: raw?.isAutogenerated === true,
    duplicateStatus: str(raw?.duplicateStatus) || 'normal',
    similarity: typeof raw?.similarity === 'number' ? raw.similarity : null,
  };
}

// 服务端可能把每页封顶在比 pageSize 小的条数：有 page.total 时按它判断读没读完，没有才看这一页满没满
async function allPages(fetchPage) {
  const rows = [];
  for (let current = 1; current <= MAX_PAGES; current++) {
    const { list, total } = await fetchPage(current);
    rows.push(...list);
    if (!list.length) break;
    if (Number.isFinite(total) && total > 0) {
      if (rows.length >= total) break;
    } else if (list.length < PAGE_SIZE) break;
  }
  return rows;
}
const pageOf = (payload) => ({ list: asArray(payload?.data), total: Number(payload?.page?.total) });

export async function listKbs(identity, orgId) {
  const rows = await allPages(async (current) => pageOf(await request(identity, '/api/knowledge-base/list', { query: { orgId, current, pageSize: PAGE_SIZE } })));
  return rows.map(normalizeKb).filter((k) => k.id);
}

export async function kbDetails(identity, orgId, kbId) {
  const payload = await request(identity, '/api/knowledge-base/details', { query: { orgId, knowledgeBaseId: kbId } });
  return normalizeKb(payload?.data ?? {});
}

export async function faqMetrics(identity, orgId, kbId) {
  const d = (await request(identity, '/api/qa/metrics', { query: { orgId, knowledgeBaseId: kbId } }))?.data ?? {};
  return { total: num(d.total), reviewed: num(d.reviewed), unreviewed: num(d.unreviewed) };
}

export async function listFaqs(identity, orgId, kbId, { filter = FAQ_FILTER.ALL } = {}) {
  const rows = await allPages(async (current) => pageOf(await request(identity, '/api/qa/list', {
    method: 'POST',
    query: { orgId },
    body: { knowledgeBaseId: kbId, current, pageSize: PAGE_SIZE, filterType: filter, sortType: 'DEFAULT' },
  })));
  return rows.map(normalizeFaq);
}

// 按相似度搜 FAQ。mode=semantic：语义搜索，分数就是大模型知识库工具的分数（spec §2.3），未审核的不在索引里；
// mode=text：问题或答案里包含这段文字，未审核的也算
export async function searchFaqs(identity, orgId, kbId, text, { mode = 'semantic', size = SEARCH_SIZE } = {}) {
  const payload = await request(identity, '/api/qa/list', {
    method: 'POST',
    query: { orgId },
    body: { knowledgeBaseId: kbId, current: 1, pageSize: size, filterType: FAQ_FILTER.ALL, sortType: 'SIMILARITY', keyword: text, searchMode: mode },
  });
  return asArray(payload?.data).map(normalizeFaq);
}

// 问题对问题的相似度：未审核的也查得到（spec §2.3）
export async function checkSimilarity(identity, orgId, kbId, question) {
  const payload = await request(identity, '/api/qa/check-similarity', { method: 'POST', query: { orgId }, body: { knowledgeBaseId: kbId, question } });
  return asArray(payload?.data).map(normalizeFaq);
}

export async function listFiles(identity, orgId, kbId) {
  const rows = await allPages(async (current) => pageOf(await request(identity, '/api/knowledge-base/file/list', {
    query: { orgId, knowledgeBaseId: kbId, current, pageSize: PAGE_SIZE },
  })));
  return rows.map((f) => ({ id: num(f.id), name: str(f.name), extension: str(f.extension), status: str(f.status) }));
}

export async function fileDetails(identity, orgId, kbId, fileId) {
  const d = (await request(identity, '/api/knowledge-base/file/details', { query: { orgId, knowledgeBaseId: kbId, docId: fileId } }))?.data ?? {};
  return { id: num(d.id), name: str(d.name), status: str(d.status), paragraphCount: num(d.paragraphCount) };
}

// 段落列表：id 是文件的数字 id（以字符串传）；knowledgeBaseId 文档里漏写了，缺了回 400（spec §2.2 第 2 条）
export async function listParagraphs(identity, orgId, kbId, fileId) {
  const rows = await allPages(async (current) => pageOf(await request(identity, '/api/knowledge-base/file/paragraphs', {
    query: { orgId, knowledgeBaseId: kbId, id: String(fileId), current, pageSize: PAGE_SIZE },
  })));
  return rows.map((p) => ({ id: num(p.id), index: num(p.index), content: str(p.content), wordCount: num(p.wordCount), status: str(p.status) }));
}

export async function listWebs(identity, orgId, kbId) {
  const rows = await allPages(async (current) => pageOf(await request(identity, '/api/knowledge-base/web/list', {
    query: { orgId, knowledgeBaseId: kbId, current, pageSize: PAGE_SIZE },
  })));
  return rows.map((w) => ({ id: str(w.id), name: str(w.name ?? w.title), url: str(w.url), status: str(w.status) }));
}
```

- [ ] **Step 6：跑测试，确认通过**

Run：`T test/kb-api.test.mjs`
Expected：PASS 6/6。

- [ ] **Step 7：提交**

```bash
git add src/kb.mjs test/helpers/kb-fixtures.mjs test/helpers/kb-server.mjs test/kb-api.test.mjs
git commit -q -F - <<'EOF'
feat(kb): 知识库读接口——字段统一、按 total 分页、filterType 只传数字（spec 3a §2.1、§2.2）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2：画布里的知识库引用 `src/kb-refs.mjs`，以及知识库名字匹配

**Files:**
- Create：`src/kb-refs.mjs`、`src/kb-target.mjs`（这一步只放 `matchKbs`）、`test/kb-refs.test.mjs`

**Interfaces:**
- Consumes：`asArray`（`src/api.mjs`）、`isEdgeCell`（`src/canvas.mjs`）
- Produces：
  - `toolKbId(name) → string | null`：从 `q_kb_<id>` 取出知识库 id；
  - `kbRefs(canvas)`，返回数组，元素是下面两种之一：
    - `{ kind: 'tool', nodeId, nodeName, kbIds }`
    - `{ kind: 'node', nodeId, nodeName, kbIds, resultCount, threshold, rerank }`
  - `matchKbs(kbs, query) → kb[]`，匹配顺序：id 完全一致、4 位以上 id 前缀、名字完全一致、名字包含。

- [ ] **Step 1：写会失败的测试 `test/kb-refs.test.mjs`**

```js
// 画布里的知识库引用（spec 3a §2.4）和知识库的名字匹配（§3.1）
import test from 'node:test';
import assert from 'node:assert/strict';
import { kbRefs, toolKbId } from '../src/kb-refs.mjs';
import { matchKbs } from '../src/kb-target.mjs';
import { U } from './helpers/fixtures.mjs';
import { KB_FAQ, KB_FILE, KB_GONE, KB_OTHER, kbCanvas } from './helpers/kb-fixtures.mjs';

test('kb refs：大模型节点挂的知识库工具、知识库查询节点都认得；连线和普通节点不算', () => {
  assert.deepEqual(kbRefs(kbCanvas()), [
    { kind: 'tool', nodeId: U(2), nodeName: '回答生成', kbIds: [KB_FAQ, KB_OTHER] },
    { kind: 'tool', nodeId: U(3), nodeName: '闲聊', kbIds: [KB_GONE] },
    { kind: 'node', nodeId: U(4), nodeName: '查手册', kbIds: [KB_FILE], resultCount: 5, threshold: 80, rerank: '加权（向量 0.5）' },
  ]);
});

test('kb refs：执行记录里的工具名 q_kb_<知识库 id> 换回知识库 id', () => {
  assert.equal(toolKbId(`q_kb_${KB_FAQ}`), KB_FAQ);
  assert.equal(toolKbId('search_web'), null);
});

test('kb target：知识库按 id > 4 位以上 id 前缀 > 名字 > 名字包含 找；同一档多个就都返回', () => {
  const kbs = [{ id: KB_FAQ, name: '售后 FAQ' }, { id: KB_OTHER, name: '财务 FAQ' }, { id: KB_FILE, name: '产品手册' }];
  assert.deepEqual(matchKbs(kbs, KB_FILE).map((k) => k.name), ['产品手册']);
  assert.deepEqual(matchKbs(kbs, 'aaaa').map((k) => k.name), ['售后 FAQ']);
  assert.deepEqual(matchKbs(kbs, 'aaa').map((k) => k.name), []);
  assert.deepEqual(matchKbs(kbs, '产品手册').map((k) => k.name), ['产品手册']);
  assert.deepEqual(matchKbs(kbs, 'FAQ').map((k) => k.name), ['售后 FAQ', '财务 FAQ']);
});
```

- [ ] **Step 2：跑测试，确认失败**

Run：`T test/kb-refs.test.mjs`
Expected：FAIL，`ERR_MODULE_NOT_FOUND`（`src/kb-refs.mjs`）。

- [ ] **Step 3：写 `src/kb-refs.mjs` 和 `src/kb-target.mjs`**

`src/kb-refs.mjs`：

```js
// 画布里的知识库引用（spec 3a §2.4）。纯函数。
// - 大模型节点挂的知识库工具（主路径）：data.nodePayload.tools[] 里的 { type: 'query_kb', configParams: { knowledgeBaseId } }；
// - 知识库查询节点（次要路径）：data.type 是 query-knowledge-base，配置在 data.nodePayload。
import { asArray } from './api.mjs';
import { isEdgeCell } from './canvas.mjs';

// 执行记录里，工具调用的名字是 q_kb_<知识库 id>（spec §2.5）
const TOOL_NAME = /^q_kb_([0-9a-z]+)$/i;
export function toolKbId(name) {
  const m = TOOL_NAME.exec(String(name ?? ''));
  return m ? m[1] : null;
}

function rerankOf(p) {
  if (p.rerankType === 'weighted') return `加权（向量 ${p.weightedRerankConfig?.vectorWeight ?? '?'}）`;
  if (p.rerankType) return `${p.rerankType}${p.modelRerankConfig?.modelType ? `（${p.modelRerankConfig.modelType}）` : ''}`;
  return '无';
}

export function kbRefs(canvas) {
  const refs = [];
  for (const c of asArray(canvas)) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || isEdgeCell(c)) continue;
    const payload = c.data?.nodePayload ?? {};
    const nodeName = String(c.data?.name ?? '');
    if ((c.data?.type ?? c.shape) === 'query-knowledge-base') {
      refs.push({
        kind: 'node', nodeId: c.id, nodeName,
        kbIds: asArray(payload.knowledgeBaseIds).map(String),
        resultCount: Number(payload.resultCount) || null,
        threshold: typeof payload.threshold === 'number' ? payload.threshold : null,
        rerank: rerankOf(payload),
      });
      continue;
    }
    const kbIds = asArray(payload.tools)
      .filter((t) => t?.type === 'query_kb')
      .map((t) => String(t.configParams?.knowledgeBaseId ?? ''))
      .filter(Boolean);
    if (kbIds.length) refs.push({ kind: 'tool', nodeId: c.id, nodeName, kbIds });
  }
  return refs;
}
```

`src/kb-target.mjs`（这一步只放名字匹配，Task 3 再加区、企业和知识库的换算）：

```js
// 知识库命令的「区 / 企业 / 知识库」换算（spec 3a §3.1）。
// 知识库按 id 完全一致 > id 前缀（至少 4 位）> 名字完全一致 > 名字包含 的顺序找；同一档命中多个，由调用方列出候选停下。
const norm = (v) => String(v ?? '').trim().toLowerCase();

export function matchKbs(kbs, query) {
  const q = norm(query);
  const tiers = [
    (k) => norm(k.id) === q,
    (k) => q.length >= 4 && norm(k.id).startsWith(q),
    (k) => norm(k.name) === q,
    (k) => norm(k.name).includes(q),
  ];
  for (const matches of tiers) {
    const hits = kbs.filter(matches);
    if (hits.length) return hits;
  }
  return [];
}
```

- [ ] **Step 4：跑测试，确认通过**

Run：`T test/kb-refs.test.mjs`
Expected：PASS 3/3。

- [ ] **Step 5：提交**

```bash
git add src/kb-refs.mjs src/kb-target.mjs test/kb-refs.test.mjs
git commit -q -F - <<'EOF'
feat(kb): 画布里的知识库引用（大模型工具、知识库查询节点）和知识库名字匹配

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3：`md kb` 命令和 `md kb list`

**Files:**
- Create：`src/commands/kb.mjs`、`src/commands/kb-list.mjs`、`test/kb-cli-list.test.mjs`
- Modify：`src/kb-target.mjs`（加 `orgEntries`、`resolveOrg`、`resolveKb`、`kbLine`）、`src/commands/index.mjs`（登记 `kb`）

**Interfaces:**
- Consumes：`listKbs`、`faqMetrics`（Task 1）；`kbRefs`、`matchKbs`（Task 2）；`resolveBot`、`targetArgs`、`filterEntries`、`resolveVersion`（`src/target.mjs`）；`getCanvas`、`listVersions`（`src/api.mjs`）；`requireIdentities`（`src/identity.mjs`）；`out`、`shortId`、`targetLine`（`src/output.mjs`）
- Produces：
  - `resolveOrg(args)`，返回 `{ identityKey, regionLabel, orgId, orgName, identity, bot? }`；
  - `resolveKb(org, query)`，返回知识库对象；
  - `kbLine(org, kb)`，返回字符串 `区 / 企业 / 名字 (id8)`；
  - `kb` 命令对象，结构是 `{ summary, usage, run }`。

- [ ] **Step 1：写会失败的测试 `test/kb-cli-list.test.mjs`**

```js
// md kb list（spec 3a §3.2）：企业的全部知识库；--bot 时这个智能体怎么用知识库、FAQ 未审核数、被删的库；多个企业时要指定
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';

let server;
before(async () => { server = await startKbServer(); });
after(() => server.close());
function home({ second = false } = {}) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  if (second) seedIdentity(h, { key: 'k2', label: '另一个区', origin: server.origin, token: 't', orgs: [{ id: 'org-2', name: '别的企业' }], currentOrgId: 'org-2' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });

test('md kb list：列出企业的全部知识库和各类数量；第一行是区 / 企业', async () => {
  const r = await md(['kb', 'list']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], '测试区 / 兴趣岛平台');
  assert.match(r.stdout, /共 3 个知识库/);
  assert.match(r.stdout, /售后 FAQ \(aaaa0001\)\s+FAQ 4 · 文件 0 · 网页 0 · 视频 0 · text-embedding-ada-002/);
});

test('md kb list --bot：大模型节点挂的库、知识库查询节点的配置、FAQ 未审核数；被删的库单独标出来', async () => {
  const r = await md(['kb', 'list', '--bot', '太极2.0 质检革新版']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^测试区 \/ 兴趣岛平台 \/ 太极2\.0 质检革新版 \(147bd600\) \/ 草稿\n/);
  assert.match(r.stdout, /回答生成 \[00000002\]：售后 FAQ、财务 FAQ/);
  assert.match(r.stdout, /闲聊 \[00000003\]：❌ 已不存在（dddd0004）/);
  assert.match(r.stdout, /查手册 \[00000004\]：产品手册 · 召回 5 条 · 门槛 80 · 重排 加权（向量 0\.5）/);
  assert.match(r.stdout, /售后 FAQ \(aaaa0001\).*⚠️ 未审核 1 条：这些 FAQ 检索不到/);
  assert.match(r.stdout, /❌ dddd0004：企业里没有这个库（被删了？），引用它的节点永远召回不到/);
});

test('md kb list --bot --version：看指定版本的引用', async () => {
  const r = await md(['kb', 'list', '--bot', '太极2.0 质检革新版', '--version', 'v1.0.402']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.split('\n')[0], /\/ v1\.0\.402$/);
});

test('md kb list：本机能看到两个企业时，不带 --region / --org 就列候选停下（退出码 4）（Review Focus 5）', async () => {
  const h = home({ second: true });
  const r = await md(['kb', 'list'], h);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /能看到 2 个企业，请用 --region 或 --org 指定/);
  const picked = await md(['kb', 'list', '--org', '兴趣岛平台'], h);
  assert.equal(picked.code, 0, picked.stderr);
});

test('md kb：只调读接口；不认识的子命令报用法错误', async () => {
  const r = await md(['kb', 'nope']);
  assert.equal(r.code, 2);
  assert.deepEqual(server.unexpected(), []);
});
```

- [ ] **Step 2：跑测试，确认失败**

Run：`T test/kb-cli-list.test.mjs`
Expected：FAIL，退出码是 2 而不是 0，stderr 是「未知命令：kb」。

- [ ] **Step 3：补全 `src/kb-target.mjs`**

在 Task 2 那个文件的末尾加上下面的内容，并在文件开头补上这几行 import：

```js
import { EXIT, MdError } from './errors.mjs';
import { requireIdentities } from './identity.mjs';
import { listKbs } from './kb.mjs';
import { shortId } from './output.mjs';
import { filterEntries, resolveBot, targetArgs } from './target.mjs';
```

```js
// 区和企业来自本机身份，不拉智能体目录；带 --bot 时跟着智能体走
export function orgEntries() {
  return requireIdentities().flatMap((identity) => identity.orgs.map((org) => ({
    identityKey: identity.key, regionLabel: identity.label, orgId: org.id, orgName: org.name, identity,
  })));
}

export async function resolveOrg(args) {
  const t = targetArgs(args);
  if (t.bot) {
    const bot = await resolveBot(t);
    return { identityKey: bot.identityKey, regionLabel: bot.regionLabel, orgId: bot.orgId, orgName: bot.orgName, identity: bot.identity, bot };
  }
  const hits = filterEntries(orgEntries(), { region: t.region, org: t.org });
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new MdError('org_not_found', '找不到这个区或企业', { exitCode: EXIT.TARGET, hint: 'md orgs 看本机身份能看到哪些企业' });
  const lines = hits.map((h) => `  - ${h.regionLabel} / ${h.orgName}`).join('\n');
  throw new MdError('org_ambiguous', `本机身份能看到 ${hits.length} 个企业，请用 --region 或 --org 指定：\n${lines}`, { exitCode: EXIT.TARGET });
}

export function pickKb(kbs, query) {
  const hits = matchKbs(kbs, query);
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new MdError('kb_not_found', `找不到知识库「${query}」`, { exitCode: EXIT.TARGET, hint: 'md kb list 看这个企业有哪些知识库' });
  const lines = hits.slice(0, 20).map((k) => `  - ${k.name} (${shortId(k.id)})`).join('\n');
  throw new MdError('kb_ambiguous', `「${query}」匹配到 ${hits.length} 个知识库：\n${lines}`, { exitCode: EXIT.TARGET, hint: '用更完整的名字或 id 前缀' });
}

export async function resolveKb(org, query) {
  return pickKb(await listKbs(org.identity, org.orgId), query);
}

export function kbLine(org, kb) {
  return `${org.regionLabel} / ${org.orgName} / ${kb.name} (${shortId(kb.id)})`;
}
```

- [ ] **Step 4：写 `src/commands/kb.mjs` 和 `src/commands/kb-list.mjs`，并登记命令**

`src/commands/kb.mjs`（这一步先只登记 `list`；Task 4、5、8 再加 `pull`、`find`、`why`，USAGE 里先写全）：

```js
// md kb：知识库（spec 3a）。全部只读：看有哪些库、拉到本机、查一句话、查一条执行为什么没召回。子命令分在 kb-*.mjs 里，这里只分发
import { usage } from '../errors.mjs';
import { list } from './kb-list.mjs';

const SUBS = { list };

const USAGE = [
  'md kb list [--bot <智能体> [--version vX]] [--region <区>] [--org <企业>]   知识库列表；--bot 只列这个智能体引用的库、各节点怎么挂的、FAQ 未审核数',
  'md kb pull <知识库> [--region <区>] [--org <企业>]           把全部 FAQ、文件、段落拉到本机；条数和平台对不上就报错',
  'md kb find <知识库> "<一句话>" [--local]                    文字命中 + 语义最像 + 问题相似（含未审核），带分数和状态',
  'md kb why <执行id> [--node <节点|#序号>] [--expect <FAQ id|"关键词">]   这次为什么没召回：重放当时的检索，给出原因和证据',
  '全部只读、不花钱；知识库全文只存本机 ~/.miaodong/md/kb/，终端里答案和段落只显示前 60 个字',
];

export const kb = {
  summary: '知识库（只读）：列知识库和智能体的引用，拉到本机，查一句话的命中和分数，查一条执行为什么没召回',
  usage: USAGE.join('\n'),
  async run(args) {
    const sub = args._[0];
    const handler = SUBS[sub];
    if (!handler) throw usage(sub ? `不认识「md kb ${sub}」` : '缺子命令', `可用：${Object.keys(SUBS).join('、')}`);
    return handler({ ...args, _: args._.slice(1) });
  },
};
```

`src/commands/kb-list.mjs`：

```js
// md kb list（spec 3a §3.2）：企业的全部知识库；--bot 时列出这个智能体怎么用知识库：
// 大模型节点挂了哪些库（门槛和条数由模型每次调用时自己定，不列）、知识库查询节点的配置、各库 FAQ 未审核数、已经被删的库。
import { strArg } from '../args.mjs';
import { EXIT } from '../errors.mjs';
import { getCanvas, listVersions } from '../api.mjs';
import { faqMetrics, listKbs } from '../kb.mjs';
import { kbRefs } from '../kb-refs.mjs';
import { resolveOrg } from '../kb-target.mjs';
import { resolveVersion } from '../target.mjs';
import { out, shortId, targetLine } from '../output.mjs';

const counts = (k) => `FAQ ${k.faqCount} · 文件 ${k.fileCount} · 网页 ${k.webCount} · 视频 ${k.videoCount}`;

export async function list(args) {
  const org = await resolveOrg(args);
  const kbs = await listKbs(org.identity, org.orgId);
  if (!org.bot) {
    out(`${org.regionLabel} / ${org.orgName}`);
    out(`共 ${kbs.length} 个知识库`);
    for (const k of kbs) out(`  ${k.name} (${shortId(k.id)})  ${counts(k)}${k.model ? ` · ${k.model}` : ''}`);
    return EXIT.OK;
  }
  const { bot } = org;
  let canvas = await getCanvas(bot.identity, bot.orgId, bot.botId);
  let versionLabel = '草稿';
  const versionQuery = strArg(args, 'version');
  if (versionQuery) {
    const version = resolveVersion(await listVersions(bot.identity, bot.orgId, canvas.canvasId), versionQuery);
    canvas = await getCanvas(bot.identity, bot.orgId, bot.botId, version.canvasId);
    versionLabel = version.version;
  }
  const byId = new Map(kbs.map((k) => [k.id, k]));
  const nameOf = (id) => byId.get(id)?.name ?? `❌ 已不存在（${shortId(id)}）`;
  const refs = kbRefs(canvas.rawCanvas);
  const tools = refs.filter((r) => r.kind === 'tool');
  const nodes = refs.filter((r) => r.kind === 'node');
  out(targetLine({ ...bot, versionLabel }));
  out(`大模型节点挂的知识库工具（${tools.length} 个节点；门槛和条数由模型每次调用时定）：`);
  for (const r of tools) out(`  ${r.nodeName} [${shortId(r.nodeId)}]：${r.kbIds.map(nameOf).join('、')}`);
  out(`知识库查询节点（${nodes.length} 个）：`);
  for (const r of nodes) out(`  ${r.nodeName} [${shortId(r.nodeId)}]：${r.kbIds.map(nameOf).join('、')} · 召回 ${r.resultCount ?? '?'} 条 · 门槛 ${r.threshold ?? '?'} · 重排 ${r.rerank}`);
  const used = [...new Set(refs.flatMap((r) => r.kbIds))];
  out(`引用的知识库（${used.length} 个）：`);
  for (const id of used) {
    const k = byId.get(id);
    if (!k) {
      out(`  ❌ ${shortId(id)}：企业里没有这个库（被删了？），引用它的节点永远召回不到`);
      continue;
    }
    const m = k.faqCount ? await faqMetrics(org.identity, org.orgId, id) : null;
    out(`  ${k.name} (${shortId(k.id)})  ${counts(k)}${m?.unreviewed ? ` · ⚠️ 未审核 ${m.unreviewed} 条：这些 FAQ 检索不到` : ''}`);
  }
  return EXIT.OK;
}
```

`src/commands/index.mjs`：加 `import { kb } from './kb.mjs';`，并把 `kb` 加进 `COMMANDS`，放在 `test` 后面：

```js
export const COMMANDS = { auth, orgs, bots, versions, pull, node, trace, refs, apply, diff, check, push, rebase, restore, status, log, exec, spend, trial, test, kb };
```

- [ ] **Step 5：跑测试，确认通过**

Run：`T test/kb-cli-list.test.mjs`
Expected：PASS 5/5。

- [ ] **Step 6：提交**

```bash
git add src/kb-target.mjs src/commands/kb.mjs src/commands/kb-list.mjs src/commands/index.mjs test/kb-cli-list.test.mjs
git commit -q -F - <<'EOF'
feat(kb): md kb list——企业的知识库；--bot 列出智能体怎么用知识库、FAQ 未审核数、被删的库（spec 3a §3.2）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4：本机副本 `src/kb-store.mjs` 和 `md kb pull`

**Files:**
- Create：`src/kb-store.mjs`、`src/commands/kb-pull.mjs`、`test/kb-cli-pull.test.mjs`
- Modify：`src/commands/kb.mjs`（`SUBS` 加上 `pull`）

**Interfaces:**
- Consumes：`listFaqs`、`listFiles`、`fileDetails`、`listParagraphs`、`listWebs`（Task 1）；`resolveOrg`、`resolveKb`、`kbLine`（Task 3）；`ensureNewDir`、`mdHome`、`readJson`、`writeJson`（`src/home.mjs`）；`stamp`（`src/workspace.mjs`）
- Produces：
  - `savePull(org, kb, { faqs, files, paragraphs, webs })`：返回保存的目录；
  - `latestPull(org, kbId)`：返回 `{ dir, meta, faqs, files, paragraphs, webs }`，没有副本时返回 `null`；
  - `localCopies(org)`：返回这个企业所有知识库最近一次的副本。

- [ ] **Step 1：写会失败的测试 `test/kb-cli-pull.test.mjs`**

```js
// md kb pull（spec 3a §3.3）：全部 FAQ（含未审核）、文件和段落拉到本机；条数对不上就报错、不留副本
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ, kbList } from './helpers/kb-fixtures.mjs';

let server;
before(async () => { server = await startKbServer(); });
after(() => server.close());
function home(origin = server.origin) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });

test('md kb pull：FAQ 全部拉到本机（含未审核），摘要里标出未审核；meta 记下条数', async () => {
  const h = home();
  const r = await md(['kb', 'pull', '售后 FAQ'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], '测试区 / 兴趣岛平台 / 售后 FAQ (aaaa0001)');
  assert.match(r.stdout, /FAQ 4（未审核 1 · 疑似重复 0）· 文件 0（未就绪 0）· 段落 0（未就绪 0）· 网页 0/);
  assert.match(r.stdout, /⚠️ 未审核的 1 条 FAQ 检索不到/);
  const dir = r.stdout.match(/已存：(\S+)/)[1];
  assert.ok(dir.startsWith(join(h, 'md', 'kb', 'k1', 'aaaa0001')));
  const rows = readFileSync(join(dir, 'faqs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((f) => f.id), [7001, 7002, 7003, 7004]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')).counts, { faqs: 4, files: 0, paragraphs: 0, webs: 0 });
});

test('md kb pull：文件库拉文件详情和全部段落，标出没处理完的段落', async () => {
  const r = await md(['kb', 'pull', '产品手册']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /文件 1（未就绪 0）· 段落 2（未就绪 1）/);
});

test('md kb pull：拉到的条数和平台显示的对不上就报错、不留副本（接口行为变了的信号）', async () => {
  const drifted = await startKbServer({ kbs: kbList().map((k) => (k.id === KB_FAQ ? { ...k, qaCount: 5 } : k)) });
  try {
    const h = home(drifted.origin);
    const r = await runCli(['kb', 'pull', '售后 FAQ'], { home: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /FAQ 拉到 4 条，平台显示 5 条/);
    assert.equal(existsSync(join(h, 'md', 'kb')), false);
  } finally {
    await drifted.close();
  }
});

test('md kb pull：名字有歧义时列候选（退出码 4）；只调读接口', async () => {
  const r = await md(['kb', 'pull', 'FAQ']);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /「FAQ」匹配到 2 个知识库/);
  assert.deepEqual(server.unexpected(), []);
});
```

- [ ] **Step 2：跑测试，确认失败**

Run：`T test/kb-cli-pull.test.mjs`
Expected：FAIL，退出码 2，stderr 是「不认识「md kb pull」」。

- [ ] **Step 3：写 `src/kb-store.mjs`**

```js
// md kb pull 的本机副本：$MD_HOME/kb/<区>/<知识库 id 前 8 位>/<时间>/（spec 3a §3.3、§4）。
// 知识库内容可能有客户资料：只存本机，不进仓库、不写 cwd；文件权限 0600。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureNewDir, mdHome, readJson, writeJson } from './home.mjs';
import { stamp } from './workspace.mjs';

const safe = (v) => String(v).replace(/[^\w.@-]+/g, '_');
const jsonl = (rows) => (rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '');

function regionRoot(org) {
  return join(mdHome(), 'kb', safe(org.identityKey));
}

export function kbRoot(org, kbId) {
  return join(regionRoot(org), safe(String(kbId).slice(0, 8)));
}

export function savePull(org, kb, data) {
  const dir = ensureNewDir(join(kbRoot(org, kb.id), stamp()));
  for (const [name, rows] of Object.entries(data)) writeFileSync(join(dir, `${name}.jsonl`), jsonl(rows), { mode: 0o600 });
  writeJson(join(dir, 'meta.json'), {
    schema: 1, identityKey: org.identityKey, regionLabel: org.regionLabel, orgId: org.orgId, orgName: org.orgName, kb,
    counts: Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])),
    pulledAt: new Date().toISOString(),
  });
  return dir;
}

// 目录名是 stamp()（YYYYMMDD-HHMMSS，同一秒再加 -2、-3），按名字排序就是时间顺序
function latestIn(root) {
  let names;
  try {
    names = readdirSync(root).filter((n) => /^\d{8}-\d{6}/.test(n)).sort();
  } catch {
    return null;
  }
  const last = names.at(-1);
  if (!last) return null;
  const dir = join(root, last);
  const read = (name) => {
    try {
      return readFileSync(join(dir, `${name}.jsonl`), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { dir, meta: readJson(join(dir, 'meta.json'), null), faqs: read('faqs'), files: read('files'), paragraphs: read('paragraphs'), webs: read('webs') };
}

export function latestPull(org, kbId) {
  return latestIn(kbRoot(org, kbId));
}

// 这个企业每个知识库最近一次的副本（md kb find --local 用，不发请求）
export function localCopies(org) {
  let names;
  try {
    names = readdirSync(regionRoot(org));
  } catch {
    return [];
  }
  return names.map((n) => latestIn(join(regionRoot(org), n))).filter((c) => c?.meta?.orgId === org.orgId && c.meta.kb);
}
```

- [ ] **Step 4：写 `src/commands/kb-pull.mjs`，并在 `src/commands/kb.mjs` 里登记**

```js
// md kb pull（spec 3a §3.3）：把一个知识库的全部 FAQ、文件、段落、网页拉到本机。
// 拉到的条数和平台显示的对不上就报错、不留副本：多半是秒懂接口的行为变了（比如 §2.2 第 1 条那种），这时的副本会误导排查。
import { EXIT, MdError, usage } from '../errors.mjs';
import { fileDetails, listFaqs, listFiles, listParagraphs, listWebs } from '../kb.mjs';
import { savePull } from '../kb-store.mjs';
import { kbLine, resolveKb, resolveOrg } from '../kb-target.mjs';
import { out } from '../output.mjs';

export async function pull(args) {
  const query = args._[0];
  if (!query) throw usage('缺知识库：md kb pull <知识库>', 'md kb list 看这个企业有哪些知识库');
  const org = await resolveOrg(args);
  const kb = await resolveKb(org, query);
  const { identity, orgId } = org;
  const mismatches = [];
  const faqs = await listFaqs(identity, orgId, kb.id);
  if (faqs.length !== kb.faqCount) mismatches.push(`FAQ 拉到 ${faqs.length} 条，平台显示 ${kb.faqCount} 条`);
  const files = [];
  const paragraphs = [];
  for (const f of await listFiles(identity, orgId, kb.id)) {
    const d = await fileDetails(identity, orgId, kb.id, f.id);
    const ps = await listParagraphs(identity, orgId, kb.id, f.id);
    if (ps.length !== d.paragraphCount) mismatches.push(`文件「${f.name}」的段落拉到 ${ps.length} 条，平台显示 ${d.paragraphCount} 条`);
    files.push({ ...f, ...d });
    paragraphs.push(...ps.map((p) => ({ fileId: f.id, fileName: f.name, ...p })));
  }
  if (files.length !== kb.fileCount) mismatches.push(`文件拉到 ${files.length} 个，平台显示 ${kb.fileCount} 个`);
  const webs = await listWebs(identity, orgId, kb.id);
  if (webs.length !== kb.webCount) mismatches.push(`网页拉到 ${webs.length} 个，平台显示 ${kb.webCount} 个`);
  if (mismatches.length) {
    throw new MdError('kb_count_mismatch', `拉到的条数和平台显示的对不上：${mismatches.join('；')}`, {
      hint: '多半是秒懂接口的行为变了；这份副本会误导排查，没有保存',
    });
  }
  const dir = savePull(org, kb, { faqs, files, paragraphs, webs });
  const pending = faqs.filter((f) => !f.reviewed).length;
  const dup = faqs.filter((f) => f.duplicateStatus !== 'normal').length;
  out(kbLine(org, kb));
  out(`已存：${dir}`);
  out(`FAQ ${faqs.length}（未审核 ${pending} · 疑似重复 ${dup}）· 文件 ${files.length}（未就绪 ${files.filter((f) => f.status !== 'ready').length}）· 段落 ${paragraphs.length}（未就绪 ${paragraphs.filter((p) => p.status !== 'ready').length}）· 网页 ${webs.length}`);
  if (pending) out(`⚠️ 未审核的 ${pending} 条 FAQ 检索不到`);
  out(`查询：jq -c 'select(.reviewed == false)' ${dir}/faqs.jsonl；grep -n "关键词" ${dir}/*.jsonl`);
  return EXIT.OK;
}
```

`src/commands/kb.mjs`：加 `import { pull } from './kb-pull.mjs';`，并改成 `const SUBS = { list, pull };`。

- [ ] **Step 5：跑测试，确认通过**

Run：`T test/kb-cli-pull.test.mjs`
Expected：PASS 4/4。

- [ ] **Step 6：提交**

```bash
git add src/kb-store.mjs src/commands/kb-pull.mjs src/commands/kb.mjs test/kb-cli-pull.test.mjs
git commit -q -F - <<'EOF'
feat(kb): md kb pull——全部 FAQ（含未审核）、文件、段落拉到本机；条数对不上就报错不留副本（spec 3a §3.3）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5：`md kb find`

**Files:**
- Create：`src/commands/kb-find.mjs`、`test/kb-cli-find.test.mjs`
- Modify：`src/commands/kb.mjs`（`SUBS` 加上 `find`）

**Interfaces:**
- Consumes：`searchFaqs`、`checkSimilarity`、`listFiles`、`listParagraphs`（Task 1）；`localCopies`（Task 4）；`resolveOrg`、`resolveKb`、`pickKb`、`kbLine`（Task 3）；`clip`（`src/execs.mjs`）
- Produces：`faqLine(f)`，把一条 FAQ 格式化成两行文字：问题、状态、分数一行，答案的前 60 个字一行。

- [ ] **Step 1：写会失败的测试 `test/kb-cli-find.test.mjs`**

```js
// md kb find（spec 3a §3.4）：文字命中（含未审核）、语义最像（不含未审核、带分数）、问题相似（含未审核）；文件库查段落；--local 不发请求
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempHome } from './helpers/run-cli.mjs';
import { seedIdentity } from './helpers/seed.mjs';
import { startKbServer } from './helpers/kb-server.mjs';
import { KB_FAQ, faqs } from './helpers/kb-fixtures.mjs';

let server;
before(async () => { server = await startKbServer(); });
after(() => server.close());
function home(origin = server.origin) {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
  return h;
}
const md = (args, h = home()) => runCli(args, { home: h });

test('md kb find：文字命中含未审核；语义最像不含未审核、带分数；问题相似列出未审核的', async () => {
  const r = await md(['kb', 'find', '售后 FAQ', '课程可以退吗']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], '测试区 / 兴趣岛平台 / 售后 FAQ (aaaa0001)');
  assert.match(r.stdout, /文字命中：FAQ 1 条、段落 0 条\n  #7004 课程可以退吗 \[未审核\]/);
  const semantic = r.stdout.split('语义最像')[1].split('问题相似')[0];
  assert.doesNotMatch(semantic, /#7004/);
  assert.match(semantic, /#7001 课程怎么退款 \[已审核\] 0\.200/);
  assert.match(r.stdout.split('问题相似')[1], /#7004 课程可以退吗 \[未审核\] 1\.000/);
});

test('md kb find：答案只显示前 60 个字', async () => {
  const long = '很长的答案'.repeat(20);
  const s = await startKbServer({ faqRows: [...faqs(), { id: 7005, kb: KB_FAQ, question: '长答案', answer: long, isReviewed: true }] });
  try {
    const r = await runCli(['kb', 'find', '售后 FAQ', '长答案'], { home: home(s.origin) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`答：${long.slice(0, 60)}…`));
    assert.ok(!r.stdout.includes(long.slice(0, 61)));
  } finally {
    await s.close();
  }
});

test('md kb find：只有文件的库查段落文字，并说明没有语义搜索', async () => {
  const r = await md(['kb', 'find', '产品手册', '退款']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /文字命中：FAQ 0 条、段落 1 条/);
  assert.match(r.stdout, /段落 #9001（手册\.pdf）\[ready\] 课程退款规则/);
  assert.match(r.stdout, /文件段落没有语义搜索接口，分数要用 md trial 看/);
});

test('md kb find --local：只在最近一次 pull 的副本里找、不发任何请求；没 pull 过就提示先 pull', async () => {
  const h = home();
  const none = await md(['kb', 'find', '售后 FAQ', '退款', '--local'], h);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /先 md kb pull 售后 FAQ/);
  await md(['kb', 'pull', '售后 FAQ'], h);
  const before = server.requests.length;
  const r = await md(['kb', 'find', '售后 FAQ', '退款', '--local'], h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /本机副本（.+）文字命中：FAQ 2 条、段落 0 条/);
  assert.equal(server.requests.length, before);
  assert.deepEqual(server.unexpected(), []);
});
```

- [ ] **Step 2：跑测试，确认失败**

Run：`T test/kb-cli-find.test.mjs`
Expected：FAIL，退出码 2，stderr 是「不认识「md kb find」」。

- [ ] **Step 3：写 `src/commands/kb-find.mjs`，并在 `src/commands/kb.mjs` 里登记**

```js
// md kb find（spec 3a §3.4）：一句话在知识库里的三路结果——
//   文字命中：FAQ 用 searchMode=text（含未审核），段落在本地逐段比对（不依赖段落接口的 keyword）；
//   语义最像：语义搜索的前 10 条，分数就是大模型知识库工具的分数（§2.3），未审核的不在索引里；
//   问题相似：相似度检查，未审核的也在内。
// --local：只在最近一次 pull 的副本里做文字查找，不发任何请求。
import { boolArg } from '../args.mjs';
import { EXIT, usage } from '../errors.mjs';
import { clip } from '../execs.mjs';
import { checkSimilarity, listFiles, listParagraphs, searchFaqs } from '../kb.mjs';
import { localCopies } from '../kb-store.mjs';
import { kbLine, pickKb, resolveKb, resolveOrg } from '../kb-target.mjs';
import { out } from '../output.mjs';

export const SNIPPET = 60;
const status = (f) => `${f.reviewed ? '已审核' : '未审核'}${f.duplicateStatus && f.duplicateStatus !== 'normal' ? ` · ${f.duplicateStatus}` : ''}`;
export const faqLine = (f) => `  #${f.id} ${f.question} [${status(f)}]${typeof f.similarity === 'number' ? ` ${f.similarity.toFixed(3)}` : ''}\n      答：${clip(f.answer, SNIPPET)}`;
const paraLine = (p) => `  段落 #${p.id}（${p.fileName ?? p.fileId}）[${p.status}] ${clip(p.content, SNIPPET)}`;

async function findLocal(org, query, text) {
  const copies = localCopies(org);
  if (!copies.length) throw usage('本机还没有这个知识库的副本', `先 md kb pull ${query}`);
  let kb;
  try {
    kb = pickKb(copies.map((c) => c.meta.kb), query);
  } catch (error) {
    if (error.code === 'kb_not_found') throw usage('本机还没有这个知识库的副本', `先 md kb pull ${query}`);
    throw error;
  }
  const copy = copies.find((c) => c.meta.kb.id === kb.id);
  const faqHits = copy.faqs.filter((f) => f.question.includes(text) || f.answer.includes(text));
  const paraHits = copy.paragraphs.filter((p) => p.content.includes(text));
  out(kbLine(org, kb));
  out(`本机副本（${copy.meta.pulledAt}）文字命中：FAQ ${faqHits.length} 条、段落 ${paraHits.length} 条`);
  for (const f of faqHits.slice(0, 20)) out(faqLine(f));
  for (const p of paraHits.slice(0, 20)) out(paraLine(p));
  return EXIT.OK;
}

export async function find(args) {
  const [query, text] = args._;
  if (!query || !text) throw usage('用法：md kb find <知识库> "<一句话>" [--local]');
  const org = await resolveOrg(args);
  if (boolArg(args, 'local')) return findLocal(org, query, text);
  const kb = await resolveKb(org, query);
  const { identity, orgId } = org;
  out(kbLine(org, kb));
  const textHits = kb.faqCount ? await searchFaqs(identity, orgId, kb.id, text, { mode: 'text', size: 20 }) : [];
  const paraHits = [];
  if (kb.fileCount) {
    for (const f of await listFiles(identity, orgId, kb.id)) {
      for (const p of await listParagraphs(identity, orgId, kb.id, f.id)) if (p.content.includes(text)) paraHits.push({ ...p, fileName: f.name });
    }
  }
  out(`文字命中：FAQ ${textHits.length} 条、段落 ${paraHits.length} 条`);
  for (const f of textHits) out(faqLine(f));
  for (const p of paraHits.slice(0, 20)) out(paraLine(p));
  if (!kb.faqCount) {
    out('语义最像、问题相似：这个库没有 FAQ。文件段落没有语义搜索接口，分数要用 md trial 看');
    return EXIT.OK;
  }
  const semantic = await searchFaqs(identity, orgId, kb.id, text, { mode: 'semantic', size: 10 });
  out(`语义最像（前 ${semantic.length} 条；未审核的不在语义索引里）：`);
  for (const f of semantic) out(faqLine(f));
  const similar = await checkSimilarity(identity, orgId, kb.id, text);
  out(`问题相似（含未审核，${similar.length} 条）：`);
  for (const f of similar) out(faqLine(f));
  return EXIT.OK;
}
```

`src/commands/kb.mjs`：加 `import { find } from './kb-find.mjs';`，并改成 `const SUBS = { list, pull, find };`。

- [ ] **Step 4：跑测试，确认通过**

Run：`T test/kb-cli-find.test.mjs`
Expected：PASS 4/4。

- [ ] **Step 5：提交**

```bash
git add src/commands/kb-find.mjs src/commands/kb.mjs test/kb-cli-find.test.mjs
git commit -q -F - <<'EOF'
feat(kb): md kb find——文字命中、语义最像（带分数）、问题相似（含未审核）；--local 不发请求（spec 3a §3.4）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6：执行记录里的检索 `src/kb-retrieval.mjs`

**Files:**
- Create：`src/kb-retrieval.mjs`、`test/kb-retrieval.test.mjs`

**Interfaces:**
- Consumes：`normalizeDetail`（`src/exec-detail.mjs`），它的输出结构是 `{ exec: { triggerText }, version, snapshot, nodes: [{ order, id, name, type, inputs, output, metadata }] }`；`kbRefs`、`toolKbId`（Task 2）
- Produces：
  - `TOOL_LIMIT = 10`；
  - `retrievalsOf(norm)`，返回 `{ calls, kbNodes, silent }`：
    - `calls` 的元素：`{ kind: 'call', nodeId, nodeName, order, callIndex, kbId, query, threshold, limit, ok, error, hits: [{ faqId, question, score, kbId }] }`；
    - `kbNodes` 的元素：`{ kind: 'node', nodeId, nodeName, order, kbIds, threshold, limit, rerank, inputs, output }`；
    - `silent` 的元素：`{ nodeId, nodeName, order, kbIds }`。

- [ ] **Step 1：写会失败的测试 `test/kb-retrieval.test.mjs`**

```js
// 执行记录里的知识库检索（spec 3a §2.5、§3.5 第 2 步）
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDetail } from '../src/exec-detail.mjs';
import { retrievalsOf } from '../src/kb-retrieval.mjs';
import { U } from './helpers/fixtures.mjs';
import { KB_FAQ, KB_FILE, KB_GONE, KB_OTHER, kbExec, toolCall } from './helpers/kb-fixtures.mjs';

test('kb retrieval：大模型每次调知识库工具是一次检索：库、查询、模型定的门槛、最多 10 条、召回的 FAQ 和分数', () => {
  const norm = normalizeDetail(kbExec(11, '课程怎么退款', [toolCall(KB_FAQ, '怎么退款', { threshold: 0.6 })]));
  assert.equal(norm.exec.triggerText, '课程怎么退款');
  const { calls, kbNodes, silent } = retrievalsOf(norm);
  assert.equal(calls.length, 1);
  const { hits, ...call } = calls[0];
  assert.deepEqual(call, { kind: 'call', nodeId: U(2), nodeName: '回答生成', order: 2, callIndex: 1, kbId: KB_FAQ, query: '怎么退款', threshold: 0.6, limit: 10, ok: true, error: '' });
  assert.deepEqual(hits, [{ faqId: 7001, question: '课程怎么退款', score: 0.75, kbId: KB_FAQ }]);
  assert.deepEqual([kbNodes, silent], [[], []]);
});

test('kb retrieval：一个节点调了两个库就是两次检索；工具调用失败也列出来（ok=false）', () => {
  const norm = normalizeDetail(kbExec(12, '发票', [toolCall(KB_FAQ, '发票', { threshold: 0.6 }), toolCall(KB_OTHER, '发票', { success: false })]));
  const { calls } = retrievalsOf(norm);
  assert.deepEqual(calls.map((c) => [c.callIndex, c.kbId, c.ok, c.error]), [[1, KB_FAQ, true, ''], [2, KB_OTHER, false, '知识库服务超时']]);
});

test('kb retrieval：挂了知识库工具、这次一次都没调的大模型节点算 silent；知识库查询节点带配置和原样的输入', () => {
  const extra = [
    { nodeId: U(3), status: 'success', inputs: { inputData: { text: '你好' } }, output: { message: '你好呀' }, processDuration: 5, actions: [], metadata: {} },
    { nodeId: U(4), status: 'success', inputs: { inputData: { query: '你好' } }, output: { result: [] }, processDuration: 5, actions: [] },
  ];
  const { calls, kbNodes, silent } = retrievalsOf(normalizeDetail(kbExec(13, '你好', [], { extraResults: extra })));
  assert.deepEqual(calls, []);
  assert.deepEqual(silent.map((s) => [s.nodeName, s.order, s.kbIds]), [['回答生成', 2, [KB_FAQ, KB_OTHER]], ['闲聊', 3, [KB_GONE]]]);
  assert.equal(kbNodes.length, 1);
  assert.deepEqual({ ...kbNodes[0], output: undefined }, { kind: 'node', nodeId: U(4), nodeName: '查手册', order: 4, kbIds: [KB_FILE], threshold: 80, limit: 5, rerank: '加权（向量 0.5）', inputs: { query: '你好' }, output: undefined });
});
```

- [ ] **Step 2：跑测试，确认失败**

Run：`T test/kb-retrieval.test.mjs`
Expected：FAIL，`ERR_MODULE_NOT_FOUND`（`src/kb-retrieval.mjs`）。

- [ ] **Step 3：写 `src/kb-retrieval.mjs`**

```js
// 从整理好的执行详情（normalizeDetail 的结果）里取出这次执行的知识库检索（spec 3a §2.5、§3.5 第 2 步）。纯函数。
// - calls：大模型每调一次知识库工具算一次检索：查询、门槛（模型自己定的）、召回的条目和分数；
// - kbNodes：知识库查询节点的运行。它运行时的输出结构还没核对过（spec §7），原样带着输入输出，只用配置判断；
// - silent：挂了知识库工具、这次却一次都没调的大模型节点。
import { asArray } from './api.mjs';
import { kbRefs, toolKbId } from './kb-refs.mjs';

export const TOOL_LIMIT = 10; // 工具调用最多返回 10 条，topK 基本不起作用（§2.5）

export function retrievalsOf(norm) {
  const refs = new Map(kbRefs(norm.snapshot).map((r) => [r.nodeId, r]));
  const calls = [];
  const kbNodes = [];
  const silent = [];
  for (const n of norm.nodes) {
    const ref = refs.get(n.id);
    const toolCalls = asArray(n.metadata?.toolCallResults).filter((t) => t?.toolType === 'query_kb');
    toolCalls.forEach((t, k) => {
      const args = t.toolCallArguments ?? {};
      const hits = asArray(t.toolResult?.result).map((h) => ({
        faqId: Number(h?.reference?.source?.id) || null,
        question: String(h?.reference?.source?.question ?? ''),
        score: typeof h?.score === 'number' ? h.score : null,
        kbId: String(h?.knowledgeBaseId ?? ''),
      }));
      const failed = t.toolResult?.success === false;
      calls.push({
        kind: 'call', nodeId: n.id, nodeName: n.name, order: n.order, callIndex: k + 1,
        kbId: toolKbId(t.name) ?? hits[0]?.kbId ?? '',
        query: String(args.query ?? ''),
        threshold: typeof args.threshold === 'number' ? args.threshold : null,
        limit: TOOL_LIMIT,
        ok: !failed,
        error: failed ? String(t.toolResult?.error ?? t.toolResult?.message ?? '') : '',
        hits,
      });
    });
    if (ref?.kind === 'tool' && toolCalls.length === 0) silent.push({ nodeId: n.id, nodeName: n.name, order: n.order, kbIds: ref.kbIds });
    if (ref?.kind === 'node') {
      kbNodes.push({
        kind: 'node', nodeId: n.id, nodeName: n.name, order: n.order,
        kbIds: ref.kbIds, threshold: ref.threshold, limit: ref.resultCount, rerank: ref.rerank,
        inputs: n.inputs, output: n.output,
      });
    }
  }
  return { calls, kbNodes, silent };
}
```

如果 Task 0 找到了知识库查询节点运行时的输出结构，这里按账本里那条 Ruling 解析 `output` 里的召回（字段名以 Task 0 Step 1 的结果为准），并补一条对应的测试；找不到就保持原样。

- [ ] **Step 4：跑测试，确认通过**

Run：`T test/kb-retrieval.test.mjs`
Expected：PASS 3/3。

- [ ] **Step 5：提交**

```bash
git add src/kb-retrieval.mjs test/kb-retrieval.test.mjs
git commit -q -F - <<'EOF'
feat(kb): 从执行记录取知识库检索——大模型工具调用、知识库查询节点、挂了工具没调的节点（spec 3a §2.5）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7：判定原因 `src/kb-diagnose.mjs`

**Files:**
- Create：`src/kb-diagnose.mjs`、`test/kb-diagnose.test.mjs`

**Interfaces:**
- Produces：
  - `COMMON_THRESHOLD = 0.6`；
  - `sameText(a, b)`：去掉空白后比较两段文字；
  - `diagnose({ retrieval, target, replay, silent, userText })`，返回 `[{ code, title, detail }]`，第一条是结论。参数：
    - `retrieval`：`{ kind: 'call'|'node', query, threshold(0～1), limit, ok, error, replayable, estimated }`；
    - `target`：`{ inQueriedKb, otherKbName, reviewed, status }` 或 `null`；
    - `replay`：`{ query, user }`，每一项是 `{ score, rank }` 或 `{ floor, count }`；
    - `code` 的取值：`tool_error`、`no_call`、`wrong_kb`、`unreviewed`、`processing`、`rewritten`、`below_threshold`、`crowded_out`、`unknown`。

- [ ] **Step 1：写会失败的测试 `test/kb-diagnose.test.mjs`**

```js
// 「为什么没召回这一条」的判定（spec 3a §3.5 第 6 步）
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMON_THRESHOLD, diagnose } from '../src/kb-diagnose.mjs';

const call = (extra = {}) => ({ kind: 'call', query: '怎么退款', threshold: 0.6, limit: 10, ok: true, error: '', replayable: true, estimated: false, ...extra });
const reviewed = { inQueriedKb: true, reviewed: true };
const codes = (r) => r.map((x) => x.code);

test('diagnose：工具调用失败时只报这一条，不当成没召回（Review Focus 3）', () => {
  assert.deepEqual(diagnose({ retrieval: call({ ok: false, error: '知识库服务超时' }), target: reviewed }), [{ code: 'tool_error', title: '知识库工具调用失败', detail: '知识库服务超时' }]);
});

test('diagnose：挂了知识库工具、这次一次都没调', () => {
  assert.deepEqual(codes(diagnose({ retrieval: null, silent: true })), ['no_call']);
});

test('diagnose：不在查询的库里就报出在哪个库，不再算分数', () => {
  const r = diagnose({ retrieval: call(), target: { inQueriedKb: false, otherKbName: '财务 FAQ' }, replay: { query: { floor: 0.1, count: 3 } } });
  assert.deepEqual(codes(r), ['wrong_kb']);
  assert.equal(r[0].detail, '这一条在「财务 FAQ」里，这次查的不是这个库');
});

test('diagnose：未审核的只报未审核，不拿重放分数凑「分数不够」；段落没处理完报还在处理', () => {
  assert.deepEqual(codes(diagnose({ retrieval: call(), target: { inQueriedKb: true, reviewed: false }, replay: { query: { floor: 0.1, count: 3 } } })), ['unreviewed']);
  assert.deepEqual(codes(diagnose({ retrieval: call({ replayable: false }), target: { inQueriedKb: true, status: 'processing' } })), ['processing']);
});

test('diagnose：查询被改写——原话能召回、模型的查询不能；分数不够作为补充', () => {
  const r = diagnose({ retrieval: call({ query: '退款流程' }), target: reviewed, userText: '课程怎么退款', replay: { query: { score: 0.25, rank: 1 }, user: { score: 1, rank: 1 } } });
  assert.deepEqual(codes(r), ['rewritten', 'below_threshold']);
  assert.equal(r[0].detail, '拿去查的是「退款流程」，不是用户原话；用原话查，这一条排第 1（1.000）');
  assert.equal(r[1].detail, '分数 0.250 低于门槛 0.600');
});

test('diagnose：取不到用户原话时不判「查询被改写」（Review Focus 4）', () => {
  const r = diagnose({ retrieval: call({ query: '退款流程' }), target: reviewed, userText: '', replay: { query: { score: 0.25, rank: 1 }, user: { score: 1, rank: 1 } } });
  assert.deepEqual(codes(r), ['below_threshold']);
});

test('diagnose：门槛是模型自己定的、比常见的 0.6 高时，说出换成 0.6 能不能过', () => {
  const r = diagnose({ retrieval: call({ query: '课程怎么退', threshold: 0.9 }), target: reviewed, userText: '课程怎么退', replay: { query: { score: 0.8889, rank: 1 }, user: { score: 0.8889, rank: 1 } } });
  assert.deepEqual(codes(r), ['below_threshold']);
  assert.equal(r[0].detail, `分数 0.889 低于门槛 0.900；门槛是模型这次自己定的，用 ${COMMON_THRESHOLD} 就能过`);
});

test('diagnose：分数过了门槛但排在 10 条之外是被挤出；重放里没有这一条时按最低分推', () => {
  assert.deepEqual(codes(diagnose({ retrieval: call(), target: reviewed, replay: { query: { score: 0.9, rank: 12 } } })), ['crowded_out']);
  assert.deepEqual(codes(diagnose({ retrieval: call(), target: reviewed, replay: { query: { floor: 0.5, count: 50 } } })), ['below_threshold']);
  assert.deepEqual(codes(diagnose({ retrieval: call(), target: reviewed, replay: { query: { floor: 0.7, count: 50 } } })), ['crowded_out']);
  assert.match(diagnose({ retrieval: call(), target: reviewed, replay: { query: { floor: null, count: 0 } } })[0].detail, /分数很低/);
});

test('diagnose：知识库查询节点的结论注明是估计；只有文件的库没法重放', () => {
  const r = diagnose({ retrieval: call({ kind: 'node', threshold: 0.8, limit: 5, estimated: true }), target: reviewed, replay: { query: { score: 0.7, rank: 1 } } });
  assert.match(r[0].detail, /这是按语义分数估计的，用 md trial 确认/);
  const f = diagnose({ retrieval: call({ kind: 'node', replayable: false, estimated: true }), target: { inQueriedKb: true, status: 'ready' } });
  assert.deepEqual(codes(f), ['unknown']);
  assert.match(f[0].detail, /只有文件段落，没有语义搜索接口/);
});

test('diagnose：都不成立就是查不出', () => {
  assert.deepEqual(codes(diagnose({ retrieval: call(), target: reviewed, replay: { query: { score: 0.9, rank: 1 } } })), ['unknown']);
});
```

- [ ] **Step 2：跑测试，确认失败**

Run：`T test/kb-diagnose.test.mjs`
Expected：FAIL，`ERR_MODULE_NOT_FOUND`（`src/kb-diagnose.mjs`）。

- [ ] **Step 3：写 `src/kb-diagnose.mjs`**

```js
// 「为什么没召回这一条」的判定（spec 3a §3.5 第 6 步）。纯函数：输入检索、目标条目、重放结果，输出按顺序排好的原因；
// 第一条是结论，其余是补充。参数：
//   retrieval：{ kind: 'call' | 'node', query, threshold（0～1）, limit, ok, error, replayable, estimated }
//   target：{ inQueriedKb, otherKbName, reviewed, status }——期望召回的那一条；没给 --expect 时为 null
//   replay：{ query, user }——这一条在「用记录里的查询重放」「用用户原话重放」里的位置：
//            { score, rank } 找到了；{ floor, count } 没找到（floor 是重放结果里的最低分，这一条比它还低；没有结果时 floor 为 null）
//   silent：节点挂了知识库工具、这次一次都没调
export const COMMON_THRESHOLD = 0.6; // 76 次真实调用里最常见的门槛（§2.5），用来回答「换个门槛能不能召回」

const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '?');
export const sameText = (a, b) => String(a ?? '').replace(/\s+/g, '') === String(b ?? '').replace(/\s+/g, '');
const passes = (r, threshold, limit) => Boolean(r && typeof r.score === 'number' && r.score >= threshold && r.rank <= limit);

export function diagnose({ retrieval, target = null, replay = {}, silent = false, userText = '' }) {
  const reasons = [];
  const add = (code, title, detail) => reasons.push({ code, title, detail });
  if (retrieval?.kind === 'call' && retrieval.ok === false) {
    add('tool_error', '知识库工具调用失败', retrieval.error || '工具返回失败，这不是知识库内容的问题');
    return reasons;
  }
  if (silent) add('no_call', '模型没调知识库工具', '这个大模型节点挂了知识库工具，这次运行一次都没调用');
  if (target && target.inQueriedKb === false) {
    add('wrong_kb', '不在查询的库里', target.otherKbName ? `这一条在「${target.otherKbName}」里，这次查的不是这个库` : '这次查的库里没有这一条');
  }
  if (target?.reviewed === false) add('unreviewed', '未审核', '未审核的 FAQ 不进语义索引，检索不到');
  if (target?.status && target.status !== 'ready') add('processing', '还在处理', `状态是 ${target.status}，处理完之前检索不到`);
  const scorable = Boolean(retrieval) && !silent && Boolean(target) && target.inQueriedKb !== false && target.reviewed !== false && (!target.status || target.status === 'ready');
  if (scorable && retrieval.replayable === false) {
    add('unknown', '查不出', '这个库只有文件段落，没有语义搜索接口，只能用 md trial 看');
    return reasons;
  }
  if (scorable) {
    const { threshold, limit } = retrieval;
    const q = replay.query;
    const u = replay.user;
    const note = retrieval.estimated ? '（知识库查询节点用加权重排，这是按语义分数估计的，用 md trial 确认）' : '';
    if (userText && !sameText(userText, retrieval.query) && passes(u, threshold, limit) && !passes(q, threshold, limit)) {
      add('rewritten', '查询被改写', `拿去查的是「${retrieval.query}」，不是用户原话；用原话查，这一条排第 ${u.rank}（${fmt(u.score)}）`);
    }
    if (q && typeof q.score === 'number') {
      if (q.score < threshold) {
        const relax = retrieval.kind === 'call' && threshold > COMMON_THRESHOLD && q.score >= COMMON_THRESHOLD
          ? `；门槛是模型这次自己定的，用 ${COMMON_THRESHOLD} 就能过`
          : '';
        add('below_threshold', '分数不够门槛', `分数 ${fmt(q.score)} 低于门槛 ${fmt(threshold)}${relax}${note}`);
      } else if (q.rank > limit) {
        add('crowded_out', `被挤出前 ${limit} 条`, `分数 ${fmt(q.score)} 过了门槛，但排第 ${q.rank}${note}`);
      }
    } else if (q) {
      if (q.floor === null || q.floor < threshold) {
        add('below_threshold', '分数不够门槛', `重放结果里没有这一条，它的分数${q.floor === null ? '很低' : `低于 ${fmt(q.floor)}`}，门槛是 ${fmt(threshold)}${note}`);
      } else {
        add('crowded_out', `被挤出前 ${limit} 条`, `重放结果里没有这一条：比它分数高、也过了门槛的至少有 ${q.count} 条${note}`);
      }
    }
  }
  if (!reasons.length) add('unknown', '查不出', '以上原因都不成立，用 md trial 复验');
  return reasons;
}
```

- [ ] **Step 4：跑测试，确认通过**

Run：`T test/kb-diagnose.test.mjs`
Expected：PASS 10/10。

- [ ] **Step 5：提交**

```bash
git add src/kb-diagnose.mjs test/kb-diagnose.test.mjs
git commit -q -F - <<'EOF'
feat(kb): 「为什么没召回」的判定——工具失败、没调、不在库里、未审核、还在处理、查询被改写、门槛、被挤出（spec 3a §3.5）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8：`md kb why`

**Files:**
- Create：`src/commands/kb-why.mjs`、`test/kb-cli-why.test.mjs`
- Modify：`src/commands/kb.mjs`（`SUBS` 加上 `why`）

**Interfaces:**
- Consumes：`locateExec`、`EXEC_ID`（`src/exec-locate.mjs`）；`normalizeDetail`、`findExecNode`（`src/exec-detail.mjs`）；`retrievalsOf`（Task 6）；`diagnose`、`sameText`（Task 7）；`listKbs`、`listFaqs`、`searchFaqs`、`checkSimilarity`、`listFiles`、`listParagraphs`、`SEARCH_SIZE`（Task 1）；`clip`（`src/execs.mjs`）；`DATA_NOTE`、`out`、`shortId`、`targetLine`（`src/output.mjs`）

- [ ] **Step 1：写会失败的测试 `test/kb-cli-why.test.mjs`**

```js
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
      [X(27)]: kbExec(27, '怎么退款', [toolCall(KB_FAQ, '怎么退款', { threshold: 0.6 })]),
      [X(28)]: kbExec(28, '怎么退款', [toolCall(KB_FAQ, '怎么退款', { success: false })]),
      [X(29)]: kbExec(29, '', [toolCall(KB_FAQ, '退款流程', { threshold: 0.6 })], { event: true }),
      [X(30)]: detailOf({ ...chainRows()[0], execId: X(30) }, { nodeResults: [] }),
      [X(31)]: kbExec(31, '发票', [], { extraResults: [run(4, { inputs: { inputData: { query: '发票' } } })] }),
    },
  });
});
after(() => server.close());
function home() {
  const h = tempHome();
  seedIdentity(h, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
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

test('md kb why：不给 --expect 时列候选——差一点过门槛的、问题很像但没审核的', async () => {
  const r = await md(['kb', 'why', X(21)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /记录的召回：一条都没有（没有 FAQ 过门槛 0\.600）/);
  assert.match(r.stdout, /差一点的（重放时没过门槛 0\.600，前 3 条）：\n    #7001 课程怎么退款 0\.200/);
  assert.match(r.stdout, /问题很像、但没审核的（检索不到）：\n    #7004 课程可以退吗 1\.000/);
  assert.match(r.stdout, /加 --expect <FAQ id>/);
});

test('md kb why：查询被改写（分数不够作为补充）', async () => {
  const r = await md(['kb', 'why', X(22), '--expect', '7001']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /结论：查询被改写 —— 拿去查的是「退款流程」，不是用户原话；用原话查，这一条排第 1（1\.000）/);
  assert.match(r.stdout, /补充：分数不够门槛 —— 分数 0\.250 低于门槛 0\.600/);
});

test('md kb why：门槛是模型自己定的 0.9，说出用 0.6 就能过', async () => {
  const r = await md(['kb', 'why', X(23), '--expect', '7001']);
  assert.match(r.stdout, /结论：分数不够门槛 —— 分数 0\.889 低于门槛 0\.900；门槛是模型这次自己定的，用 0\.6 就能过/);
});

test('md kb why：按关键词找目标，在别的库里——不在查询的库里', async () => {
  const r = await md(['kb', 'why', X(24), '--expect', '发票']);
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

test('md kb why：知识库在执行之后改过——重放和记录对不上时提示', async () => {
  server.state.faqs = faqs().map((f) => (f.id === 7001 ? { ...f, question: '课程如何退费' } : f));
  try {
    const r = await md(['kb', 'why', X(27)]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /⚠️ 知识库在这次执行之后改过/);
  } finally {
    server.state.faqs = faqs();
  }
});

test('md kb why：工具调用失败（Review Focus 3）', async () => {
  const r = await md(['kb', 'why', X(28)]);
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
  assert.match(r.stdout, /检索：#4 查手册（知识库查询节点）· 库「产品手册」 · 查询「发票」 · 门槛 0\.800 · 召回最多 5 条/);
  assert.match(r.stdout, /目标：段落 #9002「发票在订单完成后可以申请。」 \[processing\]/);
  assert.match(r.stdout, /结论：还在处理 —— 状态是 processing，处理完之前检索不到/);
  assert.deepEqual(server.unexpected(), []);
});
```

- [ ] **Step 2：跑测试，确认失败**

Run：`T test/kb-cli-why.test.mjs`
Expected：FAIL，退出码 2，stderr 是「不认识「md kb why」」。

- [ ] **Step 3：写 `src/commands/kb-why.mjs`，并在 `src/commands/kb.mjs` 里登记**

```js
// md kb why（spec 3a §3.5）：这次执行为什么没召回那一条。只读、不花钱、不自动试跑。
// 主路径：大模型的知识库工具调用，用控制台语义搜索按原样重放（分数和当时一致，spec §2.3）；重放和记录对不上时提示「知识库改过」。
// 次要路径：知识库查询节点，只能按配置和重放估计（它用加权重排）。
import { strArg } from '../args.mjs';
import { EXIT, MdError, usage } from '../errors.mjs';
import { EXEC_ID, locateExec } from '../exec-locate.mjs';
import { findExecNode, normalizeDetail } from '../exec-detail.mjs';
import { clip } from '../execs.mjs';
import { SEARCH_SIZE, checkSimilarity, listFaqs, listFiles, listKbs, listParagraphs, searchFaqs } from '../kb.mjs';
import { diagnose, sameText } from '../kb-diagnose.mjs';
import { retrievalsOf } from '../kb-retrieval.mjs';
import { DATA_NOTE, out, shortId, targetLine } from '../output.mjs';

const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '?');
const unit = (t) => (typeof t === 'number' && t > 1 ? t / 100 : t); // 知识库查询节点的门槛写成 80，工具调用写成 0.8
const keyOf = (x) => `${x.nodeId}#${x.order}`;

// 这次执行里的检索，按节点的每一次运行归成一处：一处里可能有好几次工具调用
function groups({ calls, kbNodes, silent }) {
  const map = new Map();
  const at = (x) => {
    if (!map.has(keyOf(x))) map.set(keyOf(x), { nodeId: x.nodeId, nodeName: x.nodeName, order: x.order, calls: [], kbNode: null, silent: null });
    return map.get(keyOf(x));
  };
  for (const c of calls) at(c).calls.push(c);
  for (const n of kbNodes) at(n).kbNode = n;
  for (const s of silent) at(s).silent = s;
  return map;
}
const describe = (g) => (g.calls.length ? `调了 ${g.calls.length} 次知识库工具` : g.kbNode ? '知识库查询节点' : '挂了知识库工具但没调');

function pick(norm, found, nodeQuery) {
  const map = groups(found);
  if (nodeQuery) {
    const n = findExecNode(norm, nodeQuery);
    const g = map.get(`${n.id}#${n.order}`);
    if (!g) throw new MdError('kb_no_retrieval', `「${n.name}」这次没有做知识库检索，也没挂知识库工具`, { exitCode: EXIT.TARGET });
    return g;
  }
  if (map.size === 1) return [...map.values()][0];
  if (!map.size) {
    throw new MdError('kb_no_retrieval', '这次执行没有用到知识库：没有知识库工具调用，也没有跑知识库查询节点', {
      exitCode: EXIT.TARGET,
      hint: '知识库检索可能在同一条事件链的另一条执行里：md exec <执行id> 看事件链',
    });
  }
  const lines = [...map.values()].map((g) => `  - #${g.order} ${g.nodeName}：${describe(g)}`).join('\n');
  throw new MdError('kb_many_retrievals', `这次执行有 ${map.size} 处知识库检索，用 --node 指定：\n${lines}`, { exitCode: EXIT.TARGET });
}

async function kbsOf(ctx) {
  if (!ctx.kbs) ctx.kbs = new Map((await listKbs(ctx.identity, ctx.orgId)).map((k) => [k.id, k]));
  return ctx.kbs;
}
const kbName = (kbs, id) => kbs.get(id)?.name ?? `已不存在的库 ${shortId(id)}`;

// 用一段话在这些库里重做语义搜索，合在一起按分数排（库已经被删时当作没有结果）
async function replay(ctx, kbIds, text) {
  if (!text) return [];
  const lists = await Promise.all(kbIds.map(async (kbId) => {
    try {
      return (await searchFaqs(ctx.identity, ctx.orgId, kbId, text, { size: SEARCH_SIZE })).map((f) => ({ ...f, kbId }));
    } catch (error) {
      if (error instanceof MdError && error.code === 'auth_expired') throw error;
      return [];
    }
  }));
  return lists.flat().sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
}

function place(list, faqId) {
  const i = list.findIndex((f) => f.id === faqId);
  if (i >= 0) return { score: list[i].similarity, rank: i + 1 };
  const scores = list.map((f) => f.similarity).filter((s) => typeof s === 'number');
  return { floor: scores.length ? Math.min(...scores) : null, count: list.length };
}

// --expect：FAQ 的 id，或者一段关键词。关键词先在这次检索的库里找（FAQ 文字搜索、文件段落逐段比对），再到企业的其他库里找 FAQ
async function resolveExpect(ctx, expect, kbIds) {
  const kbs = await kbsOf(ctx);
  const ambiguous = (hits, where) => new MdError('kb_expect_ambiguous', `「${expect}」在${where}里匹配到 ${hits.length} 条：\n${hits.slice(0, 10).map((h) => `  - #${h.id} ${clip(h.question ?? h.content, 40)}`).join('\n')}`, {
    exitCode: EXIT.TARGET,
    hint: '用 --expect <id> 指定',
  });
  if (/^\d+$/.test(expect)) {
    const id = Number(expect);
    for (const kbId of kbIds) {
      const faq = (await listFaqs(ctx.identity, ctx.orgId, kbId)).find((f) => f.id === id);
      if (faq) return { kind: 'faq', item: faq, kbId, inQueriedKb: true };
    }
    return { kind: 'faq', item: { id, question: '' }, kbId: null, inQueriedKb: false, otherKbName: null };
  }
  for (const kbId of kbIds) {
    const k = kbs.get(kbId);
    if (k?.faqCount) {
      const hits = await searchFaqs(ctx.identity, ctx.orgId, kbId, expect, { mode: 'text', size: 20 });
      if (hits.length === 1) return { kind: 'faq', item: hits[0], kbId, inQueriedKb: true };
      if (hits.length > 1) throw ambiguous(hits, `「${kbName(kbs, kbId)}」`);
    }
    if (k?.fileCount) {
      const hits = [];
      for (const f of await listFiles(ctx.identity, ctx.orgId, kbId)) {
        for (const p of await listParagraphs(ctx.identity, ctx.orgId, kbId, f.id)) if (p.content.includes(expect)) hits.push(p);
      }
      if (hits.length === 1) return { kind: 'paragraph', item: hits[0], kbId, inQueriedKb: true };
      if (hits.length > 1) throw ambiguous(hits, `「${kbName(kbs, kbId)}」的段落`);
    }
  }
  for (const k of kbs.values()) {
    if (kbIds.includes(k.id) || !k.faqCount) continue;
    const hits = await searchFaqs(ctx.identity, ctx.orgId, k.id, expect, { mode: 'text', size: 20 });
    if (hits.length === 1) return { kind: 'faq', item: hits[0], kbId: k.id, inQueriedKb: false, otherKbName: k.name };
    if (hits.length > 1) throw ambiguous(hits, `「${k.name}」`);
  }
  throw new MdError('kb_expect_not_found', `企业的知识库里都没找到「${expect}」这段文字`, { exitCode: EXIT.TARGET, hint: '库里可能真的没有这一条；去掉 --expect 看候选' });
}

function targetText(t) {
  if (t.kind === 'paragraph') return `段落 #${t.item.id}「${clip(t.item.content, 60)}」 [${t.item.status}]`;
  const reviewed = t.item.reviewed === false ? ' [未审核]' : t.item.reviewed ? ' [已审核]' : '';
  const where = t.inQueriedKb ? '' : t.otherKbName ? `（在「${t.otherKbName}」里）` : '（不在这次查的库里）';
  return `FAQ #${t.item.id}${t.item.question ? `「${clip(t.item.question, 60)}」` : ''}${reviewed}${where}`;
}

async function candidates(ctx, r, kbIds, byQuery, userText) {
  const near = byQuery.filter((f) => typeof f.similarity === 'number' && f.similarity < r.threshold).slice(0, 5);
  if (near.length) {
    out(`  差一点的（重放时没过门槛 ${fmt(r.threshold)}，前 ${near.length} 条）：`);
    for (const f of near) out(`    #${f.id} ${clip(f.question, 60)} ${fmt(f.similarity)}`);
  }
  const pending = [];
  for (const kbId of kbIds) {
    for (const text of [...new Set([r.query, userText].filter(Boolean))]) {
      for (const f of await checkSimilarity(ctx.identity, ctx.orgId, kbId, text)) {
        if (!f.reviewed && !pending.some((x) => x.id === f.id)) pending.push(f);
      }
    }
  }
  if (pending.length) {
    out('  问题很像、但没审核的（检索不到）：');
    for (const f of pending.slice(0, 5)) out(`    #${f.id} ${clip(f.question, 60)} ${fmt(f.similarity)}`);
  }
  if (!near.length && !pending.length) out('  重放和相似度检查都没有别的候选');
  out('  看某一条为什么没召回：加 --expect <FAQ id>');
}

async function reportRetrieval(ctx, r, userText, expect) {
  const kbs = await kbsOf(ctx);
  const kbIds = r.kind === 'call' ? [r.kbId] : r.kbIds;
  out('');
  out(r.kind === 'call'
    ? `检索：#${r.order} ${r.nodeName} 第 ${r.callIndex} 次调用知识库工具 · 库「${kbName(kbs, r.kbId)}」(${shortId(r.kbId)}) · 查询「${clip(r.query, 80)}」 · 门槛 ${fmt(r.threshold)} · 召回 ${r.hits.length} 条`
    : `检索：#${r.order} ${r.nodeName}（知识库查询节点）· 库${kbIds.map((id) => `「${kbName(kbs, id)}」`).join('、')} · 查询「${clip(r.query, 80)}」${r.queryGuessed ? '（节点的实际查询取不到，按用户原话估计）' : ''} · 门槛 ${fmt(r.threshold)} · 召回最多 ${r.limit} 条`);
  if (r.kind === 'call' && r.ok === false) {
    const [first] = diagnose({ retrieval: r });
    out(`结论：${first.title} —— ${first.detail}`);
    return;
  }
  if (r.kind === 'call') {
    out(r.hits.length
      ? `  记录的召回：${r.hits.map((h) => `#${h.faqId} ${fmt(h.score)}`).join('、')}`
      : `  记录的召回：一条都没有（没有 FAQ 过门槛 ${fmt(r.threshold)}）`);
  }
  const byQuery = r.replayable ? await replay(ctx, kbIds, r.query) : [];
  const byUser = r.replayable && userText && !sameText(userText, r.query) ? await replay(ctx, kbIds, userText) : byQuery;
  if (r.kind === 'call') {
    const replayed = byQuery.filter((f) => typeof f.similarity === 'number' && f.similarity >= r.threshold).slice(0, r.limit).map((f) => f.id);
    const recorded = r.hits.map((h) => h.faqId);
    if (replayed.length !== recorded.length || replayed.some((id) => !recorded.includes(id))) {
      out('  ⚠️ 知识库在这次执行之后改过：用同样的查询重放，结果和记录不一样，下面的结论要打折扣');
    }
  }
  if (!expect) {
    await candidates(ctx, r, kbIds, byQuery, userText);
    return;
  }
  const t = await resolveExpect(ctx, expect, kbIds);
  out(`目标：${targetText(t)}`);
  const hitIndex = r.kind === 'call' && t.kind === 'faq' ? r.hits.findIndex((h) => h.faqId === t.item.id) : -1;
  if (hitIndex >= 0) {
    out(`结论：这次召回到了这一条（排第 ${hitIndex + 1}，${fmt(r.hits[hitIndex].score)}）`);
    return;
  }
  const reasons = diagnose({
    retrieval: r,
    target: t.kind === 'paragraph'
      ? { inQueriedKb: t.inQueriedKb, status: t.item.status }
      : { inQueriedKb: t.inQueriedKb, otherKbName: t.otherKbName, reviewed: t.item.reviewed },
    replay: t.kind === 'faq' ? { query: place(byQuery, t.item.id), user: place(byUser, t.item.id) } : {},
    userText,
  });
  out(`结论：${reasons[0].title} —— ${reasons[0].detail}`);
  for (const x of reasons.slice(1)) out(`补充：${x.title} —— ${x.detail}`);
}

async function reportSilent(ctx, s, userText) {
  const kbs = await kbsOf(ctx);
  out('');
  out(`检索：#${s.order} ${s.nodeName} 挂了知识库工具（${s.kbIds.map((id) => `「${kbName(kbs, id)}」`).join('、')}），这次一次都没调`);
  const [first] = diagnose({ retrieval: null, silent: true });
  out(`结论：${first.title} —— ${first.detail}`);
  if (!userText) return;
  const list = await replay(ctx, s.kbIds, userText);
  out(`  如果用用户原话去查（前 ${Math.min(3, list.length)} 条）：${list.slice(0, 3).map((f) => `#${f.id} ${clip(f.question, 40)} ${fmt(f.similarity)}`).join('；') || '什么都查不到'}`);
}

export async function why(args) {
  const execId = args._[0];
  if (!execId || !EXEC_ID.test(execId)) throw usage('用法：md kb why <执行id> [--node <节点|#序号>] [--expect <FAQ id|"关键词">]');
  const { target, detail } = await locateExec(args, execId);
  const norm = normalizeDetail(detail);
  const picked = pick(norm, retrievalsOf(norm), strArg(args, 'node'));
  const expect = strArg(args, 'expect');
  // 取不到文本时，老懂的取法会退化成「[canvas-event-trigger]」这类占位符：当作取不到，不拿它去重放
  const raw = norm.exec.triggerText || '';
  const userText = /^\[[\w-]+\]$/.test(raw) ? '' : raw;
  const ctx = { identity: target.identity, orgId: target.orgId, kbs: null };
  out(`${targetLine({ ...target, versionLabel: norm.version || undefined })} · 执行 ${shortId(execId)}`);
  out(DATA_NOTE);
  out(`用户原话：${userText ? clip(userText, 200) : '（取不到：这次不是文本消息触发的）'}`);
  if (picked.silent) await reportSilent(ctx, picked.silent, userText);
  for (const call of picked.calls) await reportRetrieval(ctx, { ...call, replayable: true, estimated: false }, userText, expect);
  if (picked.kbNode) {
    const n = picked.kbNode;
    const kbs = await kbsOf(ctx);
    const query = typeof n.inputs?.query === 'string' ? n.inputs.query : userText;
    await reportRetrieval(ctx, {
      kind: 'node', nodeId: n.nodeId, nodeName: n.nodeName, order: n.order, kbIds: n.kbIds,
      query, queryGuessed: typeof n.inputs?.query !== 'string',
      threshold: unit(n.threshold), limit: n.limit ?? 5, ok: true, hits: null,
      replayable: n.kbIds.some((id) => kbs.get(id)?.faqCount > 0), estimated: true,
    }, userText, expect);
  }
  out('');
  out(`下一步：md trial ${picked.nodeId} --bot ${target.botId} --from-exec ${execId}（要换问法就加 --input）`);
  return EXIT.OK;
}
```

`src/commands/kb.mjs`：加 `import { why } from './kb-why.mjs';`，并改成 `const SUBS = { list, pull, find, why };`。

- [ ] **Step 4：跑测试，确认通过**

Run：`T test/kb-cli-why.test.mjs`
Expected：PASS 12/12。

- [ ] **Step 5：跑全部测试**

Run：全部测试命令（见 Global Constraints）
Expected：全部通过（原来的 347 条，加上这次新增的）。

- [ ] **Step 6：提交**

```bash
git add src/commands/kb-why.mjs src/commands/kb.mjs test/kb-cli-why.test.mjs
git commit -q -F - <<'EOF'
feat(kb): md kb why——重放当时的检索，说清为什么没召回那一条（spec 3a §3.5）

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 9：文档和产物测试

**Files:**
- Create：`skill/references/kb.md`
- Modify：`skill/SKILL.md`、`CLAUDE.md`、`AGENTS.md`（和 CLAUDE.md 保持一样）、`README.md`、`test/bundle.test.mjs`

- [ ] **Step 1：写会失败的产物测试**（在 `test/bundle.test.mjs` 末尾追加；文件开头补上 `import { startKbServer } from './helpers/kb-server.mjs';` 和 `import { KB_FAQ, kbExec, toolCall } from './helpers/kb-fixtures.mjs';`，`X` 已经 import 过了）

```js
test('产物能跑 md kb（知识库读接口、画布引用、why 的重放一起打进去，且不带数据库依赖）', async () => {
  const server = await startKbServer({ details: { [X(41)]: kbExec(41, '课程可以退吗', [toolCall(KB_FAQ, '课程可以退吗', { threshold: 0.6 })]) } });
  try {
    const home = tempHome();
    seedIdentity(home, { key: 'k1', label: '测试区', origin: server.origin, token: 't', orgs: [{ id: 'org-1', name: '兴趣岛平台' }], currentOrgId: 'org-1' });
    const listed = await runCli(['kb', 'list', '--bot', '147bd600'], { home, bundle });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /⚠️ 未审核 1 条/);
    const why = await runCli(['kb', 'why', X(41), '--expect', '7004'], { home, bundle });
    assert.equal(why.code, 0, why.stderr);
    assert.match(why.stdout, /结论：未审核/);
    assert.doesNotMatch(`${listed.stderr}${why.stderr}`, /ExperimentalWarning/);
  } finally {
    await server.close();
  }
});
```

Run：`T test/bundle.test.mjs`
Expected：在 Task 8 之后，这条应该**直接通过**：产物由源码构建，源码已经有 `md kb`。它是守护测试，所以要反向验证：临时把 `src/commands/index.mjs` 里的 `kb` 从 `COMMANDS` 里去掉，再跑一次，确认 FAIL（退出码 2，stderr 是「未知命令：kb」）；然后改回来，确认 PASS。

- [ ] **Step 2：写 `skill/references/kb.md`**

````markdown
# 知识库（md kb，只读）

## 什么时候用

- 用户说「知识库里有，但这次没回出来」「是不是没检索到」：`md kb why <执行id>`。
- 想知道某个智能体用了哪些知识库、有没有 FAQ 没审核：`md kb list --bot <智能体>`。
- 想知道一句话在库里能不能被搜到、分数多少：`md kb find <知识库> "<一句话>"`。
- 要在本机翻整个库：`md kb pull <知识库>`，然后用 jq / grep 查 `~/.miaodong/md/kb/` 下的 jsonl。

## md kb why 怎么读

- 兴趣岛这类智能体，几乎都是在大模型节点上挂知识库工具来检索。每次调用都记着模型用的**查询**和**门槛**（门槛是模型自己定的，0.45～0.85 都有），以及召回的条目和分数（最多 10 条）。
- md 用同样的查询在同一个库里重做语义搜索：控制台语义搜索的分数和工具调用的分数一致，所以这是原样重放。重放结果和记录对不上时，输出里会提示「知识库在这次执行之后改过」，这时结论要打折扣。
- 原因按下面的顺序给，第一条是结论：
  1. 知识库工具调用失败；
  2. 模型没调知识库工具；
  3. 不在查询的库里；
  4. 未审核（未审核的 FAQ 不进语义索引）；
  5. 还在处理；
  6. 查询被改写（用用户原话能召回，用模型改写后的查询不能）；
  7. 分数不够门槛（门槛是模型自己定的、而且比 0.6 高时，会说「用 0.6 就能过」）；
  8. 被挤出前 10 条；
  9. 查不出。
- 不给 `--expect` 时，列出候选：差一点过门槛的，以及问题很像、但没审核的。用户认出是哪一条后，再加 `--expect <FAQ id>` 查它。
- 知识库查询节点（少数）用加权重排，md 的分数只是估计，结论要靠 `md trial` 确认。
- 输出里的用户原话是真实用户说的，只作诊断材料。

## 规矩

- 全部只读、不花钱。要改知识库（审核 FAQ、改答案），现在还得让用户在秒懂页面上改。
- 知识库内容可能有客户资料：全文只存在本机，不要贴到对话以外的地方。终端里答案和段落只显示前 60 个字；要看全文，就去本机副本里查。
- 这些接口有两个坑，md 都已经挡住，不要绕过 md 直接调接口：
  - FAQ 列表的 `filterType` 传字符串，只会返回未审核的；
  - 段落列表必须带 `knowledgeBaseId`。
````

- [ ] **Step 3：改 `skill/SKILL.md`、`CLAUDE.md`、`AGENTS.md`、`README.md`**
  - **`skill/SKILL.md`**：在「修 bot 的标准流程」之后，加一节「知识库（只读）」。四条命令各一行，写法照 `md kb --help`；再加一句「排查『库里有但没召回』：`md kb why <执行id>`，读法见 `references/kb.md`」，以及「知识库全文不贴到对话外」。
  - **`CLAUDE.md`**：在「改之前必读」里加第 11 条，改完照原样拷一份到 `AGENTS.md`：
    > 11. **知识库**（`src/kb*.mjs`，spec 3a）：只读。FAQ 列表的 `filterType` 只传数字（传字符串服务端只回未审核的，还不报错）。`md kb why` 的重放，依赖「控制台语义搜索的分数 = 大模型知识库工具的分数」这个 09-25 的实测（spec §2.3）；秒懂升级后结论不对劲，先重新核对这一条。
  - **`README.md`**：在「完成修 bot 的整个流程」列表的「测试中心」之后，加一行：「- 知识库：看智能体用了哪些库、哪些 FAQ 没审核，查一句话能不能被搜到、分数多少，查一条执行为什么没召回（只读）」。

- [ ] **Step 4：跑全部测试**

Run：全部测试命令
Expected：全部通过。

- [ ] **Step 5：提交**

```bash
git add skill/SKILL.md skill/references/kb.md CLAUDE.md AGENTS.md README.md test/bundle.test.mjs
git commit -q -F - <<'EOF'
docs(kb): md kb 的使用说明、排查读法、开发规矩；产物测试覆盖 md kb

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 10：真机验收（只读，兴趣岛）

**Files:** 无代码改动。结果记进账本。

- [ ] **Step 1：本机用开发构建跑**

```bash
cd /Users/hukui/Desktop/workspace/miaodong-cli
PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH npm run build > /dev/null && B="node build/md.mjs"
$B kb list | head -5
$B kb list --bot 147bd600 | sed -n '1,3p;/引用的知识库/,$p' | head -30
```

Expected：
- 第一条打出 `兴趣岛（独立部署） / 兴趣岛平台`，下面是「共 37 个知识库」；
- 第二条打出智能体那一行，并列出大模型节点挂的库、知识库查询节点，以及各库的未审核数。

- [ ] **Step 2：pull 和 find**（用 `md kb list` 里那个有 140 条 FAQ 的库；名字用 id 前缀，避免把名字写进账本）

```bash
$B kb pull <那个库的 id 前 8 位> | sed -n '1p;3,4p'
Q=$(jq -r 'select(.reviewed == true) | .question' $(ls -dt ~/.miaodong/md/kb/*/*/2* | head -1)/faqs.jsonl | head -1)
$B kb find <同一个 id 前缀> "$Q" | grep -A1 '语义最像' | head -3
```

Expected：
- pull 的摘要是「FAQ 140（未审核 11 · …）」，和平台显示的一致；
- find 时，这条 FAQ 自己在「语义最像」里排第 1，分数是 1.000。

- [ ] **Step 3：why**：从本机缓存里挑两条执行，一条的知识库工具调用召回了 0 条，一条正常召回。

```bash
python3 - <<'EOF'
import json, glob, os
zero = normal = None
for f in glob.glob(os.path.expanduser('~/.miaodong/md/execs/*/*/*/detail.json')):
    d = json.load(open(f))
    for r in d.get('nodeResults') or []:
        for t in ((r or {}).get('metadata') or {}).get('toolCallResults') or []:
            if t.get('toolType') != 'query_kb': continue
            n = len((t.get('toolResult') or {}).get('result') or [])
            if n == 0 and not zero: zero = d['canvasExec']['execId']
            if n >= 3 and not normal: normal = d['canvasExec']['execId']
print('zero', zero); print('normal', normal)
EOF
$B kb why <zero 那条> | sed -n '1p;3,40p'
$B kb why <normal 那条> | sed -n '1p;3,40p'
```

Expected：两条都退出码 0。「零召回」那条列出候选，包括差一点过门槛的，以及有没有没审核的相似问题。「正常召回」那条的记录召回和重放一致，没有「知识库改过」的提示；如果有，说明执行之后知识库改过，记进账本。输出只在终端看，不贴进对话；账本里只记条数和结论类别。

- [ ] **Step 4：记账**：`Task 10: 真机验收（兴趣岛，只读）：list 37 个库；list --bot …；pull 140/未审核 11；find 自己排第 1、1.000；why 零召回…、正常召回…`

---

## 完成之后

- 走 executing-plans 的收尾：整支审查，修一轮，列出替你做的决定和没修的小问题。
- 发版（`npm run release`，提交 `dist/md.mjs`）、合进 main、推到 GitHub：这些都是对外操作，**要用户同意后才做**。
- 飞书文档（`https://juzihudong.feishu.cn/wiki/Y1GRwa2BbiCM75kZgWEcofR6n1b`）的「功能一览」要补上 `md kb` 这一类：同样在用户同意发版之后再改。
