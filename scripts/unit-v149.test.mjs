// 单元测试：v1.4.9 新增纯函数/探测函数 ——
//   pickTargetSource（两源交叉：非平局按版本较高者；平局按默认下载源 github/npm/smart）
//   probeNpmGlobalRoot（npm 全局根探测：DSH_UC_NPM_GLOBAL_ROOT 测试钩子 + 真实 npm root -g 回退）
// v1.4.10 追加：pickMainLatest（主程序取最高版本含预发布）、mainTagToVersion（dsh-v 前缀 tag）
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTargetSource, pickMainLatest, mainTagToVersion } from '../lib/index.js';

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

// ── pickMainLatest（v1.4.10）───────────────────────────────────────────
test('pickMainLatest: 无稳定版时取最高版本（含预发布，next 通道 rc 也计入）', () => {
  const doc = {
    'dist-tags': { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' },
    versions: {
      '0.1.0-rc.6': {},
      '0.1.0-rc.7': {},
      '0.1.0-rc.8': {},
    },
  };
  // 主程序忽略稳定版优先：即使 latest=rc.7，也要看到 next 通道更高的 rc.8
  assert.equal(pickMainLatest(doc), '0.1.0-rc.8');
});

test('pickMainLatest: 有稳定版时仍取最高版本（含 rc 比较规则）', () => {
  const doc = {
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {}, '1.1.0-rc.1': {}, '0.9.9': {} },
  };
  assert.equal(pickMainLatest(doc), '1.1.0-rc.1'); // rc.1 高于 1.0.0 与 0.9.9
});

test('pickMainLatest: 空 packument → null', () => {
  assert.equal(pickMainLatest(null), null);
  assert.equal(pickMainLatest({}), null);
  assert.equal(pickMainLatest({ versions: {} }), null);
});

test('pickMainLatest: 排序与 rc 序号（rc.10 > rc.9）', () => {
  const doc = { versions: { '0.1.0-rc.9': {}, '0.1.0-rc.10': {}, '0.1.0-rc.2': {} } };
  assert.equal(pickMainLatest(doc), '0.1.0-rc.10');
});

// ── mainTagToVersion（v1.4.10）────────────────────────────────────────
test('mainTagToVersion: 主程序 dsh-v 前缀 tag', () => {
  assert.equal(mainTagToVersion('dsh-v0.1.0-rc.8'), '0.1.0-rc.8');
  assert.equal(mainTagToVersion('dsh-v1.2.3'), '1.2.3');
});

test('mainTagToVersion: 兼容裸 v 前缀与无前缀', () => {
  assert.equal(mainTagToVersion('v0.1.0-rc.8'), '0.1.0-rc.8');
  assert.equal(mainTagToVersion('1.2.3'), '1.2.3');
});

test('mainTagToVersion: 非 semver → null', () => {
  assert.equal(mainTagToVersion('dsh-latest'), null);
  assert.equal(mainTagToVersion(''), null);
  assert.equal(mainTagToVersion('release-2026'), null);
});
