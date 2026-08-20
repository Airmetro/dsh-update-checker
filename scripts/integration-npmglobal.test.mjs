// 集成测试：npm -g 全局安装布局（issue #7）——
// profile 侧 @deepseek-ai/dsh 是独立目录（pnpm hoisted，非 junction）、cwd 无部署根时，
// findDeployRoot 通过 DSH_UC_NPM_GLOBAL_ROOT 钩子探测 npm 全局前缀命中部署根。
// 模拟方式与 integration-junction 一致：DSH_UC_PROFILE_NODE_MODULES 指向临时 profile；
// DSH_UC_NPM_GLOBAL_ROOT 注入 "npm root -g" 的输出（全局 node_modules 路径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let base;
let prefix; // npm 全局前缀（部署根）：<base>/prefix/lib
let globalNodeModules; // npm root -g 输出：<base>/prefix/lib/node_modules
let profile;
let mod;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-npmg-'));
  prefix = join(base, 'prefix', 'lib'); // Linux 布局：<prefix>/lib 为部署根
  globalNodeModules = join(prefix, 'node_modules');
  profile = join(base, 'profile');

  // npm -g 安装的包在 <prefix>/lib/node_modules/@deepseek-ai/dsh
  await mkdir(join(globalNodeModules, '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(
    join(globalNodeModules, '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.9' })
  );

  // profile 侧 @deepseek-ai/dsh 是独立目录（pnpm hoisted 布局，非 junction）——
  // junction 反推路径不命中，必须靠 npm 全局根候选
  await mkdir(join(profile, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(
    join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.9' })
  );

  process.env.DSH_UC_PROFILE_NODE_MODULES = join(profile, 'node_modules');
  process.env.DSH_UC_NPM_GLOBAL_ROOT = globalNodeModules; // 模拟 npm root -g 输出
  delete process.env.DSH_DEPLOY_ROOT; // 不走 env 回退
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
