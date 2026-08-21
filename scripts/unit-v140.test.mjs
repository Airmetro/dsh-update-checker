


import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  satisfies,
  pickNpmLatest,
  deriveRisk,
  planDepMerges,
  resolveEntryFile,
  isLoopback,
  deployType,
  buildNpmInstallArgs,
} from '../lib/index.js';


test('satisfies: 精确版本', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
  assert.equal(satisfies('1.2.3', '=1.2.3'), true);
  assert.equal(satisfies('1.2.3', 'v1.2.3'), true);
});

test('satisfies: ^ caret 语义（含 0.x 特殊规则）', () => {
  assert.equal(satisfies('1.2.3', '^1.2.3'), true);
  assert.equal(satisfies('1.9.9', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false); 
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false); 
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false); 
});

test('satisfies: ~ tilde 语义', () => {
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.2.3', '~1.2'), true); 
  assert.equal(satisfies('1.3.0', '~1.2'), false);
});

test('satisfies: 比较符与空格 AND', () => {
  assert.equal(satisfies('1.2.0', '>=1.2.0'), true);
  assert.equal(satisfies('1.1.9', '>=1.2.0'), false);
  assert.equal(satisfies('2.0.0', '>=1.2.0'), true);
  assert.equal(satisfies('1.5.0', '>=1.2.0 <2.0.0'), true);
  assert.equal(satisfies('2.0.0', '>=1.2.0 <2.0.0'), false);
  assert.equal(satisfies('1.2.0', '>1.2.0'), false);
  assert.equal(satisfies('1.2.1', '>1.2.0'), true);
  assert.equal(satisfies('1.2.0', '<=1.2.0'), true);
  assert.equal(satisfies('1.2.1', '<=1.2.0'), false);
});

test('satisfies: x/通配与部分版本', () => {
  assert.equal(satisfies('1.2.5', '1.2.x'), true);
  assert.equal(satisfies('1.3.0', '1.2.x'), false);
  assert.equal(satisfies('1.9.9', '1.x'), true);
  assert.equal(satisfies('2.0.0', '1.x'), false);
  assert.equal(satisfies('1.2.5', '1.2'), true); 
  assert.equal(satisfies('1.3.0', '1.2'), false);
  assert.equal(satisfies('1.2.3', '*'), true);
});

test('satisfies: 连字符区间与 || 或', () => {
  assert.equal(satisfies('1.5.0', '1.2.3 - 2.3.4'), true);
  assert.equal(satisfies('2.3.4', '1.2.3 - 2.3.4'), true);
  assert.equal(satisfies('2.4.0', '1.2.3 - 2.3.4'), false);
  assert.equal(satisfies('2.1.0', '^1.0.0 || ^2.0.0'), true);
  assert.equal(satisfies('3.0.0', '^1.0.0 || ^2.0.0'), false);
});

test('satisfies: 预发布规则（与 npm semver 一致）', () => {
  assert.equal(satisfies('0.1.0-rc.2', '^0.1.0-rc.1'), true); 
  assert.equal(satisfies('0.1.0', '^0.1.0-rc.1'), true); 
  assert.equal(satisfies('1.0.0-beta.1', '^1.0.0'), false); 
  assert.equal(satisfies('1.0.0', '1.0.0'), true);
});


test('pickNpmLatest: 有稳定版时优先最高稳定版（latest tag 指向 prerelease 也不受影响）', () => {
  const doc = {
    'dist-tags': { latest: '2.0.0-beta.1', next: '2.0.0-beta.2' },
    versions: { '1.9.0': {}, '2.0.0-beta.1': {}, '2.0.0-beta.2': {}, '1.8.0': {} },
  };
  assert.equal(pickNpmLatest(doc), '1.9.0');
});

test('pickNpmLatest: 全部为预发布时回退 dist-tags.latest（或最高版）', () => {
  assert.equal(
    pickNpmLatest({ 'dist-tags': { latest: '0.1.0-rc.6' }, versions: { '0.1.0-rc.6': {}, '0.1.0-rc.3': {} } }),
    '0.1.0-rc.6'
  );
  assert.equal(
    pickNpmLatest({ 'dist-tags': {}, versions: { '0.1.0-rc.9': {}, '0.1.0-rc.3': {} } }),
    '0.1.0-rc.9'
  );
});

test('pickNpmLatest: 空 packument 返回 null', () => {
  assert.equal(pickNpmLatest({}), null);
  assert.equal(pickNpmLatest(null), null);
});


test('deriveRisk: 语义化分级', () => {
  assert.equal(deriveRisk('1.0.0', '2.0.0'), 'major');
  assert.equal(deriveRisk('1.0.0', '1.1.0'), 'minor');
  assert.equal(deriveRisk('1.0.0', '1.0.1'), 'patch');
  assert.equal(deriveRisk('0.1.0', '0.1.0-rc.6'), 'pre');
  assert.equal(deriveRisk('0.1.0-rc.6', '0.1.0-rc.7'), 'pre');
  assert.equal(deriveRisk('1.0.0', '1.0.0'), 'same');
  assert.equal(deriveRisk('abc', '1.0.0'), 'unknown');
});


test('planDepMerges: 缺失→copy；满足→keep；不满足→replace', () => {
  const plan = planDepMerges(
    { a: '^1.0.0', b: '^2.0.0', c: '^3.0.0', d: '1.0.0' },
    { a: '1.5.0', b: '1.9.9', d: '1.0.0' }
  );
  const byDep = Object.fromEntries(plan.map((i) => [i.dep, i.action]));
  assert.equal(byDep.a, 'keep'); 
  assert.equal(byDep.b, 'replace'); 
  assert.equal(byDep.c, 'copy'); 
  assert.equal(byDep.d, 'keep'); 
});

test('planDepMerges: 空规格 / 非法已装版本', () => {
  assert.deepEqual(planDepMerges({}, {}), []);
  assert.equal(planDepMerges({ a: '^1.0.0' }, { a: 'not-a-version' })[0].action, 'replace');
});


test('resolveEntryFile: main / exports 各形态', () => {
  assert.equal(resolveEntryFile({ main: 'lib/index.js' }), 'lib/index.js');
  assert.equal(resolveEntryFile({ exports: 'lib/index.js' }), 'lib/index.js');
  assert.equal(resolveEntryFile({ exports: { '.': 'lib/index.js' } }), 'lib/index.js');
  assert.equal(
    resolveEntryFile({ exports: { '.': { require: './dist/index.js', import: './dist/index.mjs' } } }),
    './dist/index.js'
  );
  assert.equal(resolveEntryFile({ exports: { '.': { import: './dist/index.mjs' } } }), './dist/index.mjs');
  assert.equal(resolveEntryFile({}), null);
});


test('isLoopback: 仅回环地址放行', () => {
  const req = (addr) => ({ socket: { remoteAddress: addr } });
  assert.equal(isLoopback(req('127.0.0.1')), true);
  assert.equal(isLoopback(req('::1')), true);
  assert.equal(isLoopback(req('::ffff:127.0.0.1')), true);
  assert.equal(isLoopback(req('192.168.1.10')), false);
  assert.equal(isLoopback(req('10.0.0.5')), false);
  assert.equal(isLoopback({}), false);
});


test('deployType: 有 package.json（含依赖）→ local；无 → global', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'duc-deploy-'));
  try {
    assert.equal(deployType(dir), 'global'); 
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '^0.1.0-rc.6' } }),
      'utf8'
    );
    assert.equal(deployType(dir), 'local');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildNpmInstallArgs: local 不加 -g；global 加 -g（npm 大版本自适应）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'duc-args-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"dependencies":{}}', 'utf8');
    const local = buildNpmInstallArgs(dir, '@deepseek-ai/dsh@latest');
    assert.equal(local.type, 'local');
    assert.ok(!local.args.includes('-g'));
    assert.ok(local.args.includes('@deepseek-ai/dsh@latest'));
    const plain = join(dir, 'no-pkg');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(plain, { recursive: true }));
    const global = buildNpmInstallArgs(plain, '@deepseek-ai/dsh@latest');
    assert.equal(global.type, 'global');
    assert.ok(global.args.includes('-g'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
