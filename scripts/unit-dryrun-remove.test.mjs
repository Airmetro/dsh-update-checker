import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseNpmRemoveList, parseNpmRemoveCount, formatRemovedPackages, assessDryRunRemovals } from '../lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const REAL_NPM_OUTPUT = [
  'add web-streams-polyfill 3.3.3',
  'add node-domexception 1.0.0',
  'remove whatwg-url 5.0.0',
  'remove webidl-conversions 3.0.1',
  'remove tr46 0.0.3',
  'change node-fetch 2.7.0 => 3.3.2',
  '',
  'added 5 packages, removed 3 packages, and changed 1 package in 2s',
].join('\n');

const GLOBAL_NPM_OUTPUT = [
  'change @deepseek-ai/dsh 0.1.7-rc.2 => 0.2.0-rc.2',
  'remove @smithy/util-buffer-from 4.0.0',
  'remove @aws-crypto/sha256-browser 5.2.0',
  'remove @opentelemetry/exporter-logs-otlp-http 0.57.0',
  '',
  'added 30 packages, removed 11 packages, and changed 507 packages in 15s',
].join('\n');

test('parseNpmRemoveList: 从 npm dry-run 输出里取出被移除的包名与版本', () => {
  const list = parseNpmRemoveList(REAL_NPM_OUTPUT);
  assert.deepEqual(list, [
    { name: 'whatwg-url', version: '5.0.0' },
    { name: 'webidl-conversions', version: '3.0.1' },
    { name: 'tr46', version: '0.0.3' },
  ]);
  assert.equal(parseNpmRemoveCount(REAL_NPM_OUTPUT), 3);
  assert.deepEqual(formatRemovedPackages(list), ['whatwg-url@5.0.0', 'webidl-conversions@3.0.1', 'tr46@0.0.3']);
});

test('parseNpmRemoveList: 无移除 / 无包名时返回空，不误报', () => {
  assert.deepEqual(parseNpmRemoveList('added 5 packages, and changed 1 package in 2s'), []);
  assert.equal(parseNpmRemoveCount('added 5 packages in 2s'), 0);
  assert.deepEqual(parseNpmRemoveList(''), []);
});

test('assessDryRunRemovals: 只回收更新目标自身的传递依赖 → 放行（issue #34）', () => {
  const assess = assessDryRunRemovals({ text: GLOBAL_NPM_OUTPUT, directDeps: ['@deepseek-ai/dsh'], allowRemove: false });
  assert.equal(assess.plannedRemovals, true);
  assert.equal(assess.count, 11);
  assert.equal(assess.allowed, true);
  assert.equal(assess.reason, 'transitive-only');
  assert.deepEqual(assess.unsafe, []);
  assert.equal(assess.summary.length, 3);
});

test('assessDryRunRemovals: 移除部署根直接声明的包 → 中止并列出包名', () => {
  const assess = assessDryRunRemovals({
    text: 'remove lodash 4.17.21\nremoved 1 package in 2s',
    directDeps: ['lodash', '@deepseek-ai/dsh'],
    allowRemove: false,
  });
  assert.equal(assess.allowed, false);
  assert.equal(assess.reason, 'declared-packages-removed');
  assert.deepEqual(assess.unsafe.map((r) => r.name), ['lodash']);
});

test('assessDryRunRemovals: allowRemove 显式覆盖（即使移除了声明的包）', () => {
  const assess = assessDryRunRemovals({
    text: 'remove lodash 4.17.21\nremoved 1 package in 2s',
    directDeps: ['lodash'],
    allowRemove: true,
  });
  assert.equal(assess.allowed, true);
  assert.equal(assess.override, true);
  assert.equal(assess.reason, 'allowRemove');
});

test('assessDryRunRemovals: npm 只给出计数不给包名时保持保守（不放行）', () => {
  const assess = assessDryRunRemovals({ text: 'removed 38 packages in 15s', directDeps: ['@deepseek-ai/dsh'] });
  assert.equal(assess.plannedRemovals, true);
  assert.equal(assess.count, 38);
  assert.equal(assess.allowed, false);
  assert.equal(assess.reason, 'removals-not-listed');
});

test('assessDryRunRemovals: 无移除时视为无风险', () => {
  const assess = assessDryRunRemovals({ text: 'added 5 packages in 2s', directDeps: ['@deepseek-ai/dsh'] });
  assert.equal(assess.plannedRemovals, false);
  assert.equal(assess.allowed, true);
  assert.equal(assess.count, 0);
});

test('dryRunGuard: 接入分类逻辑，报错保留包名并提示 allowRemove 覆盖方式', async () => {
  const src = await readFile(join(HERE, '..', 'lib', 'index.js'), 'utf8');
  assert.match(src, /err\.code = "EDRYREMOVE"/);
  assert.match(src, /assessDryRunRemovals\(\{ text, directDeps, allowRemove: opts\.allowRemove === true \}\)/);
  assert.match(src, /const listed = assess\.summary\.length \? assess\.summary : \[/);
  assert.match(src, /main-dryrun-remove-overridden/);
  assert.match(src, /main-dryrun-remove-transitive/);
  assert.match(src, /allowRemove/);
});
