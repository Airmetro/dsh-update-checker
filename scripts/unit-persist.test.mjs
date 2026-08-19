// 单元测试：v1.4.6 新增纯函数 derivePersistedSpec —— 一键更新后推导应写回 profile
// package.json 的新依赖声明（修复"同一插件反复提醒更新"死循环的 spec 推导层）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePersistedSpec } from '../lib/index.js';

// ── semver 风格：保留前导操作符 ─────────────────────────────────────────
test('derivePersistedSpec: ^ 前导操作符保留', () => {
  assert.equal(derivePersistedSpec('^0.12.3', '0.13.1', null), '^0.13.1');
  assert.equal(derivePersistedSpec('^1.13.1', '1.14.1', null), '^1.14.1');
});

test('derivePersistedSpec: ~ 前导操作符保留', () => {
  assert.equal(derivePersistedSpec('~1.2.3', '1.3.0', null), '~1.3.0');
});

test('derivePersistedSpec: 精确版本 → 精确新版本', () => {
  assert.equal(derivePersistedSpec('0.2.3', '0.3.0', null), '0.3.0');
  assert.equal(derivePersistedSpec('v1.2.3', '1.3.0', null), '1.3.0');
});

test('derivePersistedSpec: 单比较符保留操作符', () => {
  assert.equal(derivePersistedSpec('>=1.2.3', '1.4.0', null), '>=1.4.0');
  assert.equal(derivePersistedSpec('<2.0.0', '1.4.0', null), '<1.4.0');
});

test('derivePersistedSpec: 复杂范围 / 通配 → npm 默认 caret', () => {
  assert.equal(derivePersistedSpec('>=1.2.3 <2.0.0', '1.4.0', null), '^1.4.0');
  assert.equal(derivePersistedSpec('1.x', '2.0.0', null), '^2.0.0');
  assert.equal(derivePersistedSpec('*', '2.0.0', null), '^2.0.0');
});

test('derivePersistedSpec: 预发布版本号照常', () => {
  assert.equal(derivePersistedSpec('^0.12.3', '0.13.1-beta.1', null), '^0.13.1-beta.1');
});

// ── GitHub 声明：钉到 release tag ───────────────────────────────────────
test('derivePersistedSpec: github 简写 + tag → #tag 钉死', () => {
  const gh = { source: 'github', owner: 'ChenRuoT', repo: 'dsh-sidebar-qa', tag: 'v0.3.0' };
  assert.equal(
    derivePersistedSpec('github:ChenRuoT/dsh-sidebar-qa', '0.3.0', gh),
    'github:ChenRuoT/dsh-sidebar-qa#v0.3.0'
  );
  assert.equal(
    derivePersistedSpec('github:ChenRuoT/dsh-sidebar-qa#main', '0.3.0', gh),
    'github:ChenRuoT/dsh-sidebar-qa#v0.3.0'
  );
});

test('derivePersistedSpec: GitHub URL 声明 → github 简写 #tag（去掉 .git 后缀）', () => {
  const gh = { source: 'github', owner: 'A', repo: 'B', tag: 'v1.0.0' };
  assert.equal(
    derivePersistedSpec('git+https://github.com/A/B.git#main', '1.0.0', gh),
    'github:A/B#v1.0.0'
  );
  assert.equal(
    derivePersistedSpec('https://github.com/A/B', '1.0.0', gh),
    'github:A/B#v1.0.0'
  );
});

test('derivePersistedSpec: github 声明缺 tag/来源 → 不推导（跳过持久化）', () => {
  assert.equal(derivePersistedSpec('github:A/B', '1.0.0', null), null);
  assert.equal(derivePersistedSpec('github:A/B', '1.0.0', { source: 'npm' }), null);
  assert.equal(derivePersistedSpec('github:A/B', '1.0.0', { source: 'github' }), null);
});

// ── 无法推导 / 防注入 → null ────────────────────────────────────────────
test('derivePersistedSpec: 本地/别名/标签 spec 不推导', () => {
  assert.equal(derivePersistedSpec('file:../dsh-better-sidebar', '0.13.1', null), null);
  assert.equal(derivePersistedSpec('npm:dsh-better-sidebar@^0.12.3', '0.13.1', null), null);
  assert.equal(derivePersistedSpec('latest', '0.13.1', null), null);
  assert.equal(derivePersistedSpec('workspace:*', '0.13.1', null), null);
});

test('derivePersistedSpec: 非法输入不产出', () => {
  assert.equal(derivePersistedSpec(null, '0.13.1', null), null);
  assert.equal(derivePersistedSpec('', '0.13.1', null), null);
  assert.equal(derivePersistedSpec('  ', '0.13.1', null), null);
  assert.equal(derivePersistedSpec('^0.12.3', 'latest', null), null);
  assert.equal(derivePersistedSpec('^0.12.3', '', null), null);
  assert.equal(derivePersistedSpec('^0.12.3', '1.2.3 && rm -rf /', null), null);
});
