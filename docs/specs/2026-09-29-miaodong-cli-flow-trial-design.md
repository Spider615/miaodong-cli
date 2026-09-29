# miaodong-cli：整条试跑（`md trial --text` / `--event`）

日期：2026-09-29。前置：md 1.0.0（main e007eda）。
这份设计推翻了第 2 步设计 §1「不做整条流程试运行 `/canvas/exec`」的决定，原因见 §1.2。

## 1. 目标与边界

### 1.1 要解决什么

用户 09-29 的原话：

> 我觉得可以补上这个功能，因为有的场景确实是没有插件的，用这个功能就可以快速测试了。

现在想看「一句话进来，草稿会走哪些节点、最后回什么」，只有两条路：
- `md trial <节点>`：只跑一个节点；
- 测试中心：要先建测试集、导用例，再跑、再看报告。

链路上没有插件时，测试中心的 mock 用不上，这套流程就显得太重。整条试跑补的就是这一块：对草稿发一句话（或触发一个事件），直接看完整链路。

**验收**（全部由自动测试对着假秒懂验证；§2.2 列的几条要在第一次正式使用时补测）：

| 指标 | 目标 |
|---|---|
| 没有插件的草稿：一句话 → 走过的节点、最终回复 | 1 条命令，0 段临时脚本 |
| 接着上一句聊 | 同一条命令加 `--session` |
| 从文本入口或事件入口能走到插件（含事件那头） | 100% 拒跑，一个 POST 都不发 |
| 能走到 md 不认识的节点类型 | 100% 拒跑，一个 POST 都不发 |
| `--session` 给的不是 md 在这个智能体上开的试跑会话 | 100% 拒绝 |
| `--var` 预置内置会话变量（平台会静默忽略） | 100% 拦下 |
| 启动结果不明（网络错、超时、5xx、没回 execId） | 0 次自动重发 |
| 没经用户确认的花费 | 不超过单次门槛（沿用 `md trial`） |
| 看某个节点的输入、输出、prompt | `md exec <执行id> --node …` 直接能看 |

### 1.2 为什么现在做：第 2 步的四条理由逐条对照

1. **「没有跑到底但不真发的开关」**：09-29 实测，试跑会话的联系人、接收人都是空的，发消息节点只留下一条动作记录，没有投递状态（§2.1）。这类动作找不到真人去作用。真正会碰外部系统的是插件，所以插件一律拒跑。
2. **「用假联系人会大面积走兜底」**：这条仍然成立。缓解办法有两个：
   - `--var` 能预置自定义会话变量；
   - 结果里逐个节点列出走了哪条分支，走了兜底一眼就能看出来。
   整条试跑的定位是「快速看一句话怎么走」，成批回归还是用测试中心。
3. **「不会自动沿事件跟链」**：实测 `list-by-session` 能按会话列出试跑执行。md 跑完查一次同一会话后面有没有执行；没有，就打出「从事件入口接着跑」的现成命令（§5.3）。
4. **「跑到最终回复由测试中心覆盖」**：对有插件的智能体仍然如此，而且测试中心能 mock 插件。没有插件的，就用整条试跑。

### 1.3 不做

- **链路上有插件的，不给绕过的开关。** 试跑没法 mock 插件，用户 09-29 定过规矩：插件一律 mock，不许真调。有插件就走 `md test import` → `md test edit` 补 mock → `md test run`。
- **跑已发布版本。** 只跑草稿，秒懂画布页的试运行也只跑草稿。
- **图片、语音、文件、邮件、留资等其它触发。** 表单字段多，也没有实测。
- **从执行记录回放。** 回放要带当时的会话变量和插件 mock，归测试中心。
- **预置内置会话变量和用户属性**（`userAttributeData`）。前者平台会忽略（§2.1），后者没有实测。
- **自动沿事件往下跑。** 没实测秒懂会不会自己接着跑事件那头；md 自己再跑一遍，可能重复执行。
- **`md exec` 看试跑执行时的事件链。** 维持现状「测试 / 试跑执行没有事件链」，事件那头由整条试跑自己查（§5.3）。

## 2. 事实基础

依据有两份：
- I区控制台前端 1.19.11 的代码，标【前端】；
- 在用户指定的测试智能体 ba4fff74 的草稿上真跑 5 次，标【实测】。5 次都只走了没有插件的入口，花费 ¥0。

用户给的《秒懂接口大全》§13 依据的是前端 1.17.3，和实测不一致的地方以实测为准。

### 2.1 已确认的

**启动** `POST /api/canvas/exec?orgId`
- 返回 `{code: 0, data: {execId}}`【实测】。
- `code === 3` 时页面报「画布中引用的 AI SOP 或类型已被删除，无法试运行」【前端】。
- 文本触发：`{canvasId, sessionId, triggerType: 'receive-text-message', receiveTextMessage: {text, customAttrs: []}}`【前端；同形状的 `bot-receive-text-message` 实测】。
- 事件触发：`{canvasId, sessionId, triggerType: 'canvas-event-trigger', canvasEvent: {eventId, data: {变量名: 值}}}`【实测】。页面要求事件的每个变量都有值才能跑【前端】。
- 预置会话变量：`sessionMemoryData: {变量id: 值}`【实测】。只对自定义变量生效；内置变量（会话变量列表里 `isDefault: true` 的，比如「最后一条消息来源」）会被**静默忽略**，不报错【实测】。
- `sessionId` 由客户端生成 UUID【前端】。
  - 用同一个 id 再跑一次，「消息历史」会带上前一句，「消息数量」会累加【实测】。
  - 页面关着「保持会话」时，每次都换新 id【前端】。

**查询** `GET /api/canvas/exec?canvasExecId&orgId`
- 返回 `data: {canvasExec, nodeResults}`，**没有 `canvas`**【实测】。
- `canvasExec` 里的字段：`testRun: true`、`status`、`processDuration`、`totalCostInCny`（没跑大模型时是 0）、`tokenCount`（没跑大模型时是 `{}`）、`outputActions`、`sessionMemorySnapshot`、`errorNodeIds`、`allNodesSuccess`【实测】。
- 终态【前端】：页面每 2 秒查一次，满足下面两条才算跑完：
  - `status` 是 `success / cancelled / error / merged_skipped / interrupted` 之一；
  - 没有哪个节点的 `metadata.orderedDelivery.state` 还是 `queued` 或 `sending`。
  没跑大模型的链路，0.1 秒就到终态【实测】。

**试跑执行在别处能不能查到**
- `history/details` 按 id 能取到：带 `canvas` 快照，`testRun: true`【实测】。所以 `md exec <执行id>` 可以直接用。
- `history/list` 按会话查不到【实测】（与第 2 步设计 §2.1 一致）。
- `GET /api/canvas/history/list-by-session` 能列出【实测】：
  - 参数：`botId`、`sessionId`、`timestamp`（毫秒，字符串）、`direction`（`before / middle / after`）、`pageSize`（字符串）；
  - 每行有 `execId, triggerContent, outputActions, createdAt, status, sessionMemorySnapshot, rawTrigger, mergedIntoExecId, mergedFromExecIds`。

**试跑会话碰不到真人**
- `GET /api/session-memory/get-data?botId&sessionId` 看试跑会话：`testRun: true`、`contactId: null`、`receiverId: null`、`isMhSession: false`【实测】。
- 发文本节点的结果【实测】：
  - `actions: [{type: 'send-text-message', status: 'send', payload: {text, clientIds: [1 个]}, nodeId, nodeExecId}]`；
  - 没有 `metadata.orderedDelivery`，也就是没有进入投递。
  - 动作的 `status` 取值是 `send / handover / skip`【前端】。

### 2.2 还没实测到的

ba4fff74 上没有走不到插件、又带大模型或发事件的链路，下面三条测不了：

- **大模型节点在试跑里的花费。** 按 `history/details` 里的同名字段处理（`totalCostInCny`、`tokenCount`）。拿不准就记「花费不知道」，按保守价记账（§4.3）。
- **发出去的事件，秒懂会不会在试跑会话里接着跑事件那头。** 闸门按「含事件跳转」的范围算，已经把这种可能包进去了（§4.1）。跑完用 `list-by-session` 查一次，看到什么报什么（§5.3）。
- **打标签、转人工、改自定义属性在试跑里的具体表现。** 试跑会话没有联系人，推断这些动作作用不到真人。旁证：`md test run` 跑整条链路时也从来不拦这些动作。

以上三条在第一次正式使用时补测，结果回写到本节。

## 3. 命令

```
md trial --text "<用户消息>" (--bot <智能体> | --ws <工作副本>) [--session <会话>] [--var 变量=值 …] [--times 1] [--confirm <确认码>]
md trial --event <事件名或 id> [--data 变量=值 …] (--bot … | --ws …) [--session …] [--var …] [--times 1] [--confirm …]
```

**模式**
- `--text` 和 `--event` 只能给一个。给了其中之一就是整条试跑，不能再给节点。
- 单节点才有的参数（`--from-exec / --input / --inputs / --keep-platform-params / --allow-plugin`）在整条试跑里报用法错误；其中 `--allow-plugin` 会特别说明「整条试跑没法 mock 插件」。

**跑哪一版**
- 跑的是秒懂上的草稿。
- 本地工作副本里有能走到的节点改了还没推，要提醒；判断沿用单节点的 `draftVsLocal`，逐个可达节点看。

**入口**
- `--text`：草稿里所有「收到文本」触发器（`receive-text-message`）。
- `--event`：这个事件的所有事件入口节点。
- 草稿里没有对应入口时，报错不跑：秒懂这时不报错，只会什么都不执行。

**`--event`**
- 从事件列表里找：名字完全一致，或 id（前缀至少 8 位）。
- `--data` 的键必须是事件声明过的变量；缺了哪个变量就不跑，和页面一致。

**`--var`**
- 按名字从会话变量列表里找，要完全一致；有重名就报错。
- 内置变量一律拒绝，因为平台会忽略。要带聊天历史，就用 `--session` 接着聊。

**值怎么转**（`--data` 和 `--var` 一样，按变量类型）
- `string`：原样；
- `number`、`boolean`：按字面转，转不了就报错；
- 其它类型：按 JSON 解析，解析不了就报错。

**`--session <会话 id 或前缀（至少 8 位）>`**
- 只认 md 在这个智能体上开过的试跑会话（本机有记录），否则拒绝。这样不会把试跑写进真实客户的会话。
- 不给就新开一个会话。
- 不能和 `--times` 大于 1 同时用。

**`--times 1–10`**：每次都新开一个会话。

## 4. 闸门（开跑前，全部只读）

### 4.1 可达范围

从入口出发做一次广度优先遍历，沿两种边走：
- 连线；
- 事件跳转：事件动作节点 → 同一个 `eventId` 的事件入口节点。复用 `graph.mjs` 的 `buildIndex`。

可达节点的子节点也一并算进来，包括 x6 的 `parent` / `children` 和 `data.parentLoopBodyNodeId`，免得循环体里的节点被漏掉。

### 4.2 判定

按顺序判，任何一条拒跑都发生在所有 POST 之前，拒跑时一个请求都不发：

1. **插件**：`plugin-calculation`、`plugin-action`，以及挂了 `query_kb` 以外工具的大模型（认法同 `md trial`）。
   → 拒跑，退出码 5。列出前 10 个（名字、短 id、类型），并提示改走测试中心。
2. **md 不认识的类型** → 拒跑，退出码 5，列出这些类型。
3. **认识的类型照跑**，开跑前按类型列出数量：
   - 触发器：`category` 是 `trigger` 的节点。
   - 计算：就是 `md trial` 能跑的那张表，包括大模型、代码、规则、知识库 / SQL 查询、计算器、质检、语音转文字、联网搜索、`chat-search`、图片生成。
   - 动作：发文本、发图片、发语音、发组合消息、发素材，打标签、智能标签（`smart-tag`），写会话变量，改自定义属性，邀请入群，发事件，转人工。

拿本机的 3 个兴趣岛大智能体和 ba4fff74 算过一遍：从文本入口出发，算上事件跳转，能走到 23–28 个插件节点，全部拒跑。兴趣岛那 3 个的事件入口里，有 31–32 个（共 36–39 个）走不到插件，可以用 `--event` 单独跑。

### 4.3 花费

沿用 `md trial` 的规则：单次门槛、每日上限、确认码、估不出时先跑 1 次、每跑完一次按实际重算、花费不知道的按保守价记。

- 账本里记 `kind: 'flow'`，按「智能体 + 入口（text 或事件 id）」记实际单价。
- 预估正好 ¥0 的，不因为「今天已超每日上限」要确认：它不会让今天多花钱。这一条改在共用的 `spendDecision` 里，单节点试跑只跑代码、规则这类节点时同样适用；测试中心把单价 0 当估不出，不受影响。
- 预估：能走到的节点全是不花钱的类型（触发器、代码、规则、计算器、除智能标签以外的动作）时记 ¥0。09-29 实测这种链路 `totalCostInCny` 是 0；不这样的话，第一次跑都「估不出」，当天到了上限就得为一笔 ¥0 的试跑去问用户（09-29 真机核对时撞上）。否则取上一次同一入口的实际单价，没有就算估不出。
- 一次跑下来花了多少：
  - `canvasExec.totalCostInCny` 是数字就用它；
  - 但如果 `tokenCount` 不是空的、`totalCostInCny` 却是 0，算「花费不知道」；
  - 没跑完，算「花费不知道」；
  - 没有这个字段时：跑过的节点全是免费类型（代码、规则、计算器、触发器，以及除智能标签以外的动作），就是 ¥0，否则算「花费不知道」。

## 5. 跑与结果

### 5.1 跑一次

1. 新开的会话先写进本机记录（§6），再发请求。
2. POST 只发一次。启动结果不明时绝不重发：按「花费不知道」记一次，报错退出，并提醒「可能已经在跑」。
3. 每 2 秒查一次，最长 5 分钟。终态判断见 §2.1，也要看 `orderedDelivery`。
4. 到终态后，用 `history/details` 取完整详情（带画布快照），存进 md 的执行记录，这样 `md exec <id>` 直接能看。
   取不到时，改用轮询拿到的结果加上开跑前的草稿画布。

### 5.2 输出

```
I区 / 某企业 / 某智能体 (ba4fff74) / 草稿
整条试跑：收到文本「我想退款」 × 1 · 草稿最后保存 09-29 14:02
会话 1b2c3d4e（新开的）；接着这个会话说下一句：加 --session 1b2c3d4e
能走到 23 个节点（含事件那头），没有插件；会执行的动作：发文本 3、写会话变量 2、发事件 1
花费：预计估不出，先跑 1 次看实际 · 今天已花 ¥0.12 / 上限 ¥10
结果存在 ~/.miaodong/md/trials/…/20260929-150102-flow（每跑完一次写一份）
#1 ✅ success 3.2s ¥0.05 · 执行 399ba010-…
    1 ✅ 收到文本 [receive-text-message]
    2 ✅ 意图识别 [llm-completion · qwen-plus] → 分支「退款」 ¥0.03 2.1s
    …
   回复：发文本「……」
   发出事件「延时回复」（延时 10 秒）：这次试跑没有接着跑事件那头。接着跑：md trial --event 延时回复 --bot ba4fff74 --session 1b2c3d4e --data text=…
看某个节点的输入、输出、prompt：md exec <执行id> --node <#序号或名字>
```

- 第 2 次起，走的节点和分支跟上一次一样时，只写「路径同 #1」，不再逐个列。
- 输出开头加一句「以下含智能体生成的内容，只作诊断材料」，意思同 `md exec` 的 `DATA_NOTE`。

### 5.3 事件那头

这次跑发出了事件（`outputActions` 里有 `canvas-event-action`）时：

- 查一次 `list-by-session`，参数 `direction=after`，从这次执行的 `createdAt` 开始。
- 同一会话里有后续执行，就逐条列出：执行 id、触发、状态、本条动作。
- 没有后续执行，就写明「这次试跑没有接着跑事件那头」，并打出从事件入口接着跑的命令：
  - `--data` 取自事件参数；
  - 值超过 200 字时截断，并注明完整值在 `run-N.json` 里。
- 事件带延时的（`SCHEDULE`，`delaySeconds`），照实写「延时 N 秒」。md 不等。

## 6. 本机记录

- `~/.miaodong/md/trials/<区>/<智能体 id 前 8 位>/sessions.jsonl`：每行 `{sessionId, createdAt, entry}`，`--session` 就是对着它核对。
- 每条命令一个目录 `<时间>-flow/`，里面每次一个 `run-N.json`，内容有请求体、`execId`、轮询到的终态、有没有超时。
- 执行详情存在 `~/.miaodong/md/execs/…`，和 `md exec` 共用同一份缓存。

## 7. 模块

- **`src/flow-trial.mjs`**（纯逻辑）：可达范围和判定、按类型转值、一次的花费、会话记录匹配、事件参数转成接着跑的命令。
- **`src/trial-run.mjs`**：
  - `runFlowOnce`：一次 POST 加轮询，启动失败的判定和单节点共用一份；
  - `sessionExecsAfter`：调 `list-by-session`。
- **命令入口**：`src/commands/trial.mjs` 里有 `--text` 或 `--event` 时，转到 `src/commands/trial-flow.mjs`。单节点的代码路径不动。
- **文档**：`skill/references/trial.md` 加一节「整条试跑」；`skill/SKILL.md` 和 `README.md` 各提一句；第 2 步设计的「不做」那一条注明「09-29 改为做」。

## 8. 测试

**纯逻辑**
- 可达范围：沿连线能走到插件、只有经过事件跳转才走到插件、挂了外部工具的大模型、循环体里的子节点、没有插件的正常链路。
- 判定：不认识的类型；动作按类型计数。
- 按类型转值：`--var` / `--data` 的 string、number、boolean、JSON，以及转不了的报错。
- 一次的花费：有 `totalCostInCny`；`tokenCount` 有内容而花费是 0；没有字段且只跑了免费节点；没有字段且跑了大模型；超时。
- 会话记录：前缀匹配、太短、不唯一、别的智能体的会话。

**命令（对着假秒懂跑）**
- 文本：请求体正确；打出路径和回复；存进执行记录（`md exec <id>` 不联网能看）；记账。
- 插件、不认识的类型：拒跑，一个 POST 都不发。
- `--event`：
  - 名字能找到；请求体是 `canvasEvent {eventId, data}`；
  - 缺变量、多给了没声明的变量：报错，不发请求；
  - 草稿里没有这个事件的入口：报错，不发请求。
- `--var`：
  - 自定义变量写进 `sessionMemoryData {id: 值}`；
  - 内置变量、找不到的名字：拒绝，不发请求。
- `--session`：
  - 接着跑时请求里是同一个 `sessionId`；
  - 不是 md 开的会话：拒绝；
  - 和 `--times 2` 一起给：报用法错误。
- 花费：
  - 超单次门槛：给确认码，不跑；
  - 估不出：先跑 1 次；
  - 花费不知道：按保守价记账。
- 启动结果不明（5xx、断网）：只发了一次 POST，退出码非 0，账本里记一次「花费不知道」。
- 轮询：先回几次 running 再到终态；`orderedDelivery` 还在 sending 时继续等；5 分钟超时（测试里调短）。
- 事件那头：同会话有后续执行就列出来；没有就给出 `--event` 命令，`--data` 取自事件参数。
- 单节点试跑原有的测试全部不改、照样通过。

## 9. 实施顺序

1. 纯逻辑：`flow-trial.mjs`，TDD。
2. 请求与轮询：`trial-run.mjs` 里的 `runFlowOnce`、`sessionExecsAfter`，TDD，对着假秒懂。
3. 命令：`commands/trial-flow.mjs` 接上闸门、花费、输出、本机记录，TDD。
4. 文档：skill、README；第 2 步设计里的「不做」那一条改掉。
5. 全量测试，发版检查：版本号改成 1.1.0，用 Node 18 跑打包产物的冒烟测试。
6. 找用户确认之后才合并到 main、推送、打标签。
