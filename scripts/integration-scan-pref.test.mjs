import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mod;
let base;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-scanpref-'));
  const profileNM = join(base, 'profiles', 'node_modules');
  const webNM = join(base, 'profiles', 'web', 'node_modules');
  const shared = join(profileNM, 'prefplugin');
  const local = join(webNM, 'prefplugin');
  await mkdir(shared, { recursive: true });
  await mkdir(local, { recursive: true });
  await writeFile(
    join(shared, 'package.json'),
    JSON.stringify({ name: 'prefplugin', version: '1.0.0', dsh: { client: { platform: 'web' } } }),
    'utf8'
  );
  await writeFile(
    join(local, 'package.json'),
    JSON.stringify({ name: 'prefplugin', version: '2.0.0', dsh: { client: { platform: 'web' } } }),
    'utf8'
  );
  await mkdir(join(base, 'profiles', 'web'), { recursive: true });
  await writeFile(
    join(base, 'profiles', 'web', 'cordis.patch.yml'),
    "- insert:\n    - id: prefplugin\n      name: 'prefplugin'\n",
    'utf8'
  );

  process.env.DSH_UC_PROFILE_NODE_MODULES = profileNM;
  mod = await import('../lib/index.js');
});

test.after(async () => {
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  await rm(base, { recursive: true, force: true });
});

test('scanInstalledPlugins: 同名多位置优先组合所属 profile 的副本，且记录 copies', async () => {
  const found = await mod.scanInstalledPlugins();
  assert.equal(found.length, 1);
  const p = found[0];
  assert.equal(p.name, 'prefplugin');
  assert.equal(p.installed, '2.0.0');
  assert.ok(p.dir.includes(join('profiles', 'web', 'node_modules')), `dir=${p.dir}`);
  assert.equal(p.copies.length, 1);
  assert.equal(p.copies[0].installed, '1.0.0');
});
