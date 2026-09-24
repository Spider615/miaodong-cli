# 秒懂 CLI（md）第 2 步设计：执行记录、单节点试跑、测试中心

> 2026-09-24。接第 1 步 spec（`2026-09-23-miaodong-cli-design.md`，下称「第 1 步」），沿用它的形态、身份、目标换算、工作副本、输出约定与退出码。
>
> 依据：老懂代码（`apps/api/lib/miaodong/*`，chat-agent 的试跑与回归代码）、`秒懂接口.md`、会话里下载的秒懂控制台前端 1.18.4 代码、本机 9 个秒懂会话的转录（含真实请求与响应）、用户的 `miaodong-test-case-import` skill。调研原始报告在会话 scratchpad，结论已全部收进本文。
>
> 证据标记：【实测】会话里真调过并看到了响应；【代码】老懂代码；【前端】秒懂前端代码，只说明页面怎么调，不等于服务端行为；【文档】只在接口文档里有；【推】推断。

## 1. 要解决的问题与验收

会话实测的现状：
- **查 badcase**：kit 的 `md:badcase` 只取一页，不能按事件、动作、版本筛。执行详情有 20MB，AI 只能自己写 jq 或 node 脚本逐节点翻（单个会话 27–61 次）。「回复在哪条执行里」这件事，两天里各重新发现了一次。
- **单节点试跑**：kit 没有封装，AI 每次手写 `trial-node.mjs`。原样回灌 badcase 的输入，会把平台参数钉成当时的旧值。
- **测试中心**：
  - 接口靠猜路径（单个会话里 404 最多 50 种），或下载前端 bundle 来找（最多 441 个 chunk），每次 37–51 分钟才跑起来。
  - 跨智能体导入会静默空跑：100 条 8.9 秒跑完、花费 ¥0，照样显示「完成」。
  - 平台导出没有执行 id 这一列，报告要 AI 另写脚本。
- **花费**：
  - AI 自己加跑的 245 条回归花了 ¥27.6，它是夹在「可以推吗」的请求里一起提的。
  - 还有一次 ¥28.92 的第二轮、两组各 50 条的自造用例，都被用户否定。

用户 09-24 决定：这三块，加上 `miaodong-test-case-import` 的全部能力，都做进 md。

**验收**（都能从转录或测试里量出来）：

| 指标 | 现状 | 目标 |
|---|---|---|
| 给一个执行 id，拿到按执行顺序排的节点链路，以及整条事件链的最终回复 | 自写脚本，来回多轮 | 1 条命令，0 段临时脚本 |
| 「这句话最早是哪个节点生成的」 | 自写 IN/OUT 矩阵 | 1 条命令 |
| 单节点复现：用原始输入跑 N 次、看花费 | 手写脚本 | 1 条命令；动作类节点一律拒跑 |
| 跨智能体回归：选执行 → 导入 → 跑 → 出报告 | 37–51 分钟，靠猜接口 | ≤ 5 条命令，0 次猜接口 |
| 静默空跑（事件、会话变量没对上） | 发生过 | 跑前拦下 |
| 没经用户同意的花费 | ¥27.6（一次） | ¥0：超门槛必须先拿确认码、单独问用户（约定，见 §7） |
| 结果文件里的调优中心执行 id | 靠正则从用例名里解析 | 每行都有 |
| 外部用例导入后的缺失、丢字段 | 靠事后审计脚本 | 导入命令自带回读审计 |

**不做**，以及原因：
- **整条流程试运行 `/canvas/exec`**：
  - 没有「跑到底但不真发」的开关【前端】。
  - 用假联系人会大面积走兜底：2137c4c1 的 100 条里有 61 条是假象【实测】。
  - 它也不会自动沿事件跟链。
  - 「跑到最终回复」由测试中心覆盖。
- **标记 badcase 已处理（`update-process-status`）**：9 个会话里从没用过；它是覆盖写、不能撤销，处理说明还会展示给反馈的用户。
- **LLM 调试台（`/test-center/llm-debug/*`）**：从没实测过；它的「应用」会覆盖整张草稿。
- **发布、启用、灰度、test-mode**：同第 1 步，不做。
- **执行记录按时间均匀采样、本地跑代码节点**：留到第 3 步。

## 2. 事实基础

### 2.1 执行记录

**执行 id**
- 只有一种：`execId`。它就是调优中心的执行 id，也是 `test-case/import` 里 `canvasExecIds` 填的那个。
- 测试执行和试跑执行也是这类 id，但**它们不出现在列表里**，按 id 查详情可以取到【实测】。
- `canvasEvent.executionId` 不是执行 id，拿它查详情会报 NOT_FOUND【代码】。

**列表** `POST /api/canvas/history/list?orgId`
- body 是 `{botId, startTimestamp, endTimestamp, current, pageSize, feedbackStatus?, keyword?, sessionId?, …}`。起止时间是毫秒，必传；pageSize 用 100 可以。按时间从新到旧排【实测】。
- 每条约 25KB，其中 81% 是 `sessionMemorySnapshot`【实测】。
- **服务端筛选**：时间、`sessionId`、`feedbackStatus`、`keyword` 早有实测；`triggerType / actionType / canvasId（版本）/ isCanary / allNodesSuccess / execId` 在 09-24 核对中全部生效【实测 09-24】。按事件名、按节点筛不了。
- **`keyword` 按词匹配用户消息和回复文本**：整句、开头两个字都能命中；从中间截的半个词可能搜不到；事件载荷和事件名搜不到【实测 09-24】。
- 列表项共 27 个键，包括 `execId, sessionId, createdAt, status, processDuration, canvasVersion, canvasName, isCanary, triggerContent{triggerType, content}, rawTrigger, outputActions[{type,payload}], tokenCount, totalCostInCny, feedbackStatus`。**事件名只在 `triggerContent.content.eventName` 里有**【实测】。列表项里没有 `botId`、`allNodesSuccess` 和节点数据。
- 速度：高流量 bot（147bd600）一天约 90 万条执行。7 天窗口光首页就要 17–22 秒；按会话、按关键词查只要 1–3 秒【实测】。

**详情** `GET /api/canvas/history/details?execId&botId&orgId`（前端只传 execId）
- 返回 `data = {canvasExec, canvas, nodeResults}`，约 20MB，因为画布有两份（`canvas.rawCanvas` 和 `canvasExec.rawCanvas`）。取一次约 2 秒【实测】。
- `canvas` 带 `version` 和 `rootCanvasId`。
- `nodeResults[]` 每项是 `{nodeId, status, actions, inputs:{inputData}, output, errorMessage, processDuration, outputBranchId?, metadata?}`。**没有节点名、没有时间戳，数组顺序也不是执行顺序**【实测】。
- LLM 节点的 `metadata = {prompt:[{role,content}], reasoningMessage, tokenUsage{…, costInCny}, requestIds, toolCallResults}`【实测】。

**事件链**
- 上游的 `outputActions[].payload{eventId, params}` 与下游的 `rawTrigger.canvasEvent{eventId, data}` 深度相等（复算 189/189），同一条链的 sessionId 相同【实测】。
- 同一会话里 eventId 相同的候选很常见（32/221），必须比对载荷才能配对【实测】。
- 延迟从 0.5 秒到约 1 小时不等：「延时回复」中位 41 秒，「发送」中位 63 秒【实测】。
- 秒懂自带的两个链路接口都不用：`list-by-session` 从来没调通过，`merged-chain` 是消息合并链、不是事件链【实测】。
- 太极类 bot 的一条用户消息要跨 3 条执行：消息 →「延时回复」→「发送」。最终文本在「发送」那条里，转人工也常在另一条事件执行里【实测】。

### 2.2 单节点试跑

**接口**
- 启动：`POST /api/canvas/node/exec?orgId`，body 是 `{canvasId, nodeId, inputs:{inputData}}`，返回 `data.execId`（旧契约是 `data.nodeExecId`）【前端】【实测】。
- 轮询：`GET /api/canvas/node/exec?nodeExecId&orgId`。结果在 1.18.4 上直接在 `data` 里，文档说通常在 `data.nodeExec`，两种都要认。页面每 2 秒查一次，终态是 `success / cancelled / error / interrupted`【前端】【实测】。
- **没有取消接口，也没有能列出节点执行的接口**：POST 的结果不明时，无从核对它到底跑没跑【前端】。

**跑哪张画布**
- 跑的是草稿（主画布 canvasId），推送后立即生效【实测】。
- 传版本的 canvasId 行不行，没验证过。

**输入**
- 输入键就是 `nodePayload.inputs[].name`。每一项的来源三选一：`referenceNodeId`、`sessionMemoryItemId`、`operationAttrId`。
- 平台不校验缺键，缺了照样返回 success【实测】。
- 来源是 `operationAttrId` 的平台参数（例如「质检规则」），不传时平台会自动填最新值；而 badcase 的 `inputs.inputData` 里带的是执行当时的值【实测】。

**花费**
- 结果里就有实际花费：`metadata.tokenUsage.costInCny`【实测】。
- 豆包约 ¥0.01/次；gemini-3.5-flash 每次 ¥0.23–0.67，不挂工具也要 ¥0.3 左右【实测】。
- 积分不足时，报错里带 `errorCode: AI_INTEGRAL_POINTS_EXHAUSTED` 和 `userMessage`【前端】。

**副作用**
- 秒懂页面只给计算类节点「测试该节点」的按钮，动作类、触发器、循环类都不给【前端；按钮和节点类型的对应关系是推断】。
- 插件计算节点单独试跑时，会真的调外部系统【实测】。
- LLM 节点可以挂 `plugin` 类工具【前端】。

### 2.3 测试中心

**有哪些接口**
- 兴趣岛（1.18.4）上 `test-set / test-case / test-task / test-task-item / scenario` 这几组接口都在【实测】。I 区没有任何实测。
- 场景树是在同一组路径上叠加的新功能，`scenario/tree` 返回 404 就是老一代【代码】。

**起跑**
- 用 `POST test-task/create`，body 是 `{testSetId, canvasId, name, testRound[, concurrency, botId]}`，返回 `data.testTaskId`【实测，共 12 次】。
  - 必填四项由空 body 的 400 校验列出：`testSetId`、`canvasId`、`name` 是字符串，`testRound` 是数字【实测 09-25】。
  - 任务记录里轮数显示成 `repeatTimes`，不是 `testRound`【实测 09-25】。
- `canvasId` 决定跑草稿还是某个版本。任务会选中测试集里的全部用例【实测】。
- `regression-test` 不用：服务端要求回归集至少 50 条，而且会忽略 testSetId【实测】。

**任务状态**
- 同一个 bot 上的任务会排队，后建的处于 `pending`【实测】。
- 只有暂停（`test-task/pause`，body `{testTaskId}`），没有取消【实测；body 09-25 由 400 校验确认】。
- `test-task/list` 和 `test-task/detail` 的字段【实测 09-25】：`testTaskId, testSetId, testSetName, selectedTestCaseIds, name, canvasId, canvasName, canvasVersion, repeatTimes, concurrency, status, totalTestCaseCount, processedTestCaseCount, passedTestCaseCount, failedTestCaseCount, passRate, totalCostInCny, averageCostInCny, taskDuration, startedAt, origin, createdAt`。
  - `totalTestCaseCount` 是用例数，`processedTestCaseCount` 是用例数 × 轮数。
  - 任务可以只选部分用例（`selectedTestCaseIds`）；不指定时选中集里全部用例。
- 删掉测试集之后，任务记录还在，`detail` 照样能查到【实测 09-25】。
- 判断完成只看 `status === 'finished'`；多轮时 processed 会大于 total【实测】。

**花费**
- 任务的 `totalCostInCny / averageCostInCny / tokenCount` 只在 `finished` 后才有值，暂停后仍是 null【实测】。
- `averageCostInCny` = 总花费 ÷ 跑过的条数（含空跑的条目）【实测 09-25：2 条里 1 条空跑，平均是总花费的一半】。
- 逐条的 `test-task-item.costInCny` 在这一条跑完后才有值，跑的过程中一直是 null；空跑的条目始终是 null【实测 09-25】。
  所以进度里的「已花」只能把跑完的条目加起来。
- 没有预估接口。单条从 ¥0（链路没触发）到 ¥0.29 不等【实测】。

**逐条结果** `GET test-task-item/list?testTaskId&current&pageSize=50`
- 关键字段：`testCaseName, passed, executedActions[{type,nodeId,nodeName,summary}], canvasActionOutputAssertionResult[{type,passed,message,llmReason,actualOutput,…}], canvasExecId, costInCny, processDuration, triggerExists`【实测】。
- 09-25 实测的完整字段：`testTaskItemId, testTaskId, testCaseId, testCaseName, dimension, scenarioNodeId, scenarioPath, status, triggerEvent, passed, processDuration, canvasExecId, canvasExecAvailable, testNodeOutputAssertionResult, canvasActionOutputAssertionResult, executedActions, tokenCount, costInCny, errorMessage, triggerContent, triggerExists`。
  - 条目 `status`：`pending → processing → success`。
  - 断言结果的字段：`type, passed, assertionDetailedInfo, expectedValue, actualValue, nodeId, nodeName`；非 LLM 断言另有 `message`；事件断言另有 `similarity, threshold, actualOutput{type, payload{eventId, eventName, params}}`。样本里没见到 `llmReason`。
- 发送在同一条链里时，回复就是 `send-text-message` 的 `summary`。
- 发送在下游事件链里时，测试项里没有发送，要用 `canvasExecId` 去详情里取【实测】。`canvas-event-action` 的 summary 只有「触发 <事件名> 事件」，不带参数；测试执行的详情里 `outputActions` 带着事件参数【实测 09-24】。
- 逐条结果 pageSize 200 可用，响应带 `page.total`；`test-task/list` 按 `testSetId` 筛选生效【实测 09-24】。

**从执行记录导入** `POST test-case/import`
- body 是 `{testSetId, canvasExecIds[], includeSessionMemory}`，每批 20 条跑通过【实测】。
- 三个字段都会校验：`testSetId` 和每个 `canvasExecIds` 必须是 UUID，至少 1 条；`includeSessionMemory` 必须是布尔值【实测 09-25】。
- 计数在 data 外面：`{imported, failed, skippedNodeTypes}`【实测】。
- 别的智能体的执行也能导进来（`imported: 1`），导入时不做任何检查【实测 09-25】。
- 导入的用例：
  - 事件触发类的 `triggerInputs` 是 `{eventId, executionId, data}`；
  - 带着当时的全部会话变量（样本 56 个）；
  - 断言按源执行的每个动作自动生成：写字段、打标签、发文本、发事件各一条【实测 09-25】。
- 导入后：
  - 用例名固定为 `调优中心导入(<execId>)`；
  - `isReviewed` 是 false；
  - 断言按源执行的输出自动生成，相似度阈值 0.75【实测】。

**跨智能体导入**
- 导入的用例带着源 bot 的 eventId、会话变量 UUID，以及断言里的 fieldId、eventId；不改就会静默空跑【实测】。
- 空跑时秒懂没有任何专门标记【实测 09-25】：`triggerExists` 仍是 true，条目 `status` 是 `success`、`passed` 是 false。
  能认出来的只有 `canvasExecAvailable=false`、`costInCny=null`、`processDuration=null`。
  所以 md 要在跑之前按名字核对事件（§6.5），结果里按 `canvasExecAvailable=false` 标「没有真正执行」。
- 两个 bot 的事件、会话变量可以按名字一一对上：事件 52/52、会话变量 131/131 同名【实测】。

**其它接口的真实形状**【实测 09-25，兴趣岛 147bd600 / 179cd443，只读】
- `test-set/list` 每行：`testSetId, name, testCaseCount, testNodes, createdAt, updatedAt`。列表里没有区分「回归测试集」的字段（建集响应里有 `type`），所以标不出来。
- `test-set/create {botId, name}` 返回 `data.testSetId`。
- `scenario/tree` 返回 `data: {tree[], unclassifiedCount, classifiedCount, uncoveredNodeCount, excludedNodeCount}`；这两个 bot 的树都是空的。
- `session-memory/list` 每个变量：`id, name, isDefault, type, description`；「消息历史」是默认变量。

**外部用例**（来自 test-case-import skill，1.18.4 实测 674 条和 1075 条）
- 写入：
  - `test-case/create {testSetId, testCases[]}` 每批 50 条，不返回 id，只能按 name 回读，所以 name 必须唯一。
  - `create/update` 会丢掉 `scenarioNodeId` 和 `dimensionDetail`；有的部署连 `dimension` 也丢。
  - `update` 是全量覆盖。
  - 挂场景用 `scenario/attach-cases`，每批 100 个，幂等。
  - 删测试集要先删用例。
- 建模：
  - 多轮历史写在 `sessionMemoryCustomData[<「消息历史」变量的 UUID>]` 里，这个 UUID 每个 bot 不同。
  - 历史里的图片直接写裸 URL。用户另发的文字进历史，不进 `triggerInputs.text`。
- 断言：
  - `verifyPayload` 和 `actionContent` 两份都要给。
  - 断言的 `type` 服务端不校验；写错时 `actionContent` 会被丢掉，这条断言永远不生效【实测】。
- 触发类型：服务端枚举共 20 个【实测】。

**「沙箱」的准确含义**
- 测试执行带 `testRun=true`，不进调优中心列表。
- 发送、打标签、转人工是「执行并记为动作」。用户经验是不会真的送到客户手里，但接口本身证明不了。
- **插件和外部 HTTP 调用是真实发生的**，只有用例的 `pluginMockOutputs / sqlDbMockOutputs` 能挡住【实测】。

### 2.4 对第 1 步 spec 和 SKILL 的更正
- 「测试中心跑的是草稿」：改为跑哪一版由任务的 canvasId 决定。
- 「测试中心沙箱不真发」：改为按 §2.3 的准确含义来写。
- 「Gemini 节点带知识库才要 0.3–0.7 元」：改为贵在模型本身。

## 3. 公共部分

- **报错**：`http.mjs` 除了 `message`，还要读 `userMessage / errorMessage / errorCode`。遇到 `AI_INTEGRAL_POINTS_EXHAUSTED` 就报「秒懂积分不足」。
- **分页**：统一一个 helper。`current` 从 1 开始，拿到 `page.total` 条或遇到短页就停。每条命令都设总条数上限，超了就明说「只取了前 N 条」。
- **时间参数**：`--since 30m|6h|24h|7d`，或者 `--from / --to`。时间按本地时区理解，写 `YYYY-MM-DD HH:mm` 或 ISO 都行。
- **本地存储**：都放在 `$MD_HOME`，目录权限 0700，不写仓库也不写 cwd。
  - `execs/<区>/<bot8>/`：搜索结果、执行详情；
  - `trials/<区>/<bot8>/`：试跑结果；
  - `tests/<区>/<bot8>/`：用例备份、导入来源、结果缓存；
  - `spend.jsonl`：花费账本；
  - `config.json`：花费门槛。
- **输出**：沿用第 1 步。第一行是 `区 / 企业 / 智能体 (id8) / 版本`；大数据落盘，stdout 只出摘要，并给出文件路径。
- **目标**：`exec / trial / test` 都用 `--bot` 指定智能体，trial 也可以用 `--ws`。写测试中心和花钱的命令不用任何默认智能体。
- **退出码**：沿用第 1 步。5（被拦）新增三种情况：要用户确认（输出里有确认码）、跑前检查不通过、改动计划码不符。

## 4. md exec：查执行记录

### 4.1 搜

```
md exec --bot <智能体> [--since 24h | --from … --to …] [--keyword 词] [--session <id>]
        [--down|--up] [--event <事件名>] [--trigger <类型>] [--action <动作>]
        [--version vX] [--canary|--no-canary] [--failed] [--limit 20] [--scan 5] [--save <文件>]
```

- **默认条件**：最近 24 小时，不筛赞踩。
- **服务端筛和本地筛**：`--keyword / --session / --down|--up / --trigger / --action / --version / --canary|--no-canary / --failed` 全部放进请求（09-24 核对都生效）；`--version` 先经 list-version 换成版本 canvasId，`--failed` 即 `allNodesSuccess=false`。只有 `--event` 要本地筛：请求里先带 `triggerType=canvas-event-trigger` 缩小范围，再按 `triggerContent.content.eventName` 本地比对。
  - `--trigger`、`--action` 接受简写，例如 text、image、event、send、handover。
  - `--keyword` 按词匹配（见 §2.1）；搜不到时提示换成完整的词或更短的词，事件用 `--event`。
- **扫描量**：只有 `--event` 需要翻页扫：每页 100 条，最多扫 `--scan` 页（默认 5 页，即 500 条），命中数够 `--limit` 就停。
  - 输出里说明「窗口内共 N 条，扫了 M 条，命中 K 条」。
  - 没扫完时，给出接着扫的写法。
- **每行显示**：
  - 时间、完整 execId；
  - 触发：事件名或触发类型，外加 40 字以内的触发文本；
  - 本条动作摘要，60 字以内：发文本、组合消息、转人工、发出的事件及其中的文本、写了几个字段；
  - 版本（灰度要标出）、花费、赞踩。
- **保存**：
  - 命中的行存成 JSONL，去掉 `sessionMemorySnapshot`。
  - 第一行是 `{"kind":"md-exec-search", 区, botId, 智能体名, 条件}`，自带源智能体。
  - 输出里打印文件路径；`--save` 可以指定路径。
  - 这个文件可以直接交给 `md test import --from-execs`。

### 4.2 看一条：`md exec <执行id> [--bot <智能体>]`

- **取数和缓存**：取详情后缓存到 `execs/<区>/<bot8>/<execId>/`，去掉重复的那份 `canvasExec.rawCanvas`。状态已经结束的执行，再看时直接用缓存。
- **省略 `--bot`**：在已取身份的各企业里按 id 找（09-24 核对：查详情不带 botId 也能取到）。
- **节点加工**：
  - 名字、类型、分类取自执行当时的画布快照；
  - 顺序按快照里的连线，对执行过的节点做拓扑排序；
  - 分支名取自规则节点的分支表；
  - 每个 LLM 节点标出模型和花费。
- **事件链**：
  - 查一次「同一个 sessionId、执行时间前后 65 分钟」的列表（`--chain-window` 可以放宽，最多翻 5 页），按 eventId 加载荷深度相等来配对上游和下游，最多 8 跳。
  - 载荷相同的候选有多个时，取时间最近的一个，并在输出里标注。
  - 测试执行和试跑执行不在列表里，直接说明「没有链」。
- **回复提取**覆盖四类：
  - `send-text-message` 的 `payload.text`；
  - `send-combination-message` 的 `payload.messages[].content`；
  - `handover` 的 `handoverMessage`；
  - 发出的事件 `params` 里的文本。
- **输出**：
  1. 目标行。
  2. 执行摘要：时间、触发、事件名、版本、状态、节点数、耗时、花费。
  3. 触发文本。
  4. 本条动作。
  5. **事件链**：`← 上游 … ● 本条 … → 下游 …`，以及「整条链最终：发文本 … / 转人工 …」。
  6. **节点按执行顺序**，一行一个：✅ 或 ❌、名字、类型、分支、模型、花费、耗时、报错原因。超过 150 个就截断并说明。
  7. 文件路径和下一步命令的提示。

### 4.3 `--node <节点>`

看这个节点在这次执行里的：
- 输入：逐键列出，长值截断，并给出完整内容的文件；
- 实际发给模型的 prompt：system 和 user 各有多长、开头若干字，全文存在 `prompts/` 下；
- 推理过程和输出；
- 工具调用：知识库查了什么、召回了几条；
- token 与花费，以及它发出的动作。

节点可以用 id、id 前缀或名字找。同名的有多个时，列出这次执行过的候选。

### 4.4 `--find "<文字>"`

按执行顺序，逐个节点标出这段文字出现在哪里：节点配置（快照里写死的）、输入、prompt、输出。最后给出结论，三选一：
- 写死在 X 的配置里；
- 最早由 X 生成（输入里没有、输出里有）；
- 来自上游 X 的输出。

### 4.5 `--vs-draft`

拉取当前草稿，逐个比较这次执行过的节点：
- 快照和草稿不同的，列出节点名和改了哪些字段，坐标等纯渲染字段不算；
- 草稿里已经删掉的，单独列出。

用来回答「这个问题是不是已经修过了」。

## 5. md trial：单节点试跑

```
md trial <节点> (--bot <智能体> | --ws <工作副本>) [--from-exec <执行id>]
         [--input 键=值 …] [--inputs <文件.json>] [--times 1] [--keep-platform-params] [--allow-plugin]
```

- **跑的是秒懂上的草稿**：先取草稿，再按 id、前缀或名字找节点；有歧义就列候选并停下。
- **本地改动提醒**：存在这个智能体的工作副本（`--ws` 指定的，或最近一个），而且这个节点在本地改过、草稿里还是旧的，就醒目提示「这次跑的是草稿上的旧版本，本地改动还没推」。
- **哪些节点能跑**：按 1.18.4 的节点全集写死；未知类型一律拒绝。
  - **可以跑**：`llm-completion, javascript-code, rule-center, query-knowledge-base, query-knowledge-child, query-sql-db, calculator, quality-check, speech-to-text, web-search, chat-search, image-generation`。
  - **要 `--allow-plugin` 且用户确认（§7）才跑**：`plugin-calculation`，以及挂了知识库查询以外工具的 `llm-completion`。原因是它们会真的调外部系统。工具类型的真实字段是 `type`（`{ type: 'query_kb', configParams: { knowledgeBaseId } }`，09-25 核对 147bd600 草稿），认不出的类型一律按外部调用处理。
  - **一律拒绝**：
    - 全部动作类节点，共 25 种，包括发消息、打标签、转人工、事件、写数据、插件动作等；
    - 触发器和事件入口；
    - 循环类、修改变量类；
    - `write-content-router`。
- **输入**：
  - `--from-exec`：取那次执行里这个节点的 `inputs.inputData`；那次执行没跑过这个节点就报错。
  - 默认去掉来源是 `operationAttrId` 的平台参数，让秒懂填最新值，并列出去掉了哪些。加 `--keep-platform-params` 则保留。
  - `--input 键=值` 覆盖单个键（值按字符串处理）；复杂值用 `--inputs` 从 JSON 文件合并进来。
  - 对照节点的输入定义检查：缺的键醒目提示「会按空值跑」，多出来的键也提示。
- **执行**：
  - 依次跑 `--times` 次，最多 10 次。每次 POST 一次、每 2 秒查一次，单次最长 5 分钟。
  - **POST 失败绝不自动重发**。网络错误、超时、5xx、缺 execId，一律报「不确定有没有启动，别重试，去秒懂页面看」。
- **输出**：
  - 每次一行结果：状态、耗时、花费、分支；再附上输出正文（截断）和推理的开头。
  - 跑了多次时汇总成一句：「N 次里有 K 种不同输出」，并给出总花费。
  - 每次的完整结果和渲染后的 prompt 存到 `trials/…`，打印路径。
- **花费**：闸门见 §7。单次预估按这个顺序取：
  1. `--from-exec` 那次执行里这个节点的 `costInCny`；
  2. 账本里这个节点上一次的实际花费；
  3. 都没有就是「未知」。

## 6. md test：测试中心

所有子命令都要带 `--bot`。测试集按名字或 id 找，歧义规则和找智能体一样。

### 6.1 看

- **`md test sets`**：列出测试集（名字、id、用例数、更新时间），回归测试集单独标出，并说明这个区有没有场景树。
- **`md test cases <集> [--out <文件.jsonl>]`**：
  - 汇总：用例数、按触发类型的分布、未审核几条、挂了场景几条，外加前若干条的摘要。
  - 完整的用例对象存盘；给了 `--out` 就是导出。
- **`md test tree`**：场景树和各节点的用例数。老一代的区直接说明没有场景树。

### 6.2 从执行记录导入

```
md test import <集> --from-execs <文件或 id…> [--from-bot <源智能体>] [--into]
```

- **目标测试集**：默认新建，同名的已经存在就报错；`--into` 表示导进已有的集。
- **输入**：`md exec` 保存的 JSONL（自带源智能体），或者 id 列表。
- **导入**：每批 20 条调 `test-case/import`，带 `includeSessionMemory: true`，把 data 外面的计数汇总起来。
- **跨智能体**（源智能体和目标不同）时自动重映射：
  - 要换的 id：
    - 事件 id：`triggerInputs.eventId`，以及断言里的 `eventId`；
    - 会话变量 UUID：`sessionMemoryCustomData` 的键，以及断言里的 `fieldId`。
  - 一律按名字，从源 bot 的 id 换成目标 bot 的 id。`verifyPayload` 和 `actionContent` 两份都改。
  - 用 `test-case/update` 回写完整的用例对象，再回读核对，确认里面不再有源 bot 的 id。
  - 名字在目标 bot 里找不到、或者重名的，列出受影响的用例。这些用例在 `md test run` 的跑前检查里会被拦下。
  - 源智能体来自 JSONL 或 `--from-bot`。只给了 id 却发现事件对不上时，报错并要求补 `--from-bot`。
- **审核状态**：导入的用例是 `isReviewed:false`。核对 6 证实未审核的用例照样会跑（§2.3），所以不去改它。
- **记下来源**：每条用例对应哪条源执行（时间、触发文本、线上回复，取自 JSONL），供结果报告的「线上回复」列使用。

### 6.3 从文件导入外部用例

```
md test import <集> --from-file <cases.jsonl> [--into]
```

AI 先把 Excel、飞书、聊天记录转成 JSONL，一行一条用例。格式写进 `references/test-cases.md`：

| 字段 | 含义 |
|---|---|
| `name` | 必填，同一个测试集里唯一；溯源信息（例如源文件第几行）写在这里 |
| `trigger` | triggerType，默认 `receive-text-message`；只接受服务端的 20 个枚举值 |
| `text` / `image` / `event` + `data` | 常用触发的简写。`text` 填文本；`image` 填最后一张图，写进 `imageUrl`；`event` 填事件名，按名字换成 eventId，`data` 是事件变量 |
| `input` | 完整的 `triggerInputs`；给了它就不再用上面的简写 |
| `history` | 此前的上下文：字符串数组（图片写裸 URL），或 `{role, content}` 数组。写进这个 bot 的「消息历史」变量 |
| `vars` | `{会话变量名: 值}`，按名字换成 UUID |
| `expect` | 断言的简写。见下方说明 |
| `scenario` | 场景名或场景路径；有场景树时挂上去 |
| `dimension`、`strict`、`mocks` | 可选 |

`expect` 有这几种写法：
- 字符串：用 LLM 判定回复；
- `{reply: …}`，里面写 `llm`、`similar` 或 `equal`；
- `{handover: true}`：期望转人工；
- `{event: "事件名"}`：期望发出某个事件；
- `raw`：原样写入的断言。

导入流程：
1. **本地先校验全部用例**：
   - name 唯一，用了 `--into` 时还要和集里已有的用例比；
   - 触发类型合法，常用触发的必填字段齐全；
   - 历史变量、会话变量、事件、场景的名字都能在目标 bot 里找到。
   - 有任何错误就一条都不写，并列出全部错误。
2. **生成请求体**，按 skill 的建模规则：文字进历史、图片写裸 URL、断言两份都给，只生成已知有效的断言形态。
3. **先写 1 条并回读**，逐字段核对有没有被服务端丢掉。字段在不同部署间会漂移，例如 `dimension`。
   - 关键字段（触发输入、会话数据、断言）被丢了，就停下来报告；
   - 非关键字段被丢了，提示后继续。
4. **写入其余用例**：每批 50 条。写完按 name 回读拿到 id，再按 `scenario` 每批 100 个挂场景；老一代的区跳过这一步，并说明原因。
5. **审计**：
   - 全部用例逐字段比对；
   - 导入前后，场景树各节点用例数的变化加起来要等于这次挂上的条数，否则提示有旧批次被重复挂载。
6. **输出**：提交、回读、挂载、缺失各多少条，以及字段差异。

### 6.4 批量改用例

```
md test edit <集> <脚本.mjs> [--confirm <计划码>]
```

- 脚本默认导出 `({cases, h}) => void`，直接修改用例对象。
- `h` 提供几类辅助：按名字换 eventId 或会话变量 id、生成断言、按名字挑用例。
- 不带 `--confirm` 时只预演：md 比较改前和改后，列出改了几条、每条改了哪些字段，并给出计划码。
- 带 `--confirm` 时：先备份，再用完整对象逐条 `update`，最后回读核对。

### 6.5 跑

```
md test run <集> [--version vX] [--rounds 1] [--concurrency 5] [--name <任务名>]
```

- **跑哪一版**：默认跑草稿；`--version` 跑某个版本，用的是那个版本的 canvasId。
- **任务名**：默认 `<集名>-<草稿|vX>-<MMDD-HHmm>`。
- **跑前检查**，都针对要跑的那张画布：
  - 用例数 × 轮数；
  - 事件触发类的用例：eventId 在事件列表里要有，在要跑的画布上也要有对应的事件入口；
  - 会话变量的键在这个 bot 里存不存在（不存在就会静默空跑）；
  - 未审核用例有几条；
  - 画布上会真实调用的插件：插件计算节点、插件动作节点、LLM 挂的插件工具，逐个列出名字；
  - 这个智能体上正在排队、正在运行的任务。
- **检查没通过怎么办**：事件或会话变量对不上时默认拦下，退出码 5；加 `--allow-preflight-errors` 才放行。
- **预估花费**：先按下面顺序取每条的单价，再乘以条数和轮数：
  1. 这个测试集最近一次跑完的任务的 `averageCostInCny`；
  2. 导入来源里源执行的花费；
  3. 都没有就是「未知」。
- **起跑**：过了确认（§7）后调 `test-task/create`，并先按预估记账。输出任务 id、跑的是什么、预估花费、排队情况，以及下一步命令。

### 6.6 进度、结果、暂停、删除

- **`md test status [<任务>] [--wait] [--timeout 540]`**：
  - 不给任务时，列出最近的任务：状态、进度、通过率、花费。
  - `--wait` 每 15 秒查一次，直到跑完或暂停。默认最多等 9 分钟，留在 AI 命令的超时之内。
  - 跑完后，用实际花费更新账本。
- **`md test results <任务> [<任务2> …] [--out <文件.xlsx|.csv|.jsonl>] [--deep]`**：
  - **逐条字段**：
    - 用例名、**调优中心执行 ID**（从用例名或导入来源取）、场景、用户消息；
    - 期望（断言说明）、是否通过、断言结论（含 `llmReason`）；
    - 实际回复：取发送动作的 summary，没有的话取发出事件里的文本；
    - 实际动作、花费、耗时、测试执行 id；
    - 有导入来源时，再加一列「线上回复」。
  - **多个任务**：按用例对齐，每个任务一组「通过、回复」列，用来看改前改后、两轮是否稳定。
  - **`--deep`**：测试项里拿不到回复时，按 `canvasExecId` 取详情来提取回复。每条约 2 秒，开跑前会先说大概要多久。
  - **输出**：stdout 只出汇总（每个任务的通过率、花费、耗时）和前若干条失败；`--out` 写文件。
  - **`.xlsx`**：由 md 内置的最小写入器生成，分「汇总」「逐条」两张表，表头加粗并冻结，通过和不通过用不同颜色。
- **`md test stop <任务>`**：暂停（秒懂没有取消）。暂停后秒懂不给出任务花费，账本保留原来的预估。
- **`md test drop <集> [--confirm <计划码>]`**：
  - 不带 `--confirm` 时预演：列出集名、用例数、挂载情况。
  - 带 `--confirm` 时：先把全部用例备份到本机，再先删用例、后删测试集，最后回读确认已删掉。

## 7. 用户确认（确认码）

> 2026-09-25 改：原设计是 macOS 系统弹窗（非 macOS 在终端里输入「同意」），只有用户本人能点。用户看过之后决定不要弹窗；执行者反对过一次（理由见本节末尾），用户坚持，改成和推送一样的确认码。

**哪些操作要用户确认**：
1. 花费超门槛，或者花费未知（`md trial`、`md test run`）；
2. 会真的调用插件：`md trial --allow-plugin`，以及画布上有插件动作节点时的 `md test run`；
3. 调高门槛（调低只会更严，直接生效）。

只读命令、导入、删除不花钱，不走这道闸门。删除和批量改走计划码，而且 skill 规定必须先得到用户明确同意。

**账本** `$MD_HOME/spend.jsonl`，只追加。每一笔记录：
- 时间、区、智能体、做了什么（节点名或测试集名）、模型、条数 × 次数；
- 预估花费及其依据，以及开跑前的预留；
- 自动放行，还是用户确认过（记下确认码）；
- 实际花费（跑完补记）：花费不知道的几次单独记次数和保守估计；任务 id。

「今天已花」= 本地日期今天的每一笔。跑完的按「实际 + 花费不知道那几次的保守估计」算，还没跑完的按预留算。

「查今天已花 → 判断 → 记一笔」在文件锁里做，并行的几条命令不会一起越过每日上限。

**预估**：
- 一条命令的预估：试跑是单次预估 × 次数，测试是每条预估 × 条数 × 轮数。
- 单次预估只认同一个模型跑出来的花费：上次试跑这个节点的实际单价优先；其次是执行记录里这个节点的花费（执行之后换了模型就不算）。
- 花费不知道时不当 ¥0：该花钱的节点没回花费字段、超时没跑完、启动结果不明，都按已知单价记，没有已知单价就按每次 ¥0.7。

**门槛**：放在 `$MD_HOME/config.json`，分「单次门槛」和「每日上限」，单位是元。默认 ¥2 和 ¥10。

**规则**：
- 预估已知、不超过单次门槛、今天已花加上预估不超过每日上限，而且不涉及插件：直接跑。AI 仍然要先告诉用户大概多少钱。
- 其他情况都要用户确认。
- 试跑的预估未知时：只要今天已花没超上限，第 1 次照跑。
- 跑的过程中逐次止损：
  - 每跑完一次，按「预估和已跑实际取大的」单价重算整条命令（已花 + 其余）；
  - 超单次门槛或每日上限，就在下一次开跑前停下，给其余几次的确认码；
  - 用户确认过的金额，推算超出一个单次门槛以上也停；
  - 预估偏低时，最多多花一次的钱。
- 测试的预估未知时：一律要确认，预演里写「费用未知（参考：单条 ¥0–0.3）」。

**怎么确认**：
- 需要确认时 md 什么都不跑，只输出预演，退出码 5。预演里写明：
  - 智能体、要做什么、条数 × 次数；
  - 预估花费及依据，会调用的插件；
  - 本地没推的改动；
  - 今天已花和上限；
  - 要确认的原因；
  - 最后是 8 位确认码。
- AI 必须把预演**单独**告诉用户，写明金额，不能夹在别的问题里。
- 用户明确同意这一笔后，AI 在同一条命令后加 `--confirm <码>` 再跑。跑到一半停下的，把次数改成剩下的次数，再加码。
- 码绑定这次操作的全部要素：智能体、节点 / 测试集、次数 / 条数 / 轮数、输入、预估、插件、本地日期。任何一样变了码就对不上，要重新问。
- 同一笔操作每确认一次就换一个码（账本里记着用过几次），所以用过的码对不上；同样的操作要再跑，就再问一次。
- 不需要确认时，多给的 `--confirm` 不起作用。

**改门槛**：`md spend limit --per-command X --per-day Y`。调高要确认码，调低直接生效。

**查看**：`md spend` 显示今天已花和上限、最近 7 天每天的合计，以及最近若干笔明细：预估、实际、花费不知道的次数、自动放行还是用户确认。

**为什么不用弹窗了（2026-09-25）**：
- 弹窗防的是「AI 顺手把花钱夹在别的请求里」，¥27.6 就是这么来的：金额单独出现在一个窗口里，只有人点了才算。
- 确认码做不到这一点。码只有 AI 看得到，它能证明 AI 看过金额，证明不了 AI 真的单独问了用户。这一层现在只靠 skill 的规矩，以及事后在 `md spend` 里查。
- 用户选确认码的理由：
  - 各平台一样。弹窗只有 macOS 有，Linux / WSL 上 AI 调用时一律被拒。
  - 不用守在屏幕前。
  - 装了操控屏幕工具的 AI 本来也能点弹窗，弹窗同样不是锁。
- 执行者的反对意见（记在这里，供以后回看）：弹窗平时很少出现（只有超门槛和调插件时才弹），而它防的正是出过事的那一类。

## 8. skill 与文档

**`SKILL.md`**
- description 覆盖三块：
  - 执行记录：badcase、执行 id；
  - 单节点试跑；
  - 测试中心：测试集、用例、回归、场景树，以及从执行记录、Excel、飞书导入用例。
- 去掉原来的「不负责测试中心用例导入与执行记录查询」。
- 三条标准流程：
  1. **查 badcase**：`exec` → `--node` / `--find` → 改 → 用 `trial` 做改前复现、改后复验。
  2. **回归**：`exec` 搜并保存 → `test import` → `test run` → `test status --wait` → `test results --out`。
  3. **外部用例**：转成 JSONL → `test import --from-file`。
- 规矩：
  - 花钱前先说预估；
  - 花钱要单独问用户、写明金额，不能夹在别的问题里；不许没问就用确认码，不许改 `$MD_HOME` 里的门槛和账本，不许直接调秒懂接口；
  - 插件节点试跑、删测试集、批量改用例，都要用户明确同意；
  - 要测回复质量，就导入生成回复的那条执行（太极类 bot 是「延时回复」那条）；
  - 按 §2.4 更正领域常识。

**`references/`**：新增三份。
- `exec.md`：执行记录和事件链怎么读；
- `trial.md`：单节点试跑；
- `test-cases.md`：用例 JSONL 格式、建模规则、触发类型与字段表、断言写法、测试中心的坑。

**README**：补上新增命令一览，以及花费闸门的说明（确认码怎么用；为什么它是约定不是锁）。

**旧 skill `miaodong-test-case-import`**：md 覆盖它的全部能力后，两者会抢同一类任务。征得用户同意后：
- 本机停用旧 skill；
- 在它的仓库（magic-skills，公开）里加上「已并入 miaodong」的说明。

## 9. 开工前真跑核对

**只读，不花钱**（在兴趣岛现有的智能体上做；09-24 已完成，结论已写回 §2）：
1. 列表的 `triggerType / actionType / canvasId / isCanary / allNodesSuccess / execId` 在服务端是否生效：用小时间窗、小页查询，比对返回的行。
2. 查详情时不带 botId 能不能取到。
3. 已有测试任务的逐条结果：
   - `canvas-event-action` 的 `summary` 长什么样，里面有没有事件参数的文本；
   - `test-task-item/list` 有没有 `page.total`，pageSize 最大能到多少。
4. `test-task/list` 按 testSetId 筛选是否生效。

**小额花费**（需要用户授权，总额 ≤ ¥1，在「【测试测试测试】太极2.0 测试专用版」上做）：

5. ~~单节点试跑传版本的 canvasId~~：2b 决定不做。试跑只跑草稿、不提供 `--version`，常用流程是「推草稿再试跑」；也省掉一次要用户授权的花费。
6. ✅ 09-25 已做（在「【测试测试测试】太极2.0 测试专用版」上，花费 ¥0.024，临时测试集已删）。结论写回了 §2.3：
   - 未审核的用例不会被跳过（2/2 都跑了），所以导入后不用标成已审核；
   - 事件对不上时 `triggerExists` 仍是 true，只能靠 `canvasExecAvailable=false` 认出空跑；
   - 逐条 `costInCny` 不实时：跑完那一条才有值。
7. ~~在用户机器上试弹一次对话框~~：2026-09-25 用户决定不用弹窗，不做。

核对结论写回本文 §2。影响实现的地方，按上文各节里「核对后再定」的写法执行。

## 10. 分步

每一步完成后都安装，并发布到 magic-skills/miaodong。
- **2a（只读，零花费）**：公共部分、`md exec` 全部功能、执行记录相关文档；做核对 1–4。
- **2b**：确认闸门（原为弹窗，09-25 改成确认码）、`md spend`、`md trial`、相关文档；核对 5、7 都不做（见 §9）。
- **2c**：`md test` 全部功能（含外部用例导入、审计、批量改、报告）、相关文档、停用旧 skill（征得同意后）；做核对 6。

## 11. 不确定项与假设

- 只在兴趣岛（1.18.4）实测过。其他区的接口可能缺失，字段也可能漂移；md 遇到 404 或字段缺失时明确报出来，不猜。
- 「测试中心不会把消息真的送到客户」的依据是用户经验：跑过上千条都没出事，但接口本身证明不了。
- 其余不确定项见 §9。
