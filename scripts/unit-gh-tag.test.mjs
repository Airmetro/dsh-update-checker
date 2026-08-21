



import test from 'node:test';
import assert from 'node:assert/strict';
import { ghTagBelongsTo, deriveStatus } from '../lib/index.js';

test('ghTagBelongsTo: 根包名与插件名一致 → 采信（独立仓库）', () => {
  assert.equal(ghTagBelongsTo('@tt-a1i/archify-dsh', '@tt-a1i/archify-dsh'), true);
  assert.equal(ghTagBelongsTo('dsh-update-checker', 'dsh-update-checker'), true);
});

test('ghTagBelongsTo: 根包名与插件名不一致 → 拒绝（monorepo 主仓库 tag）', () => {
  
  assert.equal(ghTagBelongsTo('archify', '@tt-a1i/archify-dsh'), false);
  assert.equal(ghTagBelongsTo('hindsight', '@vectorize-io/hindsight-coding-agents'), false);
});

test('ghTagBelongsTo: ghName 为 null（限流/网络失败/根无 package.json）→ 保持采信', () => {
  
  assert.equal(ghTagBelongsTo(null, 'dsh-sysmon'), true);
  assert.equal(ghTagBelongsTo(undefined, 'dsh-sysmon'), true);
});

test('ghTagBelongsTo: 大小写/空白精确比较（package.json name 为规范包名）', () => {
  assert.equal(ghTagBelongsTo('My-Pkg', 'my-pkg'), false);
  assert.equal(ghTagBelongsTo('my-pkg', 'my-pkg'), true);
});


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
  assert.equal(deriveStatus('1.0.0', null, true), 'error'); 
  assert.equal(deriveStatus('1.0.0', '1.0.0', false), 'error');
});

test('deriveStatus: installed 缺失时不误报，归为 latest', () => {
  assert.equal(deriveStatus(null, '1.0.0', true), 'latest');
  assert.equal(deriveStatus(undefined, '1.0.0', true), 'latest');
});
