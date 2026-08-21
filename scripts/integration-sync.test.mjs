

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let base;
let deploy;
let profile;
let mod;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-it-'));
  deploy = join(base, 'deploy');
  profile = join(base, 'profile');

  
  await mkdir(join(deploy, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(
    join(deploy, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' })
  );
  await mkdir(join(deploy, 'node_modules', '@deepseek-ai', 'dsh-client-runtime'), { recursive: true });
  await writeFile(
    join(deploy, 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-client-runtime', version: '2.0.0' })
  );
  await writeFile(join(deploy, 'package-lock.json'), '{}');

  
  await mkdir(join(profile, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(
    join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.9.0' })
  );
  await mkdir(join(profile, 'node_modules', 'dsh-update-checker'), { recursive: true });
  await writeFile(
    join(profile, 'node_modules', 'dsh-update-checker', 'package.json'),
    JSON.stringify({ name: 'dsh-update-checker', version: '1.3.1' })
  );

  process.env.DSH_UC_PROFILE_NODE_MODULES = join(profile, 'node_modules');
  process.env.DSH_DEPLOY_ROOT = deploy;
  mod = await import('../lib/index.js');
});

test.after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('readEcoVersions 读取 @deepseek-ai 各包版本', async () => {
  assert.deepEqual(await mod.readEcoVersions(join(deploy, 'node_modules')), {
    dsh: '1.0.0',
    'dsh-client-runtime': '2.0.0',
  });
  
  assert.deepEqual(await mod.readEcoVersions(join(profile, 'node_modules')), { dsh: '0.9.0' });
});

test('planSync 生成同步计划（版本差 + 缺失）', async () => {
  const { todo } = await mod.planSync(deploy);
  assert.deepEqual(todo, [
    { name: 'dsh', from: '0.9.0', to: '1.0.0' },
    { name: 'dsh-client-runtime', from: null, to: '2.0.0' },
  ]);
});

test('backupForUpdate 写 lockfile + 两份版本清单备份', async () => {
  const dir = await mod.backupForUpdate(deploy);
  const deployV = JSON.parse(await readFile(join(dir, 'versions-deploy.json'), 'utf8'));
  const profileV = JSON.parse(await readFile(join(dir, 'versions-profile.json'), 'utf8'));
  assert.equal(deployV.dsh, '1.0.0');
  assert.equal(deployV['dsh-client-runtime'], '2.0.0');
  assert.equal(profileV.dsh, '0.9.0'); 
  assert.equal(await readFile(join(dir, 'package-lock.json'), 'utf8'), '{}');
});

test('runSync 执行同步且不碰 profile 独有包', async () => {
  const { todo } = await mod.planSync(deploy);
  const results = await mod.runSync(deploy, todo);
  assert.equal(results.filter((r) => !r.ok).length, 0, JSON.stringify(results));
  
  const dsh = JSON.parse(await readFile(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  assert.equal(dsh.version, '1.0.0');
  const rt = JSON.parse(await readFile(join(profile, 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'package.json'), 'utf8'));
  assert.equal(rt.version, '2.0.0');
  
  const uc = JSON.parse(await readFile(join(profile, 'node_modules', 'dsh-update-checker', 'package.json'), 'utf8'));
  assert.equal(uc.version, '1.3.1');
});

test('findDeployRoot 通过 DSH_DEPLOY_ROOT 回退命中', async () => {
  assert.equal(await mod.findDeployRoot(), deploy);
});

test('readInstalledVersion 读取部署侧版本', async () => {
  assert.equal(await mod.readInstalledVersion(), '1.0.0');
});
