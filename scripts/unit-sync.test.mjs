// 单元测试：同步计划计算（planSyncFromMaps 纯函数，不碰磁盘）
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSyncFromMaps } from '../lib/index.js';

test('planSyncFromMaps: 版本不同 / 缺失的包进入计划', () => {
  const todo = planSyncFromMaps(
    { a: '1.0.0', b: '2.0.0', c: '3.0.0' }, // 部署侧
    { a: '1.0.0', b: '1.5.0' }               // profile 侧
  );
  assert.deepEqual(todo, [
    { name: 'b', from: '1.5.0', to: '2.0.0' }, // 版本不同 → 更新
    { name: 'c', from: null, to: '3.0.0' },    // profile 缺失 → 新增
  ]);
});

test('planSyncFromMaps: 版本一致 → 空计划', () => {
  assert.deepEqual(planSyncFromMaps({ a: '1.0.0' }, { a: '1.0.0' }), []);
  assert.deepEqual(planSyncFromMaps({}, {}), []);
});

test('planSyncFromMaps: profile 独有包绝不被列入计划（不会删除）', () => {
  // 关键安全不变量：只从部署侧拷贝，绝不把 profile 独有的包（如 dshcost）当垃圾清理
  const todo = planSyncFromMaps({ a: '1.0.0' }, { a: '1.0.0', x: '9.9.9' });
  assert.deepEqual(todo, []);
});

test('planSyncFromMaps: 部署侧缺失的包不进计划', () => {
  assert.deepEqual(planSyncFromMaps({}, { x: '1.0.0' }), []);
  assert.deepEqual(planSyncFromMaps({}, {}), []);
});

test('planSyncFromMaps: 同名不同版本只生成一条记录', () => {
  const todo = planSyncFromMaps({ p: '2.0.0' }, { p: '1.0.0' });
  assert.equal(todo.length, 1);
  assert.deepEqual(todo[0], { name: 'p', from: '1.0.0', to: '2.0.0' });
});
