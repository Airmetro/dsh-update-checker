import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { escapePnpmStore, findProfileNodeModules, findNodeModulesDir, resolveProfileNodeModules, readProfileLinker } from '../lib/index.js';

const winStore = 'C:\\Users\\Lenovo\\.dsh\\profiles\\web\\node_modules\\.pnpm\\dsh-update-checker@1.7.2_react@18.3.1\\node_modules';
const winProfileNm = 'C:\\Users\\Lenovo\\.dsh\\profiles\\web\\node_modules';
const posixStore = '/home/me/.dsh/profiles/web/node_modules/.pnpm/dsh-update-checker@1.7.2_react@18.3.1/node_modules';
const posixProfileNm = '/home/me/.dsh/profiles/web/node_modules';

test('escapePnpmStore：isolated 布局从 .pnpm 内部回到 profile 的 node_modules', () => {
  assert.equal(escapePnpmStore(winStore), winProfileNm);
  assert.equal(escapePnpmStore(posixStore), posixProfileNm);
});

test('escapePnpmStore：hoisted/共用布局原样返回', () => {
  assert.equal(escapePnpmStore(winProfileNm), winProfileNm);
  assert.equal(escapePnpmStore(posixProfileNm), posixProfileNm);
  assert.equal(escapePnpmStore('C:\\Program Files\\nodejs\\node_modules'), 'C:\\Program Files\\nodejs\\node_modules');
  assert.equal(escapePnpmStore(''), '');
  assert.equal(escapePnpmStore(null), '');
});

test('escapePnpmStore：.pnpm 自带的 node_modules 也回到外层', () => {
  assert.equal(escapePnpmStore(winProfileNm + '\\.pnpm\\node_modules'), winProfileNm);
  assert.equal(escapePnpmStore(posixProfileNm + '/.pnpm/node_modules'), posixProfileNm);
});

test('findProfileNodeModules：插件自身 realpath 在 .pnpm 里时，扫描根是 profile', () => {
  const selfLib = join(winStore, 'dsh-update-checker', 'lib');
  assert.equal(findNodeModulesDir(selfLib), winStore);
  assert.equal(findProfileNodeModules(selfLib), winProfileNm);
  assert.equal(
    findProfileNodeModules('/home/me/.dsh/profiles/web/node_modules/.pnpm/x@1.0.0/node_modules/dsh-update-checker/lib'),
    posixProfileNm
  );
});

test('resolveProfileNodeModules：显式环境变量优先，不被 store 推导覆盖', () => {
  const explicit = join(tmpdir(), 'duc-explicit-node-modules');
  assert.equal(resolveProfileNodeModules({ DSH_UC_PROFILE_NODE_MODULES: explicit }, winStore), explicit);
});

test('resolveProfileNodeModules：profile 内的 isolated 安装解析到 profile 的 node_modules', () => {
  const resolved = resolveProfileNodeModules({}, join(winStore, 'dsh-update-checker', 'lib'));
  assert.equal(resolved, winProfileNm);
});

test('resolveProfileNodeModules：全局安装时优先用运行中的 profile', async () => {
  const base = await mkdtemp(join(tmpdir(), 'duc-isolated-unit-'));
  try {
    const home = join(base, 'home');
    const profileNm = join(home, 'profiles', 'web', 'node_modules');
    await mkdir(profileNm, { recursive: true });
    const globalSelf = 'C:\\Program Files\\nodejs\\node_modules\\dsh-update-checker\\lib';
    const picked = resolveProfileNodeModules({ DSH_HOME: home, DSH_PROFILE: 'web' }, globalSelf);
    assert.equal(picked, profileNm);
    const missing = resolveProfileNodeModules({ DSH_HOME: home, DSH_PROFILE: 'nope' }, globalSelf);
    assert.equal(missing, 'C:\\Program Files\\nodejs\\node_modules');
    const dirForm = resolveProfileNodeModules({ DSH_PROFILE_DIR: join(home, 'profiles', 'web'), DSH_HOME: join(base, 'other') }, globalSelf);
    assert.equal(dirForm, profileNm);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('readProfileLinker：从 .modules.yaml 读出 nodeLinker，缺失时为 null', async () => {
  const base = await mkdtemp(join(tmpdir(), 'duc-isolated-linker-'));
  try {
    const profile = join(base, 'profiles', 'web');
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    assert.equal(readProfileLinker(profile, 0, Date.now() + 1), null);
    await writeFile(join(profile, 'node_modules', '.modules.yaml'), 'hoistPattern:\n  - "*"\nnodeLinker: isolated\n');
    assert.equal(readProfileLinker(profile, 0, Date.now() + 2), 'isolated');
    await writeFile(join(profile, 'node_modules', '.modules.yaml'), 'nodeLinker: hoisted\n');
    assert.equal(readProfileLinker(profile, 0, Date.now() + 3), 'hoisted');
    assert.equal(readProfileLinker(null, 0, Date.now() + 4), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
