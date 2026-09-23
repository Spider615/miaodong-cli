# 改动脚本

脚本是一个 `.mjs` 文件，默认导出一个函数，在 `ctx.canvas`（秒懂画布数组）上直接改：

```js
export default ({ canvas, h }) => {
  // …
};
```

守卫一律「宁可报错也不猜」：命中次数不对、路径不存在、数量不符都会让整个脚本失败，工作副本保持不变。

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
