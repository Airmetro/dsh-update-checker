




import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let base;
let prefix; 
let globalNodeModules; 
let profile;
let mod;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-npmg-'));
  prefix = join(base, 'prefix', 'lib'); 
  globalNodeModules = join(prefix, 'node_modules');
  profile = join(base, 'profile');

  
  await mkdir(join(globalNodeModules, '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(
    join(globalNodeModules, '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.9' })
  );

  
  
  await mkdir(join(profile, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(
    join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.9' })
  );

  process.env.DSH_UC_PROFILE_NODE_MODULES = join(profile, 'node_modules');
  process.env.DSH_UC_NPM_GLOBAL_ROOT = globalNodeModules; 
  delete process.env.DSH_DEPLOY_ROOT; 
  mod = await import('../lib/index.js');
});

test.after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('probeNpmGlobalRoot 通过测试钩子返回全局前缀（npm root -g 输出的父目录）', async () => {
  const root = await mod.probeNpmGlobalRoot();
  assert.equal(root, prefix);
});

test('findDeployRoot 在 npm -g 布局下命中全局前缀（issue #7 场景）', async () => {
  assert.equal(await mod.findDeployRoot(), prefix);
});

test('readInstalledVersion 经 npm 全局根读到已装版本', async () => {
  assert.equal(await mod.readInstalledVersion(), '0.1.0-rc.9');
});
