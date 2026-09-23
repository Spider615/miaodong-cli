# 秒懂 CLI（md）设计

> 2026-09-23。依据：本机 9 个秒懂会话转录的统计、仓库代码阅读、本机实测（esbuild 打包、三方合并、数组路径 bug、Codex 沙箱）。
> 调研原始报告在会话 scratchpad，结论已全部收进本文。

## 1. 要解决的问题

用户的日常是让 Claude Code / Codex 用本仓库的工具修秒懂 bot：拉画布 → 定位 badcase → 批量改 LLM 节点 → 推草稿 → 试跑复验 → 跑回归。现状（9 个会话实测）：

- kit 只封装 7 个接口，AI 每个会话临时写 13–61 段脚本解析画布 / 调接口；
- 测试中心接口靠猜路径 + 下载前端 bundle 找，每次 37–51 分钟；
- Node 22 前缀 324 次（kit 依赖 `--experimental-strip-types`）；
- 全量覆盖推送差点冲掉用户在 UI 上的并发改动；`--bot` 时显示错 bot 名；
- 用户追问「改了啥 / 改的哪个智能体 / 推了没」每会话约 3.5 次；
- AI 自作主张跑了 245 条回归（¥27.6），`--confirm` 挡不住 AI 自己加。

形态不是瓶颈，能力缺口才是；但约一半的用户纠正是模型行为问题，只能写进 skill 规则。

## 2. 形态

**一个 skill 外壳，里面装一个打包好的单文件 CLI。**

```
~/.claude/skills/miaodong/
  SKILL.md          何时用、修 bot 标准流程、行为规则、领域常识（短）
  references/       推送、改动脚本 helper、取身份等细节（按需读）
  scripts/md.mjs    esbuild 单文件，Node 18+ 可跑，无 flag、无警告
~/.codex/skills/miaodong  → 软链到上面
~/.local/bin/md           → 软链到 scripts/md.mjs（用户本人也要在终端用）
~/Desktop/miaodong/       完整副本（用户 09-23 要求放桌面：方便查看、直接转给同事；每次安装刷新，改它不生效）
```

- 源码在仓库 `miaodong-kit/`（复用 `apps/api/lib/miaodong/*`、`packages/shared` 的纯函数），`npm run md:install` 构建并安装。安装产物不依赖仓库、不随分支切换消失。
- 不用 `npm link`（会装进 nvm 的 v18 目录）；不软链进工作树。
- 暂不做 MCP：用户 CC=bypassPermissions、Codex=danger-full-access，MCP 的沙箱优势为零，而批量改动与 jq 组合需要 CLI。命令实现与参数解析分离，以后要包 MCP 时只加适配层。
- 最终并入 `miaodong-test-case-import`（它会抢「测试中心」类任务）；`skills/miaodong-platform` 退役（区域表过期、自检红、两个 harness 都发现不了）。这两件不在第 1 步。

## 3. 身份（不用账号密码）

参照 github.com/magic-skills/miaodong-test-case-import 的控制台取法，三处不同：

1. **不绑定智能体**：控制台 JS 只取 origin、token、当前企业（及 localStorage 里有的企业列表），登录后任意页面可执行。
2. **按区分别存**：`$MD_HOME/identities.json`（0600），一个区一条；多个区同时可用。
3. **token 不进对话**：JS 把 `md-auth:<base64 JSON>` 复制到剪贴板；用户说「好了」，AI 跑 `md auth import`，由它读剪贴板（macOS `pbpaste`；测试与其他平台用 `--stdin`）。输出只显示区 / 企业 / 用户名 / 过期时间。

流程：用户给域名 → `md auth snippet <域名>` 输出步骤 + 一行 JS（AI 原样转给用户）→ 用户在控制台执行 → `md auth import` → 立即用 token 调 `bot/list` 验证可用 → 保存。

没有密码就不能自动续期：任何请求 401 时停下，打印该区的取身份步骤。token 若带 `exp` 就展示过期时间。

## 4. 目标换算

所有命令接受 `--org` / `--bot` / `--version`，名字或 id 都行：

- 名字完全一致优先，其次 id / id 前缀，再次名字包含；**有歧义列候选并停，绝不自己挑**；
- `--bot` 不给企业时跨所有已取身份的区、所有企业搜索；
- 每条命令输出第一行：`区 / 企业 / 智能体 (id8) / 版本`；
- **写操作不使用任何默认智能体**，只认工作副本里记下的目标。

查询：`md auth list`（已取身份的区）、`md orgs`、`md bots [关键词]`、`md versions --bot X`。

## 5. 版本

「版本」有三种：草稿（唯一可写）、已发布版本（只读快照）、线上在跑的版本（可能正式 + 灰度并存）。

- `md versions`：`list-version` 的版本表（版本号、名称、创建人 / 时间、test/online、灰度、测试状态）；「线上启用」取 `bot/basic-info` 的 `canvasVersion`（只有前端代码证据，取不到时明说）。按执行记录统计实际流量放到第 3 步。
- `md pull --version v1.0.400`：以该版为底；同时拉草稿，告诉用户「草稿与 v1.0.400 差 N 个节点」。
- 以版本为底推送时，草稿若与该版不同，必须显式选择：`--onto-draft`（三方合并进当前草稿）或 `--replace-draft`（草稿变成 该版 + 改动）。

## 6. 工作副本

`md pull` 在 `$MD_HOME/work/<区>/<bot8>/<label>/` 建工作副本：

| 文件 | 内容 |
|---|---|
| `meta.json` | 区、orgId、botId、智能体名、主画布 canvasId、来源（draft / 版本号 + 版本 canvasId）、草稿 updatedAt / version / 哈希、拉取时间 |
| `base.json` | `{canvas, sessions, events}` 改动的基线 |
| `draft.json` | 以版本为底时，拉取时刻的草稿（推送时比对用） |
| `after.json` | 改后快照（`md apply` 产出） |
| `transforms/NNN-*.mjs` | 产出 after 的改动脚本副本，rebase 时按序重跑 |
| `index/nodes.jsonl` `edges.jsonl` `refs.jsonl` | 供 jq 查询：节点摘要、连线（含 action→trigger 事件边）、全图引用索引 |
| `backups/` | 推送前远端草稿的备份 |

`MD_HOME` 默认 `~/.miaodong/md`，可用环境变量覆盖（测试用）。不写仓库、不写 cwd。

## 7. 看 / 改 / 自检 / 推 / 账本

- **看**：`md trace <节点> [--up|--down] [--depth N]`（走真实连线 + 事件边）；`md refs <节点>`（谁引用了它，全图递归扫描，给出字段路径）；`md node <节点>`（完整配置）。其余查询直接 jq 索引文件。
- **改**：改动以 after.json 为准。`md apply <脚本.mjs>`：脚本默认导出 `(ctx) => void`，`ctx = {canvas, sessions, events, h}`；helper 自带守卫：`h.select(pred)`、`h.node(id|前缀|名字)`、`h.get/set(node, path)`（支持 `a[0].b` 与 `a.0.b` 两种数组写法，路径不存在报错，绝不把数组改成对象）、`h.replaceOnce`（必须恰好命中 1 次）、`h.replaceAll(..., {expect})`、`h.insertAfter / insertBefore`、`h.expectCount(list, n)`、`h.retargetRefs({from, to, fromDataPath, toDataPath, expect})`、`h.cloneNode(query, {name})`、`h.portOf(node, 'left'|'right', i)`、`h.addEdge(from, fromPort, to, toPort)`、`h.removeEdges(pred, {expect})`、`h.removeNode(query)`。多次 apply 叠加；`md apply --reset` 回到 base；`md apply --json <file>` 接受整份手改（不可重放）。`md rebase` 在最新草稿上按顺序重跑改动脚本。
- **自检** `md check`：只报**相对基线新增**的问题——作用域校验（改动节点）、新增风险（workflow-risk，可达性由其 D 组规则体现）、数组 ↔ 对象的类型突变（null / 标量与结构互换只警告）、连线端点 / 端口悬空、引用悬空、自引用。
- **diff** `md diff [--json]`：节点 / 连线增删、改动节点的字段路径；字符串字段按行 diff；过滤坐标 / 尺寸 / zIndex 等纯渲染字段。
- **推** `md push`（默认预演，`--confirm <计划码>` 才写）：
  - 重新 GET 草稿，做**元素级三方合并** `merge(base, 你的改后, 当前草稿)`：节点按 id、连线按「源节点#端口→目标节点#端口」对齐；只有你改的节点用你的内容（位置沿用草稿）、只有别人改的保留别人的、双方都改同一节点 → 冲突停下；合并后有悬空连线 → 冲突。
    - 不复用老懂的 `planContentPublish`：它只处理纯内容改动、按整个 `node.data` 判冲突、不搬结构改动（实测代码），一条合并路径覆盖内容与结构两种情况更简单。
    - 秒懂编辑页会自动保存，且加载时会就地改 rawCanvas（前端代码证实），所以「远端变过就停」会被噪声频繁打断；按节点合并只在碰到同一节点时才停。
  - 合并结果还要过一遍断头检查：相对当前草稿新出现悬空引用 / 连线 / 端口 → 拦下（自检只比基线与改后，看不到别人的并发删除）。
  - 以版本为底且草稿与该版不同 → 必须显式 `--onto-draft`（走合并）或 `--replace-draft`（整体替换）。
  - 自检（`md check`）有新增硬问题时拒绝推送，除非 `--allow-check-errors`。
  - 预演打印目标、改动清单、计划码；计划码 = 哈希(智能体, 草稿 id, 当前草稿内容, 要写入的内容)，`--confirm` 必须与当前预演一致（预演后草稿又变了就要重新预演）。
  - 写前备份，只调 `canvas/save`（不再 import 事件 / 会话变量）；写后回读核对：节点集合、连线集合、你改过的那些字段必须一致，其余差异只提示（服务端会归一化个别字段，实测换模型时会删 `data.modelDeprecated`）。
  - 推送成功后工作副本以回读结果为新基线，改动脚本移入 `history/<时间>/`。
  - 记账本。`md restore` 用推送前备份回滚（同样预演 + 计划码）。
- **账本** `md status [--bot X] [--remote]` / `md log`：哪个区哪个智能体、改了哪些节点、推没推；`--remote` 拉当前草稿，逐个核对上次推送改动的节点是否还在（发现被旧编辑页覆盖）。

退出码：0 成功；1 一般错误 / 自检有问题；2 用法错误；3 需要（重新）取身份；4 智能体 / 版本 / 节点找不到或有歧义；5 推送被拦（冲突、计划码不符、草稿与版本不同、回读不一致）。

## 8. 安全与行为规则（写进 SKILL.md）

- 秒懂任务不开子 agent / workflow，除非用户明确要求；
- 先几行回答字面问题，不自行扩大范围；
- 花钱 / 外发的范围等于用户说的范围；
- 每次写后固定回执：区 / 智能体 / id、仅本地 or 已推草稿未发布、改了哪些节点、UI 里怎么看；
- 身份只走 `md auth`，不读 identities.json、不 pbpaste、不在回复里出现 token；不许从老懂数据库或别处找密码；
- 领域常识：回复在「延时回复」事件那条执行里；测试中心沙箱不真发；跨 bot 导入用例通过率无意义；regression-test ≥50 条且不能指定测试集；试跑跑的是草稿；推完刷新编辑页，旧标签页保存会覆盖推送。
- 不做 publish / enable / 灰度。

## 9. 验收（从会话转录可量，均有基线）

| 指标 | 现状 | 目标 |
|---|---|---|
| Node 版本前缀 / 警告过滤 | 324 次 | 0 |
| 高频任务中直接调秒懂 HTTP 或手解析 rawCanvas 的命令 | 每会话 13–61 | 接近 0 |
| 「改了啥 / 哪个智能体 / 推了没」追问 | 每会话约 3.5 | ≤ 1 |
| 推错智能体 | — | 0 |
| 未经同意的花费 | ¥27.6（一次） | ¥0 |
| 说出「智能体+问题」到第一份可审阅答案 / diff | 测试中心类 35–51 分钟 | 显著下降（第 2 步起量） |

## 10. 分步

1. **第 1 步（本计划）**：打包安装 + skill；身份 / 目标换算 / 版本；pull + 索引 + trace/refs/node；apply / diff / check；push；status / log。
2. 第 2 步：`md exec`（badcase 执行链、`--find`）、`md trial node`（带副作用预检与花费闸门）、测试中心全链路、花费账本与阈值确认（超阈值必须用户本人在终端确认）。
3. 第 3 步：执行记录检索与采样、本地跑代码节点、并入 test-case-import、老懂侧修 workflow-patch 数组路径 bug（该 bug 同样影响老懂 apply_workflow_patch）。

## 11. 已知事实与不确定

已确认（前端 1.18.4 代码 / 会话实测）：
- 控制台页面顶层执行时 `location.origin` 就是 API base（axios `baseURL:"/api"`）；控制台域名是 `-insight` 族，`-hi` 是对话页。
- `localStorage.user` = 登录响应 `data.user`（含 `orgs[]`）+ `token` + `currentOrg`，每次加载刷新；嵌入 wujie 时键名是 `user-ai-pc`。
- 统一外壳 `{code:0, data, page?}`；POST 成功多为 201；登录失败是 `201 + code:-1`，所以必须检查 `code`；orgId 一律放 query。
- `canvas/get` 草稿和版本响应都带 `updatedAt` / `version`；1.18.4 没有 `botName` 键。
- 秒懂编辑页会自动保存，加载时会就地改画布。

不确定：
- token 实际有效期、过期时回 401 还是 403（两种都按「身份失效」处理）。
- `canvas/save` 成功响应体（按「2xx 且 code 为 0 或无 code」处理）。
- `canvas/event/list` 不带 `eventListFilter=all` 是否漏隐藏事件（md 固定带上）；`bot/basic-info` 只有前端代码证据。
- 草稿 canvasId 与版本 `rootCanvasId` 不一致的智能体（例：b785966b），用草稿 canvasId 调 `list-version` 能否列全版本。
