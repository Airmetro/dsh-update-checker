// 单元测试：Issue #3 修复 —— monorepo 子包 GitHub tag 归属判定（ghTagBelongsTo 纯函数）
// 场景：主仓库 releases/latest 的 tag（如 v2.15.0）对应根 package.json 的 name 与 DSH
// 子包名不同（如 @tt-a1i/archify-dsh vs archify），应判定该 tag 与本插件无关 → 不采信。
// v1.4.5 追加：状态灯判定（deriveStatus 纯函数）—— 黄/绿/红三态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ghTagBelongsTo, deriveStatus } from '../lib/index.js';

test('ghTagBelongsTo: 根包名与插件名一致 → 采信（独立仓库）', () => {
  assert.equal(ghTagBelongsTo('@tt-a1i/archify-dsh', '@tt-a1i/archify-dsh'), true);
  assert.equal(ghTagBelongsTo('dsh-update-checker', 'dsh-update-checker'), true);
});

test('ghTagBelongsTo: 根包名与插件名不一致 → 拒绝（monorepo 主仓库 tag）', () => {
  // issue #3 复现场景：npm 子包 @tt-a1i/archify-dsh，主仓库根包名 archify
  assert.equal(ghTagBelongsTo('archify', '@tt-a1i/archify-dsh'), false);
  assert.equal(ghTagBelongsTo('hindsight', '@vectorize-io/hindsight-coding-agents'), false);
});

test('ghTagBelongsTo: ghName 为 null（限流/网络失败/根无 package.json）→ 保持采信', () => {
  // 保护 GitHub-only 插件：拿不到根包名时不得误杀，维持原行为
  assert.equal(ghTagBelongsTo(null, 'dsh-sysmon'), true);
  assert.equal(ghTagBelongsTo(undefined, 'dsh-sysmon'), true);
});

test('ghTagBelongsTo: 大小写/空白精确比较（package.json name 为规范包名）', () => {
  assert.equal(ghTagBelongsTo('My-Pkg', 'my-pkg'), false);
  assert.equal(ghTagBelongsTo('my-pkg', 'my-pkg'), true);
});

// ── deriveStatus（v1.4.5 状态灯）───────────────────────────────────────
test('deriveStatus: 有更新 → update（黄灯）', () => {
  assert.equal(deriveStatus('1.0.0', '1.2.0', true), 'update');
  assert.equal(deriveStatus('0.1.0', '2.15.0', true), 'update');
});

test('deriveStatus: 已是最新 → latest（绿灯）', () => {
  assert.equal(deriveStatus('1.2.0', '1.2.0', true), 'latest');
  assert.equal(deriveStatus('1.0.0', '1.0.0', true), 'latest');
});

test('deriveStatus: 本机版本高于发布源 → rollback（红灯，作者回退版本）', () => {
  assert.equal(deriveStatus('2.15.0', '1.0.0', true), 'rollback');
  assert.equal(deriveStatus('1.2.0', '1.0.0', true), 'rollback');
});

test('deriveStatus: 无发布源可用 / 无法查询 → error（红灯，库被删）', () => {
  assert.equal(deriveStatus('1.0.0', null, false), 'error');
  assert.equal(deriveStatus('1.0.0', null, true), 'error'); // target 为空仍 error
  assert.equal(deriveStatus('1.0.0', '1.0.0', false), 'error');
});

test('deriveStatus: installed 缺失时不误报，归为 latest', () => {
  assert.equal(deriveStatus(null, '1.0.0', true), 'latest');
  assert.equal(deriveStatus(undefined, '1.0.0', true), 'latest');
});
