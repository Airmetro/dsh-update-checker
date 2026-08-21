


import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mod;
let profileNM;
let base;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-dedupe-'));
  profileNM = join(base, 'profiles', 'node_modules');
  const webNM = join(base, 'profiles', 'web', 'node_modules');
  const pluginTop = join(profileNM, 'dupplugin');
  const pluginWeb = join(webNM, 'dupplugin');
  await mkdir(pluginTop, { recursive: true });
  await mkdir(pluginWeb, { recursive: true });
  const pkg = { name: 'dupplugin', version: '1.0.0', dsh: { client: { platform: 'web' } } };
  await writeFile(join(pluginTop, 'package.json'), JSON.stringify(pkg), 'utf8');
  await writeFile(join(pluginWeb, 'package.json'), JSON.stringify(pkg), 'utf8');
  await mkdir(join(base, 'profiles', 'web'), { recursive: true });
  await writeFile(
    join(base, 'profiles', 'web', 'cordis.patch.yml'),
    "- insert:\n    - id: dupplugin\n      name: 'dupplugin'\n",
    'utf8'
  );
  
  const other = join(profileNM, 'otherplugin');
  await mkdir(other, { recursive: true });
  await writeFile(
    join(other, 'package.json'),
    JSON.stringify({ name: 'otherplugin', version: '2.0.0', dsh: { client: { platform: 'web' } } }),
    'utf8'
  );

  process.env.DSH_UC_PROFILE_NODE_MODULES = profileNM;
  mod = await import('../lib/index.js');
});

test.after(async () => {
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  await rm(base, { recursive: true, force: true });
});

test('scanInstalledPlugins: 同名插件多位置只返回一条（1.4.1 去重）', async () => {
  const found = await mod.scanInstalledPlugins();
  const names = found.map((p) => p.name).sort();
  assert.deepEqual(names, ['dupplugin', 'otherplugin'], `实际: ${JSON.stringify(names)}`);
  
  assert.equal(names.filter((n) => n === 'dupplugin').length, 1);
});
