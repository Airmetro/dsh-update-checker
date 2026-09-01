



import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTargetSource, pickMainLatest, mainTagToVersion } from '../lib/index.js';


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


test('pickMainLatest: 默认（无 allowPre）跳过预发布，无稳定版时返回 null（安全）', () => {
  const doc = {
    'dist-tags': { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' },
    versions: {
      '0.1.0-rc.6': {},
      '0.1.0-rc.7': {},
      '0.1.0-rc.8': {},
    },
  };
  assert.equal(pickMainLatest(doc), null);
  assert.equal(pickMainLatest(doc, true), '0.1.0-rc.8');
});

test('pickMainLatest: 默认优先最高稳定版，不落到预发布', () => {
  const doc = {
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': {}, '1.1.0-rc.1': {}, '0.9.9': {}, '1.0.2': {} },
  };
  assert.equal(pickMainLatest(doc), '1.0.2');
  assert.equal(pickMainLatest(doc, true), '1.1.0-rc.1');
});

test('pickMainLatest: 事故场景（最高版为 alpha，默认不选它）', () => {
  const doc = {
    'dist-tags': { latest: '0.1.0' },
    versions: { '0.1.0': {}, '0.1.1': {}, '0.1.2-alpha.3': {} },
  };
  assert.equal(pickMainLatest(doc), '0.1.1');
  assert.equal(pickMainLatest(doc, true), '0.1.2-alpha.3');
});

test('pickMainLatest: 空 packument → null', () => {
  assert.equal(pickMainLatest(null), null);
  assert.equal(pickMainLatest({}), null);
  assert.equal(pickMainLatest({ versions: {} }), null);
});

test('pickMainLatest: allowPre 时排序含 rc 序号（rc.10 > rc.9）', () => {
  const doc = { versions: { '0.1.0-rc.9': {}, '0.1.0-rc.10': {}, '0.1.0-rc.2': {} } };
  assert.equal(pickMainLatest(doc, true), '0.1.0-rc.10');
  assert.equal(pickMainLatest(doc), null);
});


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
