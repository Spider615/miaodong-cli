# 秒懂 CLI（md）设计：改秒懂上的数据要用户同意——范围与守卫

> 2026-09-27。用户的要求：「直接在秒懂上修改、新增这类操作数据的动作，需要告知用户并且经过用户同意才能执行」。
>
> 结论：按用户划定的范围（§1），现有命令已经做到了（§2）。这次只做两件事：把规矩写下来，再加一个守卫测试把它钉住（§3）。md 本身不改：不动 `src/`、`vendor/`，不改版本号，不发版。

## 1. 范围（用户 09-27 定）

- **要用户同意**：改智能体画布（`md push`、`md restore`）、写知识库（`md kb import`、`md kb revoke`）、改已有用例和删测试集（`md test edit`、`md test drop`）。
- **不用确认**：
  - `md test import`：建测试集、导用例。导入前说清导到哪个智能体、哪个测试集。
  - `md test run` / `status` / `stop`：建回归任务、止损暂停。
  - `md trial`：单节点试跑。
  - 花钱的照旧按门槛（CLAUDE.md 第 4 条）。
- **「同意」沿用计划码**：默认只读预演；带 `--confirm <计划码>` 才写。
  - 这是约定不是锁。码 AI 看得到，证明不了它真的问过用户，靠 skill 的规矩约束。
  - 09-25 用户定的「不用弹窗」不变。

## 2. 现状（09-27 读代码核对）

要确认的 6 个命令，都是先预演、核对计划码，最后才写。每个都有现成的测试，在假秒懂那一侧断言预演时一个写请求都没发：

| 命令 | 写的接口 | 预演返回 → 核对计划码 → 写 | 断言「预演不写」的测试 |
|---|---|---|---|
| `push` | `canvas/save` | `push.mjs:160 → 166 → 174` | `push.test.mjs:16`（`saves` 为 0） |
| `restore` | `canvas/save` | `restore.mjs:45 → 51 → 55` | `restore.test.mjs:13`（`saves` 不变） |
| `test edit` | `test-case/update` | `test-edit.mjs:47 → 52 → 62` | `test-cli-cases.test.mjs:146`（写日志不变） |
| `test drop` | `test-case/batch-delete`、`test-set/delete` | `test-drop.mjs:27 → 32 → 37` | `test-cli.test.mjs:384`（写日志为空） |
| `kb import` | `qa/batch-create` 等 | `kb-import.mjs:164 → 169 → 172`（续跑）、`207 → 212 → 217` | `kb-cli-import.test.mjs:20`（写请求数不变） |
| `kb revoke` | `qa/batch-delete` 等 | `kb-revoke.mjs:157 → 162 → 163` | `kb-cli-revoke.test.mjs:35`（写请求数不变） |

不用确认的命令会写这些接口：
- `test import`：`test-set/create`、`test-case/import|create|update|batch-delete`、`scenario/attach-cases`、`test-set/delete`。后两类删除是导错时自动撤回这次导进来的。
- `test run` / `status` / `stop`：`test-task/create`、`test-task/pause`。
- `trial`：`canvas/node/exec`。

vendor 里的整链路试跑 `startTrialRun`（POST `/api/canvas/exec`，会真的给用户发消息），`src/` 没有引用。

## 3. 改动

### 3.1 skill 的规矩（`skill/SKILL.md`「规矩」一节）

原来的第 102 行（不能替用户确认推送）和第 112 行（导入、批量改、删测试集）合成两条：

- 改秒懂上的数据，包括：
  - 推草稿、回滚草稿（`push`、`restore`）；
  - 写知识库（`kb import`、`kb revoke`）；
  - 批量改用例、删测试集（`test edit`、`test drop`）。

  一律先预演，把清单和计划码单独交给用户；用户明确同意这一笔后，才在同一条命令加 `--confirm <计划码>`。不能替用户确认，不许没问就用码。也不许绕开 md 去改：不自己调秒懂接口，不在控制台页面上替用户点。计划码对不上（退出码 5）时重新预演，把新清单给用户看。
- 导入用例、跑回归、试跑不用确认。导入前说清导到哪个智能体、哪个测试集；花钱的按上面的门槛。

### 3.2 开发说明（`CLAUDE.md` = `AGENTS.md`）

「改之前必读」加第 13 条，写明：
- §1 的范围；
- 由 `test/write-confirm-guard.test.mjs` 守着；
- 新命令碰到写接口时怎么归类：要确认的照 `test drop` 写预演和计划码，并补一个「预演不写」的测试；归到不用确认的，先问用户；
- 新接口要先在守卫里标成读或写。

### 3.3 守卫测试 `test/write-confirm-guard.test.mjs`

写法照 `kb-readonly-guard.test.mjs`：纯静态，读源码、顺着 import 找，不起服务。

1. **接口清单闭合。**
   - `src/` 和 `vendor/` 里出现的每个秒懂接口路径，都要在清单里标成读或写；清单里的也要都还在用。新接口没归类就不过。
   - 路径这样找：
     - 带引号的 `/api/…` 字面量；
     - `testcenter.mjs` 里测试中心的相对路径（`'/test-…'`、`'/scenario/…'`，以及 `` `${TC}/…` ``），加上 `/api/test-center` 前缀。
   - `/api/canvas/exec`、`/api/canvas/node/exec`：同一个路径 GET 是查结果、POST 是启动，按写算。
2. **写接口只许出现在封装它的文件里。**
   - 画布保存：`src/api.mjs`
   - 测试中心：`src/testcenter.mjs`
   - 知识库：`src/kb-write.mjs`（和 `kb-readonly-guard` 重叠，无妨）
   - 试跑：vendor 的 `trial-core.ts`

   其余文件直接写这些路径（测试中心的连相对路径一起查）就不过。这样绕不开封装函数，第 3 条按函数名认才靠得住。
3. **会写秒懂的命令正好是这 10 个文件，两个方向都比。**
   - 要确认的：`push`、`restore`、`test-edit`、`test-drop`、`kb-import`、`kb-revoke`。
   - 不用确认的：`test-import`、`test-import-file`、`test-run`、`trial`。

   怎么判：
   - 命令文件顺着 import 往下找，包括动态 `import()` 和 vendor，但不进别的命令文件。路上任何文件（封装文件本身除外）提到写函数的名字，或者碰到 `kb-write.mjs`，就算会写。写函数就是封装写接口的函数：
     - `saveCanvas`
     - 测试中心：`createTestSet`、`deleteTestSet`、`importExecs`、`updateCase`、`createCases`、`attachCases`、`deleteCases`、`createTask`、`pauseTask`
     - vendor：`startNodeTrialRun`、`startTrialRun`

     按名字（`\b名字\b`）认，不只认调用，换个别名 import 也躲不开。
   - 命令文件之间的 import 单独看：从会写的命令文件 import 了不在「只读工具」名单里的东西（包括 `import *` 和动态 import），也算会写，一直算到不再变。「只读工具」名单目前只有 `test-run.mjs` 的 `resolveTask`（`test-results` 在用）。
   - 路由（`index.mjs`、`test.mjs`、`kb.mjs`）不参与分类，但它们自己不许提到写函数、不许碰 `kb-write.mjs`。
   - 要确认的命令，源码里要有预演（「这是预演」）和计划码核对（`givenCode(` 或 `args.confirm`）。这只是兜底，真正的保证是 §2 的行为测试。
4. **预演不写**：§2 表里的现有测试已经覆盖，不另写。

09-27 在当前代码上试算过：按第 3 条判出来会写的正好是这 10 个，路由都是干净的。

### 3.4 局限（守卫认不出的情况）

- 只认名字和路径字面量：
  - 用拼接字符串造出来的写接口路径认不出；
  - 「只读工具」名单里的函数以后改成会写，也认不出。
- 守卫证明的是「会写的命令都归了类」。归到「要确认」的命令是不是真的先预演，靠 §2 的行为测试，所以新命令进这个清单时要补同样的测试（第 13 条写明）。
- 仍然是约定不是锁（§1）。

## 4. 交付与验收

- 在 worktree 的分支 `write-confirm-guard` 上做，只动 `test/`、`skill/`、`CLAUDE.md`、`AGENTS.md`、`docs/specs/`。不改版本号，不发版（CLAUDE.md 第 7 条）。
- 验收：
  - Node 22 下 `npm test` 全过。基线是 555 个：554 过，1 个跳过（没设 `MD_E2E_NODE`）。
  - 守卫在当前代码上通过。
  - 人为制造三种违规，各跑一次，守卫都要报错，改回后恢复通过：
    - 新命令偷偷调写函数；
    - 代码里新增一个没归类的接口路径；
    - 在别的文件里直接写写接口路径。
  - `CLAUDE.md` 与 `AGENTS.md` 一字不差。
- 合进 main、推送：先问用户。
