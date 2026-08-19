// 单元测试：Issue #3 修复 —— monorepo 子包 GitHub tag 归属判定（ghTagBelongsTo 纯函数）
// 场景：主仓库 releases/latest 的 tag（如 v2.15.0）对应根 package.json 的 name 与 DSH
// 子包名不同（如 @tt-a1i/archify-dsh vs archify），应判定该 tag 与本插件无关 → 不采信。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ghTagBelongsTo } from '../lib/index.js';

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
