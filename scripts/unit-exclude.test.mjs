import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mod;
let base;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-exclude-'));
  const profileNM = join(base, 'profiles', 'node_modules');
  await mkdir(profileNM, { recursive: true });
  process.env.DSH_UC_PROFILE_NODE_MODULES = profileNM;
  mod = await import('../lib/index.js');
});

test.after(async () => {
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  await rm(base, { recursive: true, force: true });
});

test('normalizeExcludedPlugins: 去重、去空白、剔除非法值', () => {
  const out = mod.normalizeExcludedPlugins([' a ', 'a', '', 3, null, 'b', 'a', '  b c  ']);
  assert.deepEqual(out, ['a', 'b', 'b c']);
});

test('normalizeExcludedPlugins: 非数组返回空数组', () => {
  assert.deepEqual(mod.normalizeExcludedPlugins(undefined), []);
  assert.deepEqual(mod.normalizeExcludedPlugins('nope'), []);
  assert.deepEqual(mod.normalizeExcludedPlugins({}), []);
});

test('writeExcludedPlugin/readExcludedPlugins: 增加与移除循环', async () => {
  await mod.writeExcludedPlugin('dupplugin', true);
  await mod.writeExcludedPlugin('otherplugin', true);
  let set = await mod.readExcludedPlugins();
  assert.equal(set.has('dupplugin'), true);
  assert.equal(set.has('otherplugin'), true);

  await mod.writeExcludedPlugin('dupplugin', false);
  set = await mod.readExcludedPlugins();
  assert.equal(set.has('dupplugin'), false);
  assert.equal(set.has('otherplugin'), true);

  await mod.writeExcludedPlugin('dupplugin', true);
  set = await mod.readExcludedPlugins();
  assert.equal(set.has('dupplugin'), true);
});
