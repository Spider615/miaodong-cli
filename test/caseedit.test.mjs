import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './helpers/run-cli.mjs';
import { createEditHelpers, editChanges, runEditScript } from '../src/caseedit.mjs';
import { TARGET_BOT, botEvents, botVars } from './helpers/testcenter-fixtures.mjs';

const ctx = { events: botEvents[TARGET_BOT], vars: botVars[TARGET_BOT] };
const stored = (i, patch = {}) => ({ testCaseId: `c${i}`, testSetId: 's1', name: `退款-0${i}`, status: 'ready', isReviewed: true, scenarioNodeId: null, dimension: '', triggerType: 'receive-text-message', triggerInputs: { text: `问题 ${i}` }, sessionMemoryCustomData: {}, pluginMockOutputs: [], sqlDbMockOutputs: [], testNodeOutputAssertions: [], canvasActionOutputAssertions: [], isStrictVerify: false, ...patch });
let n = 0;
const script = (body) => {
  const file = join(tempHome(), `edit-${++n}.mjs`);
  writeFileSync(file, body);
  return file;
};

test('h：按名字挑用例、取 id、生成断言和历史；找不到就报错', () => {
  const cases = [stored(1), stored(2)];
  const log = [];
  const h = createEditHelpers(cases, ctx, log);
  assert.deepEqual(h.pick('退款-02').map((c) => c.testCaseId), ['c2']);
  assert.equal(h.pick(/退款/).length, 2);
  assert.deepEqual(h.pick((c) => c.testCaseId === 'c1').map((c) => c.name), ['退款-01']);
  assert.throws(() => h.pick(['退款-01', '没有的']), /没有用例「没有的」/);
  assert.equal(h.eventId('发送4.0'), 'tev-send');
  assert.equal(h.varId('已发优惠'), 'tv-flag');
  assert.equal(h.historyVarId(), 'tv-hist');
  assert.throws(() => h.varId('不存在'), /不存在」在这个智能体里没有/);
  assert.deepEqual(h.expect({ handover: true }), [{ verifyPayload: { type: 'handover' }, actionContent: { type: 'handover' } }]);
  assert.throws(() => h.expect({ event: '没有的事件' }), /没有的事件/);
  assert.deepEqual(h.history(['a']), [{ role: 'user', content: 'a' }]);
  h.log('改了断言');
  assert.deepEqual(log, ['改了断言']);
});

test('runEditScript：脚本改的是副本；脚本出错、没有默认导出都报清楚', async () => {
  const cases = [stored(1)];
  const { cases: after } = await runEditScript(script(`export default ({ cases, h }) => { for (const c of cases) c.canvasActionOutputAssertions = h.expect('应说明退款流程'); };`), cases, ctx);
  assert.equal(cases[0].canvasActionOutputAssertions.length, 0);
  assert.equal(after[0].canvasActionOutputAssertions[0].verifyPayload.text.description, '应说明退款流程');
  await assert.rejects(runEditScript(script('export default () => { throw new Error("写错了"); };'), cases, ctx), /脚本出错：写错了/);
  await assert.rejects(runEditScript(script('export const x = 1;'), cases, ctx), /export default/);
});

test('editChanges：只列 update 会写的字段；改了别的字段、增删用例、name 空或重名、触发类型不对都算错', () => {
  const before = [stored(1), stored(2)];
  const ok = editChanges(before, [stored(1, { name: '退款-01-改', dimension: '退款' }), stored(2)]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.changed.map((c) => [c.after.testCaseId, c.fields]), [['c1', ['name', 'dimension']]]);
  const bad = editChanges(before, [stored(1, { scenarioNodeId: 'sn-x', isReviewed: false }), stored(2, { name: '退款-01' }), stored(3)]);
  const text = bad.errors.join('\n');
  assert.match(text, /2 条变成了 3 条/);
  assert.match(text, /改了不能改的字段：isReviewed、scenarioNodeId/);
  assert.match(text, /name「退款-01」有 2 条重名/);
  assert.match(editChanges(before, [stored(1, { name: ' ' }), stored(2)]).errors.join(), /name 被改成空的/);
  assert.match(editChanges(before, [stored(1, { triggerType: 'x' }), stored(2)]).errors.join(), /不是秒懂的触发类型/);
  assert.match(editChanges(before, [stored(1, { canvasActionOutputAssertions: [{ verifyPayload: { type: 'handover' }, actionContent: { type: 'tag-user' } }] }), stored(2)]).errors.join(), /类型不一致/);
});
