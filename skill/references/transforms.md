# 改动脚本

脚本是一个 `.mjs` 文件，默认导出一个函数，在 `ctx.canvas`（秒懂画布数组）上直接改：

```js
export default ({ canvas, h }) => {
  // …
};
```

守卫一律「宁可报错也不猜」：命中次数不对、路径不存在、数量不符都会让整个脚本失败，工作副本保持不变。

**节点名称最多 20 个字**：新增节点、`h.cloneNode(..., {name})`、`h.set(node, 'data.name', ...)` 改名时，提前取 20 个 Unicode 字符以内的短名称；中文、英文、数字、空格、符号都计数，恰好 20 个允许。不能自动截断，以免重名或丢掉用途；写完用 `md check` 核对。推送会检查最终合并的画布，回滚也检查备份，超长名称不能用 `--allow-check-errors` 或确认码放行。

方案取舍遵循 [修改原则](../SKILL.md#修改原则)。

## 事件节点的画布格式

事件资源定义和画布节点是两回事。先用 `md events` 查询或新增资源，再 `md pull` 获取当前定义；仅在需求确实需要新节点时添加。调整节点时核对必要的端口、连线和引用，保留需求范围外的布局和配置。

| 节点 | shape | data.type | 必需的事件信息 |
|---|---|---|---|
| 事件动作／调度 | `action-event` | `canvas-event-action` | `data.nodePayload.eventId` 指向目标事件 |
| 事件入口 | 具体事件的 `eventId` | `canvas-event-trigger` | `data.eventItem` 为该事件的定义副本，至少含一致 ID、名称、变量列表；`nodePayload.eventId` 如有也要一致 |

**不能把业务类型直接当成 shape。** `shape='canvas-event-action'` 和事件入口缺 `data.eventItem` 都可能中断编辑器初始化。md 对本地目标、最终合并结果、回滚备份及保存入口检查这些格式；即使是原有错误、带了确认码或 `--allow-check-errors` 也不能写入。CLI 只报错，不静默改用户画布。

入口副本按当前资源生成，例如改动脚本中拿到现有入口后：

```js
export default ({ events, h }) => {
  const entry = h.node('事件入口的精确id');
  const event = events.find((e) => e.eventId === entry.shape);
  if (!event) throw new Error('找不到入口对应的当前事件定义');
  h.set(entry, 'data.eventItem', structuredClone(event));
};
```

格式检查只证明已覆盖的结构约束，不证明浏览器整图可以加载或业务正确。变更涉及新节点或特殊 shape 时，回执分别说明结构检查、浏览器加载和业务回归的实际结果，未做的不能写成通过。

## helper

| 写法 | 作用 |
|---|---|
| `h.select(n => …)` | 按条件选业务节点（不含连线和便签） |
| `h.node('前缀'或'唯一名字')` | 取一个节点，有歧义就报错 |
| `h.expectCount(list, n)` | 数量必须等于 n |
| `h.get(node, 'data.nodePayload.inputs[0].name')` / `h.set(...)` | 读 / 写字段；`a[0].b` 与 `a.0.b` 都行；只有最后一段可以新建 |
| `h.replaceOnce(node, path, 查找, 替换)` | 文本里「查找」必须恰好出现 1 次 |
| `h.insertAfter(node, path, 锚点, 新内容)` / `h.insertBefore` | 基于 replaceOnce |
| `h.replaceAll(node, path, 查找, 替换, { expect })` | 全部替换，可要求次数 |
| `h.retargetRefs({ from, to, fromDataPath?, toDataPath?, expect })` | 把所有引用 from 的地方改成引用 to。from / to 必须是两个不同的节点 id；to 节点自己对 from 的引用不改（避免自引用） |
| `h.cloneNode(query, { name })` | 复制节点（新 id、新端口 id） |
| `h.portOf(node, 'left'或'right', i)` | 取端口 id |
| `h.addEdge(from, fromPort, to, toPort)` | 加连线（样式照抄画布里已有的连线） |
| `h.removeEdges(e => …, { expect })` / `h.removeNode(query)` | 删连线；删节点时连带删掉它的连线 |
| `h.log('说明')` | 往 apply 的输出里加一行说明 |

## 例 1：给所有「回答生成」节点在锚点后插一段

```js
export default ({ h }) => {
  const nodes = h.expectCount(h.select((n) => n.data?.name === '回答生成'), 16, '回答生成节点');
  for (const n of nodes) {
    h.insertAfter(n, 'data.nodePayload.systemPrompt', '## 回复要求', '\n- 用户描述症状时先问清具体情况，不要直接下结论。');
  }
};
```

各节点的锚点写法不一致时，按写法分组，每组用各自的锚点，并各自 `expectCount`。

## 例 2：把 gemini 系列换成 luna（智能标签节点除外）

```js
export default ({ h }) => {
  const nodes = h.select((n) => /gemini/i.test(n.data?.nodePayload?.modelType ?? '') && n.data?.type !== 'smart-tag');
  h.log(`命中 ${nodes.length} 个节点`);
  for (const n of nodes) h.set(n, 'data.nodePayload.modelType', 'gpt-5.6-luna');
};
```

## 例 3：把「上下文重写」挪到某个节点后面

```js
export default ({ h }) => {
  const anchor = h.node('aaaa1111');   // 锚点节点的 id 前缀
  const rewrite = h.node('bbbb2222');  // 要挪过去的节点
  // 下游原来引用 anchor.text 的地方，改为引用重写节点的 message
  h.retargetRefs({ from: anchor.id, fromDataPath: 'text', to: rewrite.id, toDataPath: 'message', expect: 123 });
  h.removeEdges((e) => e.target.cell === rewrite.id, { expect: 1 });
  h.addEdge(anchor, h.portOf(anchor, 'right'), rewrite, h.portOf(rewrite, 'left'));
};
```

## 同一套改动用到别的版本或别的智能体

```bash
md pull --bot <另一个智能体> --version v1.0.401
md apply ~/fixes/fare-fix.mjs     # 同一个脚本；锚点或数量不对会直接报错，不会悄悄漏改
```
