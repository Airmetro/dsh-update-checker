// 单元测试：v1.4.9 新增纯函数/探测函数 ——
//   pickTargetSource（两源交叉：非平局按版本较高者；平局按默认下载源 github/npm/smart）
//   probeNpmGlobalRoot（npm 全局根探测：DSH_UC_NPM_GLOBAL_ROOT 测试钩子 + 真实 npm root -g 回退）
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTargetSource } from '../lib/index.js';

// ── pickTargetSource ────────────────────────────────────────────────────
test('pickTargetSource: 非平局按版本较高者（github 高）', () => {
  const r = pickTargetSource('1.0.0', '2.0.0', 'github');
  assert.deepEqual(r, { target: '2.0.0', src: 'github', source: 'both' });
});

test('pickTargetSource: 非平局按版本较高者（npm 高，不受下载源设置影响）', () => {
  for (const pref of ['github', 'npm', 'smart']) {
    const r = pickTargetSource('2.0.0', '1.0.0', pref);
    assert.deepEqual(r, { target: '2.0.0', src: 'npm', source: 'both' });
  }
});

test('pickTargetSource: 平局 + 默认 github → github', () => {
  const r = pickTargetSource('1.2.3', '1.2.3', 'github');
  assert.deepEqual(r, { target: '1.2.3', src: 'github', source: 'both' });
});

test('pickTargetSource: 平局 + smart → 先 github', () => {
  const r = pickTargetSource('1.2.3', '1.2.3', 'smart');
  assert.deepEqual(r, { target: '1.2.3', src: 'github', source: 'both' });
});

test('pickTargetSource: 平局 + npm → npm', () => {
  const r = pickTargetSource('1.2.3', '1.2.3', 'npm');
  assert.deepEqual(r, { target: '1.2.3', src: 'npm', source: 'both' });
});

test('pickTargetSource: 单源（仅 github / 仅 npm）', () => {
  assert.deepEqual(pickTargetSource(null, '3.0.0', 'npm'), { target: '3.0.0', src: 'github', source: 'github' });
  assert.deepEqual(pickTargetSource('3.0.0', null, 'github'), { target: '3.0.0', src: 'npm', source: 'npm' });
});

test('pickTargetSource: 双 null → 全空', () => {
  assert.deepEqual(pickTargetSource(null, null, 'github'), { target: null, src: null, source: null });
});
