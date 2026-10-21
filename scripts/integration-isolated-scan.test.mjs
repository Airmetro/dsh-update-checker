import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

let base;
let home;
let profile;
let profileNm;
let store;
let selfStoreDir;
let mod;

const pluginSpecs = [
  ['dshmarket', '1.66.44'],
  ['dsh-codex-subscription', '3.1.4'],
  ['@acme/dsh-tool', '0.4.0'],
];

function storeDirFor(name, version) {
  return join(store, `${name.replace('/', '+')}@${version}`, 'node_modules', ...name.split('/'));
}

async function writePlugin(dir, name, version) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, dsh: { client: { platform: 'web' } } }, null, 2) + '\n'
  );
}

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-isolated-scan-'));
  home = join(base, 'home');
  profile = join(home, 'profiles', 'web');
  profileNm = join(profile, 'node_modules');
  store = join(profileNm, '.pnpm');

  selfStoreDir = storeDirFor('dsh-update-checker', '1.7.3');
  await mkdir(selfStoreDir, { recursive: true });
  await cp(new URL('../lib', import.meta.url), join(selfStoreDir, 'lib'), { recursive: true });
  await writeFile(
    join(selfStoreDir, 'package.json'),
    JSON.stringify({ name: 'dsh-update-checker', version: '1.7.3', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n'
  );
  await symlink(selfStoreDir, join(profileNm, 'dsh-update-checker'), LINK_TYPE);

  for (const [name, version] of pluginSpecs) {
    const dir = storeDirFor(name, version);
    await writePlugin(dir, name, version);
    const link = join(profileNm, ...name.split('/'));
    await mkdir(dirname(link), { recursive: true });
    await symlink(dir, link, LINK_TYPE);
  }

  await writePlugin(join(profileNm, 'dsh-real-plugin'), 'dsh-real-plugin', '2.0.1');

  const localSource = join(base, 'local-dev', 'dsh-local-dev');
  await writePlugin(localSource, 'dsh-local-dev', '0.2.0');
  await symlink(localSource, join(profileNm, 'dsh-local-dev'), LINK_TYPE);

  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: Object.fromEntries(pluginSpecs.map(([n, v]) => [n, '^' + v]).concat([['dsh-update-checker', '^1.7.3']])),
      },
      null,
      2
    ) + '\n'
  );
  await writeFile(join(profile, 'cordis.patch.yml'), 'plugins:\n  - id: dsh-update-checker\n');
  await writeFile(
    join(profileNm, '.modules.yaml'),
    'hoistPattern:\n  - "*"\nnodeLinker: isolated\nstoreDir: C:/pnpm/store\n'
  );

  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'web';
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  delete process.env.DSH_PROFILE_DIR;

  mod = await import(pathToFileURL(join(selfStoreDir, 'lib', 'index.js')).href);
});

test.after(async () => {
  delete process.env.DSH_HOME;
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  await rm(base, { recursive: true, force: true });
});

test('isolated 布局：插件自身 realpath 在 .pnpm 里，扫描根仍解析为 profile 的 node_modules', async () => {
  const selfLib = join(selfStoreDir, 'lib');
  assert.equal(await realpath(selfLib), await realpath(join(selfStoreDir, 'lib')));
  assert.ok(selfLib.includes('.pnpm'), '测试前提：被测代码真的位于 pnpm 虚拟仓库里');
  assert.equal(mod.findProfileNodeModules(selfLib), profileNm);
  assert.equal(mod.desktopRuntimeInfo().profileNodeModules, profileNm);
  assert.equal(mod.desktopRuntimeInfo().profileDir, profile);
});

test('isolated 布局：符号链接条目被视为插件目录，列表包含全部插件', async () => {
  const list = await mod.scanInstalledPlugins();
  const names = list.map((p) => p.name).sort();
  assert.deepEqual(names, ['@acme/dsh-tool', 'dsh-codex-subscription', 'dsh-local-dev', 'dsh-real-plugin', 'dsh-update-checker', 'dshmarket']);
  for (const p of list) {
    assert.ok(!p.dir.includes('.pnpm'), `${p.name} 的目录不能落在 .pnpm 仓库里：${p.dir}`);
    assert.ok(resolve(p.dir).startsWith(resolve(profileNm)), `${p.name} 的目录必须在 profile 的 node_modules 下：${p.dir}`);
  }
  const byName = new Map(list.map((p) => [p.name, p]));
  assert.equal(byName.get('dshmarket').installed, '1.66.44');
  assert.equal(byName.get('@acme/dsh-tool').installed, '0.4.0');
  assert.equal(byName.get('dsh-real-plugin').installed, '2.0.1');
  assert.equal(byName.get('dsh-update-checker').installed, '1.7.3');
});

test('isolated 布局：link: 本地源码链接被标记，存储区链接不被标记', async () => {
  const list = await mod.scanInstalledPlugins();
  const byName = new Map(list.map((p) => [p.name, p]));
  assert.equal(byName.get('dsh-local-dev').localLink, true, 'link:../source 形式的条目应标记为 localLink');
  assert.ok(!byName.get('dshmarket').localLink, 'pnpm 存储区链接不是本地源码链接');
  assert.ok(!byName.get('dsh-update-checker').localLink, '插件自身的存储区链接不是本地源码链接');
  assert.ok(!byName.get('dsh-real-plugin').localLink, '真实目录不是链接');
});

test('isolated 布局：runtime 报告 nodeLinker 并给出可见提示', async () => {
  const rt = mod.desktopRuntimeInfo();
  assert.equal(rt.profileLinker, 'isolated');
  assert.ok(Array.isArray(rt.warnings));
  const codes = rt.warnings.map((w) => w.code);
  assert.ok(codes.includes('profile-isolated-linker'));
});

test('hoisted/profile 共用布局：解析与扫描行为不变', async () => {
  const realProfileNm = join(base, 'hoisted', 'profiles', 'node_modules');
  await mkdir(join(realProfileNm, 'dsh-hoisted'), { recursive: true });
  await writePlugin(join(realProfileNm, 'dsh-hoisted'), 'dsh-hoisted', '0.1.0');
  assert.equal(mod.resolveProfileNodeModules({ DSH_UC_PROFILE_NODE_MODULES: realProfileNm }, join(realProfileNm, 'dsh-update-checker', 'lib')), realProfileNm);
  assert.equal(mod.findProfileNodeModules(join(realProfileNm, 'dsh-hoisted')), realProfileNm);
});
