import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseChannel, prereleaseGate } from '../lib/index.js';

test('releaseChannel: 预发布标识即频道，正式版为 stable', () => {
  assert.equal(releaseChannel('0.1.5-rc.1'), 'rc');
  assert.equal(releaseChannel('0.1.5-rc.2'), 'rc');
  assert.equal(releaseChannel('0.1.6-alpha.1'), 'alpha');
  assert.equal(releaseChannel('1.0.0-beta.2'), 'beta');
  assert.equal(releaseChannel('1.2.3'), 'stable');
  assert.equal(releaseChannel(''), 'unknown');
  assert.equal(releaseChannel(null), 'unknown');
  assert.equal(releaseChannel('not-a-version'), 'unknown');
});

test('prereleaseGate: 实机那次 rc -> alpha 跨频道升级被拦下', () => {
  const gate = prereleaseGate('0.1.5-rc.1', '0.1.6-alpha.1', false);
  assert.equal(gate.blocked, true);
  assert.equal(gate.code, 'E_PRERELEASE');
  assert.equal(gate.from, 'rc');
  assert.equal(gate.to, 'alpha');
});

test('prereleaseGate: 同频道内的预发布照旧放行', () => {
  assert.equal(prereleaseGate('0.1.5-rc.1', '0.1.5-rc.2', false).blocked, false);
  assert.equal(prereleaseGate('0.1.6-alpha.1', '0.1.6-alpha.2', false).blocked, false);
  assert.equal(prereleaseGate('0.1.6-alpha.1', '0.1.7-alpha.1', false).blocked, false);
});

test('prereleaseGate: 目标为正式版、或用户显式开启 allowPrerelease 时一律放行', () => {
  assert.equal(prereleaseGate('0.1.5-rc.1', '1.0.0', false).blocked, false);
  assert.equal(prereleaseGate('1.0.0', '1.1.0', false).blocked, false);
  assert.equal(prereleaseGate('0.1.5-rc.1', '0.1.6-alpha.1', true).blocked, false);
  assert.equal(prereleaseGate('1.0.0', '1.1.0-alpha.1', true).blocked, false);
});

test('prereleaseGate: 数据缺失时失败开放（宁可不拦，也不误拦）', () => {
  assert.equal(prereleaseGate(null, '0.1.6-alpha.1', false).blocked, false, '读不到已装版本');
  assert.equal(prereleaseGate('not-a-version', '0.1.6-alpha.1', false).blocked, false);
  assert.equal(prereleaseGate('0.1.5-rc.1', '', false).blocked, false, '读不到目标版本');
});
