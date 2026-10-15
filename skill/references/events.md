# 流程引擎事件（md events）

这里操作事件定义，不触发流程。**禁止删除事件**，包括撤回、回滚和失败补偿；不能绕过 CLI 调删除接口，也不能删除重建来修改事件。隐藏通过 `isHidden` 设置显示状态，不等于删除，也不能据此断言事件已停用。

## 查询和导出

```bash
md events --bot <智能体>
md events get <事件名或id> --bot <智能体>
md events used <事件名或id> --bot <智能体>
md events list --bot <智能体> --out events.json
```

- 列表固定查询 `eventListFilter=all`，包含隐藏事件，显示完整事件 ID。
- 名字精确匹配，也接受完整 ID 或至少四位的 ID 前缀；多条命中时停下，不自己挑。
- `get` 输出服务端原始定义，可以加 `--out event.json` 存单条。
- `used` 显示服务端的 `isUsed` 和当前草稿引用节点；不等于独立核对了所有历史版本。
- `list --out` 保存 `{botId, events:[…]}`，可以供另一智能体或另一区导入。单条 `get` 的输出要包成数组后才能导入。

## 新增、修改、隐藏／显示

```bash
md events add 跟进 --input text=string --bot <智能体>
md events edit 跟进 --name 课程跟进 --bot <智能体>
md events hide 跟进 --bot <智能体>
md events show 跟进 --bot <智能体>
```

上面的写命令默认只预演。**把具体清单和计划码单独交给用户；用户明确同意这一笔后，才在同一条命令加 `--confirm <计划码>`。** 不能替用户确认。新建功能的开发授权，不等于授权对任意真实智能体执行写操作。

- 同一智能体不创建重名事件；系统事件不允许修改。
- `--input` 可以重复，格式 `变量名=类型`。支持 string、number、boolean、datetime、image、audio、video、object，以及 `array<string>`、`array<number>`、`array<boolean>`、`array<object>`。含尖括号时加引号，例如 `--input 'tags=array<string>'`。
- **修改时 `--input` 指的是完整输入列表**。例如原来只有 text，要追加 score：`md events edit 跟进 --input text=string --input score=number --bot …`。
- 已引用事件（服务端或当前草稿任何一边在用）只能保留原定义并在末尾追加变量；不能改名、删改原输入或调整触发配置。引用信息不可靠就停止。
- 修改保持原事件 ID，保留未改字段。事件资源与画布分别写入，本命令不保存或发布画布；修改定义后重新 `md pull`，检查画布内嵌的 `data.eventItem` 和相关输入，必要的画布调整另走预演推送。

## 完整配置

新增、修改都可用 `--config config.json`。修改采用字段级覆盖，没给的字段原样保留；配置中的 `variables` 和命令行 `--input` 只能给一边。不能通过配置改事件 ID、归属或隐藏状态。

```json
{
  "variables": [
    {"name": "text", "type": {"type": "string"}},
    {"name": "data", "type": {"type": "object", "properties": {}}}
  ],
  "triggerTimesType": "limited",
  "maxTriggerTimes": 3,
  "effectiveDateType": "always",
  "effectiveDateConfig": [],
  "effectiveTimeType": "specific",
  "effectiveTimeConfig": [{"startTime": "08:00", "endTime": "18:00"}],
  "triggerIntervalType": "interval",
  "triggerIntervalSeconds": 60
}
```

```bash
md events add 跟进 --config config.json --bot <智能体>
md events edit 跟进 --config config.json --bot <智能体>
```

- `name` 可放在配置里；新建时若也给了 name，须与位置参数一致。
- 至少一个输入变量，变量名不能重复。复合类型使用 `type:{type:"array",items:{type:"string"}}` 或 `type:{type:"object",properties:{字段名:{type:"string"}}}`。
- 次数类型为 unlimited／limited，`maxTriggerTimes` 是非负整数；间隔类型为 no_interval／interval，启用间隔时秒数须为正整数。
- 日期类型为 always／specific；指定日期时需要非空 `effectiveDateConfig`，每个范围是 `{startTimestamp, endTimestamp}`（毫秒，起点不晚于终点）。
- 时间类型为 always／specific；范围使用 HH:mm，跨天拆成两个范围。

## 导入和 ID 映射

```bash
md events import events.json --bot <目标智能体> --out event-id-map.json
```

输入是非空事件数组或 `{events:[…]}`；每个事件必须有完整 UUID `eventId` 和有效定义，包内的 ID、名称不得重复。先整体校验，发现非法定义、系统事件或目标同名冲突时一条都不写。

确认后调用一次导入接口，按目标智能体重写归属，保留源定义的附加字段。**导入会创建新 ID，不是覆盖，也不能假定幂等。** 核对完整 `eventIdMap`、每个新 ID 对应的定义和显示状态后才报告成功。

- 映射始终保存到本机操作目录的 `event-id-map.json`；`--out` 可另存一份 `{eventIdMap:{旧ID:新ID}}`。
- 映射供后续调整画布时使用，不自动保存画布。入口 shape、`data.eventItem.eventId`、跳转的 `eventId` 等引用都要按同一映射改，再 `md check`、预演推送。
- 导入失败、超时、返回映射不完整或回读失败：先看本机 `result.json`、原始返回映射和远端事件列表，确认已创建了哪些。**不能盲目重试，不能删除新建事件补偿。** 核对后若还有未创建项，另做只含这些项的新导入包并重新预演确认。

## 操作记录和核对边界

每次写前备份完整事件列表，锁内重读列表与引用状态；确认码绑定区、企业、智能体、输入、完整列表和引用状态，请求前就记下意图并消耗确认码。用过的码即使远端恢复原状态也不能重用。

`md log` 显示事件操作和是否回读核对过。结果不明的操作不能当成功，也不自动重发。备份和结果保存在 `~/.miaodong/md/events/`（或 `MD_HOME/events/`），不能当成可自动删除重建的回滚包。

接口参数来自 2026-10-15 核对的控制台前端 1.19.17：

- API wrapper：`https://cdn.botorange.com/ai-pc/1.19.17/assets/canvas-D8uPTHpM.js`
- 创建／编辑表单：`https://cdn.botorange.com/ai-pc/1.19.17/assets/index-a_WsrJDB.js`
- 隐藏／导入调用：`https://cdn.botorange.com/ai-pc/1.19.17/assets/index-DLnKt06e.js`

本功能自动化测试只连接本机假秒懂，未对真实智能体做新增、修改、隐藏或导入验收；升级后字段或业务规则不一致时先重新核对契约。
