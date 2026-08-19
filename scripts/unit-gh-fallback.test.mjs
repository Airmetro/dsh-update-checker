// 单元测试：v1.4.8 新增纯函数 isGhFallbackable —— GitHub→npm fallback 错误码判定
import test from 'node:test';
import assert from 'node:assert/strict';
import { isGhFallbackable } from '../lib/index.js';

test('isGhFallbackable: EDOWNLOAD（v1.4.8 新增：下载失败/tarball 损坏）→ true', () => {
  assert.equal(isGhFallbackable(Object.assign(new Error('GitHub download HTTP 502'), { code: 'EDOWNLOAD' })), true);
  assert.equal(isGhFallbackable(Object.assign(new Error('tarball corrupt'), { code: 'EDOWNLOAD' })), true);
});

test('isGhFallbackable: 既有三码保持 → true', () => {
  for (const code of ['ENOBUILD', 'ETAGMISMATCH', 'ETOOBIG']) {
    assert.equal(isGhFallbackable(Object.assign(new Error(code), { code })), true, code);
  }
});

test('isGhFallbackable: 无 code / 其它 code / null / undefined → false', () => {
  assert.equal(isGhFallbackable(new Error('GitHub download HTTP 502')), false); // 旧行为：502 无 code 不进 fallback
  assert.equal(isGhFallbackable(Object.assign(new Error('x'), { code: 'ECONNRESET' })), false);
  assert.equal(isGhFallbackable(null), false);
  assert.equal(isGhFallbackable(undefined), false);
  assert.equal(isGhFallbackable({ message: 'x' }), false);
});
