import test from 'node:test';
import assert from 'node:assert/strict';
import { guardPluginUpdate } from '../lib/index.js';

const REPORTED_AFTER = {
  latest: '0.15.0',
  targetSource: 'npm',
  source: 'npm',
  npmLatest: '0.15.0',
  ghLatest: null,
  ghTag: null,
  ghError: 'github rate limited (403)',
};

const REPORTED_BEFORE = {
  latest: '0.17.0',
  targetSource: 'github',
  source: 'both',
  npmLatest: '0.15.0',
  ghLatest: '0.17.0',
  ghTag: 'v0.17.0',
  ghError: null,
};

test('guardPluginUpdate: GitHub 限流回退到更旧的 npm 版本 → 拒绝降级（issue #35）', () => {
  const guard = guardPluginUpdate('@sunjuntao/dsh-prompt-library', '0.16.1', REPORTED_AFTER);
  assert.equal(guard.refuse, true);
  assert.equal(guard.code, 'ENODOWNGRADE');
  assert.equal(guard.installed, '0.16.1');
  assert.equal(guard.planned, '0.15.0');
  assert.match(guard.message, /0\.16\.1/);
  assert.match(guard.message, /0\.15\.0/);
  assert.match(guard.message, /403/);
  assert.equal(guard.ghError, 'github rate limited (403)');
});

test('guardPluginUpdate: 探测正常拿到更高版本 → 放行', () => {
  assert.equal(guardPluginUpdate('@sunjuntao/dsh-prompt-library', '0.16.1', REPORTED_BEFORE).refuse, false);
});

test('guardPluginUpdate: 目标与已装同版本 → 不算降级（允许重装修复）', () => {
  const guard = guardPluginUpdate('pkg', '1.2.3', { latest: '1.2.3', targetSource: 'npm' });
  assert.equal(guard.refuse, false);
});

test('guardPluginUpdate: 缺 installed / 缺 probe.latest → 不拦（交给既有路径报错）', () => {
  assert.equal(guardPluginUpdate('pkg', null, REPORTED_AFTER).refuse, false);
  assert.equal(guardPluginUpdate('pkg', '1.0.0', { latest: null }).refuse, false);
  assert.equal(guardPluginUpdate('pkg', '1.0.0', null).refuse, false);
});

test('guardPluginUpdate: 预发布版本比较同样受保护（0.2.0-rc.1 不被 0.1.9 顶替）', () => {
  const guard = guardPluginUpdate('pkg', '0.2.0-rc.1', { latest: '0.1.9', targetSource: 'npm', ghError: null });
  assert.equal(guard.refuse, true);
  assert.equal(guard.code, 'ENODOWNGRADE');
});
