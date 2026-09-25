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
  // 别的区的库 id 带横杠也认（整支审查小问题 4）
  assert.equal(toolKbId('q_kb_ab-12_x'), 'ab-12_x');
});

test('kb target：知识库按 id > 4 位以上 id 前缀 > 名字 > 名字包含 找；同一档多个就都返回', () => {
  const kbs = [{ id: KB_FAQ, name: '售后 FAQ' }, { id: KB_OTHER, name: '财务 FAQ' }, { id: KB_FILE, name: '产品手册' }];
  assert.deepEqual(matchKbs(kbs, KB_FILE).map((k) => k.name), ['产品手册']);
  assert.deepEqual(matchKbs(kbs, 'aaaa').map((k) => k.name), ['售后 FAQ']);
  assert.deepEqual(matchKbs(kbs, 'aaa').map((k) => k.name), []);
  assert.deepEqual(matchKbs(kbs, '产品手册').map((k) => k.name), ['产品手册']);
  assert.deepEqual(matchKbs(kbs, 'FAQ').map((k) => k.name), ['售后 FAQ', '财务 FAQ']);
});
